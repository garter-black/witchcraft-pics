// Identity + personal-layer route tests against the REAL exported Worker.fetch.
// Honest scope: this proves the FAIL-CLOSED contract and the private,no-store
// surface, NOT a live Cloudflare Access sign-in (no real team/aud is configured
// and none is invented here).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index";
import { fakeR2 } from "./fake-r2";

const ORIGIN = "https://studio.test";
const SESSION_SECRET = "session-secret-for-tests-only-long-enough-value";

function makeEnv(overrides: Record<string, unknown> = {}) {
  const r2 = fakeR2();
  const env: any = {
    ASSETS: { fetch: async () => new Response("world", { status: 200, headers: { "content-type": "text/html" } }) },
    SESSION_SECRET,
    HF_API_BASE_URL: "https://api.higgsfield.ai",
    LOCAL_BRIDGE_HMAC: "bridge-hmac-value-for-tests",
    OWNER_ACCESS_KEY: "owner-key-abcdefghijklmnop",
    MEDIA: r2,
    ...overrides,
  };
  return { env, r2 };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(ORIGIN + path, { method: "GET", headers });

/* ---------------------------------------------------- GET /api/identity */

test("GET /api/identity with NO identity config is configured:false, authenticated:false, private,no-store", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(get("/api/identity"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private,no-store");
  const body = await res.json() as any;
  assert.deepEqual(body, {
    configured: false,
    authenticated: false,
    loginUrl: "/auth/login",
    logoutUrl: "/auth/logout",
  });
  assert.ok(!("principal" in body), "no principal is disclosed when unauthenticated");
  assert.ok(!("email" in body), "email is never returned");
});

test("GET /api/identity with config present but an ABSENT token stays authenticated:false (fail closed)", async () => {
  const { env } = makeEnv({ TEAM_DOMAIN: "https://studio.cloudflareaccess.com", ACCESS_AUD: "aud-tag" });
  const res = await worker.fetch(get("/api/identity"), env);
  const body = await res.json() as any;
  assert.equal(body.configured, true);
  assert.equal(body.authenticated, false);
  assert.ok(!("principal" in body));
});

test("GET /api/identity with a GARBAGE token stays authenticated:false (never trusts raw text)", async () => {
  const { env } = makeEnv({ TEAM_DOMAIN: "https://studio.cloudflareaccess.com", ACCESS_AUD: "aud-tag" });
  const res = await worker.fetch(get("/api/identity", { "cf-access-jwt-assertion": "not.a.jwt" }), env);
  const body = await res.json() as any;
  assert.equal(body.configured, true);
  assert.equal(body.authenticated, false);
});

test("GET /api/identity rejects a non-GET method with 405 (private,no-store)", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(new Request(ORIGIN + "/api/identity", { method: "POST", headers: { Origin: ORIGIN } }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

/* ---------------------------------------- personal library fails closed */

test("personal library paths FAIL CLOSED (503) when identity is unconfigured", async () => {
  const { env } = makeEnv();
  for (const [method, path] of [["GET", "/api/library"], ["POST", "/api/library/upload"], ["GET", "/api/library/object/p_" + "a".repeat(32) + "/x.png"]] as const) {
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN } }), env);
    assert.equal(res.status, 503, `${method} ${path} must fail closed`);
    assert.equal(res.headers.get("Cache-Control"), "private,no-store");
  }
});

test("personal library paths with config but NO token are 401 (never 200)", async () => {
  const { env } = makeEnv({ TEAM_DOMAIN: "https://studio.cloudflareaccess.com", ACCESS_AUD: "aud-tag" });
  const res = await worker.fetch(get("/api/library"), env);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Cache-Control"), "private,no-store");
});

test("hosted status fails closed (503) without identity config, and 401 with config but no token", async () => {
  const a = makeEnv();
  const r1 = await worker.fetch(new Request(ORIGIN + "/api/hosted/status", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ requestIds: ["req-1"] }) }), a.env);
  assert.equal(r1.status, 503);
  const b = makeEnv({ TEAM_DOMAIN: "https://studio.cloudflareaccess.com", ACCESS_AUD: "aud-tag" });
  const r2 = await worker.fetch(new Request(ORIGIN + "/api/hosted/status", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ requestIds: ["req-1"] }) }), b.env);
  assert.equal(r2.status, 401);
});

test("there is NO public ownership-register or mirror-URL route (404)", async () => {
  const { env } = makeEnv({ TEAM_DOMAIN: "https://studio.cloudflareaccess.com", ACCESS_AUD: "aud-tag" });
  for (const path of ["/api/hosted/register", "/api/hosted/mirror", "/api/library/mirror"]) {
    const res = await worker.fetch(new Request(ORIGIN + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: "{}" }), env);
    assert.ok(res.status === 404 || res.status === 405, `${path} must not exist (got ${res.status})`);
  }
});

/* ------------------------------------------------- public stays open */

test("public pages / world still reach ASSETS with no identity config (open world preserved)", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(get("/"), env);
  assert.equal(res.status, 200);
});
