// worker/privacy/hosted-output.ts
// ============================================================================
// Trusted server-side privacy finalizer for ACTUAL normalized provider outputs.
// NOT a route. Consumes the studio's normalized GenerationStatus (see
// src/generation/platform.ts and worker/runpod.ts) and returns the SAME shape
// with every provider media URL replaced by a same-origin authenticated
// /api/library handle. The raw provider URL is NEVER returned — not on success,
// not on failure.
//
// WHO CALLS IT (backend-close writer owns the callsite):
//   After an AUTHENTICATED provider status call, once the requestId has passed
//   the owner-registry gate (`partitionStatusIds`), the caller invokes:
//
//     import { privatizeHostedStatus } from "./privacy/hosted-output";
//     const safe = await privatizeHostedStatus(env, segment, requestId, status);
//
//   `status` is the normalized GenerationStatus produced by trusted server code
//   from the provider response. `segment` is the VERIFIED `p_<32hex>` namespace.
//
// CONTRACT (frozen — backend-close imports it exactly once, HELPER-READY):
//   privatizeHostedStatus(
//     env: PrivacyEnv & { MEDIA: unknown; MIRROR_ALLOWLIST?: string[] | string },
//     verifiedSegment: string,           // p_<32hex>
//     requestId: string,                 // provider request id (rp:/hf_ ids ok)
//     status: HostedStatusLike,          // normalized GenerationStatus
//     opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number },
//   ): Promise<HostedStatusLike>
//
//   Returns the SAME status object shape. On success every `images[].url` and
//   `video.url` is a same-origin `/media/<p_segment>/<uuid>.<ext>` handle (the
//   canonical generated-reference contract the existing parsers / owned-URL
//   signing / poller already recognise — see worker/local-poll.ts isMediaKey).
//   The accepted mirror returns `/api/library/object/<key>`; we adapt that key
//   to `/media/<key>` ONLY after re-validating it as a stored `p_<32hex>/<name>`
//   media key, so an image/video produced here can be reused as an I2V
//   reference through the already-reviewed short-path / method-signed reference
//   flow. `/api/library/object` remains the own read/list API. When the
//   mirror cannot run (no allowlist / size / host / timeout / unsupported type)
//   the affected media slot(s) are REMOVED (omitted) and the status carries an
//   explicit `outputState` field — never a raw URL, never a silent passthrough.
//   `status`, `requestId`, and `error` are preserved exactly as given.
//
// OWNERSHIP: this function re-checks ownership through the ACCEPTED
// `resolveOutputUrl` (which calls `authorizeStatus`) before touching any stored
// output. It does not trust the caller's segment beyond that check, and it never
// reads a URL from a client body. There is NO public register/mirror oracle.
//
// MULTI-SLOT: the accepted registry row supports a single `outputUrl` slot. So
// trusted server code records the CANONICAL output list for a request in an
// internal validated store under the principal's namespace (`.outputs/<id>.json`,
// written by `recordOwnerOutputs`). This module reads that record and mirrors
// EACH slot independently, keyed by slot index, so multiple images / a video do
// not overwrite one another and never clobber the cached single-slot mirror
// receipt. When no multi-slot record exists it falls back to the accepted
// single-slot `resolveOutputUrl`.
//
// LIMITS — stated honestly, not hidden:
//   - Mirroring an output into our private R2 namespace does NOT delete the
//     provider-hosted original and does NOT stop someone who holds the SAME
//     provider credential from using that provider directly. It removes the raw
//     capability URL from OUR browser/history/render responses only.
//   - No upstream media deletion is performed or authorized here.
//   - No live provider retention or private-CDN guarantee is made.
//   - The allowlist must be set from verified evidence (see VERIFIED-HOSTS.md);
//     it is never guessed and never a wildcard.

import {
  resolveOutputUrl,
  partitionStatusIds,
  mirrorOnce,
  normalizeAllowlist,
  isLibraryKey,
  type PrivacyEnv,
} from "./index";
import { isMediaKey } from "../local-poll";
import { createHash } from "node:crypto";

