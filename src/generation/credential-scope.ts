import { stopWatching } from "@/generation/poll";

/* Credential-change cleanup.

   A credential session is a storage scope, not a person: when the visitor
   clears or replaces a provider key, the previous session's loaded runs, media
   references and in-flight work must not remain readable on this device. The
   server already scopes media by subject; this closes the same gap in the
   browser.

   The problem this solves is not "clear the list" — a late async result (a
   history load that started before the switch, or a poll that settles after it)
   would repopulate history with the previous scope. A monotonically increasing
   epoch is bumped on every credential change; every async callback captures the
   epoch it began under and refuses to write if the epoch has moved on.

   RELIABILITY, not a request that lies: IndexedDB `deleteDatabase` can be
   BLOCKED by another tab and never complete. So the guarantee is the removal of
   the history RECORD itself — open a connection we own, delete the single key
   and await the transaction commit. That removes the readable row even while
   another tab holds the database open. Wholesale database deletion is a
   secondary, best-effort step whose `blocked` outcome is REPORTED, never
   claimed as success. */

let epoch = 0;

/** The current cleanup epoch. Bumped on every credential change. */
export function currentEpoch(): number {
  return epoch;
}

/** True when a callback that began under `startedAt` is still current. A
    callback that fails this check must discard its result and not write. */
export function epochCurrent(startedAt: number): boolean {
  return startedAt === epoch;
}

/** Everything sensitive the studio keeps in the browser. Kept in one place so a
    new store is added here rather than forgotten at the logout boundary.

    NOTE on what is NOT here: `openhiggsfield.active.v2` (surface/model/batch)
    and `openhiggsfield.settings.v1` (per-model dials) are NOT credential
    material and are deliberately preserved across a switch — they carry no
    prompt, media or reference, and resetting them would fight the visitor's own
    choices. The value of a prompt/media key IS credential material. */
const SENSITIVE_KEYS = [
  "openhiggsfield.imageMedia.v1",
  "openhiggsfield.videoMedia.v1",
  "openhiggsfield.imagePrompt.v1",
  "openhiggsfield.videoPrompt.v1",
];

const LEGACY_KEYS = ["openhiggsfield.history.v1"];

/** The IndexedDB database + record key that hold the run log. Kept here so the
    wipe owns the one record it must remove. */
const HISTORY_DB = "openhiggsfield";
const HISTORY_KEY = "history.v1";

/** Outcome of a credential-scope wipe, reported honestly. */
export type WipeResult = {
  /** The epoch this wipe established. */
  epoch: number;
  /** True when the readable history record was removed (or there was none). */
  recordRemoved: boolean;
  /** True when the whole history database was actually deleted. */
  databaseDeleted: boolean;
  /** True when a whole-database delete was requested but blocked by another
      open context. The record is gone regardless; this says the database
      itself remains. */
  databaseBlocked: boolean;
  /** A real, reportable failure — the record could not be confirmed removed. */
  error?: string;
};

/** Bump the epoch and run the SYNCHRONOUS browser-side removals: stop every
    poll/watch and drop the sensitive localStorage keys. Returns the bumped
    epoch. The IndexedDB record needs an await, so it is removed by
    `wipeSensitiveBrowserState()` (below), which the mutation boundary awaits. */
export function wipeClientState(): number {
  epoch += 1;
  // Stop every poll/watch bound to the previous credential scope.
  stopWatching();
  try {
    if (typeof localStorage !== "undefined") {
      for (const key of [...SENSITIVE_KEYS, ...LEGACY_KEYS]) localStorage.removeItem(key);
    }
  } catch {
    /* private mode or a denied store */
  }
  return epoch;
}

/** The awaited, reliable wipe the mutation boundary calls. It bumps the epoch,
    clears the synchronous surfaces, AWAITS removal of the history record (the
    real guarantee), then attempts whole-database deletion and reports precisely
    what happened.

    A `blocked` database delete is reported as blocked — never as success — and
    is NOT treated as a failure of the wipe, because the readable record is
    already gone. A failure to remove the record IS surfaced in `error` so the
    caller can report it rather than hide it. A record that could not be removed
    leaves a readable row, so the caller must treat `error` (or
    `recordRemoved === false`) as a real failure to be reported. */
