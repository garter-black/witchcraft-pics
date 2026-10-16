// worker/privacy/mirror-finalize.ts
// ============================================================================
// Trusted server-side finalize step for HOSTED outputs. NOT a route.
//
// WHY THIS FILE EXISTS (the completion wiring the root review names):
//   The live studio returns the provider's raw output URL to the browser. There
//   is no private copy under the verified person's namespace. This step fetches
//   the CANONICAL provider output ONCE, from a VERIFIED configured host, stores
//   it under p_<principal32>/, and returns only an authenticated same-origin
//   handle. The raw upstream URL is never returned.
//
// RESOURCE CONTRACT (root review, 3 Oct 2026 — HARD):
//   - Downloads are BOUNDED and SEQUENTIAL (or proven-safe low concurrency).
//     This module runs ONE job at a time and is NEVER called from the batch
//     /api/status Promise.all, so up to 16 full-size media buffers are never
//     resident at once.
//   - The accepted candidate's mirror buffers chunks PLUS a contiguous copy, so
//     its peak is ~2x the object size. With a 128 MiB Worker isolate that caps a
//     single mirror far below 64 MiB in practice. `MAX_MIRROR_BYTES_HARD` below
//     is the number we actually adopt for the live path, chosen to keep the
//     worst-case peak inside budget. (Verify current Cloudflare limits before
//     changing it: Workers memory is 128 MiB; R2/streaming ops have their own
//     bounds.)
//   - A missing/empty MIRROR_ALLOWLIST is an EXPLICIT FAIL-CLOSED unsupported
//     state. It NEVER falls back to the raw provider URL.
//
// The mirror decisions (checksum-free, historical-evidence-only) are:
//   (1) the caller must OWN the registry row (verified principal == row.subject)
//   (2) the canonical URL must be recorded on the row by trusted server code
//       from the AUTHENTICATED provider status response — never a client body
//   (3) the URL host must be on the VERIFIED allowlist
// If any is unmet the step returns a typed unsupported/unavailable result.

import { resolveOutputUrl, mirrorOnce, normalizeAllowlist, type PrivacyEnv } from "./index";

/** The adopted per-object mirror cap. ~2x peak => 64 MiB object ≈ 128 MiB peak.
    Keep this at 32 MiB (≈64 MiB peak) to leave headroom for the isolate's other
    work. This is a LIVE-path resource decision, distinct from the candidate's
    own 64 MiB constant. */
export const MAX_MIRROR_BYTES_HARD = 32 * 1024 * 1024;

export type MirrorFinalizeResult =
  | { ok: true; url: string; cached: boolean }
  | { ok: false; state: "unsupported"; reason: "allowlist_unconfigured" }
  | { ok: false; state: "not_owned" }
  | { ok: false; state: "no_canonical_output" }
  | { ok: false; state: "unavailable"; reason: string };

/**
 * Mirror ONE owned hosted job's canonical output. Sequential by contract: call
 * this in a loop (await each), never inside Promise.all over many ids.
 *
 * @param env      privacy env (MEDIA, MIRROR_ALLOWLIST, identity)
 * @param segment  the caller's VERIFIED `p_<principal32>` namespace
 * @param job      the provider request id
 * @param fetchImpl optional bounded fetch injection (offline tests only)
 */
export async function finalizeOwnedMirror(
  env: PrivacyEnv & { MEDIA: unknown },
  segment: string,
  job: string,
  fetchImpl?: typeof fetch,
): Promise<MirrorFinalizeResult> {
  const allowlist = normalizeAllowlist(env.MIRROR_ALLOWLIST);
  if (allowlist.length === 0) {
    // EXPLICIT FAIL-CLOSED: no verified output host configured => unsupported.
    // The caller must NOT substitute the raw provider URL.
    return { ok: false, state: "unsupported", reason: "allowlist_unconfigured" };
  }
  // Ownership is re-checked against the STORED registry row (never the body).
  const canonical = await resolveOutputUrl(env.MEDIA, job, segment);
  if (canonical === null) {
    // Either the id is foreign/unknown, or no canonical URL was recorded yet.
    return { ok: false, state: "no_canonical_output" };
  }
  const result = await mirrorOnce(
    env.MEDIA,
    segment,
    { upstreamUrl: canonical.url, contentType: canonical.contentType || "", job },
    { allowlist, maxBytes: MAX_MIRROR_BYTES_HARD, ...(fetchImpl ? { fetchImpl } : {}) },
  );
  if (!result.ok) {
    // A size/timeout/host refusal is an explicit unavailable state — still no
    // raw-URL fallback.
    return { ok: false, state: "unavailable", reason: result.reason };
  }
  return { ok: true, url: result.url, cached: result.cached };
}

/**
 * Sequential finalize over a bounded list of owned jobs. ONE at a time, so the
 * peak resident output buffers never multiply with the batch size. Returns a
 * per-job result map. Bounded by MAX_MIRROR_JOBS.
 */
export const MAX_MIRROR_JOBS = 8;

export async function finalizeOwnedMirrorsSequential(
  env: PrivacyEnv & { MEDIA: unknown },
  segment: string,
  jobs: string[],
  fetchImpl?: typeof fetch,
): Promise<Record<string, MirrorFinalizeResult>> {
  const out: Record<string, MirrorFinalizeResult> = {};
  const bounded = jobs.slice(0, MAX_MIRROR_JOBS);
  for (const job of bounded) {
    // Await EACH: no parallel buffers. This is the resource contract.
    out[job] = await finalizeOwnedMirror(env, segment, job, fetchImpl);
  }
  return out;
}
