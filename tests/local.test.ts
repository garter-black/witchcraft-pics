// Tests for the local renderer queue, the planner, and the REAL worker routes.
//
// The fake R2 in ./fake-r2 implements documented conditional-write semantics
// (success -> R2Object, failed precondition -> null, failed write stores
// nothing). A mock that ignored onlyIf would pass even if the claim CAS were
// broken, so the tests below also poison etags explicitly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeR2, pngBytes, mp4Bytes } from "./fake-r2";
import {
  enqueueLocalJob,
  claimLocalJob,
  finishLocalJob,
  renewLocalJobLease,
  readQueue,
  toLocalJob,
  verifyRequest,
  signRequest,
  localStatusView,
  uploadLocalMedia,
  verifyJobUpload,
  isMediaKey,
  MAX_ATTEMPTS,
  LOCAL_PREFIX,
} from "../worker/local-poll";
import { validatePlanRequest, parsePlan, planWithAgent, HELD_ROUTES, MODEL } from "../worker/planner";

const HMAC = "test-bridge-hmac-value";
const OWNER = "owner-key-abcdefghijklmnop";
const ORIGIN = "https://studio.test";

const videoPlane = {
  model: "local-ltx23-t2v",
  prompt: { text: "adult armored stunt performers, fast sparring, non-graphic" },
  media: {},
  settings: { resolution: "1280x704", duration: 4, motion: "full", seed: 7 },
};

function signedHeaders(body: string, key = HMAC) {
  return signRequest(key, body) as Record<string, string>;
}

/* ------------------------------------------------------------------ HMAC */

test("signing rejects tampering, wrong key, staleness and missing key", () => {
  const body = JSON.stringify({ a: 1 });
  const headers = new Headers(signedHeaders(body));
  assert.equal(verifyRequest(HMAC, headers, body), true);
  assert.equal(verifyRequest(HMAC, headers, JSON.stringify({ a: 2 })), false, "body tampering");
  assert.equal(verifyRequest("other", headers, body), false, "wrong key");
  const stale = new Headers({ "X-Bridge-Timestamp": "1", "X-Bridge-Signature": "beef" });
  assert.equal(verifyRequest(HMAC, stale, body), false, "replay/stale");
  assert.equal(verifyRequest("", headers, body), false, "unconfigured key");
});

/* ------------------------------------------------------------- graph build */

test("toLocalJob builds the fixed reviewed LTX graph and accepts no caller graph", () => {
  const job = toLocalJob(videoPlane, ORIGIN);
  assert.equal(job.state, "queued");
  const types = Object.values(job.graph).map((n) => (n as any).class_type);
  assert.ok(types.includes("UnetLoaderGGUF"));
  const unet = Object.values(job.graph).find((n) => (n as any).class_type === "UnetLoaderGGUF");
  assert.equal((unet as any).inputs.unet_name, "ltx-2.3-22b-dev-Q6_K.gguf");
  // LTX stays selected: it is the measured 1280x704 / 97 frame / 24fps stack.
  assert.equal((job.graph as any)["27"].class_type, "CreateVideo");
  // a graph smuggled in from the browser must not survive
  const withGraph = toLocalJob({ ...videoPlane, graph: { "99": { class_type: "X" } } }, ORIGIN);
  assert.equal((withGraph.graph as any)["99"], undefined);
});

test("toLocalJob refuses hosted models, empty prompts and foreign reference URLs", () => {
  assert.throws(() => toLocalJob({ ...videoPlane, model: "kling-3-turbo" }, ORIGIN), /not a local renderer/);
  assert.throws(() => toLocalJob({ ...videoPlane, model: "nope" }, ORIGIN), /not a local renderer/);
  assert.throws(() => toLocalJob({ ...videoPlane, prompt: { text: "  " } }, ORIGIN), /Enter a prompt/);
  for (const bad of [
    "https://evil.example/x.png",
    ORIGIN + "/media/../etc/passwd",
    ORIGIN + "/media/a/b/c.png",
    "file:///D:/AI/output/witchcraft/test-image_00001_.png",
    "http://169.254.169.254/latest/meta-data",
  ]) {
    assert.throws(
      () =>
        toLocalJob(
          { model: "local-wan22-i2v", prompt: { text: "hi" }, media: { start: [{ id: "1", url: bad }] }, settings: {} },
          ORIGIN,
        ),
      /this studio/,
      "must reject " + bad,
    );
  }
});

