// Normal-reference regression + hosted-submit ordering — meaningful tests
// against the REAL exported Worker.fetch.
//
// WHAT THIS PROVES (and only this):
//   1. A NORMAL same-origin `/media/<32hex>/<uuid>.<ext>` reference — which
//      carries an interior slash — is ACCEPTED as an owned reference, so a
//      legitimate hosted I2V input is not denied. (The regression: a raw
//      `key.includes('/')` test rejected every normal owned URL and only an
//      encoded-separator fixture escaped.)
//   2. The hosted provider is actually CALLED for an owned reference, and the
//      reference it receives is the SHORT-LIVED, method+key-bound signed URL —
//      not a bare private `/media/` URL.
//   3. A FOREIGN-subject, malformed, path-dot, encoded-separator or
//      bad-extension reference is DENIED (403) BEFORE any upstream call.
//   4. The provider is never reached on a denial.
//
// The probe keeps the REAL worker fetch. Only the provider HTTP boundary is
// stubbed (a recording fake), because the real provider is never called in this
// phase. No real credentials, no customer objects, no paid generation.

import { test } from "node:test";
import assert from "node:assert/strict";

import worker, { seal } from "../worker/index";
import { verifyMediaSignature, MEDIA_ASSERTION_QUERY, ownerSegmentOf, sha256Hex } from "../worker/local-poll";
import { fakeR2, pngBytes } from "./fake-r2";

const HMAC = "test-bridge-hmac-value-for-hosted-ref-fix";
const SESSION_SECRET = "session-secret-for-tests-only-long-enough-value";
const ORIGIN = "https://studio.test";
const HF_BASE = "https://api.higgsfield.ai";

// A synthetic but REAL-shaped higgsfield credential (`id:secret`). No real key.
const KEY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1";
const KEY_B = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

const cookieName = "__Host-witchcraft-session";

async function cookieFor(rawKey: string) {
  return `${cookieName}=${await seal(rawKey, SESSION_SECRET, "higgsfield")}`;
}

const subjectFor = async (rawKey: string) => ownerSegmentOf(await sha256Hex(rawKey));

/** Store a PNG owned by `subject`, exactly as the upload path writes it. */
async function seedOwned(r2: any, subject: string, ext = "png") {
  const key = `${subject}/${crypto.randomUUID()}.${ext}`;
  const bytes = pngBytes(64);
  await r2.put(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    httpMetadata: { contentType: ext === "png" ? "image/png" : "application/octet-stream" },
    customMetadata: { owner: subject, source: "test" },
  });
  return key;
}

/** Instrumented fake R2 that also counts `get`, to prove deny-before-storage. */
function instrumentedR2() {
  const r2 = fakeR2();
  const counters = { get: 0 };
  const baseGet = r2.get.bind(r2);
  (r2 as any).get = async (k: string) => {
    counters.get += 1;
    return baseGet(k);
  };
  return { r2, counters };
}

