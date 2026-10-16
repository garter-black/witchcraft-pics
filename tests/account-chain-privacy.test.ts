// ACCOUNT-CHAIN-PRIVACY — the identity-ON end-to-end chain, exercised through the
// REAL exported Worker.fetch with a REAL local RSA JWT/JWKS fixture.
//
// Scope (honest): this proves the WORKER code path when the identity layer is
// CONFIGURED (TEAM_DOMAIN + ACCESS_AUD present). It does NOT prove a live
// Cloudflare Access sign-in — no real team/AUD is configured and none is
// invented. The public world/assets stay open.
//
// The JWT is minted here with a locally generated RSA key and the bundle's JWKS
// resolver is pointed at a controlled global `fetch` that serves the matching
// JWKS. The verifier is NEVER bypassed: an invalid/forged/expired token really
// fails through the same code the live worker runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import worker, { seal } from "../worker/index";
import { fakeR2, pngBytes } from "./fake-r2";

// The suite swaps a controlled global `fetch` (for the JWKS endpoint) per test,
// so tests MUST run sequentially — a shared mutable global cannot be raced.
const seq = { concurrency: 1 as const };

const ORIGIN = "https://studio.test";
const SESSION_SECRET = "session-secret-for-tests-only-long-enough-value";
const BRIDGE = "bridge-hmac-value-for-tests";
const OWNER_KEY = "owner-key-abcdefghijklmnop";
// The bundle's JWKS resolver caches a key set per TEAM domain, so each test uses
// its OWN team domain to guarantee a fresh resolver (and its own key). A shared
// domain would make later tests reuse the first test's cached key set.
let TEAM = "https://team0.cloudflareaccess.com";
let AUD = "aud-tag-for-tests";
let ISSUER = TEAM; // verifyPrincipal strips a trailing slash

/** Advance to a fresh team domain (fresh JWKS resolver) for the next test. */
function freshTeam(n: number | string): void {
  TEAM = `https://team${n}.cloudflareaccess.com`;
  ISSUER = TEAM;
}

/* ------------------------------------------------ JWT/JWKS fixture ---------- */

type Key = { privateKey: any; jwk: any; kid: string };

function newKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as any), kid, alg: "RS256", use: "sig" };
  return { privateKey, jwk, kid };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signJwt(key: Key, payload: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid };
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  signer.end();
  return `${head}.${body}.${b64url(signer.sign(key.privateKey))}`;
}

/** A valid Access-style JWT for a given subject. */
function tokenFor(key: Key, sub: string, overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(key, {
    iss: ISSUER,
    aud: AUD,
    sub,
    type: "app",
    iat: now - 5,
    exp: now + 600,
    ...overrides,
  });
}

/** The p_<32hex> principal segment for a (issuer, sub) pair, computed the same
    way the accepted candidate does: first 32 hex of sha256(`${issuer}\n${sub}`). */
function expectedSegment(issuer: string, sub: string): string {
  return createHash("sha256").update(`${issuer}\n${sub}`).digest("hex").slice(0, 32);
}

/** Install a controlled global fetch that serves the JWKS for `keys` and
    nothing else, then restore it. Returns a restore function. */