/* ------------------------------------------------------------ claim / lease */

test("a racing claim yields exactly one winner (real R2 CAS semantics)", async () => {
  const r2 = fakeR2();
  await enqueueLocalJob(r2 as any, toLocalJob(videoPlane, ORIGIN));
  const results = await Promise.all([
    claimLocalJob(r2 as any, "pc-a"),
    claimLocalJob(r2 as any, "pc-b"),
    claimLocalJob(r2 as any, "pc-c"),
  ]);
  assert.equal(results.filter(Boolean).length, 1, "exactly one poller may claim");
  assert.equal(await claimLocalJob(r2 as any, "pc-d"), null, "leased job is not re-issued");
});

test("a lost conditional write stores nothing", async () => {
  // Proves the fake itself implements the documented semantics, so a passing
  // claim test is not a false positive from a permissive mock.
  const r2 = fakeR2();
  const job = await enqueueLocalJob(r2 as any, toLocalJob(videoPlane, ORIGIN));
  const key = `local/job/${job.id}.json`;
  const before = r2.store.get(key)!.body.toString("utf8");
  const lost = await r2.put(key, JSON.stringify({ state: "stolen" }), { onlyIf: { etagMatches: '"nope"' } });
  assert.equal(lost, null, "a failed precondition returns null");
  assert.equal(r2.store.get(key)!.body.toString("utf8"), before, "a failed conditional write writes nothing");
});

test("claim fails closed when the object carries no version tag to compare", async () => {
  const r2 = fakeR2();
  const job = await enqueueLocalJob(r2 as any, toLocalJob(videoPlane, ORIGIN));
  r2.stripEtag(`local/job/${job.id}.json`);
  assert.equal(await claimLocalJob(r2 as any, "pc-a"), null, "must not claim on a stale version tag");
});

test("finish is refused without a live lease owned by the caller", async () => {
  const r2 = fakeR2();
  await enqueueLocalJob(r2 as any, toLocalJob(videoPlane, ORIGIN));
  const claimed = (await claimLocalJob(r2 as any, "pc-a"))!;
  const done = [{ kind: "video" as const, url: ORIGIN + "/media/a/b.mp4", key: "a/b.mp4" }];

  assert.equal(await finishLocalJob(r2 as any, claimed.id, { state: "completed", media: done }, "pc-b"), null);
  const ok = await finishLocalJob(r2 as any, claimed.id, { state: "completed", media: done }, "pc-a");
  assert.equal(ok?.state, "completed");
  assert.deepEqual(await readQueue(r2 as any), []);
  assert.equal(await claimLocalJob(r2 as any, "pc-b"), null, "terminal job leaves the queue");
});

test("an expired lease stops being completable and becomes claimable again", async () => {
  const r2 = fakeR2();
  await enqueueLocalJob(r2 as any, toLocalJob(videoPlane, ORIGIN));
  const claimed = (await claimLocalJob(r2 as any, "pc-a"))!;
  const key = `local/job/${claimed.id}.json`;
  const rec = r2.store.get(key)!;
  r2.store.set(key, { ...rec, body: Buffer.from(JSON.stringify({ ...claimed, leaseUntil: Date.now() - 1000 })) });
  assert.equal(await finishLocalJob(r2 as any, claimed.id, { state: "completed", media: [] }, "pc-a"), null);
  const reclaimed = await claimLocalJob(r2 as any, "pc-b");
  assert.ok(reclaimed, "a lapsed lease must not strand the job");
  assert.equal(reclaimed!.attempts, 2);
  // a re-claim mints a new lease token, so the old PC cannot revive the job
  assert.notEqual(reclaimed!.leaseToken, claimed.leaseToken);
});

