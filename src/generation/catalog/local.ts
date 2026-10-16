import type { ModelEntry } from "./types";
import { LTX23_MODEL } from "./ltx23";
import { H3_MODEL_T2V, H3_MODEL_I2V } from "./h3";

const seed = { type: "range", min: -1, max: 2147483647, step: 1, default: -1 } as const;

/** The H3 video sizes the installed graphs were authored at. Kept in step with
    H3_SIZES in src/generation/h3.ts so a size the graph cannot render is never
    offered. */
const H3_SIZES = ["960x544", "544x960", "832x480", "480x832"] as const;

/** Local render engines: real GPU work on the studio PC, not a hosted API and
    not a language model. Only the presets below exist; nothing else is offered. */
export const LOCAL_MODELS: readonly ModelEntry[] = [
  LTX23_MODEL,
  H3_MODEL_T2V,
  H3_MODEL_I2V,
  {
    id: "local-wan22-i2v",
    provider: "local",
    surface: "video",
    label: "Wan 2.2 Animate — local GPU",
    roles: { start: 1 },
    settings: {
      preset: { type: "enum", values: ["wan22-i2v"], default: "wan22-i2v" },
      resolution: { type: "enum", values: ["832x448", "448x832", "1280x704", "704x1280"], default: "832x448" },
      frames: { type: "range", min: 49, max: 97, step: 16, default: 81 },
      motion: { type: "enum", values: ["full", "camera", "still"], default: "full" },
      seed,
    },
  },
  {
    id: "local-wan22-t2v",
    provider: "local",
    surface: "video",
    label: "Wan 2.2 Motion — local GPU",
    roles: {},
    settings: {
      preset: { type: "enum", values: ["wan22-t2v"], default: "wan22-t2v" },
      resolution: { type: "enum", values: ["832x448", "448x832", "1280x704", "704x1280"], default: "832x448" },
      frames: { type: "range", min: 49, max: 97, step: 16, default: 81 },
      motion: { type: "enum", values: ["full", "camera", "still"], default: "full" },
      seed,
    },
  },
  {
    id: "local-realvis-sdxl",
    provider: "local",
    surface: "image",
    label: "RealVis XL Photo — local GPU",
    roles: {},
    settings: {
      preset: { type: "enum", values: ["realvis-sdxl"], default: "realvis-sdxl" },
      width: { type: "range", min: 512, max: 1536, step: 64, default: 1024 },
      height: { type: "range", min: 512, max: 1536, step: 64, default: 1024 },
      seed,
    },
  },
  /* ---- v0.02: photoreal image models + swap/edit, verified by real renders ---- */
  {
    id: "local-krea2-turbo",
    provider: "local",
    surface: "image",
    label: "Krea 2 Turbo Photo — local GPU",
    roles: {},
    settings: {
      preset: { type: "enum", values: ["krea2-turbo"], default: "krea2-turbo" },
      width: { type: "range", min: 512, max: 1344, step: 64, default: 768 },
      height: { type: "range", min: 512, max: 1344, step: 64, default: 1024 },
      seed,
    },
  },
  {
    id: "local-flux-schnell",
    provider: "local",
    surface: "image",
    label: "FLUX Schnell Photo — local GPU (unrestricted)",
    roles: {},
    settings: {
      preset: { type: "enum", values: ["flux-schnell"], default: "flux-schnell" },
      width: { type: "range", min: 512, max: 1344, step: 64, default: 768 },
      height: { type: "range", min: 512, max: 1344, step: 64, default: 1024 },
      seed,
    },
  },
  {
    id: "local-reactor-faceswap",
    provider: "local",
    surface: "image",
    label: "Face Swap (ReActor) — local GPU",
    roles: { start: 1, reference: 1 },
    settings: {
      preset: { type: "enum", values: ["reactor-faceswap"], default: "reactor-faceswap" },
      seed,
    },
  },
  {
    id: "local-character-ipadapter",
    provider: "local",
    surface: "image",
    label: "Character Swap (IPAdapter) — local GPU",
    roles: { reference: 1 },
    settings: {
      preset: { type: "enum", values: ["character-ipadapter"], default: "character-ipadapter" },
      width: { type: "range", min: 512, max: 1344, step: 64, default: 1024 },
      height: { type: "range", min: 512, max: 1344, step: 64, default: 1024 },
      seed,
    },
  },
  {
    id: "local-image-edit",
    provider: "local",
    surface: "image",
    label: "Image Edit (inpaint-style) — local GPU",
    roles: { start: 1 },
    settings: {
      preset: { type: "enum", values: ["image-edit"], default: "image-edit" },
      denoise: { type: "range", min: 0.2, max: 0.45, step: 0.05, default: 0.4 },
      seed,
    },
  },
];
