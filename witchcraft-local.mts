/* WITCHCRAFT LOCAL — the owner studio, running only on this PC.

   witchcraft.pics is the shared/front-facing site. This is YOUR machine:
   http://127.0.0.1:8791, sign in with the studio owner key, and every preset
   renders straight onto your 3080 — no Cloudflare, no worker queue, no lease
   handshake, no polling. The graph is built by the SAME shipped toComfyGraph()
   the website uses, so local and witchcraft.pics produce identical graphs.

   Run:  set OWNER_ACCESS_KEY=<studio owner key> && node --import tsx witchcraft-local.mts
*/
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { timingSafeEqual, randomUUID } from "node:crypto";

import { toComfyGraph } from "@/generation/local-input";
import { MODELS, getModel, parseSettings } from "@/generation/catalog";
import { REFERENCE_FIELD, type ComfyGraph } from "@/generation/local-input";

const PORT = Number(process.env.WITCHCRAFT_LOCAL_PORT || 8791);
const COMFY = process.env.COMFY_URL || "http://127.0.0.1:8188";
const OWNER_KEY = process.env.OWNER_ACCESS_KEY || "";
const INPUT_DIR = "D:\\AI\\input\\witchcraft-local";
const MAX_BYTES = 200 * 1024 * 1024;

if (!OWNER_KEY) {
  console.error("OWNER_ACCESS_KEY is required - refusing to start without owner auth.");
  process.exit(1);
}

/** Local media rides its own markers so the shipped resolve() logic in the
    poller is never involved here: locally we already HAVE the file. */
const LOCAL_IMAGE_FIELD = "witchcraft_local_image";
const LOCAL_VIDEO_FIELD = "witchcraft_local_video";

/* Only these presets exist locally. Seedance/Higgsfield/Kling are cloud and
   are deliberately absent - this page never spends money. */
const LOCAL_PRESETS = (MODELS as readonly any[]).filter((m) => m.provider === "local");

function looksLikeMp4(b: Buffer) { return b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp"; }
function looksLikeWebm(b: Buffer) { return b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3; }

const sessions = new Set<string>();
const comfy = (path: string, init: RequestInit = {}) =>
  fetch(`${COMFY}${path}`, { ...init, signal: AbortSignal.timeout(600000) });

function describeComfyError(res: any): string {
  const e = res?.node_errors;
  if (!e || typeof e !== "object") return "";
  const parts: string[] = [];
  for (const [id, d] of Object.entries<any>(e)) {
    for (const err of d?.errors || []) {
      parts.push(`node ${id} ${d?.class_type || ""}: ${String(err?.message || "").replace(/\s+/g, " ").trim()}`);
    }
  }
  return parts.slice(0, 3).join("; ");
}

/** Swap a local staging path onto a LoadImage `image` field. */
async function resolveLocalImage(node: string, spec: any, out: any) {
  const value = spec?.inputs?.[LOCAL_IMAGE_FIELD];
  if (typeof value !== "string" || !value) return;
  if (!/^D:\\AI\\input\\witchcraft-local\\[A-Za-z0-9._-]+$/i.test(value)) {
    throw new Error("That reference file is not in the local staging folder.");
  }
  const bytes = await readFileSafe(value);
  const type = /\.png$/i.test(value) ? "image/png" : /\.webp$/i.test(value) ? "image/webp" : "image/jpeg";
  const bnd = "----w" + randomUUID().replace(/-/g, "");
  const body = Buffer.concat([
    Buffer.from(`--${bnd}\r\nContent-Disposition: form-data; name="image"; filename="reference${extOf(value)}"\r\nContent-Type: ${type}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${bnd}--\r\n`),
  ]);
  const up = await comfy("/upload/image", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + bnd }, body });
  if (!up.ok) throw new Error(`ComfyUI upload/image -> ${up.status}`);
  const view: any = await up.json();
  if (!view?.name) throw new Error("ComfyUI did not accept the reference image.");
  const { [LOCAL_IMAGE_FIELD]: _d, ...inputs } = spec.inputs;
  out[node] = { ...spec, inputs: { ...inputs, image: view.name } };
  console.log(`reference ${node} -> ${view.name}`);
}

const extOf = (p: string) => (p.match(/\.[A-Za-z0-9]+$/) || [""])[0];

async function readFileSafe(path: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}

/** VHS_LoadVideoPath takes an absolute path directly - no upload needed. */
async function resolveLocalVideo(node: string, spec: any, out: any) {
  const value = spec?.inputs?.[LOCAL_VIDEO_FIELD];
  if (typeof value !== "string" || !value) return;
  if (!/^D:\\AI\\input\\witchcraft-local\\[A-Za-z0-9._-]+$/i.test(value)) {
    throw new Error("That clip is not in the local staging folder.");
  }
  const { [LOCAL_VIDEO_FIELD]: _d, ...inputs } = spec.inputs;
  out[node] = { ...spec, inputs: { ...inputs, video: value } };
  console.log(`clip ${node} -> ${value}`);
}

