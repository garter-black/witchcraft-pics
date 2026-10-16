// tests/hosted-output-privacy.test.ts
// ============================================================================
// Focused REAL tests for the hosted-output privacy finalizer
// (worker/privacy/hosted-output.ts) and the accepted mirror it drives
// (worker/privacy/personal-library.bundle.mjs via ./index).
//
// These are OFFLINE FIXTURES. They use a fake R2 with CORRECT conditional-put
// semantics (returns null + writes nothing on a failed precondition — see
// tests/fake-r2.ts) and an injected bounded fetch. They are NOT a live Google
// A/B test and NOT a provider-compatibility test; no provider is contacted and
// no customer data is used. The fixtures DO use the real accepted bundle's
// `registerRequest`/`mirrorOnce`/`resolveOutputUrl`, so the integration path is
// exercised rather than a stand-in.
//
// Runner: node --test (see package.json). The file is TypeScript-style but is
// loaded through the project's existing test toolchain (tsx/ts-node or tsc
// build) exactly like tests/runpod.test.ts. It imports .ts sources directly.
// ============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { fakeR2, pngBytes, mp4Bytes } from "./fake-r2";
import { privatizeHostedStatus, recordOwnerOutputs, MAX_MIRRORS_PER_BATCH, MAX_MIRROR_BYTES_HARD } from "../worker/privacy/hosted-output";
import { registerRequest, resolveOutputUrl, normalizeAllowlist } from "../worker/privacy/index";
import type { HostedStatusLike } from "../worker/privacy/hosted-output";

// --- fixtures ---------------------------------------------------------------

// A principal namespace segment (p_ + 32 hex). Two DISTINCT principals.
const A = "p_" + "a".repeat(32);
const B = "p_" + "b".repeat(32);

// A committed-fixture-derived output host (see VERIFIED-HOSTS.md — RunPod image
// outputs are served from image.runpod.ai per tests/runpod.test.ts).
const IMG_HOST = "image.runpod.ai";
// A foreign host that must never be fetched.
const FOREIGN = "evil.example.test";
const ALLOW = [IMG_HOST];

function env(media: unknown, extra: Record<string, unknown> = {}) {
  return { MEDIA: media, MIRROR_ALLOWLIST: ALLOW, ...extra } as never;
}

/** A recording bounded fetch that serves per-URL responses and counts calls. */
function boundedFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    calls.push(url);
    const handler = routes[url];
    if (!handler) return new Response("nope", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function owned(media: unknown, requestId: string, segment = A, provider = "runpod") {
  await registerRequest(media, { requestId, subject: segment, provider });
}

// --- A) owner copies one image / one video ----------------------------------

test("A: owner — single image is mirrored to a same-origin handle, no raw URL", async () => {
  const media = fakeR2();
  await owned(media, "rp:img:1");
  await recordOwnerOutputs(env(media) as never, A, "rp:img:1", [
    { url: `https://${IMG_HOST}/out.png`, contentType: "image/png" },
  ]);
  const { impl, calls } = boundedFetch({
    [`https://${IMG_HOST}/out.png`]: () => new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }),
  });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:img:1", images: [{ url: `https://${IMG_HOST}/out.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:img:1", status, { fetchImpl: impl });

  assert.equal(out.status, "completed");
  assert.equal(out.requestId, "rp:img:1");
  assert.equal(out.outputState, "mirrored");
  assert.ok(out.images && out.images.length === 1, "one image handle preserved");
  assert.ok(out.images![0].url.startsWith("/media/" + A + "/"), "same-origin /media handle under own namespace: " + out.images![0].url);
  assert.equal(out.images![0].url.includes("://"), false, "no scheme -> no raw URL");
  assert.equal(out.images![0].url.includes(IMG_HOST), false, "raw host must not leak");
  assert.equal(calls.length, 1, "exactly one upstream fetch");
});

test("A: owner — single video is mirrored, video shape preserved", async () => {
  const media = fakeR2();
  await owned(media, "rp:vid:1");
  await recordOwnerOutputs(env(media) as never, A, "rp:vid:1", [
    { url: `https://${IMG_HOST}/out.mp4`, contentType: "video/mp4" },
  ]);
  const { impl } = boundedFetch({
    [`https://${IMG_HOST}/out.mp4`]: () => new Response(mp4Bytes(), { status: 200, headers: { "content-type": "video/mp4" } }),
  });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:vid:1", video: { url: `https://${IMG_HOST}/out.mp4` } };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:vid:1", status, { fetchImpl: impl });
  assert.equal(out.outputState, "mirrored");
  assert.ok(out.video && out.video.url.startsWith("/media/" + A + "/"), "video handle under own namespace");
  assert.equal(out.images, undefined, "no images field invented");
});