function withJwks(keys: Key[]) {
  const jwks = { keys: keys.map((k) => k.jwk) };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/* --------------------------------------------------------- env/request ----- */

function makeEnv(overrides: Record<string, unknown> = {}) {
  const r2 = fakeR2();
  const env: any = {
    ASSETS: { fetch: async () => new Response("world", { status: 200, headers: { "content-type": "text/html" } }) },
    SESSION_SECRET,
    HF_API_BASE_URL: "https://api.higgsfield.ai",
    LOCAL_BRIDGE_HMAC: BRIDGE,
    OWNER_ACCESS_KEY: OWNER_KEY,
    MEDIA: r2,
    TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ...overrides,
  };
  return { env, r2 };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(ORIGIN + path, init);
}

function withAssertion(path: string, token: string|null, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("cf-access-jwt-assertion", token);
  return req(path, { ...init, headers });
}

/* ============================================================ ANONYMOUS ==== */

test("ANONYMOUS: no token -> private library 401, status 401, upload 401; public world still 200", seq, async () => {
  freshTeam(0);
  const restore = withJwks([]);
  try {
    const { env } = makeEnv();
    assert.equal((await worker.fetch(req("/api/library"), env)).status, 401);
    assert.equal((await worker.fetch(req("/api/identity"), env)).status, 200);
    const idBody: any = await (await worker.fetch(req("/api/identity"), env)).json();
    assert.equal(idBody.authenticated, false);
    assert.equal((await worker.fetch(req("/"), env)).status, 200);
  } finally { restore(); }
});

/* ================================================== VALID ACCOUNT (A) ====== */

test("ACCOUNT A: a VALID Access JWT authenticates; /api/identity exposes only the p_ principal", seq, async () => {
  freshTeam(1);
  const key = newKey("kA");
  const restore = withJwks([key]);
  try {
    const { env } = makeEnv();
    const token = tokenFor(key, "user-a-sub-0001", { email: "a@example.test" });
    const res = await worker.fetch(withAssertion("/api/identity", token), env);
    const body: any = await res.json();
    assert.equal(body.configured, true);
    assert.equal(body.authenticated, true);
    assert.equal(body.principal, "p_" + expectedSegment(ISSUER, "user-a-sub-0001"));
    assert.ok(!("email" in body), "email is never returned");
    assert.ok(!body.principal.includes("user-a-sub-0001"), "raw sub is never exposed");
  } finally { restore(); }
});

test("EXPIRED token is refused (authenticated:false)", seq, async () => {
  freshTeam(2);
  const key = newKey("kE");
  const restore = withJwks([key]);
  try {
    const { env } = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    const token = tokenFor(key, "user-exp", { iat: now - 1200, exp: now - 600 });
    const body: any = await (await worker.fetch(withAssertion("/api/identity", token), env)).json();
    assert.equal(body.authenticated, false);
  } finally { restore(); }
});

test("FORGED token (signed by a DIFFERENT key) is refused", seq, async () => {
  freshTeam(3);
  const real = newKey("kR");
  const attacker = newKey("kR"); // same kid, different private key
  const restore = withJwks([real]);
  try {
    const { env } = makeEnv();
    const token = tokenFor(attacker, "user-forged");
    const body: any = await (await worker.fetch(withAssertion("/api/identity", token), env)).json();
    assert.equal(body.authenticated, false);
  } finally { restore(); }
});

/* ============================== SAME PROVIDER KEY, DISTINCT ACCOUNTS ======= */

test("SAME provider key, DISTINCT accounts: A's media is invisible to B (no credential-hash fallback)", seq, async () => {
  freshTeam(4);
  const key = newKey("kAB");
  const restore = withJwks([key]);
  try {
    const { env, r2 } = makeEnv();
    const segA = "p_" + expectedSegment(ISSUER, "acct-A");
    // Seed an object owned by account A (as if uploaded under A's principal).
    const keyA = `${segA}/${"11111111-1111-1111-1111-111111111111"}.png`;
    await r2.put(keyA, pngBytes(), { httpMetadata: { contentType: "image/png" }, customMetadata: { owner: segA } });

    const tokenA = tokenFor(key, "acct-A");
    const tokenB = tokenFor(key, "acct-B");

    // A reads its own object.
    const readA = await worker.fetch(withAssertion(`/media/${keyA}`, tokenA), env);
    assert.equal(readA.status, 200, "owner A reads its own media");

    // B is DENIED the same object even though both share one provider key.
    const readB = await worker.fetch(withAssertion(`/media/${keyA}`, tokenB), env);
    assert.equal(readB.status, 404, "account B cannot read A's media");
  } finally { restore(); }
});

/* ==================================== LOCAL ENQUEUE -> PRINCIPAL STAMPED ==== */

test("LOCAL ENQUEUE: a verified principal subject is STORED on the job (p_ not dropped)", seq, async () => {
  freshTeam(5);
  const key = newKey("kL");
  const restore = withJwks([key]);
  try {
    const { env, r2 } = makeEnv({ PLANNER_GO_API_KEY: "" });
    const segA = "p_" + expectedSegment(ISSUER, "acct-A");
    const tokenA = tokenFor(key, "acct-A");

    // A valid local job body for a known local preset model. Local GPU submit is
    // OWNER-ONLY: identity alone is not spend privilege, so the owner cookie must
    // be present and BOUND to the verified principal. Mint it exactly as the
    // worker does (real seal(..., 'local', segA)) — no test-only bypass.
    const ownerCookie = "__Host-witchcraft-local=" + (await seal(OWNER_KEY, SESSION_SECRET, "local", segA));
    const body = {
      model: "local-realvis-sdxl",
      prompt: { text: "a quiet room" },
      media: {},
      settings: {},
    };
    const res = await worker.fetch(
      withAssertion("/api/generate", tokenA, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", cookie: ownerCookie },
        body: JSON.stringify(body),
      }),
      env,
    );
    assert.equal(res.status, 200, `local enqueue should succeed (got ${res.status})`);
    const out: any = await res.json();
    assert.ok(out.requestId?.startsWith("lc:"), "returns a local request id");

    // Read the stored job straight from the fake store and assert the subject.
    const id = out.requestId.slice(3);
    const stored: any = await (await r2.get(`local/job/${id}.json`))!.json();
    assert.equal(stored.subject, segA, "the verified principal is stored as the job subject");
  } finally { restore(); }
});