async function resolveLocal(graph: ComfyGraph): Promise<ComfyGraph> {
  const out: any = { ...graph };
  for (const [node, spec] of Object.entries<any>(graph)) await resolveLocalImage(node, spec, out);
  for (const [node, spec] of Object.entries<any>(out)) await resolveLocalVideo(node, spec, out);
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const token = (req.headers.cookie || "").split(";").map((s) => s.trim())
    .find((c) => c.startsWith("wc_local="))?.slice("wc_local=".length);

  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    res.end(JSON.stringify(value));
  };

  try {
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(PAGE);
    }

    if (path === "/api/login" && req.method === "POST") {
      const raw = await readBody(req, 8192);
      let candidate = "";
      try { candidate = String(JSON.parse(raw).ownerKey ?? "").trim(); } catch { /* handled below */ }
      const a = Buffer.from(candidate), b = Buffer.from(OWNER_KEY);
      if (candidate.length !== OWNER_KEY.length || !timingSafeEqual(a, b)) {
        return json({ error: "That studio owner key is not recognised." }, 403);
      }
      const t = randomUUID() + randomUUID();
      sessions.add(t);
      return json({ ok: true }, 200, { "Set-Cookie": `wc_local=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    }

    if (path === "/api/logout") { sessions.clear(); return json({ ok: true }, 200, { "Set-Cookie": "wc_local=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" }); }

    if (!token || !sessions.has(token)) return json({ error: "Sign in as the studio owner." }, 401);

    if (path === "/api/state") {
      let online = false, nodes = 0;
      try { const s = await comfy("/system_stats"); online = s.ok; } catch { /* offline */ }
      try { const o = await comfy("/object_info"); nodes = Object.keys(await o.json()).length; } catch { /* offline */ }
      return json({ online, nodes, comfy: COMFY, presets: LOCAL_PRESETS.map((m) => ({ id: m.id, label: m.label, roles: m.roles })) });
    }

    if (path === "/api/render" && req.method === "POST") {
      const raw = await readBody(req, 4 * 1024 * 1024);
      const { modelId, prompt, files, settings } = JSON.parse(raw);
      const model = getModel(String(modelId));
      if (model.provider !== "local") throw new Error("That model is not a local renderer.");
      const text = String(prompt ?? "").trim();
      if (!text) throw new Error("Enter a prompt.");
      if (text.length > 4000) throw new Error("Enter a prompt shorter than 4,000 characters.");

      const media: Record<string, any[]> = {};
      for (const [role, entry] of Object.entries<any>(files || {})) {
        const max = (model.roles as any)[role];
        if (!max || !entry?.path) throw new Error("These references are not supported by this local renderer.");
        media[role] = [{ id: role, path: entry.path }];
      }
      const parsed = parseSettings(model, settings ?? {});
      const plane = { model: model.id, prompt: { text }, media: {}, settings: parsed } as any;
      let graph: ComfyGraph;
      try {
        const startPath = media.start?.[0]?.path;
        graph = toComfyGraph(plane, (model.settings as any).preset.default, undefined);
      } catch (err) {
        // presets that need a reference image take it through the marker
        const startPath = media.start?.[0]?.path;
        const refPath = media.reference?.[0]?.path;
        graph = toComfyGraph(
          { ...plane, media: { start: media.start, reference: media.reference } } as any,
          (model.settings as any).preset.default,
          startPath,
        );
      }
      /* Local media paths are attached AFTER the shipped builder runs: the
         builder places its markers, we swap them for real staging paths. */
      const staged: any = { ...graph };
      const list = (media.start || []).concat(media.reference || []);
      let i = 0;
      for (const [node, spec] of Object.entries<any>(staged)) {
        if (!(REFERENCE_FIELD in (spec.inputs || {}))) continue;
        const entry = list[i++] ?? list[0];
        const isVideo = /\.(mp4|webm)$/i.test(entry.path);
        const marker = isVideo ? LOCAL_VIDEO_FIELD : LOCAL_IMAGE_FIELD;
        const { [REFERENCE_FIELD]: _d, ...inputs } = spec.inputs;
        staged[node] = { ...spec, inputs: { ...inputs, [marker]: entry.path } };
      }

      const resolved = await resolveLocal(staged);
      const r = await comfy("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: resolved, client_id: "witchcraft-local" }) });
      const body = await r.text();
      let out: any = null; try { out = JSON.parse(body); } catch { /* keep null */ }
      if (!r.ok || !out?.prompt_id) {
        const detail = describeComfyError(out);
        return json({ error: `ComfyUI /prompt -> ${r.status}${detail ? ": " + detail : ""}` }, 400);
      }
      const pid: string = out.prompt_id;
      const t0 = Date.now();
      for (;;) {
        await new Promise((x) => setTimeout(x, 2000));
        const h: any = await (await comfy(`/history/${pid}`)).json();
        if (h[pid]) {
          if (h[pid].status?.status_str !== "success") return json({ error: "The render failed on the GPU." }, 500);
          const filesOut: any[] = [];
          for (const o of Object.values<any>(h[pid].outputs || {})) {
            for (const v of Object.values<any>(o)) {
              if (!Array.isArray(v)) continue;
              for (const it of v) {
                if (!it?.filename) continue;
                filesOut.push({ ...it,
                  url: `${COMFY}/view?filename=${encodeURIComponent(it.filename)}&subfolder=${encodeURIComponent(it.subfolder || "")}&type=${encodeURIComponent(it.type || "output")}` });
              }
            }
          }
          return json({ ok: true, files: filesOut, seconds: Math.round((Date.now() - t0) / 1000) });
        }
        if (Date.now() - t0 > 3600000) return json({ error: "The render exceeded its time limit." }, 504);
      }
    }

    if (path === "/api/upload" && req.method === "POST") {
      const form = await readForm(req);
      const f = form.get("file");
      if (!(f instanceof File) || !f.size) throw new Error("Choose a file.");
      if (f.size > MAX_BYTES) throw new Error("That file is over 200 MB.");
      const bytes = Buffer.from(await f.arrayBuffer());
      const isImg = /^image\/(png|jpeg|webp)$/i.test(f.type);
      const isVid = /^video\/(mp4|webm)$/i.test(f.type);
      if (!isImg && !isVid) throw new Error("Use PNG, JPEG, WebP, MP4 or WebM.");
      let ext: string;
      if (isVid) {
        const webm = looksLikeWebm(bytes), mp4 = looksLikeMp4(bytes);
        if (!mp4 && !webm) throw new Error("That file is not a real MP4 or WebM.");
        ext = webm ? ".webm" : ".mp4";
      } else {
        ext = /\.png$/i.test(f.type) ? ".png" : /\.webp$/i.test(f.type) ? ".webp" : ".jpg";
      }
      await mkdir(INPUT_DIR, { recursive: true });
      const path = `${INPUT_DIR}\\${randomUUID()}${ext}`;
      await writeFile(path, bytes);
      return json({ path, name: path.split("\\").pop() });
    }

    json({ error: "Not found." }, 404);
  } catch (err) {
    json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

function readBody(req: any, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > limit) { reject(new Error("Request too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function readForm(req: any): Promise<FormData> {
  const chunks: Buffer[] = []; let n = 0;
  await new Promise<void>((resolve, reject) => {
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BYTES) { reject(new Error("File too large.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  return new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers["content-type"] || "" } }).formData();
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>WITCHCRAFT / LOCAL</title>
<style>
:root{--bg:#07070a;--fg:#e9e6df;--mut:#8d8a84;--acc:#c9a227;--line:#232228}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:30px 20px 90px}
h1{font-size:15px;letter-spacing:.16em;text-transform:uppercase;margin:0 0 4px}
.sub{color:var(--mut);font-size:12px;margin-bottom:24px}
.card{border:1px solid var(--line);background:#0d0d11;padding:16px;margin-bottom:14px}
label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin:12px 0 5px}
input,select,textarea{width:100%;background:#05050a;border:1px solid var(--line);color:var(--fg);padding:9px 11px;font:inherit;font-size:13px}
textarea{min-height:84px;resize:vertical}
button{background:var(--acc);color:#0a0a0a;border:0;padding:11px 20px;font:inherit;font-weight:650;letter-spacing:.06em;cursor:pointer;margin-top:14px}
button:disabled{opacity:.45;cursor:not-allowed}
.ghost{background:none;color:var(--mut);border:1px solid var(--line);font-weight:400;margin:0}
.row{display:flex;gap:10px}.row>*{flex:1}
.state{font-size:11px;color:var(--mut);margin-left:auto}.ok{color:#7fbf7f}.bad{color:#d1655b}
.out{margin-top:10px;font-size:12px;white-space:pre-wrap;color:var(--mut)}
img,video{max-width:100%;border:1px solid var(--line);margin-top:10px;display:block}
.badge{border:1px solid var(--line);padding:2px 8px;font-size:10px;letter-spacing:.1em;color:var(--mut)}
.hint{color:var(--mut);font-size:12px;margin:0 0 10px}
</style></head><body><div class="wrap">
<h1>Witchcraft <span style="color:var(--acc)">/</span> Local</h1>
<div class="sub">This PC only &middot; your RTX 3080 &middot; no Cloudflare, no queue</div>
<div id="app"><p class="hint">Checking…</p></div>
</div><script>
const app = document.getElementById('app');
const el = (t, a, ...kids) => { const e = document.createElement(t);
  for (const [k,v] of Object.entries(a||{})) { if (k==='class') e.className=v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k,v); }
  for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k))); return e; };
const api = async (p, o) => { const r = await fetch(p, Object.assign({credentials:'same-origin'}, o||{}));
  const j = await r.json().catch(()=>({error:'unreadable reply'})); if (!r.ok) throw new Error(j.error||('HTTP '+r.status)); return j; };

let PRESETS = [];

function login(msg) {
  const key = el('input', {type:'password', placeholder:'Studio owner key'});
  const err = el('div', {class:'out'}, msg || '');
  app.replaceChildren(el('div', {class:'card'},
    el('h2', {style:'font-size:13px;margin:0 0 6px'}, 'Owner sign-in'),
    el('p', {class:'hint'}, 'Unlocks your own GPU. This is the Studio owner key - not a Higgsfield or fal key.'),
    el('label', {}, 'Owner key'), key, err,
    el('button', {onclick: async () => { err.textContent='';
      try { await api('/api/login', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ownerKey: key.value})}); studio(); }
      catch (e) { err.textContent = e.message; } }}, 'Unlock')));
  key.focus();
}

function studio() {
  const state = el('span', {class:'state'}, 'checking ComfyUI…');
  const model = el('select', {}, ...PRESETS.map(p => el('option', {value:p.id}, p.label)));
  const prompt = el('textarea', {placeholder:'Describe the shot…'});
  const w = el('input', {type:'number', value:'768', min:'256', max:'1920', step:'64'});
  const h = el('input', {type:'number', value:'1024', min:'256', max:'1920', step:'64'});
  const slots = el('div', {});
  const out = el('div', {class:'out'});
  const box = el('div', {});
  const run = el('button', {}, 'Generate');
  const files = {};

  function renderSlots() {
    for (const k of Object.keys(files)) delete files[k];
    const m = PRESETS.find(p => p.id === model.value);
    const roles = Object.keys(m.roles || {});
    slots.replaceChildren(...roles.map(role => {
      const input = el('input', {type:'file', accept: /video/.test(role) ? 'video/mp4,video/webm' : 'image/*',
        onchange: async (e) => {
          const f = e.target.files && e.target.files[0]; if (!f) return;
          out.textContent = 'uploading ' + f.name + '…';
          try { const fd = new FormData(); fd.set('file', f);
            const r = await api('/api/upload', {method:'POST', body: fd});
            files[role] = {role, path: r.path}; out.textContent = 'ready: ' + f.name; }
          catch (err) { out.textContent = err.message; }
        }});
      return el('div', {}, el('label', {}, role), input);
    }));
  }
  model.onchange = renderSlots;

  run.onclick = async () => {
    run.disabled = true; out.textContent = 'rendering on your GPU…'; box.replaceChildren();
    try {
      const r = await api('/api/render', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({modelId: model.value, prompt: prompt.value, files,
          settings: {width: Number(w.value), height: Number(h.value)}})});
      box.replaceChildren(...r.files.map(f => /\\.(mp4|webm)$/i.test(f.filename)
        ? el('video', {src:f.url, controls:''}) : el('img', {src:f.url})));
      out.textContent = 'done in ' + r.seconds + 's';
    } catch (e) { out.textContent = e.message; }
    finally { run.disabled = false; }
  };

  app.replaceChildren(el('div', {class:'card'},
    el('div', {style:'display:flex;align-items:center;gap:10px'},
      el('span', {class:'badge'}, 'LOCAL'), state,
      el('button', {class:'ghost', onclick: async () => { await api('/api/logout', {method:'POST'}); location.reload(); }}, 'Sign out')),
    el('label', {}, 'Model'), model,
    el('label', {}, 'Prompt'), prompt,
    el('div', {class:'row'}, el('div', {}, el('label', {}, 'Width'), w),
                          el('div', {}, el('label', {}, 'Height'), h)),
    slots, run, out, box));
  renderSlots();

  api('/api/state').then(s => { state.textContent = s.online ? ('ComfyUI online · ' + s.nodes + ' nodes') : 'ComfyUI OFFLINE';
      state.className = 'state ' + (s.online ? 'ok' : 'bad'); })
    .catch(() => { state.textContent = 'ComfyUI OFFLINE'; state.className = 'state bad'; });
}

api('/api/state').then(s => { PRESETS = s.presets; studio(); }).catch(() => login());
</script></body></html>`;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`WITCHCRAFT LOCAL  ->  http://127.0.0.1:${PORT}`);
  console.log(`  comfy  : ${COMFY}`);
  console.log(`  owner  : required`);
  console.log(`  presets: ${LOCAL_PRESETS.map((m) => m.id).join(', ')}`);
});