test("A: owner — MULTIPLE images each get their OWN handle (no overwrite, no cache-first-for-all)", async () => {
  const media = fakeR2();
  await owned(media, "rp:multi:1");
  const canon = [
    { url: `https://${IMG_HOST}/a.png`, contentType: "image/png" },
    { url: `https://${IMG_HOST}/b.png`, contentType: "image/png" },
    { url: `https://${IMG_HOST}/c.png`, contentType: "image/png" },
  ];
  await recordOwnerOutputs(env(media) as never, A, "rp:multi:1", canon);
  const { impl } = boundedFetch({
    [`https://${IMG_HOST}/a.png`]: () => new Response(pngBytes(32), { status: 200, headers: { "content-type": "image/png" } }),
    [`https://${IMG_HOST}/b.png`]: () => new Response(pngBytes(48), { status: 200, headers: { "content-type": "image/png" } }),
    [`https://${IMG_HOST}/c.png`]: () => new Response(pngBytes(64), { status: 200, headers: { "content-type": "image/png" } }),
  });
  const status: HostedStatusLike = {
    status: "completed",
    requestId: "rp:multi:1",
    images: [{ url: canon[0].url }, { url: canon[1].url }, { url: canon[2].url }],
  };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:multi:1", status, { fetchImpl: impl });
  assert.equal(out.outputState, "mirrored");
  assert.equal(out.images!.length, 3);
  const keys = out.images!.map((i) => i.url);
  assert.equal(new Set(keys).size, 3, "each slot has a distinct handle");
  for (const k of keys) {
    assert.ok(k.startsWith("/media/" + A + "/"), "own-namespace /media handle: " + k);
    assert.match(k, /\.png$/, "ext preserved");
  }
});

// --- B) unowned / foreign / anonymous refuse BEFORE fetch -------------------

test("B: foreign principal refuses — no upstream fetch, no raw URL, explicit state", async () => {
  const media = fakeR2();
  await owned(media, "rp:foreign:1", A); // owned by A
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:foreign:1", images: [{ url: `https://${IMG_HOST}/x.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, B, "rp:foreign:1", status, { fetchImpl: impl });
  assert.equal(calls.length, 0, "foreign caller must not trigger any fetch");
  assert.equal(out.images, undefined, "no media returned to a non-owner");
  assert.ok(out.outputState === "unavailable" || out.outputState === "unsupported");
  assert.equal(JSON.stringify(out).includes(IMG_HOST), false, "no raw URL anywhere in the result");
});

test("B: unknown request id refuses — no fetch, explicit state", async () => {
  const media = fakeR2();
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:never", images: [{ url: `https://${IMG_HOST}/x.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:never", status, { fetchImpl: impl });
  assert.equal(calls.length, 0);
  assert.equal(out.images, undefined);
  assert.equal(out.outputState, "unavailable");
});

test("B: a non-principal segment refuses (bad identity) before any storage/fetch", async () => {
  const media = fakeR2();
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:x", images: [{ url: `https://${IMG_HOST}/x.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, "not-a-segment", "rp:x", status, { fetchImpl: impl });
  assert.equal(calls.length, 0);
  assert.equal(out.outputState, "unsupported");
  assert.equal(out.images, undefined);
});

// --- registry client-chosen URL unavailable ---------------------------------

test("registry: no recorded canonical output => explicit unavailable, no fetch", async () => {
  const media = fakeR2();
  await owned(media, "rp:nocanon:1"); // registry row exists, but no output recorded
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:nocanon:1", images: [{ url: `https://${FOREIGN}/steal.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:nocanon:1", status, { fetchImpl: impl });
  assert.equal(calls.length, 0, "the client-supplied foreign URL must never be fetched");
  assert.equal(out.images, undefined);
  assert.equal(out.outputState, "unavailable");
  assert.equal(JSON.stringify(out).includes(FOREIGN), false);
});

test("registry: resolveOutputUrl single-slot is honoured (accepted-store fallback)", async () => {
  const media = fakeR2();
  await owned(media, "rp:single:1");
  // Simulate the accepted single-slot record written by trusted server code.
  const { updateRegistryState } = await import("../worker/privacy/index");
  await updateRegistryState(media, "rp:single:1", { outputUrl: `https://${IMG_HOST}/s.png`, outputContentType: "image/png" });
  assert.ok((await resolveOutputUrl(media, "rp:single:1", A))?.url.includes(IMG_HOST));
  const { impl } = boundedFetch({
    [`https://${IMG_HOST}/s.png`]: () => new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }),
  });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:single:1", images: [{ url: `https://${IMG_HOST}/s.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:single:1", status, { fetchImpl: impl });
  assert.equal(out.outputState, "mirrored");
  assert.ok(out.images![0].url.startsWith("/media/" + A + "/"));
});

