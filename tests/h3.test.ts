import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h3FrameLength, h3Video, H3_MIN_FRAMES, H3_MAX_FRAMES } from '../src/generation/h3';
import { toComfyGraph } from '../src/generation/local-input';
import { enhanceWithAgent, validateEnhanceRequest, parseEnhance } from '../worker/planner';
import { PRESET_IDS } from '../worker/local-poll';
import { getModel } from '../src/generation/catalog';
import worker from '../worker/index';

// ---- H3 frame grid (17k+5) ------------------------------------------------

test('h3 frames snap to the 17k+5 grid and never leave it', () => {
  const grid = [22, 39, 56, 73, 90, 107, 124];
  for (let raw = 1; raw <= 200; raw++) {
    const n = h3FrameLength(raw);
    assert.ok(grid.includes(n), `${raw} -> ${n} is off-grid`);
    assert.ok(n >= H3_MIN_FRAMES && n <= H3_MAX_FRAMES);
  }
  assert.equal(h3FrameLength(121), 124);
  assert.equal(h3FrameLength(120), 124);
  // Below the grid floor stays at the floor; 24 is inside the grid and snaps UP.
  assert.equal(h3FrameLength(20), 22);
  assert.equal(h3FrameLength(24), 39);
});

// ---- H3 graph shape -------------------------------------------------------

test('h3 t2v graph uses the installed filenames, BasicGuider and both VAEs', () => {
  const g = h3Video({ prompt: 'a red panda on a log', width: 960, height: 544, length: 121, seed: 11 }, 'h3-t2v');
  assert.equal(g['1'].class_type, 'UnetLoaderGGUF');
  assert.equal(g['1'].inputs.unet_name, 'minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf');
  assert.equal(g['2'].inputs.clip_name, 'qwen3vl_32b_minimax_h3-Q2_K_M.gguf');
  assert.equal(g['2'].inputs.type, 'minimax');
  assert.equal(g['3'].inputs.vae_name, 'minimax_h3_video_vae_fp16.safetensors');
  assert.equal(g['4'].inputs.vae_name, 'minimax_h3_audio_vae_fp32.safetensors');
  // BasicGuider, NOT a CFG guider, and no negative conditioning anywhere.
  assert.equal(g['11'].class_type, 'BasicGuider');
  assert.equal(JSON.stringify(g).includes('CFGGuider'), false);
  assert.equal(JSON.stringify(g).includes('negative'), false);
  // SigmaShift pair and length snapped to grid.
  assert.equal(g['5'].inputs.shift_video, 12.0);
  assert.equal(g['5'].inputs.shift_audio, 3.0);
  assert.equal(g['7'].inputs.length, 124);
  // The sampler takes the conditioning slot 0 and latent slot 1.
  assert.deepEqual(g['12'].inputs.latent_image, ['7', 1]);
  assert.deepEqual(g['11'].inputs.conditioning, ['7', 0]);
  // Audio VAE decode feeds CreateVideo, which feeds SaveVideo.
  assert.equal(g['14'].class_type, 'VAEDecodeAudio');
  assert.deepEqual(g['15'].inputs.audio, ['14', 0]);
  assert.equal(g['16'].class_type, 'SaveVideo');
});

test('h3 i2v requires a reference image, bridges via LoadImage node17 into first_frame', () => {
  assert.throws(() => h3Video({ prompt: 'x', width: 960, height: 544, length: 73, seed: 1 }, 'h3-i2v'));
  const g = h3Video({ prompt: 'x', width: 960, height: 544, length: 73, seed: 1 }, 'h3-i2v', 'https://witchcraft.pics/media/ab/cd.png');
  // The native node takes an IMAGE tensor, so a separate LoadImage carries the
  // bridge marker and its IMAGE output is linked as first_frame — not the marker
  // sitting on the conditioning node itself.
  assert.equal(g['17'].class_type, 'LoadImage');
  assert.equal(g['17'].inputs.witchcraft_reference_url, 'https://witchcraft.pics/media/ab/cd.png');
  assert.deepEqual(g['7'].inputs.first_frame, ['17', 0]);
  assert.equal('witchcraft_reference_url' in g['7'].inputs, false, 'the marker lives on node 17, not node 7');
});

test('toComfyGraph routes the h3 presets and preserves the existing ones', () => {
  const plane = { model: 'local-h3-t2v', prompt: { text: 'a lighthouse' }, media: {}, settings: { resolution: '960x544', duration: 5, seed: 3 } };
  const g = toComfyGraph(plane as any, 'h3-t2v');
  assert.equal(g['7'].class_type, 'MiniMaxH3ImageToVideo');
  // An unsupported H3 size is rejected rather than silently clamped.
  assert.throws(() => toComfyGraph({ ...plane, settings: { resolution: '1280x704', duration: 5 } } as any, 'h3-t2v'));
  // LTX/Wan/RealVis still resolve to their own graphs.
  assert.equal(toComfyGraph({ model: 'local-realvis-sdxl', prompt: { text: 'x' }, media: {}, settings: {} } as any, 'realvis-sdxl')['1'].class_type, 'CheckpointLoaderSimple');
  assert.equal(toComfyGraph({ model: 'local-wan22-t2v', prompt: { text: 'x' }, media: {}, settings: {} } as any, 'wan22-t2v')['17'].class_type, 'VHS_VideoCombine');
});