export async function wipeSensitiveBrowserState(): Promise<WipeResult> {
  const bumped = wipeClientState();
  return completeScopeRemoval(bumped);
}

/** The AWAITED half of the wipe: remove the history record (the real
    guarantee), then attempt whole-database deletion and report what happened.
    Split from `wipeSensitiveBrowserState` so a caller can run the SYNCHRONOUS
    scope invalidation (`wipeClientState`: epoch bump, stopWatching, key removal)
    IMMEDIATELY — invalidating every in-flight async callback the moment the
    boundary is reached — and only THEN queue this awaited storage removal. */
export async function completeScopeRemoval(bumped: number, preservePrincipal?: string): Promise<WipeResult> {
  let recordRemoved = true;
  let databaseDeleted = false;
  let databaseBlocked = false;
  let error: string | undefined;
  // A VALIDATED preserve-principal must match the verified p_<32hex> shape; an
  // unvalidated value is ignored so a caller can never retain an arbitrary key.
  const preserveKey =
    typeof preservePrincipal === "string" && /^p_[0-9a-f]{32}$/.test(preservePrincipal)
      ? `${HISTORY_KEY}.${preservePrincipal}`
      : undefined;

  try {
    const { removeHistoryRecord, deleteDatabaseReliably, closeHistoryDatabase } = await import(
      "@/openhiggsfield/idb"
    );
    // Close our own handles first so our own connection is not the thing that
    // blocks the delete. Other contexts are not ours to close.
    await closeHistoryDatabase();
    try {
      const { removeHistoryRecord, listHistoryKeys } = await import("@/openhiggsfield/idb");
      const keys = await listHistoryKeys();
      const sensitive = keys.filter(
        (k) =>
          (k === HISTORY_KEY || k.startsWith(`${HISTORY_KEY}.`)) &&
          // Retain ONLY the newly verified principal's own namespaced row; the
          // unscoped generic key and every OTHER principal's key still go.
          k !== preserveKey,
      );
      const targets = sensitive.length > 0 ? sensitive : [HISTORY_KEY];
      let allRemoved = true;
      for (const key of targets) {
        try {
          const removed = await removeHistoryRecord(key);
          if (!removed) allRemoved = false;
        } catch (caught) {
          allRemoved = false;
          error = caught instanceof Error ? caught.message : String(caught);
        }
      }
      recordRemoved = allRemoved;
    } catch (caught) {
      recordRemoved = false;
      error = caught instanceof Error ? caught.message : String(caught);
    }
    // Secondary, best-effort whole-DB delete. When retaining a principal's own
    // row, the whole-DB delete WOULD drop it, so it is skipped; the retained row
    // is a deliberate keep, not a blocked delete.
    if (!preserveKey) {
      const outcome = await deleteDatabaseReliably(HISTORY_DB);
      databaseDeleted = outcome.deleted;
      databaseBlocked = outcome.blocked;
    }
  } catch (caught) {
    // A shim without the idb helpers, or a denied store: there is no IndexedDB
    // record to remove in that environment.
    error ??= caught instanceof Error ? caught.message : undefined;
  }

  return { epoch: bumped, recordRemoved, databaseDeleted, databaseBlocked, error };
}

/** Delete the sensitive history record and the (history-only) database without
    hanging. Thin wrapper kept for callers that only need the promise. */
export async function wipeHistoryStore(): Promise<void> {
  await wipeSensitiveBrowserState();
}

/** The zustand stores whose in-memory state must be reset when the credential
    scope changes. Imported lazily so this module stays free of React. Media and
    prompt stores hold the sensitive values (generated media URLs and the words
    that produced them); active/settings hold model dials and are preserved. */
export async function resetPersistentStores(): Promise<void> {
  const [{ useImageMedia, useVideoMedia }, { useImagePrompt, useVideoPrompt }] = await Promise.all([
    import("@/generation/stores/media"),
    import("@/generation/stores/prompt"),
  ]);
  useImageMedia.setState({ items: [] });
  useVideoMedia.setState({ items: [] });
  useImagePrompt.setState({ text: "" });
  useVideoPrompt.setState({ text: "" });
}