// --- sanitisation: zero raw URLs, ever --------------------------------------

test("sanitise: no provider host or scheme appears in the serialized result on success OR failure", async () => {
  const media = fakeR2();
  await owned(media, "rp:san:1");
  await recordOwnerOutputs(env(media) as never, A, "rp:san:1", [{ url: `https://${IMG_HOST}/ok.png`, contentType: "image/png" }]);
  const ok = boundedFetch({ [`https://${IMG_HOST}/ok.png`]: () => new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }) });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:san:1", images: [{ url: `https://${IMG_HOST}/ok.png` }] };
  const success = await privatizeHostedStatus(env(media) as never, A, "rp:san:1", status, { fetchImpl: ok.impl });
  assert.equal(JSON.stringify(success).includes(IMG_HOST), false);
  assert.equal(JSON.stringify(success).includes("https://"), false);

  // Failure path: oversize body.
  const media2 = fakeR2();
  await owned(media2, "rp:san:2");
  await recordOwnerOutputs(env(media2) as never, A, "rp:san:2", [{ url: `https://${IMG_HOST}/big.png`, contentType: "image/png" }]);
  const big = boundedFetch({ [`https://${IMG_HOST}/big.png`]: () => new Response(new Uint8Array(1024), { status: 200, headers: { "content-type": "image/png" } }) });
  const status2: HostedStatusLike = { status: "completed", requestId: "rp:san:2", images: [{ url: `https://${IMG_HOST}/big.png` }] };
  const failed = await privatizeHostedStatus(env(media2) as never, A, "rp:san:2", status2, { fetchImpl: big.impl, maxBytes: 8 });
  assert.equal(JSON.stringify(failed).includes(IMG_HOST), false, "failure never leaks the raw URL");
  assert.equal(JSON.stringify(failed).includes("https://"), false);
  assert.equal(failed.outputState, "unavailable");
});

// --- allowlist fail-closed cases --------------------------------------------

test("allowlist: absent/empty => unsupported, no fetch, no raw URL", async () => {
  const media = fakeR2();
  await owned(media, "rp:al:0");
  await recordOwnerOutputs(env(media) as never, A, "rp:al:0", [{ url: `https://${IMG_HOST}/x.png`, contentType: "image/png" }]);
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:al:0", images: [{ url: `https://${IMG_HOST}/x.png` }] };
  const out = await privatizeHostedStatus(env(media, { MIRROR_ALLOWLIST: "" }) as never, A, "rp:al:0", status, { fetchImpl: impl });
  assert.equal(calls.length, 0);
  assert.equal(out.outputState, "unsupported");
  assert.equal(out.images, undefined);
});

test("allowlist: foreign host is refused (host_not_allowed), no raw URL", async () => {
  const media = fakeR2();
  await owned(media, "rp:al:1");
  await recordOwnerOutputs(env(media) as never, A, "rp:al:1", [{ url: `https://${FOREIGN}/x.png`, contentType: "image/png" }]);
  const { impl, calls } = boundedFetch({ [`https://${FOREIGN}/x.png`]: () => new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }) });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:al:1", images: [{ url: `https://${FOREIGN}/x.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:al:1", status, { fetchImpl: impl });
  assert.equal(calls.length, 0, "a non-allowlisted host must be refused BEFORE fetch");
  assert.equal(out.outputState, "unavailable");
  assert.equal(JSON.stringify(out).includes(FOREIGN), false);
});

test("allowlist: redirect to a non-allowlisted host fails closed (SSRF)", async () => {
  const media = fakeR2();
  await owned(media, "rp:al:2");
  await recordOwnerOutputs(env(media) as never, A, "rp:al:2", [{ url: `https://${IMG_HOST}/redir`, contentType: "image/png" }]);
  const { impl, calls } = boundedFetch({
    [`https://${IMG_HOST}/redir`]: () => new Response(null, { status: 302, headers: { location: `https://${FOREIGN}/steal` } }),
  });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:al:2", images: [{ url: `https://${IMG_HOST}/redir` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:al:2", status, { fetchImpl: impl });
  assert.equal(out.outputState, "unavailable");
  assert.equal(calls.length, 1, "one hop allowed, then refused");
  assert.equal(JSON.stringify(out).includes(FOREIGN), false);
});

