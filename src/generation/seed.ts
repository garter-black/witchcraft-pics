/** The UI's -1 sentinel means a new seed for each submitted graph.
 * Resolve it once, before the graph is queued, so retries reuse that graph.
 * Keep the range within the catalog's exact, browser-safe integer domain. */
export const MAX_SEED = 2147483647;

export function resolveComfySeed(seed: number): number {
  if (Number.isFinite(seed) && seed >= 0) return Math.min(MAX_SEED, Math.floor(seed));
  return crypto.getRandomValues(new Uint32Array(1))[0]! & MAX_SEED;
}
