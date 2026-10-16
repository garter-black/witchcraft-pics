// Production-used identity-scope leaf — behavior tests over the ACTUAL exported
// function the app imports (`identityViewKeyFrom` in src/generation/identity.ts,
// imported by src/openhiggsfield/openhiggsfield-app.tsx line 400 to decide
// `changed` / `shouldWipe` in the fail-closed identity cycle).
//
// Honest scope: deterministic UNIT tests of a pure mapping. NO browser, NO
// network, NO credentials, NO React. This is NOT a test of the component's
// effects (which are React-coupled and are covered by the browser acceptance
// pass owned elsewhere). It pins the ONE production leaf the cleanup decision
// turns on: the scope KEY an identity answer reduces to.
//
// Why this leaf matters to the fail-closed contract: the cycle wipes when the
// reduced key is null-at-start, CHANGED, or a prior cleanup is pending. If this
// mapping collapsed two distinct principals to one key, an account switch would
// look unchanged and skip the wipe; if it returned a non-null key for a failure,
// a broken endpoint could masquerade as a settled scope. Both are privacy
// regressions, so they are asserted here against the real function.

import { test } from "node:test";
import assert from "node:assert/strict";

test("identityViewKeyFrom: each identity kind maps to a DISTINCT scope key", async () => {
  const { identityViewKeyFrom } = await import("../src/generation/identity");

  const legacy = identityViewKeyFrom({ status: "legacy" });
  const anon = identityViewKeyFrom({ status: "anonymous" });
  const pA = identityViewKeyFrom({ status: "authenticated", principal: "p_" + "1".repeat(32) });
  const pB = identityViewKeyFrom({ status: "authenticated", principal: "p_" + "2".repeat(32) });

  // Legacy, anonymous and authenticated are each their own scope.
  assert.equal(legacy, "u:n:-");
  assert.equal(anon, "c:n:-");
  assert.notEqual(legacy, anon, "legacy and anonymous must not share a scope key");

  // Two different principals MUST reduce to different keys, or an account
  // switch would look unchanged and the cycle would skip the wipe.
  assert.notEqual(pA, pB, "distinct principals must map to distinct scope keys");
  assert.match(pA!, /^c:a:p_1{32}$/);
  assert.match(pB!, /^c:a:p_2{32}$/);

  // An authenticated key is distinguishable from the anonymous/legacy keys, so
  // signing in from anonymous is a real change.
  assert.notEqual(pA, anon);
  assert.notEqual(pA, legacy);
});

test("identityViewKeyFrom: a FAILURE maps to null (never a settled scope)", async () => {
  const { identityViewKeyFrom } = await import("../src/generation/identity");

  const failed = identityViewKeyFrom({ status: "failure", reason: "offline" });
  assert.equal(failed, null, "a failed identity answer must not look like a settled scope");

  // A failure key NEVER equals any real scope key, so a cycle that reduces a
  // failure cannot be mistaken for an unchanged (no-wipe) account.
  assert.notEqual(failed, identityViewKeyFrom({ status: "anonymous" }));
  assert.notEqual(failed, identityViewKeyFrom({ status: "legacy" }));
  assert.notEqual(
    failed,
    identityViewKeyFrom({ status: "authenticated", principal: "p_" + "0".repeat(32) }),
  );
});

test("identityViewKeyFrom: the same principal is STABLE (a re-validation is a no-wipe)", async () => {
  const { identityViewKeyFrom } = await import("../src/generation/identity");

  const principal = "p_" + "a".repeat(32);
  const first = identityViewKeyFrom({ status: "authenticated", principal });
  const again = identityViewKeyFrom({ status: "authenticated", principal });

  // Same account, same key -> the cycle sees `changed === false` and, absent a
  // pending cleanup, does NOT wipe. This is what preserves the visitor's own
  // work across a same-principal visibility refresh.
  assert.equal(first, again, "an unchanged principal must reduce to an unchanged key");
  assert.equal(first, `c:a:${principal}`);
});