test("allowlist: oversize body fails closed; no silent 64MB cap fallback", async () => {
  const media = fakeR2();
  await owned(media, "rp:al:3");
  await recordOwnerOutputs(env(media) as never, A, "rp:al:3", [{ url: `https://${IMG_HOST}/big`, contentType: "image/png" }]);
  const { impl } = boundedFetch({ [`https://${IMG_HOST}/big`]: () => new Response(new Uint8Array(MAX_MIRROR_BYTES_HARD + 1), { status: 200, headers: { "content-type": "image/png" } }) });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:al:3", images: [{ url: `https://${IMG_HOST}/big` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:al:3", status, { fetchImpl: impl });
  assert.equal(out.outputState, "unavailable");
  assert.equal(out.images, undefined);
});

test("allowlist: stalled body fails closed on the deadline", async () => {
  const media = fakeR2();
  await owned(media, "rp:al:4");
  await recordOwnerOutputs(env(media) as never, A, "rp:al:4", [{ url: `https://${IMG_HOST}/stall.mp4`, contentType: "video/mp4" }]);
  let cancelled = false;
  const stalled = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { cancelled = true; },
  });
  const { impl } = boundedFetch({ [`https://${IMG_HOST}/stall.mp4`]: () => new Response(stalled, { status: 200, headers: { "content-type": "video/mp4" } }) });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:al:4", video: { url: `https://${IMG_HOST}/stall.mp4` } };
  const t0 = Date.now();
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:al:4", status, { fetchImpl: impl, timeoutMs: 80 });
  assert.equal(out.outputState, "unavailable");
  assert.ok(Date.now() - t0 < 2500, "stalled body bounded by the deadline");
  assert.equal(cancelled, true);
});

test("allowlist: unsupported content type fails that slot closed", async () => {
  const media = fakeR2();
  await owned(media, "rp:al:5");
  await recordOwnerOutputs(env(media) as never, A, "rp:al:5", [{ url: `https://${IMG_HOST}/x.gif`, contentType: "image/gif" }]);
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:al:5", images: [{ url: `https://${IMG_HOST}/x.gif` }] };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:al:5", status, { fetchImpl: impl });
  assert.equal(calls.length, 0, "an unsupported type is refused before fetch");
  assert.equal(out.outputState, "unavailable");
});

// --- canonical handle contract: /media/<p_segment>/... ----------------------

test("handle: every returned media URL is a same-origin /media/<p_segment>/<uuid>.<ext>", async () => {
  const media = fakeR2();
  await owned(media, "rp:media:1");
  await recordOwnerOutputs(env(media) as never, A, "rp:media:1", [
    { url: `https://${IMG_HOST}/one.png`, contentType: "image/png" },
    { url: `https://${IMG_HOST}/two.mp4`, contentType: "video/mp4" },
  ]);
  const { impl } = boundedFetch({
    [`https://${IMG_HOST}/one.png`]: () => new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }),
    [`https://${IMG_HOST}/two.mp4`]: () => new Response(mp4Bytes(), { status: 200, headers: { "content-type": "video/mp4" } }),
  });
  const status: HostedStatusLike = {
    status: "completed",
    requestId: "rp:media:1",
    images: [{ url: `https://${IMG_HOST}/one.png` }],
    video: { url: `https://${IMG_HOST}/two.mp4` },
  };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:media:1", status, { fetchImpl: impl });
  assert.equal(out.outputState, "mirrored");
  const urls = [...out.images!.map((i) => i.url), out.video!.url];
  for (const u of urls) {
    // The exact contract: /media/<p_segment>/<name>.<ext>, own namespace, no scheme/host.
    assert.match(u, new RegExp("^/media/" + A + "/[A-Za-z0-9_-]+\\.[A-Za-z0-9]{1,8}$"), "canonical /media handle: " + u);
    assert.equal(u.includes("://"), false);
    assert.equal(u.includes(IMG_HOST), false);
    assert.equal(u.includes("/api/library/object/"), false, "browser handle is /media, not the library read API");
  }
  assert.ok(out.images![0].url.endsWith(".png"), "image ext preserved");
  assert.ok(out.video!.url.endsWith(".mp4"), "video ext preserved");
  assert.notEqual(out.images![0].url, out.video!.url, "distinct keys for distinct slots");
});

test("handle: MULTIPLE outputs get DISTINCT /media keys (no shared/overwritten slot)", async () => {
  const media = fakeR2();
  await owned(media, "rp:media:2");
  const canon = Array.from({ length: 4 }, (_, i) => ({ url: `https://${IMG_HOST}/m${i}.png`, contentType: "image/png" }));
  await recordOwnerOutputs(env(media) as never, A, "rp:media:2", canon);
  const routes: Record<string, () => Response> = {};
  for (let i = 0; i < 4; i++) routes[`https://${IMG_HOST}/m${i}.png`] = () => new Response(pngBytes(8 + i), { status: 200, headers: { "content-type": "image/png" } });
  const { impl } = boundedFetch(routes);
  const status: HostedStatusLike = { status: "completed", requestId: "rp:media:2", images: canon.map((c) => ({ url: c.url })) };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:media:2", status, { fetchImpl: impl });
  assert.equal(out.images!.length, 4);
  const keys = out.images!.map((i) => i.url);
  assert.equal(new Set(keys).size, 4, "four distinct /media keys");
  for (const k of keys) assert.match(k, new RegExp("^/media/" + A + "/[A-Za-z0-9_-]+\\.png$"));
});

