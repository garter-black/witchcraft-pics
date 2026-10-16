import { browserLegacy, defaultKv, type Kv, type LegacyStore } from "./idb";
import { currentEpoch, epochCurrent, type WipeResult } from "@/generation/credential-scope";
import { runExclusive } from "@/generation/storage-boundary";
import type { Surface } from "@/generation/catalog";

export type RunStatus = "running" | "completed" | "failed";

export interface RunRecord {
  id: string;
  surface: Surface;
  modelId: string;
  modelLabel: string;
  prompt: string;
  /** CSS aspect-ratio value, e.g. "16 / 9" */
  ratio: string;
  meta: string;
  badge?: string;
  kind: "image" | "video";
  urls: string[];
  status: RunStatus;
  /** Platform request this row is waiting on. Set while status is running so a
      refresh can resume the poll; completed rows keep it for the same id. */
  requestId?: string;
  error?: string;
  /** Layered-gradient fallback used while media loads or when a run failed. */
  art: string;
  createdAt: number;
  /** Kept deliberately: shows in the Favorites scope and outlives the cap. */
  favorite?: boolean;
  /** Resolved catalog settings this run was submitted with, so reuse can
      restore the dials and not just the words. Absent on pre-existing records. */
  settings?: Record<string, unknown>;
}

export const HISTORY_KEY = "history.v1";
export const LEGACY_HISTORY_KEY = "openhiggsfield.history.v1";
const MAX_RECORDS = 60;

/* ---------- principal namespacing ----------

   When identity is ON, the run log must belong to the VERIFIED principal, not
   to the browser. Two Google accounts on one shared browser must never read
   each other's history. So a principal-carrying scope uses a per-principal key
   `history.v1.<p_...>`; the old generic `history.v1` key is LEGACY and is never
   adopted under a new principal. An anonymous session reads only the
   anonymous scope. A key for one principal is invisible to another. */

/** The IndexedDB key for a principal, or the anonymous key when there is none.
    `principal` MUST already be the verified `p_<32hex>` (see identity.ts); this
    function does not validate it, it namespaces by it. */
export function historyKeyFor(principal: string | undefined): string {
  return principal ? `${HISTORY_KEY}.${principal}` : HISTORY_KEY;
}

/** The legacy generic key — kept so a wipe removes any pre-namespacing row. */
export const LEGACY_GENERIC_HISTORY_KEY = HISTORY_KEY;

export async function loadHistory(
  kv: Kv = defaultKv(),
  legacy: LegacyStore | undefined = browserLegacy(),
  principal?: string,
): Promise<RunRecord[]> {
  const stored = await readIdb(kv, historyKeyFor(principal));
  // A principal-scoped read NEVER adopts the legacy generic localStorage copy:
  // that copy predates namespacing and cannot be attributed to this account.
  const fromLegacy = principal ? [] : readLegacy(legacy);
  if (stored.length === 0) return fromLegacy;
  if (fromLegacy.length === 0) return stored;
  return mergeHistory(stored, fromLegacy);
}

/* Writes are serialized through ONE ordered chain shared with the credential
   wipe (`@/generation/storage-boundary`). `saveHistory` awaits `kv.set` then
   writes the legacy copy; if a wipe ran between those two steps (or between a
   save's start and its IDB write) WITHOUT being serialized against the save,
   the save would recreate a readable row AFTER the logout. Two guards close
   that: (1) every save captures the credential epoch it began under and
   refuses to write anything if the epoch moved on, and (2) both the save AND
   every wipe are queued through the one `runExclusive` chain, so removal
   ordered after a save genuinely lands after it, never interleaved into it. */
export async function saveHistory(
  records: RunRecord[],
  kv: Kv = defaultKv(),
  legacy: LegacyStore | undefined = browserLegacy(),
  principal?: string,
): Promise<void> {
  const next = capHistory(records.filter(isRunRecord));
  // Capture the scope at the START. A save that began before a credential
  // change belongs to the previous scope and must not write under the new one.
  const startedAt = currentEpoch();
  // The write key is the PRINCIPAL-scoped key, so two accounts on one browser
  // never overwrite each other's log. A principal-scoped save does NOT write the
  // legacy generic localStorage copy (that copy cannot be attributed to an
  // account); only the anonymous scope keeps the legacy mirror.
  const key = historyKeyFor(principal);
  await runExclusive(async () => {
    if (!epochCurrent(startedAt)) return;
    try {
      await kv.set(key, next);
    } catch {
      /* private mode or a denied store */
    }
    if (principal) return; // never mirror a principal's log to the generic key
    // Re-check the epoch before the legacy copy: a wipe could have run during
    // the awaited IDB write, in which case this must not recreate the key.
    if (!epochCurrent(startedAt)) return;
    try {
      legacy?.setItem(LEGACY_HISTORY_KEY, JSON.stringify(next));
    } catch {
      /* quota or a denied store */
    }
  });
}

