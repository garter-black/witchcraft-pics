import { test } from "node:test";
import assert from "node:assert/strict";

import { PRESETS, defaultPreset, isStale, presetsFor, undoApplies, type Captured } from "../src/witchcraft/exaggerator-logic";
import { enhanceFailureText, requestEnhance } from "../src/witchcraft/enhancer";

/* The Exaggerator's production logic that runs without a browser or a JSX
   loader: preset selection, staleness, undo eligibility, and the enhancer's
   real request contract. The component's rendering is reviewed in the browser. */

test("presets split cleanly by surface and always offer a default", () => {
  const image = presetsFor("image").map((p) => p.id);
  const video = presetsFor("video").map((p) => p.id);
  assert.ok(image.includes("editorial") && image.includes("product") && image.includes("cinematic"));
  assert.ok(video.includes("action") && video.includes("music-video") && video.includes("cinematic"));
  assert.ok(!video.includes("editorial"), "editorial is image-only");
  assert.ok(image.length >= 2 && video.length >= 2);
  for (const id of ["editorial", "cinematic", "product", "action", "music-video"]) {
    assert.ok(PRESETS.some((p) => p.id === id), `${id} is offered`);
  }
  assert.match(defaultPreset("image"), /^[a-z-]+$/);
  assert.match(defaultPreset("video"), /^[a-z-]+$/);
  assert.ok(presetsFor("image").some((p) => p.id === defaultPreset("image")));
});

test("staleness is true for any changed input and false only for an identical capture", () => {
  const base: Captured = { original: "a lighthouse", surface: "video", modelId: "soul-2", preset: "cinematic", duration: 4 };
  assert.equal(isStale(base, { ...base }), false);
  assert.equal(isStale(base, { ...base, original: "a lighthouse " }), true, "whitespace is a change");
  assert.equal(isStale(base, { ...base, surface: "image" }), true);
  assert.equal(isStale(base, { ...base, modelId: "seedance-2.5" }), true);
  assert.equal(isStale(base, { ...base, preset: "action" }), true);
  assert.equal(isStale(base, { ...base, duration: 6 }), true);
  assert.equal(isStale(base, { ...base, duration: null }), true);
});

test("undo only fires while the live prompt still equals the applied text", () => {
  assert.equal(undoApplies("enhanced words", "enhanced words"), true);
  assert.equal(undoApplies("enhanced words", "enhanced words!"), false, "a later edit blocks undo");
  assert.equal(undoApplies(null, "anything"), false);
  assert.equal(undoApplies("x", null), false);
});

/* requestEnhance is the real production path to /api/enhance. These tests stub
   global fetch and assert the reserved contract: success returns the service
   text; every failure returns the untouched original with a real reason — never
   a fabricated enhancement. */

let __calls: { url: string; init: RequestInit }[] = [];

function withFetch<T>(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  __calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const resolved = init ?? {};
    __calls.push({ url: String(input), init: resolved });
    return handler(String(input), resolved);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const REQ = { prompt: "a lighthouse at dawn", surface: "video" as const, model: "soul-2", mode: "extra" as const, preset: "cinematic", duration: 4 };

test("a successful response carries the service rewrite, its change notes, and the exact outbound body", async () => {
  await withFetch(
    () => jsonResponse(200, { ok: true, prompt: "a lighthouse shattering at dawn", originalPrompt: REQ.prompt, changes: ["added motion"], source: "service" }),
    async () => {
      const result = await requestEnhance(REQ);
      assert.equal(result.ok, true);
      assert.equal(result.prompt, "a lighthouse shattering at dawn");
      assert.deepEqual(result.changes, ["added motion"]);
      assert.equal(result.source, "service");
      assert.equal(__calls.length, 1);
      assert.equal(__calls[0]!.url, "/api/enhance");
      assert.equal(__calls[0]!.init.method, "POST");
      const sent = JSON.parse(String(__calls[0]!.init.body));
      assert.deepEqual(sent, {
        prompt: "a lighthouse at dawn",
        surface: "video",
        model: "soul-2",
        mode: "extra",
        preset: "cinematic",
        duration: 4,
      });
    },
  );
});

test("a 401 is reported as unauthorized and preserves the original", async () => {
  await withFetch(
    () => jsonResponse(401, { ok: false }),
    async () => {
      const result = await requestEnhance(REQ);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "unauthorized");
      assert.equal(result.prompt, REQ.prompt);
      assert.equal(result.source, "none");
      assert.match(enhanceFailureText(result.reason), /owner session/);
    },
  );
});

test("a 404 is reported as unavailable, not as a rewrite", async () => {
  await withFetch(
    () => jsonResponse(404, { ok: false }),
    async () => {
      const result = await requestEnhance(REQ);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "unavailable");
      assert.equal(result.prompt, REQ.prompt);
      assert.match(enhanceFailureText(result.reason), /not available/);
    },
  );
});

test("a 500 with a service reason preserves the original and reports that reason", async () => {
  await withFetch(
    () => jsonResponse(500, { ok: false, reason: "planner exploded" }),
    async () => {
      const result = await requestEnhance(REQ);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "planner exploded");
      assert.equal(result.prompt, REQ.prompt, "the original is preserved verbatim");
      assert.match(enhanceFailureText(result.reason), /unchanged/);
    },
  );
});

test("a pre-aborted signal never starts a request and returns the original", async () => {
  const controller = new AbortController();
  controller.abort();
  await withFetch(
    () => jsonResponse(200, { ok: true, prompt: "should never be reached" }),
    async () => {
      const result = await requestEnhance(REQ, { signal: controller.signal });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "aborted");
      assert.equal(result.prompt, REQ.prompt);
      assert.equal(__calls.length, 0, "no fetch was issued for a pre-aborted signal");
    },
  );
});

test("a network failure returns the original with a real reason", async () => {
  await withFetch(
    () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      const result = await requestEnhance(REQ);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "network");
      assert.equal(result.prompt, REQ.prompt);
      assert.match(enhanceFailureText(result.reason), /unchanged/);
    },
  );
});

test("a 200 with a blank rewrite is rejected — it must not replace the prompt", async () => {
  await withFetch(
    () => jsonResponse(200, { ok: true, prompt: "   " }),
    async () => {
      const result = await requestEnhance(REQ);
      assert.equal(result.ok, false);
      assert.equal(result.prompt, REQ.prompt, "blank output must not replace the prompt");
    },
  );
});