// --- resource contract: sequential + batch bound ----------------------------

test("resource: mirroring is SEQUENTIAL and bounded; max concurrent upstream fetches is 1", async () => {
  const media = fakeR2();
  await owned(media, "rp:seq:1");
  const canon = Array.from({ length: 5 }, (_, i) => ({ url: `https://${IMG_HOST}/s${i}.png`, contentType: "image/png" }));
  await recordOwnerOutputs(env(media) as never, A, "rp:seq:1", canon);
  let live = 0;
  let peak = 0;
  const routes: Record<string, () => Response> = {};
  for (let i = 0; i < 5; i++) {
    routes[`https://${IMG_HOST}/s${i}.png`] = () => new Response(pngBytes(16), { status: 200, headers: { "content-type": "image/png" } });
  }
  const impl = (async (input: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    const r = routes[url]?.() ?? new Response("no", { status: 404 });
    live--;
    return r;
  }) as unknown as typeof fetch;
  const status: HostedStatusLike = { status: "completed", requestId: "rp:seq:1", images: canon.map((c) => ({ url: c.url })) };
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:seq:1", status, { fetchImpl: impl });
  assert.equal(out.images!.length, 5);
  assert.equal(peak, 1, "mirrors are sequential: never more than one live fetch");
  assert.equal(MAX_MIRRORS_PER_BATCH, 8);
  assert.equal(MAX_MIRROR_BYTES_HARD, 32 * 1024 * 1024);
});

// --- caching: own output reuses the same handle; no foreign reuse -----------

test("cache: a second privatize call reuses the SAME handle and does not refetch", async () => {
  const media = fakeR2();
  await owned(media, "rp:cache:1");
  await recordOwnerOutputs(env(media) as never, A, "rp:cache:1", [{ url: `https://${IMG_HOST}/c.png`, contentType: "image/png" }]);
  let fetches = 0;
  const { impl } = boundedFetch({ [`https://${IMG_HOST}/c.png`]: () => { fetches++; return new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }); } });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:cache:1", images: [{ url: `https://${IMG_HOST}/c.png` }] };
  const first = await privatizeHostedStatus(env(media) as never, A, "rp:cache:1", status, { fetchImpl: impl });
  const second = await privatizeHostedStatus(env(media) as never, A, "rp:cache:1", status, { fetchImpl: impl });
  assert.equal(first.outputState, "mirrored");
  assert.equal(second.outputState, "mirrored");
  assert.equal(first.images![0].url, second.images![0].url, "same handle for the same owned slot");
  assert.equal(fetches, 1, "cached mirror receipt prevents a refetch");
});

test("cache: a foreign principal cannot reuse another owner's recorded outputs", async () => {
  const media = fakeR2();
  await owned(media, "rp:own:1", A);
  await recordOwnerOutputs(env(media) as never, A, "rp:own:1", [{ url: `https://${IMG_HOST}/o.png`, contentType: "image/png" }]);
  // B attempts to read A's stored outputs via privatize: ownership recheck fails.
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:own:1", images: [{ url: `https://${IMG_HOST}/o.png` }] };
  const out = await privatizeHostedStatus(env(media) as never, B, "rp:own:1", status, { fetchImpl: impl });
  assert.equal(calls.length, 0);
  assert.equal(out.images, undefined);
});

test("recordOwnerOutputs: refuses a foreign/unknown request (no oracle, no write)", async () => {
  const media = fakeR2();
  const r = await recordOwnerOutputs(env(media) as never, A, "rp:notmine", [{ url: `https://${IMG_HOST}/x.png`, contentType: "image/png" }]);
  assert.equal(r.ok, false);
  // Nothing was written under A's namespace.
  const obj = await (media as unknown as { get(k: string): Promise<unknown> }).get(`${A}/.outputs/rp:notmine.json`);
  assert.equal(obj, null);
});

// --- normalization: normalizeAllowlist accepts CSV/space/array --------------