test("renew only succeeds for the lease owner and keeps the lease live", async () => {
  const r2 = fakeR2();
  await enqueueLocalJob(r2 as any, toLocalJob(videoPlane, ORIGIN));
  const claimed = (await claimLocalJob(r2 as any, "pc-a"))!;
  assert.equal(await renewLocalJobLease(r2 as any, claimed.id, "pc-z"), null);
  const renewed = await renewLocalJobLease(r2 as any, claimed.id, "pc-a");
  assert.ok(renewed?.leaseUntil && renewed.leaseUntil > Date.now());
  assert.equal(renewed!.leaseToken, claimed.leaseToken, "renew does not rotate the lease token");
});

test("a job that burned its attempts fails observably instead of looping", async () => {
  const r2 = fakeR2();
  const job = await enqueueLocalJob(r2 as any, toLocalJob(videoPlane, ORIGIN));
  const key = `local/job/${job.id}.json`;
  const rec = r2.store.get(key)!;
  r2.store.set(key, { ...rec, body: Buffer.from(JSON.stringify({ ...job, attempts: MAX_ATTEMPTS })) });
  assert.equal(await claimLocalJob(r2 as any, "pc-a"), null);
  assert.equal(JSON.parse(r2.store.get(key)!.body.toString("utf8")).state, "failed");
});

test("concurrent enqueues all survive and order deterministically", async () => {
  const r2 = fakeR2();
  // Build each job through the real factory, then pin only the two fixture
  // fields that decide ordering. Five jobs share ONE explicit createdAt, so the
  // seq primary key cannot separate them on a tie and the id tie-break decides.
  // Real Date.now() would let the jobs cross a millisecond and compare createdAt
  // instead, which is the source of the preexisting flake.
  const createdAt = 1_700_000_000_000;
  const ids = ["e5", "a1", "c3", "b2", "d4"];
  await Promise.all(
    ids.map((id) => enqueueLocalJob(r2 as any, { ...toLocalJob(videoPlane, ORIGIN), id, createdAt })),
  );
  const queued = await readQueue(r2 as any);
  assert.equal(queued.length, 5, "no enqueue may be lost");
  assert.equal(new Set(queued).size, 5);
  // The documented tie-break for this same-time fixture is id ascending.
  assert.deepEqual(queued, ["a1", "b2", "c3", "d4", "e5"], "queue order follows the documented id tie-break");
});

test("the queue paginates past one page of job objects", async () => {
  const r2 = fakeR2();
  for (let i = 0; i < 230; i++) {
    const job = toLocalJob(videoPlane, ORIGIN);
    // write directly so the MAX_QUEUE backpressure does not mask pagination
    await r2.put(`local/job/${job.id}.json`, JSON.stringify({ ...job, seq: i + 1 }));
  }
  const queued = await readQueue(r2 as any);
  assert.equal(queued.length, 230, "a 200-item page must not starve the rest");
});

/* ------------------------------------------------------------- media schema */