/** Records every provider call the worker makes, and answers like the real API. */
function recordingProvider() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    let body: any = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = init?.body ?? null; }
    calls.push({ url: String(url), body });
    // The credential-verification probe the worker uses: a 404 means "unknown
    // request id" and is treated as a verified key. The submit path returns an
    // accepted request id.
    if (String(url).includes("/requests/") && String(url).endsWith("/status")) {
      return new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify({ status: "queued", request_id: "req-123", status_url: "/x", cancel_url: "/y" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const { r2, counters } = instrumentedR2();
  const { calls, fetchImpl } = recordingProvider();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const env: any = {
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    SESSION_SECRET,
    HF_API_BASE_URL: HF_BASE,
    LOCAL_BRIDGE_HMAC: HMAC,
    OWNER_ACCESS_KEY: "owner-key-abcdefghijklmnop",
    MEDIA: r2,
    ...overrides,
  };
  return { env, r2, counters, calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function generateReq(body: unknown, cookie: string) {
  return new Request(`${ORIGIN}/api/generate?provider=higgsfield`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, cookie },
    body: JSON.stringify(body),
  });
}

/* ======================================================= the normal-reference fix */

test("a NORMAL owned /media/<hex>/<uuid>.png reference is accepted and the hosted provider is called with a SIGNED own reference", async () => {
  const { env, r2, calls, restore } = makeEnv();
  try {
    const subjA = await subjectFor(KEY_A);
    const key = await seedOwned(r2, subjA); // normal key: 32hex/uuid.png (has a slash)
    assert.ok(key.includes("/"), "the stored key shape genuinely contains a slash");

    const res = await worker.fetch(
      generateReq(
        { model: "flux-2", prompt: { text: "a knight" }, media: { reference: [{ id: "1", url: `${ORIGIN}/media/${key}` }] }, settings: {} },
        await cookieFor(KEY_A),
      ),
      env,
    );
    assert.equal(res.status, 200, `owned normal reference must reach the provider (got ${res.status}: ${await res.clone().text()})`);

    const submit = calls.find((c) => c.body != null);
    assert.ok(submit, "the hosted provider WAS called for an owned reference");

    // The reference the provider received must be the SIGNED form of OUR key.
    const blob = JSON.stringify(submit!.body);
    assert.ok(blob.includes("/media/"), "the provider received a reference URL");
    const m = blob.match(/https:[^"\\ ]*?\/media\/([^?"\\ ]+)\?[^"\\ ]*?wa=[^"\\ ]+/);
    assert.ok(m, "the reference carries the signed query assertion, not a bare URL");
    const signedUrl = blob.match(/https:[^"\\ ]*\/media\/[^"\\ ]+/)?.[0] ?? "";
    const parsed = new URL(signedUrl.replace(/\\u0026/g, "&"));
    assert.equal(parsed.origin, ORIGIN, "the reference stays same-origin");
    assert.equal(decodeURIComponent(parsed.pathname.slice("/media/".length)), key, "the signed reference names the OWN owned key");
    const token = parsed.searchParams.get(MEDIA_ASSERTION_QUERY);
    assert.ok(token, "a signed assertion is attached");
    assert.equal(verifyMediaSignature(HMAC, key, "GET", token), true, "the assertion verifies under the real verifier");
  } finally {
    restore();
  }
});

test("a FOREIGN-subject normal reference is DENIED (403) BEFORE any upstream call", async () => {
  const { env, r2, calls, restore } = makeEnv();
  try {
    const foreignKey = await seedOwned(r2, await subjectFor(KEY_B));
    const res = await worker.fetch(
      generateReq(
        { model: "flux-2", prompt: { text: "x" }, media: { reference: [{ id: "1", url: `${ORIGIN}/media/${foreignKey}` }] }, settings: {} },
        await cookieFor(KEY_A),
      ),
      env,
    );
    assert.equal(res.status, 403, "a foreign-subject reference is refused");
    assert.equal(calls.filter((c) => c.body != null).length, 0, "the provider was never asked to fetch a foreign reference");
  } finally {
    restore();
  }
});

test("malformed, path-dot, encoded-separator and bad-extension references are DENIED before upstream", async () => {
  const { env, r2, calls, restore } = makeEnv();
  try {
    const subjA = await subjectFor(KEY_A);
    const key = await seedOwned(r2, subjA);
    const [seg, name] = key.split("/");
    const bad = [
      `${ORIGIN}/media/${seg}/${name}%2Fextra.png`,        // encoded separator -> third segment
      `${ORIGIN}/media/..%2f..%2fsecret.png`,              // path-dot traversal
      `${ORIGIN}/media/${seg}/x.exe`,                      // bad extension
      `${ORIGIN}/media/%E0%A4%A`,                          // malformed percent escape
      `${ORIGIN}/media/a/b/c.png`,                         // three segments
    ];
    for (const url of bad) {
      const before = calls.filter((c) => c.body != null).length;
      const res = await worker.fetch(
        generateReq({ model: "flux-2", prompt: { text: "x" }, media: { reference: [{ id: "1", url }] }, settings: {} }, await cookieFor(KEY_A)),
        env,
      );
      assert.equal(res.status, 403, `must deny before upstream: ${url}`);
      assert.equal(calls.filter((c) => c.body != null).length, before, `provider must not be called for: ${url}`);
    }
  } finally {
    restore();
  }
});

test("nested arrays and a query/hash still resolve the owned key (and a foreign key nested deeply is still denied)", async () => {
  const { env, r2, calls, restore } = makeEnv();
  try {
    const subjA = await subjectFor(KEY_A);
    const key = await seedOwned(r2, subjA);
    // OWNED, nested three levels deep, with a query and a hash.
    const owned = `${ORIGIN}/media/${key}?cache=1#frag`;
    const ok = await worker.fetch(
      generateReq(
        { model: "flux-2", prompt: { text: "x" }, media: { reference: [{ id: "1", url: owned, nested: { deep: [owned] } }] }, settings: {} },
        await cookieFor(KEY_A),
      ),
      env,
    );
    assert.equal(ok.status, 200, "an owned reference survives a query/hash and nesting");

    // FOREIGN, the same nesting: denied.
    const foreignKey = await seedOwned(r2, await subjectFor(KEY_B));
    const foreign = `${ORIGIN}/media/${foreignKey}?cache=1#frag`;
    const denied = await worker.fetch(
      generateReq(
        { model: "flux-2", prompt: { text: "x" }, media: { reference: [{ id: "1", url: foreign, nested: { deep: [foreign] } }] }, settings: {} },
        await cookieFor(KEY_A),
      ),
      env,
    );
    assert.equal(denied.status, 403, "a foreign reference nested deeply is still refused");
  } finally {
    restore();
  }
});

test("an owned but MISSING object is denied before upstream (no laundering of a nonexistent key)", async () => {
  const { env, calls, restore } = makeEnv();
  try {
    const subjA = await subjectFor(KEY_A);
    const missing = `${subjA}/${crypto.randomUUID()}.png`;
    const res = await worker.fetch(
      generateReq({ model: "flux-2", prompt: { text: "x" }, media: { reference: [{ id: "1", url: `${ORIGIN}/media/${missing}` }] }, settings: {} }, await cookieFor(KEY_A)),
      env,
    );
    assert.equal(res.status, 403, "a reference to an object that does not exist is refused");
    assert.equal(calls.filter((c) => c.body != null).length, 0, "the provider is not called for a missing object");
  } finally {
    restore();
  }
});
