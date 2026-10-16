// Local MiniMax H3 video presets (studio GPU).
//
// Reproduces the INSTALLED, REVIEWED ComfyUI API graphs on this machine, read
// verbatim from disk on 1 Oct 2026:
//   C:/AI/setup/H3 T2V 10GB - ready.api.json
//   C:/AI/setup/H3 I2V first-last 10GB - ready.api.json
//
// These are H3's own native nodes (ComfyUI v0.37.0). Node classes, model file
// names, the SigmaShift pair, the BasicGuider (NOT a CFG guider), sampler,
// scheduler and the 17k+5 frame grid are reproduced exactly. Only primitive
// values (prompt, width, height, length, seed) are parameterised.
//
// Nothing here is derived at run time and no caller-supplied node is accepted.
//
// SEPARATE FROM THE HOSTED MODEL: src/generation/catalog/minimax-h3.ts is the
// REMOTE MiniMax H3 route. This file is the LOCAL install. Do not conflate them.

export type H3Params = {
  prompt: string;
  width: number;
  height: number;
  /** Requested frame count. Snapped to the legal 17k+5 grid below. */
  length: number;
  seed: number;
};

export type H3Mode = "h3-t2v" | "h3-i2v";

export const H3_UNET = "minimax_h3_fl2va_pruned-UD-Q3_K_XL.gguf";
export const H3_TEXT_ENCODER = "qwen3vl_32b_minimax_h3-Q2_K_M.gguf";
export const H3_VIDEO_VAE = "minimax_h3_video_vae_fp16.safetensors";
export const H3_AUDIO_VAE = "minimax_h3_audio_vae_fp32.safetensors";

/** H3 accepts ONLY frame counts on the 17k+5 grid. A request between two grid
    values snaps UP to the next one, so a clip is never shorter than asked
    (121 -> 124, 119 -> 124, 22 -> 22). The snap is explicit, never silent. */
const H3_GRID_STEP = 17;
const H3_GRID_OFFSET = 5;
export const H3_MIN_FRAMES = 22; // 17*1+5
export const H3_MAX_FRAMES = 124; // 17*7+5
export const H3_FPS = 24;

export function h3FrameLength(requested: number): number {
  const raw = Number.isFinite(requested) ? Math.ceil(requested) : H3_MAX_FRAMES;
  const clamped = Math.min(H3_MAX_FRAMES, Math.max(H3_MIN_FRAMES, raw));
  const k = Math.ceil((clamped - H3_GRID_OFFSET) / H3_GRID_STEP);
  const snapped = H3_GRID_OFFSET + Math.max(1, k) * H3_GRID_STEP;
  return Math.min(H3_MAX_FRAMES, Math.max(H3_MIN_FRAMES, snapped));
}

// Sizes the installed graphs were authored at, plus the standard local set.
export const H3_SIZES: readonly [number, number][] = [
  [960, 544],
  [544, 960],
  [832, 480],
  [480, 832],
];

type H3Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Build the reviewed H3 graph. `startImage` is a same-origin URL the worker
    already authorised, injected only into the node's reference field. */
export function h3Video(p: H3Params, mode: H3Mode, startImage?: string): H3Graph {
  const length = h3FrameLength(p.length);
  const seed = Number.isFinite(p.seed) && p.seed >= 0 ? Math.floor(p.seed) : 1;
  const prefix = mode === "h3-i2v" ? "video/H3_I2V_10GB" : "video/H3_T2V_10GB";

  const conditioning: Record<string, unknown> = {
    clip: ["2", 0],
    vae: ["3", 0],
    prompt: p.prompt,
    width: p.width,
    height: p.height,
    length,
  };

  // I2V takes the keyframe as an IMAGE tensor on the native node's own
  // `first_frame` input (nodes_minimax_h3.py: io.Image.Input("first_frame",
  // optional=True)). A filename string cannot reach it, so a separate
  // LoadImage node carries the bridge marker and its IMAGE output is linked.
  if (mode === "h3-i2v") {
    if (!startImage) throw new Error("This preset needs a reference image to animate.");
    conditioning["first_frame"] = ["17", 0];
  }
  const graph: H3Graph = {
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: H3_UNET } },
    "2": {
      class_type: "CLIPLoaderGGUF",
      inputs: { clip_name: H3_TEXT_ENCODER, type: "minimax" },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: H3_VIDEO_VAE } },
    "4": { class_type: "VAELoader", inputs: { vae_name: H3_AUDIO_VAE } },
    "5": {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model: ["1", 0], shift_video: 12.0, shift_audio: 3.0 },
    },
    "7": { class_type: "MiniMaxH3ImageToVideo", inputs: conditioning },
    "8": { class_type: "RandomNoise", inputs: { noise_seed: seed } },
    "9": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "10": {
      class_type: "BasicScheduler",
      inputs: { model: ["5", 0], scheduler: "simple", steps: 8, denoise: 1.0 },
    },
    // BasicGuider, not a CFG guider: H3 is distilled (cfg 1.0, 8 steps).
    "11": {
      class_type: "BasicGuider",
      inputs: { model: ["5", 0], conditioning: ["7", 0] },
    },
    "12": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["8", 0],
        guider: ["11", 0],
        sampler: ["9", 0],
        sigmas: ["10", 0],
        latent_image: ["7", 1],
      },
    },
    "13": { class_type: "VAEDecode", inputs: { samples: ["12", 0], vae: ["3", 0] } },
    "14": { class_type: "VAEDecodeAudio", inputs: { samples: ["12", 0], vae: ["4", 0] } },
    "15": {
      class_type: "CreateVideo",
      inputs: {
        images: ["13", 0],
        audio: ["14", 0],
        fps: H3_FPS,
        bit_depth: 8,
        color_space: "sRGB",
        codec: "h264",
      },
    },
    "16": { class_type: "SaveVideo", inputs: { video: ["15", 0], filename_prefix: prefix } },
  };

  if (mode === "h3-i2v") {
    // The bridge substitutes this node's `image` with the ComfyUI filename it
    // uploaded; its IMAGE output feeds the native node's first_frame.
    graph["17"] = { class_type: "LoadImage", inputs: { image: "", [REFERENCE_FIELD]: startImage } };
  }
  return graph;
}

/** The ONE graph field a PC may substitute, matching the existing bridge contract. */
export const REFERENCE_FIELD = "witchcraft_reference_url";

/** Reviewed local H3 capacity. The installed graphs are built for a 5s clip at
    24 fps (length 124); longer renders are untested locally, so they are
    refused rather than silently shortened. */
export const H3_MIN_SECONDS = 2;
export const H3_MAX_SECONDS = 5;

/** Frames for a requested duration, snapped UP to the 17k+5 grid so the clip is
    never shorter than asked. Throws for a duration outside reviewed capacity or
    not on the whole-second grid; nothing is clamped silently. */
export function h3FramesForSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    throw new Error("Choose a whole-number clip length.");
  }
  if (seconds < H3_MIN_SECONDS || seconds > H3_MAX_SECONDS) {
    throw new Error(`Choose a clip length between ${H3_MIN_SECONDS} and ${H3_MAX_SECONDS} seconds.`);
  }
  const frames = h3FrameLength(seconds * H3_FPS);
  if (frames > H3_MAX_FRAMES) {
    throw new Error(`Choose a clip length between ${H3_MIN_SECONDS} and ${H3_MAX_SECONDS} seconds.`);
  }
  return frames;
}