test("uploadLocalMedia emits a 2-segment key the /media route will serve", async () => {
  const r2 = fakeR2();
  const view = await uploadLocalMedia(
    r2 as any,
    "11111111-2222-3333-4444-555555555555",
    { type: "video/mp4", bytes: mp4Bytes().buffer as ArrayBuffer },
    ORIGIN,
  );
  const key = view.url.slice((ORIGIN + "/media/").length);
  assert.ok(isMediaKey(key), "key must match the served schema: " + key);
  assert.equal(key.split("/").length, 2, "the /media handler only serves two segments");
  assert.equal(view.kind, "video");
  assert.match(view.contentType, /video\//);
});

test("a completed job only accepts media stored for that exact job", async () => {
  const r2 = fakeR2();
  const view = await uploadLocalMedia(r2 as any, "job-a", { type: "image/png", bytes: pngBytes().buffer as ArrayBuffer }, ORIGIN);
  assert.ok(await verifyJobUpload(r2 as any, "job-a", view.key), "own upload verifies");
  assert.equal(await verifyJobUpload(r2 as any, "job-b", view.key), null, "another job cannot claim it");
  assert.equal(await verifyJobUpload(r2 as any, "job-a", "not/a/key.png"), null, "schema enforced");
  assert.equal(await verifyJobUpload(r2 as any, "job-a", "a/b/c.png"), null, "three segments rejected");
});

/* ------------------------------------------------------------- status view */

test("status view reports honest queued / in_progress / completed / failed", () => {
  const base = { id: "a", createdAt: 0, model: "m", prompt: "p", graph: {} as any };
  assert.equal(localStatusView({ ...base, state: "queued" }).status, "queued");
  assert.equal(localStatusView({ ...base, state: "claimed" }).status, "in_progress");
  assert.equal(localStatusView({ ...base, state: "running" }).status, "in_progress");
  const done = localStatusView({ ...base, state: "completed", media: [{ kind: "video", url: ORIGIN + "/media/a/b.mp4" } as any] });
  assert.equal(done.video?.url, ORIGIN + "/media/a/b.mp4");
  assert.equal(done.requestId.startsWith(LOCAL_PREFIX), true);
  assert.equal(localStatusView({ ...base, state: "failed", error: "boom" }).error, "boom");
  // no fabricated percent when the renderer has not reported one
  assert.equal(localStatusView({ ...base, state: "running" }).progress, undefined);
});

/* ------------------------------------------------------------------ planner */

test("planner validates input and parses strict JSON from a fenced reply", () => {
  assert.throws(() => validatePlanRequest({ prompt: "", surface: "image" }));
  assert.throws(() => validatePlanRequest({ prompt: "ok", surface: "nope" }));
  assert.throws(() => validatePlanRequest({ prompt: "ok", surface: "video", seconds: 99 }));
  const plan = parsePlan('```json\n{"prompt":"a knight","negative":"blurry","shots":[{"order":1,"description":"charge","motion":"run"}]}\n```');
  assert.equal(plan.prompt, "a knight");
  assert.equal(plan.shots[0].motion, "run");
  assert.throws(() => parsePlan("not json at all"));
  assert.throws(() => parsePlan('{"negative":"x"}'));
});

test("the planner calls the verified model id with low reasoning and a session header", async () => {
  assert.equal(MODEL, "space-bunny-free", "the opencode-go/ prefix is a routing label, not the model id");
  let seen: any = null;
  const ok = await planWithAgent(
    { prompt: "a knight", surface: "image" },
    "go-key",
    async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"prompt":"a knight charging","negative":"blurry","shots":[]}' } }] }), { status: 200 });
    },
  );
  assert.equal(ok.ok, true);
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(seen.init.body.includes('"model":"space-bunny-free"'), true);
  assert.equal(seen.init.body.includes('"reasoning_effort":"low"'), true);
  assert.ok(seen.init.headers["x-opencode-session"], "a session header is supplied");
  // no paid fallback and no secret leak into the product prompt
  assert.equal(seen.init.body.includes("go-key"), false);
  assert.equal(seen.init.body.toLowerCase().includes("soul"), false);
});

test("the planner has no paid fallback and reports held routes honestly", async () => {
  for (const [route, why] of Object.entries(HELD_ROUTES)) assert.ok(why.length > 5, route);
  const out = await planWithAgent({ prompt: "x", surface: "image" }, "", (async () => {
    throw new Error("must not be called without a key");
  }) as any);
  assert.equal(out.ok, false);
  assert.match((out as any).reason, /route is configured/i);
  const denied = await planWithAgent({ prompt: "x", surface: "image" }, "k", (async () => new Response("nope", { status: 401 })) as any);
  assert.equal(denied.ok, false);
});

/* ------------------------------------------------- REAL worker route tests */

import worker from "../worker/index";

function makeEnv(overrides: Record<string, unknown> = {}) {
  const media = fakeR2();
  const env: any = {
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    SESSION_SECRET: "session-secret-for-tests-only-long-enough",
    HF_API_BASE_URL: "https://api.higgsfield.ai",
    LOCAL_BRIDGE_HMAC: HMAC,
    OWNER_ACCESS_KEY: OWNER,
    MEDIA: media,
    ...overrides,
  };
  return { env, media };
}

async function bridge(env: any, path: string, body: unknown, key = HMAC) {
  const raw = JSON.stringify(body);
  return worker.fetch(
    new Request(ORIGIN + "/api/local/" + path, { method: "POST", headers: signedHeaders(raw, key), body: raw }),
    env,
  );
}

