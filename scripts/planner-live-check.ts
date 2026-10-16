// One actual bounded call through the REAL product function planWithAgent(),
// using the EXISTING authorized OPENCODE_GO_API_KEY loaded privately from the
// one established current store (the same store the live dispatcher uses). The
// value is never printed, logged, or written; only the outcome is reported.
//
// A hand-written duplicate of the HTTP call is NOT evidence that the product
// function works, so this imports and calls the shipped implementation.
import { readEnvValue } from "file:///C:/Users/zwt26/Documents/Codex/2026-09-27/sw/work/professor-face-fix/openrouter-worker-adapter.mjs";
import { planWithAgent, MODEL, ROUTE_STATES } from "../worker/planner";

const STORE = "C:/Users/zwt26/AppData/Local/hermes/.env";
const key = readEnvValue(STORE, "OPENCODE_GO_API_KEY");
if (!key) {
  console.log(JSON.stringify({ configured: false, store: STORE }, null, 2));
  process.exit(3);
}

const started = Date.now();
const outcome = await planWithAgent({ prompt: "a lone lighthouse keeper during a storm", surface: "image" }, key);
const plan = outcome.ok ? outcome.plan : null;
const usable = !!plan?.prompt;
console.log(
  JSON.stringify(
    {
      configured: true,
      store: STORE,
      model: MODEL,
      routeState: ROUTE_STATES[MODEL],
      elapsedMs: Date.now() - started,
      ok: outcome.ok,
      route: outcome.route,
      planUsable: usable,
      plan: plan
        ? {
            promptChars: plan.prompt.length,
            negativeChars: plan.negative.length,
            shots: plan.shots.length,
            shotSample: plan.shots[0] ?? null,
            promptHead: plan.prompt.slice(0, 220),
          }
        : null,
      reason: outcome.ok ? null : outcome.reason,
    },
    null,
    2,
  ),
);
process.exit(usable ? 0 : 5);