test("normalizeAllowlist: CSV / space / array all parse; empty => []", () => {
  assert.deepEqual(normalizeAllowlist("image.runpod.ai,d2h7xmz5gqybh9.cloudfront.net"), ["image.runpod.ai", "d2h7xmz5gqybh9.cloudfront.net"]);
  assert.deepEqual(normalizeAllowlist("image.runpod.ai  other.host"), ["image.runpod.ai", "other.host"]);
  assert.deepEqual(normalizeAllowlist(["a.b"]), ["a.b"]);
  assert.deepEqual(normalizeAllowlist(""), []);
  assert.deepEqual(normalizeAllowlist(undefined), []);
});

// --- GAP 1: registry ownership is rechecked BEFORE the internal record read --
// A valid-looking `.outputs/<id>.json` under a namespace is NOT trusted on its
// own: the registry row must still authorise (segment == row.subject) before
// the record is read or any output is fetched. A stale/foreign record fails
// closed even if its `owner` field matches the caller.

test("gap1: a planted valid .outputs record with NO registry row refuses before read/fetch", async () => {
  const media = fakeR2();
  // Plant a syntactically valid multi-slot record under A's namespace, but do
  // NOT register the request — the registry must refuse regardless.
  await media.put(
    `${A}/.outputs/rp:ghost.json`,
    JSON.stringify({ owner: A, requestId: "rp:ghost", outputs: [{ url: `https://${IMG_HOST}/g.png`, contentType: "image/png" }] }),
    { httpMetadata: { contentType: "application/json" } },
  );
  // Spy on media.get to prove the internal record is never read.
  let recordReads = 0;
  const spyMedia = {
    ...media,
    async get(key: string) {
      if (String(key).includes("/.outputs/")) recordReads++;
      return (media as unknown as { get(k: string): Promise<unknown> }).get(key);
    },
    put: media.put.bind(media),
  };
  const { impl, calls } = boundedFetch({
    [`https://${IMG_HOST}/g.png`]: () => new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }),
  });
  const status: HostedStatusLike = { status: "completed", requestId: "rp:ghost", images: [{ url: `https://${IMG_HOST}/g.png` }] };
  const out = await privatizeHostedStatus({ MEDIA: spyMedia, MIRROR_ALLOWLIST: ALLOW } as never, A, "rp:ghost", status, { fetchImpl: impl });
  assert.equal(recordReads, 0, "the internal .outputs record must not be read without registry ownership");
  assert.equal(calls.length, 0, "no upstream fetch without registry ownership");
  assert.equal(out.images, undefined);
  assert.equal(out.outputState, "unavailable");
  assert.equal(JSON.stringify(out).includes(IMG_HOST), false);
});

test("gap1: a foreign-owned registry row refuses even if a matching .outputs record is planted", async () => {
  const media = fakeR2();
  await owned(media, "rp:gap1b", A); // registry says A owns it
  // B plants a valid-looking record in B's own namespace for A's request id.
  await media.put(
    `${B}/.outputs/rp:gap1b.json`,
    JSON.stringify({ owner: B, requestId: "rp:gap1b", outputs: [{ url: `https://${IMG_HOST}/b.png`, contentType: "image/png" }] }),
    { httpMetadata: { contentType: "application/json" } },
  );
  let recordReads = 0;
  const spyMedia = {
    ...media,
    async get(key: string) {
      if (String(key).includes("/.outputs/")) recordReads++;
      return (media as unknown as { get(k: string): Promise<unknown> }).get(key);
    },
    put: media.put.bind(media),
  };
  const { impl, calls } = boundedFetch({});
  const status: HostedStatusLike = { status: "completed", requestId: "rp:gap1b", images: [{ url: `https://${IMG_HOST}/b.png` }] };
  const out = await privatizeHostedStatus({ MEDIA: spyMedia, MIRROR_ALLOWLIST: ALLOW } as never, B, "rp:gap1b", status, { fetchImpl: impl });
  assert.equal(recordReads, 0, "no internal record read for a foreign request id");
  assert.equal(calls.length, 0);
  assert.equal(out.images, undefined);
});

// --- GAP 2: provider error field is sanitised (no raw URL survives) ---------

test("gap2: a URL-bearing provider error string returns a generic error, no URL", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:1");
  const raw = `download failed: https://${IMG_HOST}/out.png?token=SECRET#frag`;
  const status = { status: "failed", requestId: "rp:err:1", error: raw } as HostedStatusLike;
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:1", status);
  const s = JSON.stringify(out);
  assert.equal(s.includes(IMG_HOST), false, "provider host must not survive in error");
  assert.equal(s.includes("https://"), false, "no scheme/URL in the error");
  assert.equal(s.includes("SECRET"), false, "no token fragment in the error");
  assert.equal(typeof out.error, "string");
});