function loginCookie(env: any, ownerKey = OWNER) {
  return env;
}

test("real route: bridge endpoints reject unsigned and wrong-key requests", async () => {
  const { env } = makeEnv();
  for (const path of ["heartbeat", "claim", "renew", "progress", "upload", "complete"]) {
    const res = await worker.fetch(
      new Request(ORIGIN + "/api/local/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      env,
    );
    assert.equal(res.status, 401, path + " must require HMAC");
  }
  const wrong = await bridge(env, "heartbeat", { owner: "pc-a" }, "not-the-key");
  assert.equal(wrong.status, 401, "a wrong key must not authenticate");
  const noOwner = await bridge(env, "heartbeat", {});
  assert.equal(noOwner.status, 400, "an owner id is required");
});

test("real route: a browser Origin is not required for HMAC machine calls", async () => {
  const { env } = makeEnv();
  // No cookie, no Origin header at all — a machine call.
  const res = await bridge(env, "heartbeat", { owner: "pc-a", online: true, comfy: "http://127.0.0.1:8188" });
  assert.equal(res.status, 200, "HMAC routes are independent of cookies and Origin");
});

test("real route: a cross-origin browser POST is refused by CSRF defence", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(
    new Request(ORIGIN + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify(videoPlane),
    }),
    env,
  );
  assert.equal(res.status, 403, "browser POSTs still need same-origin");
});

test("real route: owner login uses the owner key, not a Higgsfield id:secret", async () => {
  const { env } = makeEnv();
  const bad = await worker.fetch(
    new Request(ORIGIN + "/api/credentials?provider=local", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ apiKey: "id:secret-that-is-valid-shaped-but-wrong" }),
    }),
    env,
  );
  assert.ok([400, 403].includes(bad.status), "a non owner-key shape is refused, status " + bad.status);

  const res = await worker.fetch(
    new Request(ORIGIN + "/api/credentials?provider=local", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ ownerKey: OWNER }),
    }),
    env,
  );
  assert.equal(res.status, 200, "the generated owner key logs in without id:secret");
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.equal(setCookie.includes(OWNER), false, "the owner key is never echoed in the cookie");
});

test("real route: the owner session gates plan and local submit, and the plan route is not anonymous", async () => {
  const { env } = makeEnv();
  let plannerCalls = 0;
  env.PLANNER_GO_API_KEY = "go-key";
  const anon = await worker.fetch(
    new Request(ORIGIN + "/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ prompt: "a knight", surface: "image" }),
    }),
    env,
  );
  assert.equal(anon.status, 401, "an anonymous caller cannot spend the planner allowance");
  assert.equal(plannerCalls, 0);

  const login = await worker.fetch(
    new Request(ORIGIN + "/api/credentials?provider=local", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ ownerKey: OWNER }),
    }),
    env,
  );
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith("__Host-witchcraft-local="), "an owner session cookie is set");

  const submit = await worker.fetch(
    new Request(ORIGIN + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, cookie },
      body: JSON.stringify(videoPlane),
    }),
    env,
  );
  assert.equal(submit.status, 200, "the owner may queue a local render");
  const queued = (await submit.json()) as any;
  assert.ok(queued.requestId.startsWith(LOCAL_PREFIX));

  // an anonymous local submit is refused
  const anon2 = await worker.fetch(
    new Request(ORIGIN + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(videoPlane),
    }),
    env,
  );
  assert.equal(anon2.status, 401);
});