// ---- catalog registration -------------------------------------------------

test('the local H3 models are registered and resolve to reviewed presets', () => {
  for (const id of ['local-h3-t2v', 'local-h3-i2v']) {
    const m = getModel(id);
    assert.equal(m.provider, 'local');
    assert.ok(PRESET_IDS[id], `${id} must resolve to a local preset`);
  }
  // The REMOTE H3 entry is a different model and is untouched.
  assert.notEqual(getModel('minimax-h3').provider, 'local');
});

// ---- enhancer: preservation, validation, parsing --------------------------

// ---- enhancer: provider call forwards the exact prompt, never fakes success --

test('enhancer validation rejects malformed input', () => {
  assert.throws(() => validateEnhanceRequest({ prompt: '', surface: 'image', mode: 'standard' }));
  assert.throws(() => validateEnhanceRequest({ prompt: 'x', surface: 'audio', mode: 'standard' }));
  assert.throws(() => validateEnhanceRequest({ prompt: 'x', surface: 'image', mode: 'wild' }));
  assert.throws(() => validateEnhanceRequest({ prompt: 'x'.repeat(4001), surface: 'image', mode: 'extra' }));
  // This is a TEXT enhancer, so its bound is the loose 1..120; a 30s request for
  // a 30s-capable model (Seedance 2.5) is valid and must NOT be refused here.
  assert.doesNotThrow(() => validateEnhanceRequest({ prompt: 'x', surface: 'video', mode: 'extra', duration: 30 }));
  assert.throws(() => validateEnhanceRequest({ prompt: 'x', surface: 'image', mode: 'extra', duration: 0 }));
  assert.throws(() => validateEnhanceRequest({ prompt: 'x', surface: 'image', mode: 'extra', duration: 121 }));
  const ok = validateEnhanceRequest({ prompt: '  hi  ', surface: 'video', mode: 'extra', duration: 5 });
  // The exact original — including its surrounding whitespace — is preserved.
  assert.equal(ok.prompt, '  hi  ');
  assert.equal(validateEnhanceRequest({ prompt: 'only trimmed for the empty check', surface: 'image', mode: 'standard' }).prompt, 'only trimmed for the empty check');
});

test('enhancer parser accepts a real rewrite but refuses non-JSON and missing prompt', () => {
  const req = { prompt: 'a fox in snow', surface: 'image' as const, mode: 'extra' as const };
  // A legitimate rewrite is allowed (there is deliberately NO substring
  // requirement): the original is preserved verbatim in originalPrompt.
  const rewrite = parseEnhance('{"prompt":"a wolf in a desert","changes":["lighting"]}', req);
  assert.ok(rewrite && rewrite.ok);
  if (rewrite && rewrite.ok) {
    assert.equal(rewrite.prompt, 'a wolf in a desert');
    assert.equal(rewrite.originalPrompt, req.prompt, 'the exact original is always preserved');
  }
  // Non-JSON and a JSON object with no string prompt are refused.
  assert.equal(parseEnhance('not json at all', req), null);
  assert.equal(parseEnhance('{"changes":["lighting"]}', req), null);
  assert.equal(parseEnhance('{"prompt":"   "}', req), null, 'an empty prompt is refused');
  const good = parseEnhance('```json\n{"prompt":"a fox in snow, art direction: layered light","changes":["lighting"]}\n```', req);
  assert.ok(good && good.ok);
  if (good && good.ok) assert.equal(good.originalPrompt, req.prompt);
});

test('enhanceWithAgent forwards the exact prompt (whitespace intact) as data', async () => {
  const original = '  a lone lighthouse keeper  during a storm  ';
  let seen: any = null;
  const out = await enhanceWithAgent(
    { prompt: original, surface: 'video', model: 'minimax-h3', mode: 'extra', preset: 'cinematic', duration: 5, constraints: 'clip_length_seconds=5' },
    'go-key',
    (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: 'a lone lighthouse keeper during a storm, art direction: hard rim light', changes: ['lighting'] }) } }] }), { status: 200 });
    }) as any,
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.originalPrompt, original, 'the exact original, whitespace intact, is returned');
  assert.equal(out.source, 'provider:space-bunny-free');
  // The provider request carries the exact prompt, model, surface, mode, preset,
  // duration and constraints forwarded verbatim.
  const body = JSON.parse(seen.init.body);
  const message = JSON.parse(body.messages[1].content);
  assert.equal(message.prompt, original, 'the exact prompt reaches the provider unchanged');
  assert.equal(message.model, 'minimax-h3');
  assert.equal(message.surface, 'video');
  assert.equal(message.mode, 'extra');
  assert.equal(message.preset, 'cinematic');
  assert.equal(message.duration, 5);
  assert.equal(message.constraints, 'clip_length_seconds=5');
  assert.equal(body.model, 'space-bunny-free');
  assert.equal(String(seen.init.headers.Authorization).includes('go-key'), true);
  // The prompt text appears only as DATA, never re-typed into the system instruction.
  assert.equal(body.messages[0].content.includes(original.trim()), false, 'the prompt is not placed in the system instruction');
});