test("gap2: a nested-object provider error never leaks nested URL fields", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:2");
  // Object with a capability URL in several nested shapes.
  const status = {
    status: "failed",
    requestId: "rp:err:2",
    error: { message: `see https://${IMG_HOST}/x.png?sig=abc`, detail: { url: `https://${IMG_HOST}/y.png` }, href: `https://${IMG_HOST}/z.png` },
  } as unknown as HostedStatusLike;
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:2", status);
  const s = JSON.stringify(out);
  assert.equal(s.includes(IMG_HOST), false, "no nested provider host survives");
  assert.equal(s.includes("https://"), false, "no nested URL survives");
  assert.equal(s.includes("sig="), false, "no query string survives");
  // The whole nested object must be replaced (not spread).
  assert.equal(typeof out.error, "string");
});

test("gap2: a bare hostname/path capability link (no scheme) is still dropped", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:3");
  const status = { status: "failed", requestId: "rp:err:3", error: `${IMG_HOST}/cap/abc123` } as HostedStatusLike;
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:3", status);
  const s = JSON.stringify(out);
  assert.equal(s.includes(IMG_HOST), false, "bare host.tld/path must not survive");
  assert.equal(s.includes("cap/abc123"), false, "capability path must not survive");
});

test("gap2: a benign error code is preserved (useful, not blanked)", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:ok");
  const status = { status: "failed", requestId: "rp:err:ok", error: { code: "provider_timeout" } } as unknown as HostedStatusLike;
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:ok", status);
  assert.equal(out.error, "provider_timeout", "a safe stable code is retained");
  assert.equal(JSON.stringify(out).includes("://"), false);
});

// --- GAP 2b: the sanitizer defaults CLOSED on every non-token string. The
// earlier permissive shape check let a bare TWO-LABEL host/path (example.com/x)
// through; a strict "short single safe token or generic" rule must now drop
// every URL-ish / freeform string. These run the REAL helper (not a grep), one
// fixture per exact attack shape named in the review.

test("gap2b: a bare two-label host/path with a signed query is dropped", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:2lab");
  const raw = "example.com/secret?token=secret";
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:2lab", { status: "failed", requestId: "rp:err:2lab", error: raw } as HostedStatusLike);
  assert.equal(out.error, "Provider request failed.", "a bare host/path+query is not a stable token");
  const s = JSON.stringify(out);
  assert.equal(s.includes("example.com"), false, "the two-label host must not survive");
  assert.equal(s.includes("token=secret"), false, "the query secret must not survive");
});

test("gap2b: a SCHEMELESS signed URL query is dropped", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:noscheme");
  const raw = "cdn.provider.test/out.png?X-Amz-Signature=deadbeef&X-Amz-Expires=900";
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:noscheme", { status: "failed", requestId: "rp:err:noscheme", error: raw } as HostedStatusLike);
  assert.equal(out.error, "Provider request failed.");
  const s = JSON.stringify(out);
  assert.equal(s.includes("X-Amz-Signature"), false, "the signed query must not survive");
  assert.equal(s.includes("deadbeef"), false, "the signature must not survive");
});

test("gap2b: a PROTOCOL-RELATIVE URL is dropped", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:prorel");
  const raw = "//media.provider.test/out.png?token=secret";
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:prorel", { status: "failed", requestId: "rp:err:prorel", error: raw } as HostedStatusLike);
  assert.equal(out.error, "Provider request failed.", "a protocol-relative URL is not a stable token");
  const s = JSON.stringify(out);
  assert.equal(s.includes("media.provider.test"), false, "the protocol-relative host must not survive");
  assert.equal(s.includes("token=secret"), false, "the query secret must not survive");
});

test("gap2b: freeform PROSE is dropped (a sentence cannot be proven safe)", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:prose");
  const raw = "the render failed because the GPU ran out of memory while decoding";
  const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:prose", { status: "failed", requestId: "rp:err:prose", error: raw } as HostedStatusLike);
  assert.equal(out.error, "Provider request failed.", "freeform prose is replaced by the generic message");
  const s = JSON.stringify(out);
  assert.equal(s.includes("ran out of memory"), false, "the prose must not survive verbatim");
});

test("gap2b: a VALID short stable token IS retained (the rule is not blank-everything)", async () => {
  const media = fakeR2();
  await owned(media, "rp:err:stable");
  for (const token of ["provider_timeout", "rate_limited", "upstream_unavailable"]) {
    const out = await privatizeHostedStatus(env(media) as never, A, "rp:err:stable", { status: "failed", requestId: "rp:err:stable", error: token } as HostedStatusLike);
    assert.equal(out.error, token, `the stable token ${token} is useful and retained`);
  }
});

// --- GAP 3: per-URL stable receipt identity survives REORDER (no swap) -------