/** Remove every readable copy of the run log: the IndexedDB record, the double
    legacy localStorage key, and (best effort, after the record is gone) the
    whole history database. AWAITED and RELIABLE — this resolves only after the
    sensitive keys are removed synchronously and the IndexedDB record removal
    (the real guarantee) has committed; the database deletion is secondary and
    its blocked outcome is reported, never assumed. */
export async function wipeHistory(
  legacy: LegacyStore | undefined = browserLegacy(),
): Promise<WipeResult> {
  // Synchronous removals first (legacy key), then the awaited, reliable record
  // removal + honest database delete, all ordered behind any in-flight save.
  return runExclusive(async () => {
    try {
      legacy?.removeItem(LEGACY_HISTORY_KEY);
    } catch {
      /* a denied store */
    }
    const { wipeSensitiveBrowserState } = await import("@/generation/credential-scope");
    return wipeSensitiveBrowserState();
  });
}

/** Session rows win on id collision so a generate that landed before IDB
    finished reading is not wiped by the delayed load. */
export function mergeHistory(stored: RunRecord[], live: RunRecord[]): RunRecord[] {
  const byId = new Map<string, RunRecord>();
  for (const row of [...stored, ...live]) {
    const prev = byId.get(row.id);
    if (!prev || newerRecord(row, prev)) byId.set(row.id, row);
  }
  return capHistory([...byId.values()].sort((a, b) => b.createdAt - a.createdAt));
}

async function readIdb(kv: Kv, key: string): Promise<RunRecord[]> {
  try {
    const stored = await kv.get<unknown>(key);
    if (!Array.isArray(stored)) return [];
    return capHistory(stored.filter(isRunRecord));
  } catch {
    return [];
  }
}

function readLegacy(legacy: LegacyStore | undefined): RunRecord[] {
  if (!legacy) return [];
  try {
    const raw = legacy.getItem(LEGACY_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return capHistory(parsed.filter(isRunRecord));
  } catch {
    return [];
  }
}

/* The cap trims the run log, not the visitor's shelf: a favorite is a
   deliberate keep, so only unmarked runs age out of the window. */
export function capHistory(records: RunRecord[], max = MAX_RECORDS): RunRecord[] {
  if (records.length <= max) return records;
  let kept = 0;
  return records.filter(
    (record) => record.favorite === true || record.status === "running" || kept++ < max,
  );
}

export function requestIdOf(record: RunRecord): string {
  return record.requestId ?? record.id.split("#")[0]!;
}

/** Swap every row of a request for its terminal records, or no-op if the
    visitor already deleted the in-flight tiles. */
export function replaceRequest(
  records: RunRecord[],
  requestId: string,
  next: RunRecord[],
): RunRecord[] {
  if (!records.some((record) => record.status === "running" && requestIdOf(record) === requestId)) {
    return records;
  }
  return capHistory(
    [...next, ...records.filter((record) => requestIdOf(record) !== requestId)].sort(
      (a, b) => b.createdAt - a.createdAt,
    ),
  );
}

function newerRecord(row: RunRecord, prev: RunRecord): boolean {
  const rowDone = row.status !== "running";
  const prevDone = prev.status !== "running";
  if (rowDone !== prevDone) return rowDone;
  return row.createdAt >= prev.createdAt;
}

function isRunRecord(value: unknown): value is RunRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<RunRecord>;
  return (
    typeof record.id === "string" &&
    (record.surface === "image" || record.surface === "video") &&
    typeof record.prompt === "string" &&
    typeof record.ratio === "string" &&
    Array.isArray(record.urls) &&
    (record.status === "completed" ||
      record.status === "failed" ||
      (record.status === "running" && typeof record.requestId === "string")) &&
    typeof record.createdAt === "number" &&
    (record.requestId === undefined || typeof record.requestId === "string") &&
    (record.favorite === undefined || typeof record.favorite === "boolean") &&
    (record.settings === undefined ||
      (typeof record.settings === "object" && record.settings !== null))
  );
}

export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/* One step along the runs the visitor is actually looking at, or null at the
   ends — the walk stops there rather than wrapping, so the edge of the scope
   can be felt. A run that has left the list steps nowhere. */
export function stepRun(records: RunRecord[], id: string, delta: number): RunRecord | null {
  const from = records.findIndex((record) => record.id === id);
  if (from < 0) return null;
  return records[from + delta] ?? null;
}