/* ================================ BRIDGE UPLOAD -> LOCAL STATUS ============= */

test("BRIDGE UPLOAD: stored p_ subject prefixes the output; own local status returns a valid PNG url; B is denied", seq, async () => {
  freshTeam(6);
  const key = newKey("kB");
  const restore = withJwks([key]);
  try {
    const { env, r2 } = makeEnv();
    const segA = "p_" + expectedSegment(ISSUER, "acct-A");

    // Seed a queued job owned by A (what local enqueue would have written).
    const jobId = "abc1234567890abc";
    await r2.put(`local/job/${jobId}.json`, JSON.stringify({
      id: jobId, state: "claimed", createdAt: Date.now(), model: "local-realvis-sdxl",
      prompt: "x", graph: {}, owner: "renderer-1", subject: segA,
      leaseUntil: Date.now() + 600_000, leaseToken: "tok-1", attempts: 1,
    }), { httpMetadata: { contentType: "application/json" } });

    // Bridge upload: HMAC over the exact raw body.
    const { createHmac } = await import("node:crypto");
    const png = Buffer.from(pngBytes());
    const payload = JSON.stringify({ id: jobId, leaseToken: "tok-1", owner: "renderer-1", name: "render.png", type: "image/png", bytes: png.toString("base64") });
    const stamp = `${Math.floor(Date.now() / 1000)}`;
    const sig = createHmac("sha256", BRIDGE).update(`${stamp}.${payload}`).digest("hex");
    const up = await worker.fetch(
      req("/api/local/upload", {
        method: "POST",
        headers: { "X-Bridge-Timestamp": stamp, "X-Bridge-Signature": sig, "Content-Type": "application/json" },
        body: payload,
      }),
      env,
    );
    assert.equal(up.status, 200, `bridge upload should succeed (got ${up.status})`);
    const upBody: any = await up.json();
    assert.ok(upBody.key.startsWith(segA + "/"), `stored key is prefixed with the p_ subject (got ${upBody.key})`);

    // Complete the job then read its LOCAL status under A.
    const completePayload = JSON.stringify({ id: jobId, leaseToken: "tok-1", owner: "renderer-1", state: "completed", receipts: [{ key: upBody.key }] });
    const cStamp = `${Math.floor(Date.now() / 1000)}`;
    const cSig = createHmac("sha256", BRIDGE).update(`${cStamp}.${completePayload}`).digest("hex");
    await worker.fetch(req("/api/local/complete", {
      method: "POST",
      headers: { "X-Bridge-Timestamp": cStamp, "X-Bridge-Signature": cSig, "Content-Type": "application/json" },
      body: completePayload,
    }), env);

    const tokenA = tokenFor(key, "acct-A");
    const tokenB = tokenFor(key, "acct-B");
    const statusA = await worker.fetch(withAssertion("/api/status", tokenA, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ requestIds: ["lc:" + jobId] }),
    }), env);
    const bodyA: any = await statusA.json();
    assert.ok(Array.isArray(bodyA), "status returns an array of results");
    const entryA = bodyA.find((e: any) => e.requestId === "lc:" + jobId);
    assert.ok(entryA && entryA.status && entryA.status.status === "completed", "own local status returns completed");
    assert.match(String(entryA.status.images?.[0]?.url ?? ""), /\/media\/p_[0-9a-f]{32}\//, "own status returns a same-origin p_ media url");

    const statusB = await worker.fetch(withAssertion("/api/status", tokenB, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ requestIds: ["lc:" + jobId] }),
    }), env);
    const bodyB: any = await statusB.json();
    assert.ok(Array.isArray(bodyB), "status returns an array of results");
    const entryB = bodyB.find((e: any) => e.requestId === "lc:" + jobId);
    assert.ok(!(entryB && entryB.status), "account B is denied A's local job status");
  } finally { restore(); }
});

/* ============================== LEGACY UNBOUND COOKIE REFUSED (ON) ========= */

test("LEGACY UNBOUND cookie is REFUSED when identity is ON (no credential-hash ownership)", seq, async () => {
  freshTeam(7);
  const key = newKey("kU");
  const restore = withJwks([key]);
  try {
    const { env, r2 } = makeEnv();
    // A legacy media object under a bare 32-hex (credential-hash) segment.
    const legacySeg = "a".repeat(32);
    const legacyKey = `${legacySeg}/22222222-2222-2222-2222-222222222222.png`;
    await r2.put(legacyKey, pngBytes(), { httpMetadata: { contentType: "image/png" }, customMetadata: { owner: legacySeg } });

    // Even a VERIFIED principal cannot read a legacy credential-hash-owned
    // object: credential hashes are not ownership subjects when identity is ON.
    const tokenA = tokenFor(key, "acct-A");
    const read = await worker.fetch(withAssertion(`/media/${legacyKey}`, tokenA), env);
    assert.equal(read.status, 404, "legacy credential-hash object is not auto-adopted by a new account");
  } finally { restore(); }
});