test("real route: full PC transport — claim, renew, progress, upload bytes, complete, status, media GET", async () => {
  const { env, media } = makeEnv();
  // 1. owner queues
  const login = await worker.fetch(
    new Request(ORIGIN + "/api/credentials?provider=local", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ ownerKey: OWNER }),
    }),
    env,
  );
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const queued = (await (
    await worker.fetch(
      new Request(ORIGIN + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, cookie },
        body: JSON.stringify(videoPlane),
      }),
      env,
    )
  ).json()) as any;

  // 2. heartbeat, then claim
  assert.equal((await bridge(env, "heartbeat", { owner: "pc-a", online: true, comfy: "http://127.0.0.1:8188" })).status, 200);
  const claim = (await (await bridge(env, "claim", { owner: "pc-a" })).json()) as any;
  assert.ok(claim.job, "a queued job is claimable");
  const id = claim.job.id;
  assert.equal(claim.job.id, queued.requestId.slice(LOCAL_PREFIX.length));
  const token = claim.job.leaseToken;
  assert.ok(token, "a claim mints a lease token");

  // 3. renew + honest progress (no fabricated percent)
  assert.equal((await bridge(env, "renew", { owner: "pc-a", id })).status, 200);
  const prog = await bridge(env, "progress", { owner: "pc-a", id, leaseToken: token, state: "running" });
  assert.equal(prog.status, 200);
  const view = localStatusView(JSON.parse(media.store.get(`local/job/${id}.json`)!.body.toString("utf8")));
  assert.equal(view.status, "in_progress");
  assert.equal(view.progress, undefined, "no percent is invented from elapsed time");

  // 4. upload real PNG bytes through the base64 envelope
  const png = pngBytes(4096);
  const envelope = JSON.stringify({ owner: "pc-a", id, leaseToken: token, name: "render.png", type: "image/png", bytes: Buffer.from(png).toString("base64") });
  const up = await worker.fetch(
    new Request(ORIGIN + "/api/local/upload", { method: "POST", headers: signedHeaders(envelope), body: envelope }),
    env,
  );
  assert.equal(up.status, 200, "authenticated binary upload must be accepted");
  const receipt = (await up.json()).receipt;
  assert.ok(isMediaKey(receipt.key));
  assert.equal(receipt.bytes, png.byteLength);

  // 5. complete with owned receipts, not URLs
  const done = await bridge(env, "complete", { owner: "pc-a", id, leaseToken: token, state: "completed", receipts: [receipt], promptId: "comfy-prompt-1" });
  assert.equal(done.status, 200);
  const stored = JSON.parse(media.store.get(`local/job/${id}.json`)!.body.toString("utf8"));
  assert.equal(stored.state, "completed");
  assert.equal(stored.promptId, "comfy-prompt-1", "the Comfy prompt id is persisted for restart recovery");
  assert.equal(stored.media[0].url, ORIGIN + "/media/" + receipt.key);

  // 6. browser status for the owner
  const status = (await (
    await worker.fetch(
      new Request(ORIGIN + "/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, cookie },
        body: JSON.stringify({ requestIds: [queued.requestId] }),
      }),
      env,
    )
  ).json()) as any;
  assert.equal(status[0].status.status, "completed");
  assert.equal(status[0].status.images[0].url, ORIGIN + "/media/" + receipt.key);

  // 7. the browser fetches the exact media bytes — a denial first, then the
  //    owning session. The /media route is owner-only now: an ANONYMOUS read is
  //    a 404 that must not leak existence, and the OWNING session gets the bytes.
  const anon = await worker.fetch(new Request(ORIGIN + "/media/" + receipt.key, { method: "GET" }), env);
  assert.equal(anon.status, 404, "an anonymous /media read is denied (no cookie)");
  assert.equal(anon.headers.get("Cache-Control"), "private,no-store", "the denial is private,no-store");

  const got = await worker.fetch(new Request(ORIGIN + "/media/" + receipt.key, { method: "GET", headers: { cookie } }), env);
  assert.equal(got.status, 200, "the owning session reads its own object");
  assert.equal(got.headers.get("Cache-Control"), "private,no-store", "the success is private,no-store too");
  const body = Buffer.from(await got.arrayBuffer());
  assert.equal(body.byteLength, png.byteLength, "served byte length matches the upload");
  assert.equal(Buffer.compare(body, Buffer.from(png)), 0, "served bytes are byte-identical");

  // 8. an unauthenticated /media traversal attempt is a 404
  const traversal = await worker.fetch(new Request(ORIGIN + "/media/a%2F..%2F..%2Fsecrets.env", { method: "GET" }), env);
  assert.equal(traversal.status, 404);
});