test('enhanceWithAgent reports failures truthfully and never fabricates a success', async () => {
  const req = { prompt: 'a fox in snow', surface: 'image' as const, mode: 'extra' as const };

  // Missing key: refused before any provider call.
  let called = false;
  const noKey = await enhanceWithAgent(req, '', (async () => { called = true; throw new Error('must not be called'); }) as any);
  assert.equal(noKey.ok, false);
  assert.equal(called, false, 'no network call without a key');
  assert.match((noKey as any).reason, /not configured/i);

  // Network failure.
  const net = await enhanceWithAgent(req, 'k', (async () => { throw new Error('socket hang up'); }) as any);
  assert.equal(net.ok, false);
  assert.match((net as any).reason, /could not be reached/i);

  // Timeout (AbortSignal.timeout raises a TimeoutError).
  const timedOut = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const timeout = await enhanceWithAgent(req, 'k', (async () => { throw timedOut; }) as any);
  assert.equal(timeout.ok, false);
  assert.match((timeout as any).reason, /in time/i);

  // HTTP 401 and 500.
  const denied = await enhanceWithAgent(req, 'k', (async () => new Response('nope', { status: 401 })) as any);
  assert.equal(denied.ok, false);
  const broken = await enhanceWithAgent(req, 'k', (async () => new Response('nope', { status: 500 })) as any);
  assert.equal(broken.ok, false);

  // Empty provider content.
  const empty = await enhanceWithAgent(req, 'k', (async () => new Response(JSON.stringify({ choices: [{ message: { content: '   ' } }] }), { status: 200 })) as any);
  assert.equal(empty.ok, false);
  assert.match((empty as any).reason, /empty/i);

  // Malformed JSON in the provider content stays a failure — never a fake success.
  const malformed = await enhanceWithAgent(req, 'k', (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), { status: 200 })) as any);
  assert.equal(malformed.ok, false);
  assert.match((malformed as any).reason, /unusable/i);
});

// ---- /api/enhance endpoint: auth + CSRF -----------------------------------

const ENV = {
  SESSION_SECRET: 'test-secret-that-is-longer-than-32-characters',
  HF_API_BASE_URL: 'https://api.higgsfield.ai',
  OWNER_ACCESS_KEY: 'owner-key-abcdefghijklmnop',
  LOCAL_BRIDGE_HMAC: 'h'.repeat(40),
  MEDIA: { get: async () => null, put: async () => ({ key: 'x' }), list: async () => ({ objects: [] }), delete: async () => {} },
} as any;

async function ownerCookie(): Promise<string> {
  const r = await worker.fetch(new Request('https://witchcraft.pics/api/credentials?provider=local', {
    method: 'POST', headers: { origin: 'https://witchcraft.pics', 'content-type': 'application/json' },
    body: JSON.stringify({ ownerKey: 'owner-key-abcdefghijklmnop' }),
  }), ENV);
  assert.equal(r.status, 200);
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

test('/api/enhance is refused anonymously and cross-origin', async () => {
  const anon = await worker.fetch(new Request('https://witchcraft.pics/api/enhance', {
    method: 'POST', headers: { origin: 'https://witchcraft.pics', 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x', surface: 'image', mode: 'extra' }),
  }), ENV);
  assert.equal(anon.status, 401);
  const cross = await worker.fetch(new Request('https://witchcraft.pics/api/enhance', {
    method: 'POST', headers: { origin: 'https://other.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x', surface: 'image', mode: 'extra' }),
  }), ENV);
  assert.equal(cross.status, 403);
});

test('/api/enhance reports a truthful failure (never a fabricated success) for the owner', async () => {
  const cookie = await ownerCookie();
  // The test env has no PLANNER_GO_API_KEY, so the enhancer cannot reach a
  // provider: the route must report ok:false with a real reason and NOT invent
  // an enhanced prompt.
  const r = await worker.fetch(new Request('https://witchcraft.pics/api/enhance', {
    method: 'POST', headers: { origin: 'https://witchcraft.pics', 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'a lone lighthouse keeper during a storm', surface: 'video', mode: 'extra' }),
  }), ENV);
  assert.equal(r.status, 200);
  const body = await r.json() as any;
  assert.equal(body.ok, false);
  assert.ok(typeof body.reason === 'string' && body.reason.length > 0);
  assert.equal('prompt' in body, false, 'a failed enhancement returns no fabricated prompt');
});

test('/api/enhance rejects an invalid mode truthfully for the owner', async () => {
  const cookie = await ownerCookie();
  const r = await worker.fetch(new Request('https://witchcraft.pics/api/enhance', {
    method: 'POST', headers: { origin: 'https://witchcraft.pics', 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'x', surface: 'image', mode: 'wild' }),
  }), ENV);
  assert.equal(r.status, 400);
  const body = await r.json() as any;
  assert.equal(body.ok, false);
  assert.ok(typeof body.reason === 'string');
});