/* ================================ PROVIDER-COOKIE MISMATCH (SHARED KEY) ==== */

test("SHARED KEY: account B's verified principal rejects account A's bound provider cookie BEFORE upstream", seq, async () => {
  freshTeam(8);
  const key = newKey("kM");
  const restore = withJwks([key]);
  try {
    const { env } = makeEnv();
    const tokenA = tokenFor(key, "acct-A");
    const tokenB = tokenFor(key, "acct-B");

    // Account A mints a provider cookie BOUND to A's principal. We drive the
    // real /api/credentials route by stubbing the provider verification fetch.
    const real = globalThis.fetch;
    (globalThis as any).fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (url.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Provider key verification: accept with 404 (the worker treats a 404 as
      // "reachable, key shape ok", never a 401/403 rejection).
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const setRes = await worker.fetch(withAssertion("/api/credentials", tokenA, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      // The provider key is an id:secret pair (parseCredentialInput contract).
      body: JSON.stringify({ apiKey: "acct-id:secret-value-1234567890" }),
    }), env);
    assert.equal(setRes.status, 200, "account A can connect the provider key");
    const setCookie = setRes.headers.get("Set-Cookie") || "";
    const cookieVal = setCookie.split(";")[0]; // __Host-witchcraft-session=...

    // Account B presents A's bound cookie: the sealed cookie is bound to A, so
    // B must get NO credential for it. (This route reads the cookie only.)
    const credsB = await worker.fetch(withAssertion("/api/credentials", tokenB, { headers: { cookie: cookieVal } }), env);
    const credsBody: any = await credsB.json();
    assert.equal(credsBody.configured, false, "B does not inherit A's bound cookie");

    // And a generate call under B with A's cookie must be refused 401 (no key).
    const gen = await worker.fetch(withAssertion("/api/generate", tokenB, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", cookie: cookieVal },
      body: JSON.stringify({ model: "higgsfield-soul", prompt: { text: "x" } }),
    }), env);
    assert.equal(gen.status, 401, "B cannot spend with A's bound cookie");

    (globalThis as any).fetch = real;
  } finally { restore(); }
});

/* ================================== LOGIN ALONE CANNOT GRANT OWNER ========= */

test("LOGIN ALONE cannot use the owner GPU (/api/plan, local generate) without the owner cookie", seq, async () => {
  freshTeam(9);
  const key = newKey("kO");
  const restore = withJwks([key]);
  try {
    const { env } = makeEnv();
    const tokenA = tokenFor(key, "acct-A");
    // /api/plan needs the local owner session; a verified principal alone is not it.
    const plan = await worker.fetch(withAssertion("/api/plan", tokenA, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ surface: "image", prompt: "a room" }),
    }), env);
    assert.equal(plan.status, 401, "login does not grant the owner planner allowance");

    // Local generate without the owner cookie is refused.
    const gen = await worker.fetch(withAssertion("/api/generate", tokenA, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "local-realvis-sdxl", prompt: { text: "x" } }),
    }), env);
    assert.equal(gen.status, 401, "login does not grant the owner GPU");
  } finally { restore(); }
});

/* ============================ AUTH ENTRY ROUTES (login-only) =============== */

test("AUTH: /auth/login is a fixed same-origin 302 to /studio (no open redirect)", seq, async () => {
  freshTeam(10);
  const restore = withJwks([]);
  try {
    const { env } = makeEnv();
    // A hostile ?next= must be IGNORED: the target is always /studio on THIS origin.
    const res = await worker.fetch(req("/auth/login?next=https://evil.test/steal"), env);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("Location"), ORIGIN + "/studio");
    assert.equal(res.headers.get("Cache-Control"), "private,no-store");
    // A non-GET is refused.
    assert.equal((await worker.fetch(req("/auth/login", { method: "POST", headers: { Origin: ORIGIN } }), env)).status, 405);
  } finally { restore(); }
});