/** Adopted per-object mirror cap: ~2x peak => ~64 MiB peak inside a 128 MiB
    isolate, leaving headroom. Distinct from the candidate's own 64 MiB constant,
    which we do not change. See VERIFIED-HOSTS.md (Cloudflare limits, read 3 Oct
    2026). */
export const MAX_MIRROR_BYTES_HARD = 32 * 1024 * 1024;

/** At most this many mirror copies per single privatize call/batch. Sequential,
    so resident buffers never multiply with the batch size. */
export const MAX_MIRRORS_PER_BATCH = 8;

/** Bound the whole fetch+redirect+body operation (mirrorOnce also bounds it). */
export const DEFAULT_MIRROR_TIMEOUT_MS = 15_000;

/** Content types the library key layout can name (mirrors candidate EXT map). */
const SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

/** The normalized output surface we accept (superset-safe: we ignore extras). */
export type HostedStatusLike = {
  status: string;
  requestId: string;
  images?: Array<{ url: string }>;
  video?: { url: string };
  error?: unknown;
  /** Added by this module. Never carries a raw provider URL. */
  outputState?: HostedOutputState;
};

export type HostedOutputState =
  | "mirrored"
  | "partial"
  | "unsupported"
  | "unavailable";

export type PrivatizeOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
};

/**
 * One canonical output slot as trusted server code records it: the URL exactly
 * as returned by the AUTHENTICATED provider status response, plus its type.
 */
export type CanonicalOutput = { url: string; contentType?: string };

/** Internal store layout: `.outputs/<requestId>.json` under the principal. */
function outputsKey(segment: string, requestId: string): string {
  return `${segment}/.outputs/${requestId}.json`;
}

type MediaLike = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
};

function asMedia(media: unknown): MediaLike {
  return media as MediaLike;
}

/** A record is well-formed only if it names the verifying segment + request. */
type StoredOutputs = { owner: string; requestId: string; outputs: CanonicalOutput[] };

function validStoredOutputs(value: unknown, segment: string, requestId: string): StoredOutputs | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.owner !== segment) return null;
  if (v.requestId !== requestId) return null;
  if (!Array.isArray(v.outputs)) return null;
  const outputs: CanonicalOutput[] = [];
  for (const item of v.outputs) {
    if (!item || typeof item !== "object") continue;
    const u = (item as Record<string, unknown>).url;
    if (typeof u !== "string" || u.length === 0) continue;
    const ct = (item as Record<string, unknown>).contentType;
    outputs.push({ url: u, ...(typeof ct === "string" && ct ? { contentType: ct } : {}) });
  }
  return outputs.length ? { owner: segment, requestId, outputs } : null;
}

/**
 * Record the CANONICAL output list for a request from trusted server code.
 * MUST be called only with URLs taken from the AUTHENTICATED provider status
 * response for `requestId` — never from a client body. Ownership is re-checked
 * against the registry before writing. NOT routable.
 *
 * @returns {ok:true} on write, or {ok:false,reason} (no throw, no oracle).
 */
export async function recordOwnerOutputs(
  env: PrivacyEnv & { MEDIA: unknown },
  segment: string,
  requestId: string,
  outputs: CanonicalOutput[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isPrincipalSegment(segment)) return { ok: false, reason: "bad_segment" };
  if (typeof requestId !== "string" || requestId.length === 0) return { ok: false, reason: "bad_request_id" };
  // Ownership gate: authorize against the stored registry row via the accepted
  // `partitionStatusIds`/`authorizeStatus` path — a TRUE ownership check that is
  // independent of whether a single-slot outputUrl has been recorded yet. (Do
  // NOT use `resolveOutputUrl` here: it returns null both for a foreign/unknown
  // id AND for a legitimately-owned row with no single-slot output, which would
  // wrongly reject the first multi-slot record.)
  const decisions = await partitionStatusIds(env.MEDIA, [requestId], segment);
  if (!decisions[0] || !decisions[0].allowed) return { ok: false, reason: "foreign_or_unknown_request" };
  const clean = outputs
    .filter((o) => o && typeof o.url === "string" && o.url.length > 0)
    .slice(0, MAX_MIRRORS_PER_BATCH)
    .map((o) => ({ url: String(o.url).slice(0, 2048), ...(o.contentType ? { contentType: String(o.contentType).slice(0, 128) } : {}) }));
  if (clean.length === 0) return { ok: false, reason: "no_outputs" };
  const media = asMedia(env.MEDIA);
  await media.put(
    outputsKey(segment, requestId),
    JSON.stringify({ owner: segment, requestId, outputs: clean }),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { owner: segment, job: requestId, source: "outputs" },
    },
  );
  return { ok: true };
}

