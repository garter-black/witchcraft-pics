// Outbound polling transport. The studio PC dials out to this worker; the
// worker never opens a path to the PC, and ComfyUI stays on loopback.
// Durable state lives in the existing MEDIA R2 bucket, so an isolate restart
// or a PC reboot loses neither a queued job nor a finished render.
//
// DOCUMENTED R2 SEMANTICS (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/):
//   put(key, value, {onlyIf:{etagMatches}}) -> R2Object on success, null when
//   the precondition fails. "Non-null is the win". There is no success boolean
//   and a failed conditional write writes nothing. Tests use a fake that
//   implements exactly this, because a mock that ignores onlyIf would pass a
//   broken claim.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getModel, parseSettings } from "../src/generation/catalog";
import type { GenerationPlane, MediaRole } from "../src/generation/catalog/types";
import { toComfyGraph, type ComfyGraph, type LocalPreset } from "../src/generation/local-input";

export const LOCAL_PREFIX = "lc:";
const JOB_PREFIX = "local/job/";
const HEARTBEAT_KEY = "local/heartbeat.json";
const MAX_QUEUE = 8;
const MAX_PROMPT = 4000;
/** Hard ceiling on an uploaded render. A real short clip is far below this. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

type R2Like = {
  get(key: string): Promise<{ json<T>(): Promise<T>; text(): Promise<string>; etag?: string; customMetadata?: Record<string, string>; size?: number } | null>;
  put(key: string, value: string | ArrayBuffer, opts?: { httpMetadata?: unknown; onlyIf?: unknown; customMetadata?: unknown }): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated?: boolean }>;
};

export type LocalMedia = {
  kind: "image" | "video";
  url: string;
  key: string;
  bytes?: number;
  contentType?: string;
};

export type LocalJobRecord = {
  id: string;
  state: "queued" | "claimed" | "running" | "completed" | "failed";
  createdAt: number;
  /** Monotonic ordering stamp; avoids a shared counter file. */
  seq?: number;
  claimedAt?: number;
  leaseUntil?: number;
  owner?: string;
  /** The AUTHORIZED submitter's owner segment (16-hex), stamped server-side at
      enqueue from the verified session — never from a client-supplied field.
      Scopes status reads and the media keys this job produces. Absent only on
      legacy rows, which fail closed for a scoped caller. */
  subject?: string;
  model: string;
  prompt: string;
  graph: ComfyGraph;
  /** Honest state only. `progress` is set by the PC when ComfyUI actually
      reports a percentage; elapsed time is never converted into a percent. */
  progress?: number;
  /** Set once ComfyUI has accepted the graph, so a PC restart can re-attach to
      the same prompt instead of submitting a duplicate render. */
  promptId?: string;
  error?: string;
  media?: LocalMedia[];
  attempts?: number;
  lastError?: string;
  /** Secret token minted on every claim. Every mutating PC call must carry
      it, so knowing the owner id alone cannot mutate the job. */
  leaseToken?: string;
};

export const PRESET_IDS: Record<string, LocalPreset> = {
  "local-wan22-i2v": "wan22-i2v",
  "local-wan22-t2v": "wan22-t2v",
  "local-realvis-sdxl": "realvis-sdxl",
  "local-ltx23-t2v": "ltx23-t2v",
  "local-h3-t2v": "h3-t2v",
  "local-h3-i2v": "h3-i2v",
  /* v0.02 - photoreal image models + swap/edit, each verified by a real render */
  "local-krea2-turbo": "krea2-turbo",
  "local-flux-schnell": "flux-schnell",
  "local-reactor-faceswap": "reactor-faceswap",
  "local-character-ipadapter": "character-ipadapter",
  "local-image-edit": "image-edit",
};

/** A lease keeps a claimed job from being handed to a second PC, and expires
    so a crashed PC cannot strand a job forever. */
const LEASE_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export function signRequest(bridgeKey: string, body: string): Record<string, string> {
  const stamp = `${Math.floor(Date.now() / 1000)}`;
  return {
    "Content-Type": "application/json",
    "X-Bridge-Timestamp": stamp,
    "X-Bridge-Signature": createHmac("sha256", bridgeKey).update(`${stamp}.${body}`).digest("hex"),
  };
}

