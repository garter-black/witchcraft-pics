import { test } from "node:test";
import assert from "node:assert/strict";

import { readRoute, normalisePath, ROUTE_PATHS } from "../src/witchcraft/route";
import { FREE_OPTIONS, SUPPORTED_LANES, FREE_CAVEATS } from "../src/witchcraft/free-access-data";

/* The access-surface decisions that must not silently regress:

   - The new private/public routes resolve, and the public studio path still
     degrades unknown paths to home (no dead ends).
   - The free-access data makes only conservative, root-reviewed claims: no
     "never store" promise, no free image/video/3D promise for Pollinations,
     Gemini's free media is "not verified" (not the overstated "text only",
     because a free audio tier exists), and Cloudflare's Free and Paid plans
     are described distinctly.
   - Every listed free option is signup-only (not presented as integrated), and
     the caveats never resurrect the removed false copy.

   Rendering (no public owner field/button; /owner shows a login) is enforced by
   the build + browser review; the honest STRINGS and route resolution are
   enforced here so a future edit fails the suite instead of shipping. */

test("the owner and free-access routes resolve, and unknown paths degrade to home", () => {
  assert.equal(readRoute("/owner"), "owner");
  assert.equal(readRoute("/OWNER/"), "owner", "case and trailing slash fold");
  assert.equal(readRoute("/free-access"), "free");
  assert.equal(readRoute("/free-access/"), "free");
  assert.equal(readRoute("/"), "home");
  assert.equal(readRoute("/prompts"), "prompts");
  assert.equal(readRoute("/something-typo"), "home", "an unknown path is never a 404 page");
  assert.equal(ROUTE_PATHS.owner, "/owner");
  assert.equal(ROUTE_PATHS.free, "/free-access");
});

test("normalisation collapses slashes without inventing a route", () => {
  assert.equal(normalisePath("//owner//"), "/owner");
  assert.equal(normalisePath(""), "/");
});

test("every free option is signup-only, never presented as integrated", () => {
  assert.ok(FREE_OPTIONS.length >= 1 && FREE_OPTIONS.length <= 4, "at most four lean options");
  for (const option of FREE_OPTIONS) {
    assert.equal(option.supportedHere, false, `${option.id} must be signup-only`);
    assert.match(option.signupUrl, /^https:\/\//, `${option.id} links to a real signup over https`);
    assert.match(option.docsUrl, /^https:\/\//, `${option.id} links to official docs`);
  }
});

test("no free image/video/3D promise is made for Pollinations", () => {
  const pollinations = FREE_OPTIONS.find((o) => o.id === "pollinations");
  assert.ok(pollinations, "pollinations is listed");
  const text = [pollinations.capabilities, pollinations.offer, pollinations.limits].join(" ");
  assert.match(text, /no free image, video or 3D claim/i, "the absence of a free-media claim is explicit");
  assert.doesNotMatch(text, /(?<!no )(?<!not )\bfree\b[^.]*\b(video|3D)\b/i, "never promise free video or 3D");
  assert.doesNotMatch(text, /unlimited|no (platform )?rate limit/i, "no unlimited/rate-limit headline");
});

test("Gemini states only what its free tier verifies, without an 'all text' overclaim", () => {
  const gemini = FREE_OPTIONS.find((o) => o.id === "gemini");
  assert.ok(gemini, "gemini is listed");
  /* The narrow assertion: NO free image or video model is verified here. */
  assert.match(
    gemini!.capabilities,
    /no free image or video model verified here/i,
    "the absence of a verified free media model is explicit",
  );
  assert.doesNotMatch(gemini!.capabilities, /Nano Banana/i, "no free image claim leaks back in");
  /* The corrected overclaim: Gemini must not be described as free TEXT ONLY,
     because a free audio tier exists. */
  assert.doesNotMatch(gemini!.capabilities, /text only/i, "the 'text only' overclaim is gone");
  assert.doesNotMatch(gemini!.capabilities, /text-only/i, "no hyphenated 'text-only' variant");
});

test("Cloudflare describes Free-plan stop and Paid-plan billed overage distinctly", () => {
  const cloudflare = FREE_OPTIONS.find((o) => o.id === "cloudflare");
  assert.ok(cloudflare, "cloudflare is listed");
  const text = [cloudflare!.offer, cloudflare!.limits].join(" ");
  assert.match(text, /free plan[^.]*stops?|free plan[^.]*stop/i, "the Free plan is stated to stop at the cap");
  assert.match(text, /paid plan[^.]*billed|billed[^.]*overage/i, "the Paid plan is stated to bill overage");
  assert.match(text, /00:00 UTC/i, "the 00:00 UTC reset is stated");
});

test("the removed false storage promise and pasting instruction cannot return", () => {
  const corpus = [
    ...FREE_OPTIONS.flatMap((o) => [o.capabilities, o.offer, o.limits, o.card]),
    ...FREE_CAVEATS,
    ...SUPPORTED_LANES.map((l) => l.wording),
  ].join("\n");
  assert.doesNotMatch(corpus, /never store|never reus/i, "the studio DOES hold a key briefly; no such promise");
  assert.doesNotMatch(corpus, /paste your own key into the studio/i, "no integration is live, so no pasting instruction");
});

test("the studio renderer is stated as owner-restricted and paid lanes are not 'free credit'", () => {
  const local = SUPPORTED_LANES.find((l) => l.id === "local");
  assert.ok(local, "the studio renderer lane is described");
  assert.match(local!.wording, /owner-restricted/i);

  const paid = SUPPORTED_LANES.filter((l) => l.paid).map((l) => l.wording).join(" ");
  assert.match(paid, /not a free credit/i);
  assert.match(paid, /RunPod/);
});