function isPrincipalSegment(segment: unknown): boolean {
  return typeof segment === "string" && /^p_[0-9a-f]{32}$/.test(segment);
}

// --- error sanitisation -----------------------------------------------------
// The provider error field is arbitrary and MUST NOT be echoed verbatim: a raw
// provider error string/object can carry a capability URL, a signed link, or a
// secret in a nested field. We never return the raw value. We keep a USEFUL but
// generic error: the status, a stable code if the provider gave one, and a
// fixed human-readable fallback. Any string that looks like a URL (with or
// without a scheme), or that embeds an allowlisted/provider host or a query
// string, is dropped rather than echoed.

/** Matches "scheme://…" as well as bare "host.tld/…" capability-style links. */
const URL_LIKE_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}(?::\d+)?\/)/i;

/** A conservative stable code: short, single token, no URL/space/query marks. */
const SAFE_CODE_RE = /^[a-z][a-z0-9_]{2,63}$/i;

function sanitizeErrorField(value: unknown): string | undefined {
  if (value === undefined) return undefined;

  // A STRING provider error: NEVER retained verbatim. A freeform provider string
  // can carry a capability URL, a bare two-label host/path (example.com/x?t=y),
  // a signed query, or a secret in prose — and a shape-check cannot prove a
  // freeform sentence is safe. Retain the value ONLY when it is a SHORT, single,
  // stable token (a strict SAFE_CODE_RE code with no URL/space/query marks);
  // otherwise fall back to the generic message. The earlier shape-only check let
  // an ordinary two-label host/path through, contradicting the no-raw-URL
  // guarantee, so this branch now defaults closed.
  if (typeof value === "string") {
    const s = value.trim();
    if (s.length > 0 && SAFE_CODE_RE.test(s) && !URL_LIKE_RE.test(s) && !/https?:\/\//i.test(s)) {
      return s;
    }
    return "Provider request failed.";
  }

  // An object/array provider error: NEVER spread it (nested URL-bearing fields
  // would leak). Extract at most a stable `code`/`error` token if it is safe,
  // then stop. Everything else becomes the generic message.
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of ["code", "error", "errorCode", "type"]) {
      const candidate = rec?.[key];
      if (typeof candidate === "string") {
        const s = candidate.trim();
        if (SAFE_CODE_RE.test(s) && !URL_LIKE_RE.test(s)) return s;
      }
    }
    return "Provider request failed.";
  }

  // numbers/booleans/null: not useful as an error, drop to generic.
  return "Provider request failed.";
}

/** Resolve the canonical output list for a request: the multi-slot record if
    present and well-formed, else the accepted single-slot `resolveOutputUrl`.
    The registry ownership gate (`partitionStatusIds`/`authorizeStatus`) MUST run
    BEFORE we read the internal `.outputs` record — a stale or foreign record is
    never trusted just because its own `owner` field happens to match. */