test("AUTH: /auth/logout requires a same-origin POST, clears our cookies, and never clears a foreign cookie", seq, async () => {
  freshTeam(11);
  const restore = withJwks([]);
  try {
    const { env } = makeEnv({ TEAM_DOMAIN: "https://zwt26420.cloudflareaccess.com" });
    // A bare GET (cross-site subresource) must NOT clear sessions.
    assert.equal((await worker.fetch(req("/auth/logout"), env)).status, 405);
    // A cross-origin POST is refused.
    assert.equal((await worker.fetch(req("/auth/logout", { method: "POST", headers: { Origin: "https://evil.test" } }), env)).status, 403);
    // A same-origin POST clears our three cookies and redirects to the documented
    // Access logout (fixed same-origin destination, no arbitrary next).
    const ok = await worker.fetch(req("/auth/logout", { method: "POST", headers: { Origin: ORIGIN } }), env);
    assert.equal(ok.status, 302);
    const setCookies = ok.headers.getSetCookie ? ok.headers.getSetCookie() : [ok.headers.get("Set-Cookie") || ""];
    const joined = setCookies.join("\n");
    assert.match(joined, /__Host-witchcraft-session=;/, "clears the higgsfield session cookie");
    assert.match(joined, /__Host-witchcraft-runpod=;/, "clears the runpod session cookie");
    assert.match(joined, /__Host-witchcraft-local=;/, "clears the owner session cookie");
    assert.ok(!/CF_Authorization/.test(joined), "never clears a cookie we did not set");
    // Item 4 (root, primary docs): the SAME-APPLICATION-DOMAIN /cdn-cgi/access/logout
    // on url.origin ends the Access identity; NO invented redirect_url/returnTo.
    assert.equal(ok.headers.get("Location"), ORIGIN + "/cdn-cgi/access/logout", "ends the Access identity on the same application domain");
    assert.ok(!/evil\.test/.test(ok.headers.get("Location") || ""), "no client-controlled redirect");
    assert.ok(!/[?&](redirect_url|returnTo|next)=/.test(ok.headers.get("Location") || ""), "no invented redirect query parameter");
  } finally { restore(); }
});

/* ==================== STATUS FINALIZER: SEQUENTIAL + NO-LEAK =============== */

test("STATUS: multiple hosted ids run the mirror SEQUENTIALLY (peak concurrent fetch = 1) and NEVER return a raw provider URL", seq, async () => {
  freshTeam(12);
  const key = newKey("kS");
  const realFetch = globalThis.fetch;
  try {
    const { env, r2 } = makeEnv({ MIRROR_ALLOWLIST: "media.provider.test" });
    const segA = "p_" + expectedSegment(ISSUER, "acct-A");
    const tokenA = tokenFor(key, "acct-A");
    // createPlatformClient legitimately requires a matching sealed provider
    // cookie — mint a REAL one bound to A's principal (do NOT weaken auth).
    const provCookie = "__Host-witchcraft-session=" + (await seal("fixture-id:fixture-secret", SESSION_SECRET, "higgsfield", segA));

    // Register ownership for two ids and record their canonical outputs.
    const { registerRequest } = await import("../worker/privacy/index");
    for (const id of ["req-aaaa1111", "req-bbbb2222"]) {
      await registerRequest(r2, { requestId: id, subject: segA, provider: "higgsfield" });
    }
    const { recordOwnerOutputs } = await import("../worker/privacy/hosted-output");
    await recordOwnerOutputs(env, segA, "req-aaaa1111", [{ url: "https://media.provider.test/a.png", contentType: "image/png" }]);
    await recordOwnerOutputs(env, segA, "req-bbbb2222", [{ url: "https://media.provider.test/b.png", contentType: "image/png" }]);

    // Instrument global fetch: count concurrent provider status + mirror fetches.
    // A small async delay INSIDE the counted region is required to discriminate
    // concurrency — without it even a concurrent batch would peak at 1.
    let inFlight = 0;
    let peak = 0;
    let providerCalls = 0;
    let mirrorCalls = 0;
    (globalThis as any).fetch = (async (input: any) => {
      const u = typeof input === "string" ? input : input?.url ?? String(input);
      if (u.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      inFlight += 1; peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 8)); // hold the slot so overlap is observable
        if (u.includes("media.provider.test")) {
          mirrorCalls += 1;
          return new Response(new Uint8Array(pngBytes()), { status: 200, headers: { "content-type": "image/png" } });
        }
        providerCalls += 1;
        // Provider status payload uses the REAL snake_case `request_id`
        // (mapStatus reads stringField(data,"request_id")), not `requestId`.
        const id = /req-[a-z0-9]+/i.exec(u)?.[0] ?? "req-aaaa1111";
        const body = JSON.stringify({ request_id: id, status: "completed", images: [{ url: `https://media.provider.test/${id}.png`, contentType: "image/png" }] });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      } finally {
        inFlight -= 1;
      }
    }) as typeof fetch;

    const res = await worker.fetch(withAssertion("/api/status", tokenA, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", cookie: provCookie },
      body: JSON.stringify({ requestIds: ["req-aaaa1111", "req-bbbb2222"] }),
    }), env);
    const body: any = await res.json();
    assert.ok(Array.isArray(body) && body.length === 2, "two results");
    assert.equal(peak, 1, `peak concurrent upstream fetch must be 1 (got ${peak}) — batch must be sequential`);
    assert.ok(providerCalls === 2, `both provider status ids were polled (got ${providerCalls})`);
    assert.ok(mirrorCalls === 2, `both outputs were actually MIRRORED (got ${mirrorCalls}) — a no-URL absence is not success`);

    // Never a raw provider URL on ANY returned status; only same-origin /media handles.
    const json = JSON.stringify(body);
    assert.ok(!/media\.provider\.test/.test(json), "no raw provider URL may reach the client");
    // EVERY entry must deliver at least one ACTUAL same-origin private handle —
    // "zero images" is NOT a pass. This proves a real successful mirror.
    for (const entry of body) {
      assert.ok(entry.status, "each returned entry carries a status object");
      const imgs = entry.status.images ?? [];
      assert.ok(imgs.length >= 1, "each entry delivered >=1 private media handle (empty is not success)");
      for (const im of imgs) {
        assert.match(String(im.url), /^\/media\/p_[0-9a-f]{32}\//, "own media is a same-origin p_ handle");
      }
      assert.ok(
        entry.status.outputState === undefined || entry.status.outputState === "mirrored" || entry.status.outputState === "partial",
        `own successful status is not a fail-closed state (got ${entry.status.outputState})`,
      );
    }
  } finally { (globalThis as any).fetch = realFetch; }
});

