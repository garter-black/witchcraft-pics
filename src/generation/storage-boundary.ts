/* The single ordered async boundary for storage mutations.

   WHY THIS EXISTS: the history save chain and the credential wipe are two
   independent async operations over the SAME browser stores (the IndexedDB
   history record and the legacy localStorage copy). If a save is in flight when
   a wipe runs, and they are not serialized against each other, the save's tail
   can recreate a readable row AFTER the logout — the exact defect the wipe
   exists to prevent. Previously the save chain lived in `history.ts` while the
   mutation boundary called the wipe directly, so a wipe started at the boundary
   was NOT ordered behind an in-flight save.

   This is a LEAF module: it imports nothing from `history.ts` or
   `credential-scope.ts`, so both can depend on it without a cycle. Every
   storage mutation — a history save, a history wipe, and the wipe the mutation
   boundary runs — is queued through the one `runExclusive` chain, so a wipe
   ordered after a save genuinely lands after it, and a save ordered after a
   wipe genuinely lands after that.

   The chain never rejects the queue itself: an individual work item's failure
   is returned to its own caller, while the shared chain is kept alive so one
   failed write cannot wedge every later mutation. */

let chain: Promise<void> = Promise.resolve();

/** Run `work` only after every operation already queued has settled (resolved
    OR rejected). Returns the work's own result/failure to its caller; the
    shared chain is kept alive regardless of that outcome. */
export function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work);
  chain = next.then(
    () => {},
    () => {},
  );
  return next;
}

/** Await the tail of the chain without queuing new work. Used by a caller that
    needs to know the boundary has fully drained (e.g. a test, or a logout that
    must not resolve before the last queued removal has committed). */
export function barrier(): Promise<void> {
  return chain;
}