async function resolveCanonicalOutputs(
  env: PrivacyEnv & { MEDIA: unknown },
  segment: string,
  requestId: string,
): Promise<CanonicalOutput[]> {
  // Ownership recheck FIRST, before any internal record read or output fetch.
  // A foreign/unknown request id is refused here even if a matching `.outputs`
  // record somehow exists under this namespace.
  const decisions = await partitionStatusIds(env.MEDIA, [requestId], segment);
  if (!decisions[0] || !decisions[0].allowed) return [];

  const media = asMedia(env.MEDIA);
  const obj = await media.get(outputsKey(segment, requestId));
  if (obj) {
    try {
      const raw = typeof (obj as { json?: unknown }).json === "function"
        ? await (obj as { json(): Promise<unknown> }).json()
        : JSON.parse(await (obj as { text(): Promise<string> }).text());
      const valid = validStoredOutputs(raw, segment, requestId);
      if (valid) return valid.outputs;
    } catch {
      // fall through to single-slot
    }
  }
  const single = await resolveOutputUrl(env.MEDIA, requestId, segment);
  if (single && single.url) return [{ url: single.url, ...(single.contentType ? { contentType: single.contentType } : {}) }];
  return [];
}

function normalizeType(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = String(raw).split(";")[0].trim().toLowerCase();
  return SUPPORTED_TYPES.has(t) ? t : null;
}

/**
 * A bounded, stable slot identity derived from the CANONICAL URL (never the raw
 * URL itself) so the mirror receipt key is independent of ordering. Reordering
 * the same set of outputs between polls yields the SAME receipt per URL, so a
 * cached handle always corresponds to the URL byte-for-byte — a reorder can
 * never swap one slot's cached media/type onto another. Bounded to 32 hex chars.
 */