test("STATUS: an ownership-record FAILURE (fake R2 write THROWS) is explicit unavailable — NEVER a raw provider URL", seq, async () => {
  freshTeam(13);
  const key = newKey("kF");
  const realFetch = globalThis.fetch;
  try {
    const { env, r2 } = makeEnv({ MIRROR_ALLOWLIST: "media.provider.test" });
    const segA = "p_" + expectedSegment(ISSUER, "acct-A");
    const tokenA = tokenFor(key, "acct-A");
    // createPlatformClient legitimately requires a matching sealed provider
    // cookie — mint a REAL one bound to A's principal (do NOT weaken auth, and
    // do NOT omit it: without it the request is refused BEFORE upstream and the
    // record-failure path is never reached).
    const provCookie = "__Host-witchcraft-session=" + (await seal("fixture-id:fixture-secret", SESSION_SECRET, "higgsfield", segA));

    // Ownership MUST be registered first (else the id is refused before upstream),
    // so we register, then sabotage the OUTPUT RECORD write to simulate a GENUINE
    // storage failure. Real R2 put REJECTS (throws) on a storage error; returning
    // null means a failed onlyIf precondition, which is NOT a storage failure and
    // which recordOwnerOutputs correctly ignores. Throw so the record step fails.
    const { registerRequest } = await import("../worker/privacy/index");
    await registerRequest(r2, { requestId: "req-fail0001", subject: segA, provider: "higgsfield" });
    const realPut = (r2 as any).put.bind(r2);
    (r2 as any).put = async (k: string, v: unknown, o?: unknown) => {
      if (String(k).includes("/.outputs/")) throw new Error("R2 storage unavailable"); // genuine storage failure
      return realPut(k, v, o);
    };

    (globalThis as any).fetch = (async (input: any) => {
      const u = typeof input === "string" ? input : input?.url ?? String(input);
      if (u.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Provider status uses the REAL snake_case `request_id` (mapStatus reads
      // stringField(data,"request_id")).
      return new Response(JSON.stringify({ request_id: "req-fail0001", status: "completed", images: [{ url: "https://media.provider.test/secret.png", contentType: "image/png" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const res = await worker.fetch(withAssertion("/api/status", tokenA, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", cookie: provCookie },
      body: JSON.stringify({ requestIds: ["req-fail0001"] }),
    }), env);
    const body: any = await res.json();
    const json = JSON.stringify(body);
    assert.ok(!/media\.provider\.test/.test(json), "record failure must NOT leak the raw provider URL");
    const entry = body.find((e: any) => e.requestId === "req-fail0001");
    assert.ok(entry && entry.status, "an explicit status object is still returned");
    assert.ok(!(entry.status.images?.length), "no media URL is returned when the record step failed");
    assert.ok(entry.status.outputState === "unavailable" || entry.status.outputState === "unsupported", "explicit fail-closed outputState");
  } finally { (globalThis as any).fetch = realFetch; }
});

/* ==================== CLAIM-DRAIN HOLD (safe reload support) =============== */

/** HMAC-sign a bridge request body exactly as the PC poller does. */
async function bridgeReq(path: string, bodyObj: unknown) {
  const { createHmac } = await import("node:crypto");
  const payload = JSON.stringify(bodyObj);
  const stamp = `${Math.floor(Date.now() / 1000)}`;
  const sig = createHmac("sha256", BRIDGE).update(`${stamp}.${payload}`).digest("hex");
  return req(path, {
    method: "POST",
    headers: {
      "X-Bridge-Timestamp": stamp,
      "X-Bridge-Signature": sig,
      "Content-Type": "application/json",
    },
    body: payload,
  });
}

test("HOLD: with LOCAL_CLAIM_HOLD='true', a valid claim returns {job:null,draining:true} and does NOT dequeue the pending job", seq, async () => {
  freshTeam(14);
  const restore = withJwks([]);
  try {
    const { env, r2 } = makeEnv({ LOCAL_CLAIM_HOLD: "true" });
    // Seed a claimable queued job for the renderer owner.
    const jobId = "hold0000000001";
    await r2.put(`local/job/${jobId}.json`, JSON.stringify({
      id: jobId, state: "queued", createdAt: Date.now(), model: "local-realvis-sdxl",
      prompt: "x", graph: {}, attempts: 0, seq: 1,
    }), { httpMetadata: { contentType: "application/json" } });

    const res = await worker.fetch(await bridgeReq("/api/local/claim", { owner: "renderer-1" }), env);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.job, null, "no job is handed out while held");
    assert.equal(body.draining, true, "the PC is told the queue is draining");

    // The pending job is STILL queued in storage (not claimed/dequeued).
    const stored: any = await (await r2.get(`local/job/${jobId}.json`))!.json();
    assert.equal(stored.state, "queued", "held claim did not dequeue the job");
    assert.equal(stored.owner, undefined, "held claim did not stamp an owner");

    // Default (undefined) behaviour is UNCHANGED: the same job IS claimed.
    // Clear the hold FIRST (a held claim would just return draining again), on
    // the SAME env/r2 the job was seeded into — a fresh makeEnv() has an empty
    // store and would prove nothing.
    delete (env as any).LOCAL_CLAIM_HOLD;
    const ok = await worker.fetch(await bridgeReq("/api/local/claim", { owner: "renderer-1" }), env);
    const okBody: any = await ok.json();
    assert.ok(okBody.job && okBody.job.id === jobId, "with no hold the job is claimed normally");
  } finally { restore(); }
});

test("HOLD: an INVALID HMAC is refused 401 even when the hold is set (auth gate precedes the hold)", seq, async () => {
  freshTeam(15);
  const restore = withJwks([]);
  try {
    const { env, r2 } = makeEnv({ LOCAL_CLAIM_HOLD: "true" });
    await r2.put("local/job/holdbad0000001.json", JSON.stringify({
      id: "holdbad0000001", state: "queued", createdAt: Date.now(), model: "local-realvis-sdxl",
      prompt: "x", graph: {}, attempts: 0, seq: 1,
    }), { httpMetadata: { contentType: "application/json" } });

    const payload = JSON.stringify({ owner: "renderer-1" });
    const bad = req("/api/local/claim", {
      method: "POST",
      headers: { "X-Bridge-Timestamp": `${Math.floor(Date.now() / 1000)}`, "X-Bridge-Signature": "deadbeef", "Content-Type": "application/json" },
      body: payload,
    });
    assert.equal((await worker.fetch(bad, env)).status, 401, "bad HMAC is refused before the hold is evaluated");
  } finally { restore(); }
});

test("HOLD: renew of an EXISTING lease still works while held (held claim does not break in-flight work)", seq, async () => {
  freshTeam(16);
  const restore = withJwks([]);
  try {
    const { env, r2 } = makeEnv({ LOCAL_CLAIM_HOLD: "true" });
    const jobId = "holdlive0000001";
    const leaseToken = "tok-hold-1";
    await r2.put(`local/job/${jobId}.json`, JSON.stringify({
      id: jobId, state: "claimed", createdAt: Date.now(), model: "local-realvis-sdxl",
      prompt: "x", graph: {}, attempts: 1, owner: "renderer-1",
      leaseUntil: Date.now() + 600_000, leaseToken,
    }), { httpMetadata: { contentType: "application/json" } });

    const res = await worker.fetch(await bridgeReq("/api/local/renew", { id: jobId, owner: "renderer-1" }), env);
    assert.equal(res.status, 200, "renew of a held-but-live lease still succeeds");
    const body: any = await res.json();
    assert.equal(body.ok, true);
    assert.ok(typeof body.leaseUntil === "number" && body.leaseUntil > Date.now(), "lease was extended while held");
  } finally { restore(); }
});

test("HOLD: a terminal completion of an EXISTING lease still works while held (drain lets current work finish)", seq, async () => {
  freshTeam(17);
  const restore = withJwks([]);
  try {
    const { env, r2 } = makeEnv({ LOCAL_CLAIM_HOLD: "true" });
    const jobId = "holddone00000001";
    const leaseToken = "tok-hold-2";
    await r2.put(`local/job/${jobId}.json`, JSON.stringify({
      id: jobId, state: "running", createdAt: Date.now(), model: "local-realvis-sdxl",
      prompt: "x", graph: {}, attempts: 1, owner: "renderer-1",
      leaseUntil: Date.now() + 600_000, leaseToken,
    }), { httpMetadata: { contentType: "application/json" } });

    // A COMPLETED state requires an owned-upload RECEIPT (verifyJobUpload), which
    // this fixture does not stage; the genuine terminal path that needs no media
    // is `failed`. Use it so we exercise the REAL handler contract, not a guessed
    // receipts[]-maps-to-success shape.
    const res = await worker.fetch(await bridgeReq("/api/local/complete", { id: jobId, leaseToken, owner: "renderer-1", state: "failed", error: "renderer stopped for reload" }), env);
    assert.equal(res.status, 200, "terminal completion of a held-but-live lease still succeeds");
    const stored: any = await (await r2.get(`local/job/${jobId}.json`))!.json();
    assert.equal(stored.state, "failed", "in-flight work drained to a terminal state while held");
  } finally { restore(); }
});

// The DRAIN contract is only meaningful if current work can really FINISH, not
// merely fail. This drives the actual completed path under an active hold: a
// REAL bridge upload mints a real owned receipt bound to the job's own p_
// subject, then /api/local/complete (state=completed, receipts=[...]) is called
// WHILE HELD. If the hold wrongly blocked completion, or the receipt/schema were
// fake, this fails. It makes NO GPU/provider call — only R2/fake fetch.
test("HOLD: a REAL upload + completed receipt succeeds UNDER the hold and the media carries the job's OWN p_ principal", seq, async () => {
  freshTeam(18);
  const key = newKey("kHold");
  const restore = withJwks([key]);
  try {
    const { env, r2 } = makeEnv({ LOCAL_CLAIM_HOLD: "true" });
    const segA = "p_" + expectedSegment(ISSUER, "acct-HOLD");
    const jobId = "holdcomplete00001";
    const leaseToken = "tok-hold-3";
    await r2.put(`local/job/${jobId}.json`, JSON.stringify({
      id: jobId, state: "running", createdAt: Date.now(), model: "local-realvis-sdxl",
      prompt: "x", graph: {}, attempts: 1, owner: "renderer-1", subject: segA,
      leaseUntil: Date.now() + 600_000, leaseToken,
    }), { httpMetadata: { contentType: "application/json" } });

    // (1) REAL upload under the hold -> a real owned receipt.
    const up = await worker.fetch(await bridgeReq("/api/local/upload", {
      id: jobId, leaseToken, owner: "renderer-1", name: "render.png", type: "image/png",
      bytes: Buffer.from(pngBytes()).toString("base64"),
    }), env);
    assert.equal(up.status, 200, `bridge upload under hold should succeed (got ${up.status})`);
    const upBody: any = await up.json();
    assert.ok(String(upBody.key).startsWith(segA + "/"), `the stored key is prefixed with the job's own p_ subject (got ${upBody.key})`);
    assert.match(String(upBody.key), /^p_[0-9a-f]{32}\/[0-9a-f-]{36}\.png$/, "real owned media handle");

    // (2) COMPLETE under the hold with the REAL receipt (not an empty/fake one).
    const done = await worker.fetch(await bridgeReq("/api/local/complete", {
      id: jobId, leaseToken, owner: "renderer-1", state: "completed", receipts: [{ key: upBody.key }],
    }), env);
    assert.equal(done.status, 200, "completed terminal transition succeeds while held");
    const doneBody: any = await done.json();
    assert.ok(Array.isArray(doneBody.media) && doneBody.media.length === 1, "the completion returned the real media, not an empty receipt");
    assert.match(String(doneBody.media[0].url), /\/media\/p_[0-9a-f]{32}\//, "media URL carries the p_ principal");

    const stored: any = await (await r2.get(`local/job/${jobId}.json`))!.json();
    assert.equal(stored.state, "completed", "in-flight work drained to COMPLETED while held");
    assert.equal((stored.media || []).length, 1, "the stored job carries exactly the one real output");
  } finally { restore(); }
});
