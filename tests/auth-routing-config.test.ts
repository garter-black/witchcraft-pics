import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* Deployment-routing config guard (auth-config-prep, 2026-10-03).

   The new /auth/login and /auth/logout routes live in the Worker (worker/index.ts),
   NOT in the SPA. The static-assets handler answers EVERY non-/api, non-/auth path
   (worker/index.ts:296), so without an explicit `run_worker_first` entry the SPA's
   single-page-application fallback would swallow /auth/* and the routes would never
   run in production. This test parses the ACTUAL wrangler.jsonc and pins:

     - /auth/* is present in assets.run_worker_first (the required deployment change)
     - /api/* and /media/* are STILL present (no regression of the existing guards)
     - the other assets/route/binding fields are unchanged (this file only added one
       array element; it must not silently drop a binding or a route)

   It reads bytes from disk and JSON-parses a minimal JSONC strip, so a future edit
   that removes /auth/* — or that breaks the file — fails here instead of shipping. */

function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const nx = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && nx === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += ch;
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        continue;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "/" && nx === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && nx === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, "..", "wrangler.jsonc");

test("wrangler.jsonc parses and routes /auth/* to the Worker ahead of static assets", () => {
  const raw = readFileSync(configPath, "utf8");
  const cfg = JSON.parse(stripJsonc(raw));

  assert.ok(Array.isArray(cfg.assets?.run_worker_first), "assets.run_worker_first is an array");
  const rwf: string[] = cfg.assets.run_worker_first;

  assert.ok(rwf.includes("/auth/*"), "/auth/* must be routed to the Worker (login/logout are Worker paths)");
  assert.ok(rwf.includes("/api/*"), "the existing /api/* guard is preserved");
  assert.ok(rwf.includes("/media/*"), "the existing /media/* guard is preserved");
});

test("the auth-routing amendment did not change any other config field", () => {
  const cfg = JSON.parse(stripJsonc(readFileSync(configPath, "utf8")));

  assert.equal(cfg.name, "witchcraft-studio-v1");
  assert.equal(cfg.main, "worker/index.ts");
  assert.equal(cfg.compatibility_date, "2026-09-01");
  assert.deepEqual(cfg.compatibility_flags, ["nodejs_compat"]);

  assert.equal(cfg.assets.directory, "./dist");
  assert.equal(cfg.assets.binding, "ASSETS");
  assert.equal(cfg.assets.not_found_handling, "single-page-application");

  // No fake issuer/AUD/hold values may be injected into the active vars block.
  assert.deepEqual(cfg.vars, { HF_API_BASE_URL: "https://api.higgsfield.ai" });
  assert.equal("TEAM_DOMAIN" in cfg.vars, false, "no staged TEAM_DOMAIN in active config");
  assert.equal("ACCESS_AUD" in cfg.vars, false, "no staged ACCESS_AUD in active config");
  assert.equal("LOCAL_CLAIM_HOLD" in cfg.vars, false, "no claim-hold var in active config");

  assert.deepEqual(cfg.r2_buckets, [{ binding: "MEDIA", bucket_name: "witchcraft-studio-media" }]);
  assert.equal(cfg.ratelimits[0].name, "API_LIMITER");
  assert.equal(cfg.ratelimits[0].namespace_id, "4126");
  assert.deepEqual(cfg.ratelimits[0].simple, { limit: 60, period: 60 });
});