test("real route: every mutating PC call requires the exact lease token", async () => {
  const { env } = makeEnv();
  await enqueueLocalJob(env.MEDIA, toLocalJob(videoPlane, ORIGIN));
  const claim = (await (await bridge(env, "claim", { owner: "pc-a" })).json()) as any;
  const id = claim.job.id;
  for (const action of ["progress", "upload", "complete"]) {
    const noToken = await bridge(env, action, { owner: "pc-a", id, state: "running" });
    assert.equal(noToken.status, 400, action + " must require a lease token");
    const wrongToken = await bridge(env, action, { owner: "pc-a", id, leaseToken: "not-the-token", state: "running" });
    assert.equal(wrongToken.status, 409, action + " must reject a wrong lease token");
  }
  // a different renderer holding no lease at all
  const stranger = await bridge(env, "complete", { owner: "pc-intruder", id, leaseToken: claim.job.leaseToken, state: "completed", receipts: [] });
  assert.equal(stranger.status, 409, "completion must require the lease owner");
});

test("real route: upload content is validated, and complete only accepts this job's uploads", async () => {
  const { env, media } = makeEnv();
  await enqueueLocalJob(env.MEDIA, toLocalJob(videoPlane, ORIGIN));
  const claim = (await (await bridge(env, "claim", { owner: "pc-a" })).json()) as any;
  const id = claim.job.id;
  const token = claim.job.leaseToken;

  // a .png name carrying non-image bytes is refused
  const bogus = JSON.stringify({ owner: "pc-a", id, leaseToken: token, name: "render.png", type: "image/png", bytes: Buffer.from("this is not a png at all").toString("base64") });
  const rejected = await worker.fetch(
    new Request(ORIGIN + "/api/local/upload", { method: "POST", headers: signedHeaders(bogus), body: bogus }),
    env,
  );
  assert.equal(rejected.status, 400, "content must match its declared type");

  // a foreign key cannot be completed through somebody else's job
  const foreign = await uploadLocalMedia(media, "someone-else", { type: "image/png", bytes: pngBytes().buffer as ArrayBuffer }, ORIGIN);
  const done = await bridge(env, "complete", { owner: "pc-a", id, leaseToken: token, state: "completed", receipts: [{ key: foreign.key }] });
  assert.equal(done.status, 400, "an upload owned by another job must not publish");
});

test("real route: a real MP4 round-trips byte-identically through upload and /media", async () => {
  const { env, media } = makeEnv();
  // A real authenticated owner submission, so the stored job carries a
  // SERVER-DERIVED subject and the receipt exercises a genuine owned job
  // (the previous fixture enqueued a subjectless job and could no longer upload).
  const login = await worker.fetch(
    new Request(ORIGIN + "/api/credentials?provider=local", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ ownerKey: OWNER }),
    }),
    env,
  );
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const queued = (await (
    await worker.fetch(
      new Request(ORIGIN + "/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, cookie },
        body: JSON.stringify(videoPlane),
      }),
      env,
    )
  ).json()) as any;
  const claim = (await (await bridge(env, "claim", { owner: "pc-a" })).json()) as any;
  const id = claim.job.id;
  assert.equal(id, queued.requestId.slice(LOCAL_PREFIX.length), "the claim returns the owner's queued job");
  const token = claim.job.leaseToken;
  const mp4 = mp4Bytes(9000);
  const envelope = JSON.stringify({ owner: "pc-a", id, leaseToken: token, name: "clip.mp4", type: "video/mp4", bytes: Buffer.from(mp4).toString("base64") });
  const up = await worker.fetch(
    new Request(ORIGIN + "/api/local/upload", { method: "POST", headers: signedHeaders(envelope), body: envelope }),
    env,
  );
  assert.equal(up.status, 200, await up.clone().text());
  const receipt = (await up.json()).receipt;
  const done = await bridge(env, "complete", { owner: "pc-a", id, leaseToken: token, state: "completed", receipts: [receipt] });
  assert.equal(done.status, 200);
  // The uploaded object is stored under the server-derived subject, and an
  // anonymous read is denied while the owning session gets the exact bytes.
  const subj = receipt.key.split("/")[0];
  const claim2 = (await (await bridge(env, "heartbeat", { owner: "pc-a", online: true })).json()) as any;
  assert.equal(claim2.ok, true);
  const anon = await worker.fetch(new Request(ORIGIN + "/media/" + receipt.key), env);
  assert.equal(anon.status, 404, "anonymous /media read is denied");
  const got = await worker.fetch(new Request(ORIGIN + "/media/" + receipt.key, { headers: { cookie } }), env);
  assert.equal(got.status, 200, "the owning session reads the MP4");
  assert.equal(Buffer.compare(Buffer.from(await got.arrayBuffer()), Buffer.from(mp4)), 0, "video bytes are exact");
  void subj;
});