function slotDigest(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/**
 * Mirror ONE slot into the principal's namespace, keyed by a stable digest of
 * the canonical URL so slots never collide AND reorder never swaps a cached
 * handle. Returns the same-origin handle, or a fail-closed reason.
 */
async function mirrorSlot(
  env: PrivacyEnv & { MEDIA: unknown },
  segment: string,
  requestId: string,
  slot: CanonicalOutput,
  allowlist: string[],
  opts: PrivatizeOptions,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const job = `${requestId}#${slotDigest(slot.url)}`;
  const result = await mirrorOnce(
    env.MEDIA,
    segment,
    { upstreamUrl: slot.url, contentType: slot.contentType || "", job },
    {
      allowlist,
      maxBytes: opts.maxBytes ?? MAX_MIRROR_BYTES_HARD,
      timeoutMs: opts.timeoutMs ?? DEFAULT_MIRROR_TIMEOUT_MS,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    },
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  // Defence in depth: the mirror must yield a stored personal-library key. We
  // adapt it to the canonical /media/<key> reference handle ONLY after
  // re-validating it as a stored media key whose shape the /media route (and
  // the existing parsers/signing/poller) accept. If it ever did not, we drop the
  // slot rather than emit anything raw or unvalidated.
  if (typeof result.key !== "string" || !isLibraryKey(result.key)) {
    return { ok: false, reason: "bad_handle" };
  }
  if (!isMediaKey(result.key)) {
    // A well-formed library key that the /media schema would not serve: fail
    // closed rather than emit a handle the reference parsers cannot use.
    return { ok: false, reason: "bad_handle" };
  }
  return { ok: true, url: "/media/" + result.key };
}

/**
 * THE FROZEN INTERFACE. See the file header for the full contract.
 */
export async function privatizeHostedStatus(
  env: PrivacyEnv & { MEDIA: unknown },
  verifiedSegment: string,
  requestId: string,
  status: HostedStatusLike,
  opts: PrivatizeOptions = {},
): Promise<HostedStatusLike> {
  // Preserve the immutable envelope exactly; never mutate the caller's object.
  const base: HostedStatusLike = {
    status: status?.status,
    requestId: status?.requestId ?? requestId,
  };
  if (status && "error" in status && status.error !== undefined) {
    // SANITISED: the provider error field may carry a capability URL or a
    // secret in a nested field. We never echo it verbatim — a useful generic
    // error (optionally a stable code) replaces it.
    const safe = sanitizeErrorField(status.error);
    if (safe !== undefined) base.error = safe;
  }

  // Nothing to privatize: no media slots at all (queued / in_progress / failed).
  const hasImages = Array.isArray(status?.images) && status.images.length > 0;
  const hasVideo = !!(status?.video && typeof status.video.url === "string");
  if (!hasImages && !hasVideo) return base;

  // Fail closed on unconfigured identity/allowlist: explicit unsupported, no
  // raw URL passthrough. This mirrors the accepted mirror's fail-closed default.
  if (!isPrincipalSegment(verifiedSegment)) {
    return { ...base, outputState: "unsupported" };
  }
  const allowlist = normalizeAllowlist(env.MIRROR_ALLOWLIST);
  if (allowlist.length === 0) {
    return { ...base, outputState: "unsupported" };
  }

  // Re-check ownership through the ACCEPTED resolver before touching storage.
  // A foreign/unknown id (or one with no recorded canonical output) => refuse.
  const stored = await resolveCanonicalOutputs(env, verifiedSegment, requestId);
  if (stored.length === 0) {
    return { ...base, outputState: "unavailable" };
  }

  // Match each PRESENT status slot to its canonical output BY URL. The status
  // carries the provider URL that trusted server code recorded, so the URL is
  // the stable key that pairs a slot with its own canonical entry regardless of
  // whether the recorded list and the status list are ordered differently. A
  // slot whose URL was not recorded (or a foreign URL) has no canonical entry
  // and fails closed. Each matched slot is mirrored under a DISTINCT key.
  const byUrl = new Map<string, CanonicalOutput>();
  for (const s of stored) byUrl.set(s.url, s);

  const slotPlan: Array<{ kind: "video" | "image"; index: number; slot: CanonicalOutput | undefined }> = [];
  if (hasVideo) slotPlan.push({ kind: "video", index: -1, slot: byUrl.get(status.video!.url) });
  if (hasImages) {
    for (let i = 0; i < status.images!.length; i++) {
      slotPlan.push({ kind: "image", index: i, slot: byUrl.get(status.images![i].url) });
    }
  }

  const boundedPlan = slotPlan.slice(0, MAX_MIRRORS_PER_BATCH);
  const results: Array<{ ok: true; url: string } | { ok: false; reason: string }> = [];
  for (let i = 0; i < boundedPlan.length; i++) {
    const plan = boundedPlan[i];
    if (!plan.slot) {
      // Not recorded (or a client-supplied/foreign URL): fail this slot closed.
      results.push({ ok: false, reason: "no_canonical_slot" });
      continue;
    }
    const type = normalizeType(plan.slot.contentType);
    if (plan.slot.contentType && !type) {
      // A recorded but unsupported content type: explicit fail closed.
      results.push({ ok: false, reason: "unsupported_type" });
      continue;
    }
    // Sequential: await each mirror so at most ~2 buffers are resident. The key
    // is derived from a stable digest of the slot's own canonical URL so
    // distinct slots never share a handle AND a reorder cannot swap a cached one.
    results.push(await mirrorSlot(env, verifiedSegment, requestId, plan.slot, allowlist, opts));
  }

  const okCount = results.filter((r) => r.ok).length;
  if (okCount === 0) {
    // Every present slot failed closed. No raw URLs, no empty url fields.
    return { ...base, outputState: "unavailable" };
  }

  // Rebuild the SAME shape by re-walking the SAME plan order (video first, then
  // images). A failed slot is OMITTED, never emitted raw.
  const out: HostedStatusLike = { ...base };
  let idx = 0;
  if (hasVideo) {
    const r = results[idx++];
    if (r && r.ok) out.video = { url: r.url };
  }
  if (hasImages) {
    const imgs: Array<{ url: string }> = [];
    for (let i = 0; i < status.images!.length; i++) {
      const r = results[idx++];
      if (r && r.ok) imgs.push({ url: r.url });
    }
    if (imgs.length) out.images = imgs;
  }
  out.outputState = okCount === boundedPlan.length ? "mirrored" : "partial";
  return out;
}