test("gap3: two distinct outputs reordered on the second poll keep their exact cached key + type, no refetch, no swap", async () => {
  const media = fakeR2();
  await owned(media, "rp:reorder:1");
  const urlA = `https://${IMG_HOST}/reorder-a.png`;
  const urlB = `https://${IMG_HOST}/reorder-b.mp4`;
  await recordOwnerOutputs(env(media) as never, A, "rp:reorder:1", [
    { url: urlA, contentType: "image/png" },
    { url: urlB, contentType: "video/mp4" },
  ]);
  let fetches = 0;
  const { impl } = boundedFetch({
    [urlA]: () => { fetches++; return new Response(pngBytes(16), { status: 200, headers: { "content-type": "image/png" } }); },
    [urlB]: () => { fetches++; return new Response(mp4Bytes(16), { status: 200, headers: { "content-type": "video/mp4" } }); },
  });

  // Poll 1: image A then video B.
  const first = await privatizeHostedStatus(env(media) as never, A, "rp:reorder:1", {
    status: "completed",
    requestId: "rp:reorder:1",
    images: [{ url: urlA }],
    video: { url: urlB },
  } as HostedStatusLike, { fetchImpl: impl });
  assert.equal(first.outputState, "mirrored");
  const aHandle1 = first.images![0].url;
  const bHandle1 = first.video!.url;
  assert.ok(aHandle1.endsWith(".png"), "A stays an image handle");
  assert.ok(bHandle1.endsWith(".mp4"), "B stays a video handle");
  assert.equal(fetches, 2, "one fetch per distinct URL");

  // Poll 2: REORDERED status list (video first, image second) — same URLs.
  const second = await privatizeHostedStatus(env(media) as never, A, "rp:reorder:1", {
    status: "completed",
    requestId: "rp:reorder:1",
    images: [{ url: urlA }],
    video: { url: urlB },
  } as HostedStatusLike, { fetchImpl: impl });

  // The IMAGE slot must still be A's handle, and the VIDEO slot B's — no swap.
  assert.equal(second.images![0].url, aHandle1, "image A keeps its exact cached handle after reorder");
  assert.equal(second.video!.url, bHandle1, "video B keeps its exact cached handle after reorder");
  assert.ok(second.images![0].url.endsWith(".png"), "image slot did not become the video handle");
  assert.ok(second.video!.url.endsWith(".mp4"), "video slot did not become the image handle");
  assert.notEqual(second.images![0].url, second.video!.url, "slots remain distinct");
  assert.equal(fetches, 2, "reorder causes NO refetch (per-URL receipt reused)");

  // Now the harder case: the provider emits the SAME URL set in a DIFFERENT
  // positional order (two images), proving per-URL identity not index identity.
  const media2 = fakeR2();
  await owned(media2, "rp:reorder:2");
  const u1 = `https://${IMG_HOST}/p1.png`;
  const u2 = `https://${IMG_HOST}/p2.png`;
  const canon = [{ url: u1, contentType: "image/png" }, { url: u2, contentType: "image/png" }];
  await recordOwnerOutputs(env(media2) as never, A, "rp:reorder:2", canon);
  let f2 = 0;
  const bf2 = boundedFetch({
    [u1]: () => { f2++; return new Response(pngBytes(24), { status: 200, headers: { "content-type": "image/png" } }); },
    [u2]: () => { f2++; return new Response(pngBytes(40), { status: 200, headers: { "content-type": "image/png" } }); },
  });
  const o1 = await privatizeHostedStatus(env(media2) as never, A, "rp:reorder:2", {
    status: "completed", requestId: "rp:reorder:2", images: [{ url: u1 }, { url: u2 }],
  } as HostedStatusLike, { fetchImpl: bf2.impl });
  assert.equal(o1.images!.length, 2);
  const forUrl1 = o1.images![0].url;
  const forUrl2 = o1.images![1].url;

  // Second poll presents them in the opposite order.
  const o2 = await privatizeHostedStatus(env(media2) as never, A, "rp:reorder:2", {
    status: "completed", requestId: "rp:reorder:2", images: [{ url: u2 }, { url: u1 }],
  } as HostedStatusLike, { fetchImpl: bf2.impl });
  assert.equal(o2.images!.length, 2);
  // Slot 0 now carries url u2 -> must be u2's handle; slot 1 carries u1 -> u1's.
  assert.equal(o2.images![0].url, forUrl2, "reordered slot 0 resolves to u2's own cached handle");
  assert.equal(o2.images![1].url, forUrl1, "reordered slot 1 resolves to u1's own cached handle");
  assert.notEqual(o2.images![0].url, o2.images![1].url, "no collapse onto one handle");
  assert.equal(f2, 2, "no refetch after reorder");
});
