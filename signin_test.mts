/* Does the OWNER sign-in flow actually work against the real worker? */
import { seal } from "file:///C:/Hecate-Umbra/Projects/witchcraft-studio/worker/index.ts";
import worker from "file:///C:/Hecate-Umbra/Projects/witchcraft-studio/worker/index.ts";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";
const OWNER = "testownerkey1234567890";
const env: any = {
  SESSION_SECRET: secret, OWNER_ACCESS_KEY: OWNER,
  HF_API_BASE_URL: "https://api.higgsfield.ai",
  MEDIA: { put: async () => ({}) },
};

console.log("\n=== A. sign in with the owner key ===");
const req = new Request("https://witchcraft.pics/api/credentials?provider=local", {
  method: "POST",
  headers: { origin: "https://witchcraft.pics", "Content-Type": "application/json" },
  body: JSON.stringify({ ownerKey: OWNER }),
});
const res: any = await worker.fetch(req as any, env, { waitUntil() {} } as any);
console.log("  HTTP", res.status, (await res.clone().text()).slice(0, 120));
const setCookie = res.headers.get("set-cookie") || "";
console.log("  Set-Cookie present:", !!setCookie);
console.log("  cookie flags:", setCookie.replace(/=[^;]+/, "=<sealed>"));

console.log("\n=== B. then read local-state with that cookie ===");
const cookie = setCookie.split(";")[0];
const req2 = new Request("https://witchcraft.pics/api/local-state", {
  headers: { origin: "https://witchcraft.pics", cookie },
});
const res2: any = await worker.fetch(req2 as any, env, { waitUntil() {} } as any);
console.log("  HTTP", res2.status, (await res2.clone().text()).slice(0, 160));

console.log("\n=== C. wrong key must be refused ===");
const req3 = new Request("https://witchcraft.pics/api/credentials?provider=local", {
  method: "POST",
  headers: { origin: "https://witchcraft.pics", "Content-Type": "application/json" },
  body: JSON.stringify({ ownerKey: "not-the-owner-key" }),
});
const res3: any = await worker.fetch(req3 as any, env, { waitUntil() {} } as any);
console.log("  HTTP", res3.status, (await res3.clone().text()).slice(0, 120));