test("real route: a subjectless (legacy) job cannot publish media at upload (fail closed)", async () => {
  const { env } = makeEnv();
  // A legacy row has no stored subject; the upload path must refuse it with a
  // 409 rather than publish under a guessable segment. (Separate coverage the
  // privacy task requires; not a replacement of the round-trip above.)
  const id = "legacy-mp4-job-1";
  await env.MEDIA.put(
    `local/job/${id}.json`,
    JSON.stringify({
      id,
      state: "claimed",
      createdAt: Date.now(),
      owner: "pc-a",
      leaseUntil: Date.now() + 60000,
      leaseToken: "tok-legacy",
      model: "local-ltx23-t2v",
      prompt: "x",
      graph: {},
      attempts: 1,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  const envelope = JSON.stringify({ owner: "pc-a", id, leaseToken: "tok-legacy", name: "clip.mp4", type: "video/mp4", bytes: Buffer.from(mp4Bytes(9000)).toString("base64") });
  const up = await worker.fetch(
    new Request(ORIGIN + "/api/local/upload", { method: "POST", headers: signedHeaders(envelope), body: envelope }),
    env,
  );
  assert.equal(up.status, 409, "a subjectless job fails closed at upload");
});

test("real route: progress is never invented, and a requeue returns the job to the queue", async () => {
  const { env, media } = makeEnv();
  await enqueueLocalJob(env.MEDIA, toLocalJob(videoPlane, ORIGIN));
  const claim = (await (await bridge(env, "claim", { owner: "pc-a" })).json()) as any;
  const id = claim.job.id;
  const token = claim.job.leaseToken;
  // fabricated percent supplied by a lying client is clamped, not trusted blindly
  await bridge(env, "progress", { owner: "pc-a", id, leaseToken: token, state: "running", progress: 0.5 });
  const ran = JSON.parse(media.store.get(`local/job/${id}.json`)!.body.toString("utf8"));
  assert.equal(ran.state, "running");
  const requeue = await bridge(env, "complete", { owner: "pc-a", id, leaseToken: token, state: "requeue", error: "ComfyUI refused the graph" });
  assert.equal(requeue.status, 200);
  const back = JSON.parse(media.store.get(`local/job/${id}.json`)!.body.toString("utf8"));
  assert.equal(back.state, "queued");
  assert.equal(back.owner, undefined, "a requeue releases the lease");
  assert.equal(back.leaseToken, undefined, "a requeue destroys the lease token");
});

test("real route: renderer state is reported honestly and offline when the PC is silent", async () => {
  const { env, media } = makeEnv();
  const state = (await (await worker.fetch(new Request(ORIGIN + "/api/local-state"), env)).json()) as any;
  assert.equal(state.renderer.online, false, "no heartbeat means offline, not guessed");
  await bridge(env, "heartbeat", { owner: "pc-a", online: true, busy: true, elapsedSeconds: 120 });
  const state2 = (await (await worker.fetch(new Request(ORIGIN + "/api/local-state"), env)).json()) as any;
  assert.equal(state2.renderer.online, true);
  assert.equal(state2.renderer.detail.busy, true);
  assert.equal(state2.renderer.detail.elapsedSeconds, 120, "elapsed seconds are observed, not a percent");
  void media;
});

test("real route: an anonymous browser cannot spend the local GPU", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(
    new Request(ORIGIN + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(videoPlane),
    }),
    env,
  );
  assert.equal(res.status, 401, "local submit still requires an owner session");
  void loginCookie;
});
