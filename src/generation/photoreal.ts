/** Krea 2 Turbo and FLUX.1 schnell text-to-image graphs.
 *
 * Both verified by real renders on this PC (12 Oct 2026):
 *   Krea 2 Turbo  768x1024, 8 steps, er_sde/simple, 28s
 *   FLUX schnell  768x1024, 4 steps, euler/simple,  20s
 *
 * Krea 2 Turbo is the quality lane. Its licence is the Krea 2 Community Licence
 * (NON-COMMERCIAL), so it must never become the default for a paid feature.
 * FLUX.1 schnell is Apache-2.0 and is the unrestricted lane.
 *
 * Krea requires CLIPLoader type "krea2" - a 12-layer Qwen3-VL stack giving
 * 12x2560 = 30720 conditioning features. Any other type fails at the sampler
 * with a precise feature-count error.
 */

import type { GenerationPlane } from "./catalog/types";
import type { ComfyGraph } from "./local-input";
import { resolveComfySeed } from "./seed";

const NEGATIVE =
  "painting, illustration, anime, cartoon, 3d render, cgi, sketch, blurry, low quality, " +
  "deformed, watermark, text, oversaturated, plastic skin, doll face, extra fingers";

function size(plane: GenerationPlane, fallback: [number, number]) {
  return {
    width: Number((plane.settings as Record<string, unknown>).width ?? fallback[0]),
    height: Number((plane.settings as Record<string, unknown>).height ?? fallback[1]),
  };
}

export function kreaGraph(prompt: string, seed: number, plane: GenerationPlane): ComfyGraph {
  const { width, height } = size(plane, [768, 1024]);
  const actualSeed = resolveComfySeed(seed);
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "krea2_turbo_fp8_scaled.safetensors", weight_dtype: "fp8_e4m3fn" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2" },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "4n": { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE, clip: ["2", 0] } },
    "5": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "6": {
      class_type: "ModelSamplingFlux",
      inputs: { model: ["1", 0], max_shift: 1.15, base_shift: 0.5, width, height },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        seed: actualSeed,
        steps: 8,
        cfg: 1.0,
        sampler_name: "er_sde",
        scheduler: "simple",
        denoise: 1.0,
        model: ["6", 0],
        positive: ["4", 0],
        negative: ["4", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "witchcraft/krea2" } },
  };
}

export function fluxGraph(prompt: string, seed: number, plane: GenerationPlane): ComfyGraph {
  const { width, height } = size(plane, [768, 1024]);
  const actualSeed = resolveComfySeed(seed);
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: "flux1-schnell-fp8.safetensors", weight_dtype: "fp8_e4m3fn" },
    },
    "2": {
      class_type: "DualCLIPLoader",
      inputs: {
        clip_name1: "t5xxl_fp8_e4m3fn.safetensors",
        clip_name2: "clip_l.safetensors",
        type: "flux",
      },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
    "4n": { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE, clip: ["2", 0] } },
    "5": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
    "6": {
      class_type: "ModelSamplingFlux",
      inputs: { model: ["1", 0], max_shift: 1.15, base_shift: 0.5, width, height },
    },
    "7": { class_type: "FluxGuidance", inputs: { conditioning: ["4", 0], guidance: 3.5 } },
    "7n": { class_type: "FluxGuidance", inputs: { conditioning: ["4n", 0], guidance: 3.5 } },
    "8": {
      class_type: "KSampler",
      inputs: {
        seed: actualSeed,
        steps: 4,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
        model: ["6", 0],
        positive: ["7", 0],
        negative: ["7n", 0],
        latent_image: ["5", 0],
      },
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "witchcraft/flux" } },
  };
}