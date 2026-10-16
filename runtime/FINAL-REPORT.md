# FINAL QA REPORT — Witchcraft Studio (H3 / prompt enhancer)

Runtime: Hermes/NIM DeepSeek V4.1 Flash, fixed key slot1. Session: witchcraft-oct1-runtime.
Repo: C:/Hecate-Umbra/Projects/witchcraft-studio — branch codex/witchcraft-studios.
Scope: worker/*, src/generation/h3.ts, catalog/h3.ts, local-input.ts and backend H3 tests only.
Frontend owned by another worker; not edited.

## Actual results (genuine exit codes)

- `npm test` → **TEST_EXIT=0**, 68 tests, 68 pass, 0 fail. Full output: `runtime/final-test.log`.
- `npm run build` → **BUILD_EXIT=0** (tsc -p tsconfig.studio.json && vite build, 18.03s, 126 modules).

Build was run AFTER the last product-code change and passed; only test files changed
afterwards, so no repeat build was required.

## Product change (owned)

`worker/planner.ts`
- Removed the UNUSED `resolveModelCapabilities()` function, which referenced undeclared
  `ModelEntry` / `getModel` and was the cause of the build failure
  (`TS2304: Cannot find name 'ModelEntry' / 'getModel'`). It is not called by
  `enhancerUserMessage` and is outside this feature's contract; the whole catalog is NOT
  imported into the worker to justify it.
- Removed the unused, inaccurate `ENHANCER_CAPABILITIES` "verified capabilities" constant.
- Corrected the `ENHANCE_CRAFT_AXES` comment to truthful scope. No behaviour change:
  `/api/enhance` outbound JSON already carried the exact `request.prompt` (whitespace
  intact), model id, surface, mode, preset, duration and constraints. `/api/plan` unchanged.

## Test corrections (current behaviour, not the removed local fallback)

`tests/h3.test.ts`
- Import switched from `buildEnhancement` (never existed on current planner) to the real
  `enhanceWithAgent`.
- Replaced the two stale local-fallback tests with real mock-fetch tests:
  `enhanceWithAgent` forwards the EXACT original prompt (whitespace intact) as DATA, plus
  model/surface/mode/preset/duration/constraints; and reports provider / missing-key /
  empty / malformed / HTTP-401 / HTTP-500 / network / timeout failures as failures — never
  a fabricated success.
- I2V now asserts the real bridge: `LoadImage` node 17 carries the reference marker and its
  IMAGE output is linked as `MiniMaxH3ImageToVideo.first_frame` (`["17",0]`); the marker is
  NOT on node 7. T2V asserts no `LoadImage` and no `first_frame`.
- Frame-grid: `h3FrameLength(24) === 39` (rounds UP); added `h3FrameLength(20) === 22`.
  Production rounding NOT changed to appease stale tests.
- Enhancer duration validation loosened to 1..120 for the TEXT enhancer (30s accepted;
  0 and 121 rejected); preserved whitespace verified. H3 GPU duration remains integer 2..5.
- Parser test updated to current (no substring requirement): a legitimate rewrite is
  accepted with the exact original preserved; non-JSON, missing prompt and blank prompt
  are refused.
- `/api/enhance` endpoint test now asserts a truthful `ok:false` with a real reason and no
  fabricated prompt (test env has no provider key).

`tests/local.test.ts` — TEST-FIXTURE-ONLY correction (no production change)
- PREEXISTING FIXTURE DEFECT: the test relied on real `Date.now()` via `toLocalJob` while
  asserting order, failing when the five jobs crossed a millisecond.
- Fixture now builds each real job with `{ ...toLocalJob(videoPlane, ORIGIN), id, createdAt }`,
  pinning only `id` and the shared `createdAt` (1.7e12). Removed the tautological sort
  assertion and the false unique-seq claim. Expected order asserted as the literal
  `["a1","b2","c3","d4","e5"]`. Queue ordering (`worker/local-poll.ts` `readQueue`) is
  UNCHANGED.

## Limits / not done

- No render, ComfyUI/poller/schedule restart, deploy, key rotation or paid fallback.
- `C:/AI/scripts/witchcraft-poller.mjs` NOT imported or run (would start a real poller);
  static review only.
- No private-env re-read, no credential exposure, no service started.
- ComfyUI remains paused by Rio; no fresh render is claimed.
- `src/witchcraft/prompt-gallery.tsx` (frontend, other worker) is outside scope and was not
  touched; the earlier full-suite CSS/loader flake in `tests/exaggerator.test.ts` resolved in
  the final run (that file's 10 tests pass; passes standalone too).

## Changed files

- worker/planner.ts
- tests/h3.test.ts
- tests/local.test.ts
- runtime/final-test.log (captured full test output)
- runtime/FINAL-REPORT.md (this file)