export function verifyRequest(bridgeKey: string, headers: Headers, body: string): boolean {
  const stamp = headers.get("X-Bridge-Timestamp") ?? "";
  const sig = headers.get("X-Bridge-Signature") ?? "";
  if (!bridgeKey || !stamp || !sig) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(stamp));
  if (!Number.isFinite(age) || age > 120) return false;
  const expected = createHmac("sha256", bridgeKey).update(`${stamp}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ media access */

/** Bound on how long a signed media assertion may remain valid. A reference
    fetch is a one-shot read, so the ceiling stays small and is enforced on the
    verifier side: a caller cannot mint a long-lived URL. */
export const MEDIA_ASSERTION_MAX_TTL_SECONDS = 300;

/** The exact canonical string a media assertion signs. The key AND method are
    in the payload, so a signature for a GET of one object cannot be replayed
    against a different object or a HEAD. NOTE: origin is NOT in the payload —
    the two studio domains share one bucket, so this assertion binds key, method
    and expiry only, and does not distinguish the requesting host. */
function mediaAssertionPayload(method: string, key: string, expires: number): string {
  return `media.${method.toUpperCase()}.${expires}.${key}`;
}

/** Mint a short-lived, method+path-bound assertion over ONE media key. The
    bridge HMAC is the only signer: there is no static public media secret, and
    the value cannot be widened to another key or method. */
export function signMediaFetch(
  bridgeKey: string,
  key: string,
  method: "GET" | "HEAD",
  ttlSeconds: number,
  nowMs = Date.now(),
): string {
  if (!bridgeKey) throw new Error("The media signer is not configured.");
  if (!isMediaKey(key)) throw new Error("Only a stored media key can be signed.");
  const ttl = Math.max(1, Math.min(MEDIA_ASSERTION_MAX_TTL_SECONDS, Math.floor(ttlSeconds)));
  const expires = Math.floor(nowMs / 1000) + ttl;
  const mac = createHmac("sha256", bridgeKey).update(mediaAssertionPayload(method, key, expires)).digest("hex");
  return `${expires}.${mac}`;
}

/** Verify a media assertion: the signature must match the EXACT key and method,
    the expiry must be in the future, and it must not exceed the maximum TTL
    from now. An over-long TTL is refused rather than silently accepted. */
export function verifyMediaSignature(
  bridgeKey: string,
  key: string,
  method: string,
  assertion: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!bridgeKey || !assertion || !isMediaKey(key)) return false;
  const dot = assertion.indexOf(".");
  if (dot <= 0) return false;
  const expires = Number(assertion.slice(0, dot));
  const sig = assertion.slice(dot + 1);
  if (!Number.isFinite(expires) || !sig) return false;
  const now = Math.floor(nowMs / 1000);
  if (expires <= now) return false;
  if (expires - now > MEDIA_ASSERTION_MAX_TTL_SECONDS) return false;
  const expected = createHmac("sha256", bridgeKey)
    .update(mediaAssertionPayload(method, key, expires))
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The header a media assertion rides on. A query parameter would land in
    access logs and Referer; a request header does not. */
export const MEDIA_ASSERTION_HEADER = "x-witchcraft-media-assertion";

/** The query parameter an OUTGOING hosted reference carries. A hosted provider
    fetches the URL itself and cannot send our cookie or header, so the
    assertion travels in the query. It binds the exact key, method and expiry
    and is minted ONLY server-side from the bridge HMAC — the browser never
    receives it, and there is no public endpoint that signs an arbitrary key. */
export const MEDIA_ASSERTION_QUERY = "wa";

/** Sign a full same-origin /media/ URL for an outgoing hosted reference. The
    returned URL carries a short-lived assertion a provider can fetch without a
    cookie. Any URL that is not this origin's /media/ path is returned
    unchanged, so a provider's own URL is never rewritten. */
export function signReferenceUrl(
  bridgeKey: string,
  rawUrl: string,
  origin: string,
  method: "GET" | "HEAD" = "GET",
  ttlSeconds = 120,
  nowMs = Date.now(),
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, origin);
  } catch {
    return rawUrl;
  }
  if (parsed.origin !== origin || !parsed.pathname.startsWith("/media/")) return rawUrl;
  const key = decodeURIComponent(parsed.pathname.slice("/media/".length));
  if (!isMediaKey(key)) return rawUrl;
  if (!bridgeKey) return rawUrl;
  const assertion = signMediaFetch(bridgeKey, key, method, ttlSeconds, nowMs);
  parsed.searchParams.set(MEDIA_ASSERTION_QUERY, assertion);
  return parsed.toString();
}

/** Read the outgoing-reference assertion from a request URL, if present. The
    media handler accepts it with the SAME verifier as the header form, so a
    signed query and a signed header are the same guarantee. */
export function mediaAssertionFromUrl(url: URL): string | null {
  const value = url.searchParams.get(MEDIA_ASSERTION_QUERY);
  return value && /^[0-9]+\.[a-f0-9]+$/i.test(value) ? value : null;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** The 16-hex subject segment that prefixes a media key: the first 16 bytes of
    sha256(subject secret). Both the hosted-upload route and the local owner
    route derive their prefix this way, so a prefix comparison is a real
    ownership check once the object carries the same segment.
    NOTE: a VERIFIED per-person principal segment is NOT a sha256 slice — it is
    the accepted candidate's `p_<32hex>` namespace and is authoritative as-is.
    A sha256-derived owner segment is 32 lowercase hex with NO prefix. */
export function ownerSegmentOf(hex: string): string {
  return hex.slice(0, 32);
}

/** True when a stored media key belongs to the given subject. The subject may be
    EITHER a verified per-person principal segment (`p_<32hex>`, identity ON) OR
    a sha256-derived owner segment (`<32hex>`, legacy / identity OFF). The key's
    first path segment must equal the subject exactly; a foreign or
    unrecognisable segment fails closed. */
export function keyBelongsToSubject(key: string, subject: string): boolean {
  if (!isMediaKey(key)) return false;
  const segment = key.split("/")[0] ?? "";
  if (isPrincipalSegment(subject)) return segment === subject;
  if (/^[a-f0-9]{32}$/i.test(subject)) return segment.length === 32 && segment === ownerSegmentOf(subject);
  return false;
}

/** True when `value` is the verified per-person principal segment `p_<32hex>`.
    This is the AUTHORITATIVE customer ownership subject when identity is ON: it
    is minted by the accepted candidate from the verified issuer+sub, never from
    a credential, and never from a caller-supplied field. */
export function isPrincipalSegment(value: unknown): value is string {
  return typeof value === "string" && /^p_[a-f0-9]{32}$/.test(value);
}

/** Legacy sha256-derived owner segment (32 lowercase hex, no prefix). */
export function isOwnerSegment(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value);
}

/** True when `value` is any acceptable server-derived ownership subject:
    a verified principal segment OR a legacy owner segment. */
export function isSubjectSegment(value: unknown): value is string {
  return isPrincipalSegment(value) || isOwnerSegment(value);
}

/** Strict ownership check for a server-derived subject: the key must be a
    stored media key AND carry a subject segment that exactly matches the
    supplied subject (principal segment or legacy owner segment). An
    empty/absent/unrecognisable subject never matches, so a legacy subjectless
    object cannot be claimed by a client-supplied value. */
export function isOwnedMediaKey(key: unknown, subject: string | undefined | null): boolean {
  if (!isSubjectSegment(subject)) return false;
  return keyBelongsToSubject(String(key ?? ""), subject);
}

/** A local render may only reference media this site already holds. This stops
    the PC being pointed at an arbitrary URL or path by a browser submission. */
function ownMediaReference(url: unknown, origin: string): string {
  const raw = String(url ?? "");
  if (!raw) return "";
  if (!raw.startsWith(origin + "/media/")) throw new Error("Reference media must come from this studio.");
  const key = raw.slice((origin + "/media/").length);
  if (!isMediaKey(key)) {
    throw new Error("Reference media must come from this studio.");
  }
  return raw;
}

/** The exact key shape the /media route will serve. Two segments: an ownership
    segment (either a verified per-person principal `p_<32hex>` when identity is
    ON, or a bare 32-hex owner segment when OFF) followed by an opaque object
    name (`[a-f0-9-]` id) and a known extension. The image/video/audio extension
    set matches what /api/upload is allowed to store, so nothing uploaded is
    left unreadable — the magic/type boundary is still enforced at upload time.
    No arbitrary extension is accepted here. */
export function isMediaKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    /^(p_[a-f0-9]{32}|[a-f0-9-]{1,64})\/[a-f0-9-]{1,64}\.(png|jpg|jpeg|webp|mp4|webm|mp3|wav|ogg)$/i.test(key)
  );
}

export function toLocalJob(value: any, origin: string, subject?: string): LocalJobRecord {
  let model;
  try {
    model = getModel(String(value?.model ?? ""));
  } catch {
    throw new Error("That model is not a local renderer.");
  }
  if (model.provider !== "local" || !PRESET_IDS[model.id]) {
    throw new Error("That model is not a local renderer.");
  }
  const preset = PRESET_IDS[model.id];
  if (typeof value?.prompt?.text !== "string" || !value.prompt.text.trim()) throw new Error("Enter a prompt.");
  const prompt = value.prompt.text.trim();
  if (prompt.length > MAX_PROMPT) throw new Error("Enter a prompt shorter than 4,000 characters.");

  // The authorized subject is stamped from the VERIFIED session by the caller,
  // never read from the submission body. A client-supplied subject is ignored.
  // When identity is ON the caller passes the VERIFIED principal segment
  // (`p_<32hex>`); when OFF it passes the legacy sha256 owner segment. BOTH are
  // accepted here so the stored subject is authoritative in either mode — a
  // `p_` subject must NOT be silently dropped.
  const stampedSubject = isSubjectSegment(subject) ? subject.toLowerCase() : undefined;

  const media: Record<string, any[]> = {};
  for (const [role, items] of Object.entries(value?.media ?? {})) {
    const max = model.roles[role as MediaRole];
    if (!max || !Array.isArray(items) || items.length > max) {
      throw new Error("These references are not supported by this local renderer.");
    }
    media[role] = items.map((item: any) => ({ id: String(item?.id ?? ""), url: ownMediaReference(item?.url, origin) }));
  }
  const settings = parseSettings(model, value?.settings ?? {});
  const plane: GenerationPlane = { model: model.id, prompt: { text: prompt }, media, settings };
  const startUrl = media.start?.[0]?.url;
  const graph = toComfyGraph(plane, preset, startUrl);

  return {
    id: crypto.randomUUID(),
    state: "queued",
    createdAt: Date.now(),
    model: model.id,
    prompt,
    graph,
    attempts: 0,
    ...(stampedSubject ? { subject: stampedSubject } : {}),
  };
}

/** The media keys a job references, so the caller can check each one is owned
    by the submitting subject before the job is queued. Same-origin is not
    enough: a same-origin URL to ANOTHER subject's object must be refused. */
export function referenceKeysOf(job: LocalJobRecord): string[] {
  const keys: string[] = [];
  for (const items of Object.values(job.graph ?? {})) {
    const url = (items as any)?.inputs?.witchcraft_reference_url;
    if (typeof url !== "string" || !url) continue;
    const marker = "/media/";
    const at = url.indexOf(marker);
    if (at < 0) continue;
    const key = url.slice(at + marker.length);
    if (isMediaKey(key)) keys.push(key);
  }
  // Also collect from the stored media record so a caller that validated the
  // plane directly (not only via the graph) is still covered.
  for (const items of Object.values((job as any).media ?? {}) as any[]) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const url = String(item?.url ?? "");
      const at = url.indexOf("/media/");
      if (at < 0) continue;
      const key = url.slice(at + "/media/".length);
      if (isMediaKey(key)) keys.push(key);
    }
  }
  return [...new Set(keys)];
}

/** Page through every job key. A single 200-item page would starve the queue
    once a studio accumulates more history than one page. */
export async function listAllJobKeys(media: R2Like): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const listed = await media.list({ prefix: JOB_PREFIX, limit: 200, cursor } as any);
    const objects = listed?.objects ?? [];
    for (const object of objects) keys.push(object.key);
    const truncated = (listed as { truncated?: boolean } | null)?.truncated;
    if (!truncated || !objects.length) break;
    const last = objects[objects.length - 1]?.key;
    if (!last || last === cursor) break;
    cursor = last;
  }
  return keys;
}

async function readJob(media: R2Like, id: string): Promise<{ job: LocalJobRecord; etag: string } | null> {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) return null;
  const obj = await media.get(JOB_PREFIX + id + ".json");
  if (!obj) return null;
  try {
    return { job: JSON.parse(await obj.text()) as LocalJobRecord, etag: obj.etag ?? "" };
  } catch {
    return null;
  }
}

/** The queue is the set of per-job objects, not a shared index file.
    A shared read/modify/write index can lose a concurrent enqueue or finish;
    listing per-job keys cannot. Ordering is by seq, then createdAt, then id. */
export async function readQueue(media: R2Like): Promise<string[]> {
  const entries: Array<{ id: string; seq: number; createdAt: number }> = [];
  for (const key of await listAllJobKeys(media)) {
    const id = key.slice(JOB_PREFIX.length).replace(/\.json$/i, "");
    const read = await readJob(media, id);
    if (!read) continue;
    // Terminal jobs are never offered for claiming.
    if (read.job.state === "completed" || read.job.state === "failed") continue;
    entries.push({ id, seq: Number(read.job.seq ?? 0), createdAt: Number(read.job.createdAt ?? 0) });
  }
  entries.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return entries.map((entry) => entry.id);
}

export async function enqueueLocalJob(media: R2Like, job: LocalJobRecord): Promise<LocalJobRecord> {
  const queue = await readQueue(media);
  if (queue.length >= MAX_QUEUE) throw new Error("The studio renderer queue is full. Try again shortly.");
  const stamped: LocalJobRecord = { ...job, seq: await nextSeq(media) };
  // Unconditional create of a brand new random key: nothing to race with.
  const written = await media.put(`${JOB_PREFIX}${stamped.id}.json`, JSON.stringify(stamped), {
    httpMetadata: { contentType: "application/json" },
  });
  if (!written) throw new Error("The studio could not queue that render. Try again.");
  return stamped;
}

async function nextSeq(media: R2Like): Promise<number> {
  let max = 0;
  for (const key of await listAllJobKeys(media)) {
    const read = await readJob(media, key.slice(JOB_PREFIX.length).replace(/\.json$/i, ""));
    const seq = Number(read?.job.seq ?? 0);
    if (seq > max) max = seq;
  }
  return max + 1;
}

/** Hand out at most one live job per PC. Claiming is a conditional R2 write, so
    two pollers racing for the same job cannot both win. */
export async function claimLocalJob(media: R2Like, owner: string): Promise<LocalJobRecord | null> {
  if (!/^[a-z0-9_-]{1,64}$/i.test(owner)) throw new Error("Invalid renderer owner id.");
  const now = Date.now();
  for (const id of await readQueue(media)) {
    const read = await readJob(media, id);
    if (!read) continue;
    const job = read.job;
    if (job.state === "completed" || job.state === "failed") continue;
    const leaseLive = typeof job.leaseUntil === "number" && job.leaseUntil > now;
    if (job.state !== "queued" && leaseLive) continue;
    // A job that has already burned its attempts fails observably rather than
    // looping forever.
    if ((job.attempts ?? 0) >= MAX_ATTEMPTS && !job.promptId) {
      await conditionalWrite(media, id, read.etag, { ...job, state: "failed", error: "The render failed repeatedly on the studio PC.", leaseUntil: undefined, owner: undefined });
      continue;
    }
    if (!read.etag) {
      // Without a version tag we cannot prove exclusivity, so we do NOT claim.
      // Failing closed is deliberate: it is not a licence to double-render.
      continue;
    }
    const claimed: LocalJobRecord = {
      ...job,
      state: "claimed",
      owner,
      claimedAt: now,
      leaseUntil: now + LEASE_MS,
      attempts: (job.attempts ?? 0) + 1,
      // Re-minted on every claim, so a lapsed lease cannot be revived by an old PC.
      leaseToken: crypto.randomUUID(),
    };
    const won = await conditionalWrite(media, id, read.etag, claimed);
    if (won) return won; // lost the race; move to the next job
  }
  return null;
}

/** Documented R2 conditional write: non-null result is the win, null is the
    lost race, and a lost race wrote nothing. */
async function conditionalWrite(
  media: R2Like,
  id: string,
  etag: string,
  next: LocalJobRecord,
): Promise<LocalJobRecord | null> {
  const result = await media.put(`${JOB_PREFIX}${id}.json`, JSON.stringify(next), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagMatches: etag },
  });
  return result ? next : null;
}

export async function renewLocalJobLease(
  media: R2Like,
  id: string,
  owner: string,
): Promise<LocalJobRecord | null> {
  const read = await readJob(media, id);
  if (!read || read.job.owner !== owner) return null;
  return conditionalWrite(media, id, read.etag, { ...read.job, leaseUntil: Date.now() + LEASE_MS });
}

export async function finishLocalJob(
  media: R2Like,
  id: string,
  patch: { state: "running" | "completed" | "failed" | "requeue"; progress?: number; error?: string; media?: LocalMedia[]; promptId?: string },
  expectedOwner?: string,
): Promise<LocalJobRecord | null> {
  const read = await readJob(media, id);
  if (!read) return null;
  const job = read.job;
  // Ownership and a live lease are both required; there is no unconditional
  // overwrite path.
  if (expectedOwner !== undefined) {
    if (job.owner !== expectedOwner) return null;
    const leaseLive = typeof job.leaseUntil === "number" && job.leaseUntil > Date.now();
    if (!leaseLive) return null;
  }
  const next: LocalJobRecord = {
    ...job,
    ...patch,
    // narrow the requeue pseudo-state to the real queued state
    state: patch.state === "requeue" ? "queued" : (patch.state as LocalJobRecord["state"]),
  };
  if (patch.progress === undefined) delete next.progress;
  if (patch.state === "completed" || patch.state === "failed" || patch.state === "requeue") {
    next.leaseUntil = undefined;
    next.owner = undefined;
    next.leaseToken = undefined;
    if (patch.state !== "completed") next.error = patch.error ?? job.error;
  }
  return conditionalWrite(media, id, read.etag, next);
}

/** Record the ComfyUI prompt id the first time it is known, so a PC restart
    re-attaches to the running render instead of submitting it twice. */
export async function attachPromptId(
  media: R2Like,
  id: string,
  owner: string,
  promptId: string,
): Promise<LocalJobRecord | null> {
  const read = await readJob(media, id);
  if (!read || read.job.owner !== owner) return null;
  if (read.job.promptId === promptId) return read.job;
  return conditionalWrite(media, id, read.etag, { ...read.job, promptId });
}

/** The exact media key schema the /media route serves, plus R2 metadata that
    ties the object to the job that produced it. When a subject is supplied the
    first path segment is that subject's segment (a verified `p_<32hex>`
    principal when identity is ON, or a sha256 `<32hex>` owner segment when OFF),
    so the /media route can authorize the read against the same subject. Without
    a subject the segment falls back to the sanitised job id (legacy callers and
    unit fixtures). */
export function mediaKeyFor(jobId: string, contentType: string, subjectSegment?: string): string {
  const ext = /video\/(mp4|webm)/.test(contentType) ? (/webm/.test(contentType) ? "webm" : "mp4")
    : /jpe?g/.test(contentType) ? "jpg"
    : "png";
  const ownerSegment =
    (isSubjectSegment(subjectSegment) ? subjectSegment.toLowerCase() : "") ||
    jobId.replace(/[^a-f0-9-]/gi, "").slice(0, 32) ||
    crypto.randomUUID().replace(/-/g, "").slice(0, 32);
  return `${ownerSegment}/${crypto.randomUUID()}.${ext}`;
}

export async function uploadLocalMedia(
  media: R2Like,
  id: string,
  file: { type: string; bytes: ArrayBuffer },
  origin: string,
  subjectSegment?: string,
): Promise<LocalMedia> {
  if (!file.bytes.byteLength) throw new Error("Empty upload.");
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("Rendered file is too large.");
  const key = mediaKeyFor(id, file.type, subjectSegment);
  const written = await media.put(key, file.bytes, {
    httpMetadata: { contentType: file.type },
    // `owner` is the authorization subject for /media; `job` still ties the
    // object to the exact job for completion verification.
    customMetadata: { source: "local-render", job: id, owner: key.split("/")[0] },
  });
  if (!written) throw new Error("The render could not be stored.");
  return {
    kind: /\.mp4$|\.webm$/i.test(key) ? "video" : "image",
    url: `${origin}/media/${key}`,
    key,
    bytes: file.bytes.byteLength,
    contentType: file.type,
  };
}

/** A completed job's media must be an object this site already stored FOR THIS
    JOB. Anything else is refused rather than silently published. */
export async function verifyJobUpload(
  media: R2Like,
  jobId: string,
  key: unknown,
): Promise<LocalMedia | null> {
  if (!isMediaKey(key)) return null;
  const object = await media.get(key);
  if (!object) return null;
  if ((object.customMetadata?.job ?? "") !== jobId) return null;
  const isVideo = /\.mp4$|\.webm$/i.test(key);
  const contentType = String(object.customMetadata?.contentType ?? (isVideo ? "video/mp4" : "image/png"));
  return {
    kind: isVideo ? "video" : "image",
    url: "",
    key,
    bytes: typeof object.size === "number" ? object.size : undefined,
    contentType,
  };
}

export async function recordHeartbeat(media: R2Like, owner: string, detail: Record<string, unknown>): Promise<void> {
  await media.put(
    HEARTBEAT_KEY,
    JSON.stringify({ owner, at: Date.now(), ...detail }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

export async function readHeartbeat(media: R2Like): Promise<{ online: boolean; ageMs: number; detail?: Record<string, unknown> }> {
  const obj = await media.get(HEARTBEAT_KEY);
  if (!obj) return { online: false, ageMs: Infinity };
  const value = (await obj.json<Record<string, unknown>>()) ?? {};
  const at = Number(value.at ?? 0);
  const ageMs = Date.now() - at;
  return { online: ageMs < 120000, ageMs, detail: value };
}

export function localStatusView(job: LocalJobRecord): {
  requestId: string;
  status: string;
  images?: Array<{ url: string }>;
  video?: { url: string };
  error?: string;
  progress?: number;
  /** Elapsed seconds the PC has reported for a running render. This is a true
      observation from the renderer, not an estimate converted to a percent. */
  elapsedSeconds?: number;
} {
  const requestId = LOCAL_PREFIX + job.id;
  if (job.state === "completed") {
    const images = (job.media ?? []).filter((m) => m.kind === "image").map((m) => ({ url: m.url }));
    const video = (job.media ?? []).find((m) => m.kind === "video");
    return {
      requestId,
      status: "completed",
      ...(images.length ? { images } : {}),
      ...(video ? { video: { url: video.url } } : {}),
    };
  }
  if (job.state === "failed") {
    return { requestId, status: "failed", error: job.error || "The render failed on the studio PC." };
  }
  return {
    requestId,
    status: job.state === "running" || job.state === "claimed" ? "in_progress" : "queued",
    ...(typeof job.progress === "number" ? { progress: job.progress } : {}),
  };
}

export { MAX_ATTEMPTS };
