import type { GenerationPlane } from "./catalog/types";
import { ltx23TextToVideo, LTX_SIZES } from "./ltx23";
import { h3Video, h3FramesForSeconds, H3_SIZES, type H3Mode } from "./h3";
import { reactorSwap, characterSwap, imageEdit } from "./swap-edit";
import { kreaGraph, fluxGraph } from "./photoreal";
import { resolveComfySeed } from "./seed";

/** The only render engines this product will drive on the studio PC. Each one is
    a fixed, reviewed ComfyUI graph. The bridge may not build a graph at run
    time, so an unknown preset can never become arbitrary remote code. */
export type LocalPreset =
  | "wan22-i2v"
  | "wan22-t2v"
  | "realvis-sdxl"
  | "ltx23-t2v"
  | "h3-t2v"
  | "h3-i2v"
  /* v0.02 - photoreal image models + swap/edit, verified against live ComfyUI */
  | "krea2-turbo"
  | "flux-schnell"
  | "reactor-faceswap"
  | "character-ipadapter"
  | "image-edit";

export const LOCAL_PRESETS: readonly LocalPreset[] = [
  "realvis-sdxl",
  "krea2-turbo",
  "flux-schnell",
  "reactor-faceswap",
  "character-ipadapter",
  "image-edit",
  "wan22-i2v",
  "wan22-t2v",
  "ltx23-t2v",
  "h3-t2v",
  "h3-i2v",
];

export type ComfyGraph = { [node: string]: { class_type: string; inputs: Record<string, unknown> } };

/** The ONE graph field a PC is allowed to substitute, and only with bytes it
    has downloaded from a same-origin URL the worker already authorised. */
export const REFERENCE_FIELD = "witchcraft_reference_url";

const WAN = {
  highNoise: "Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf",
  lowNoise: "Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf",
  highT2v: "Wan2.2-T2V-A14B-HighNoise-Q4_K_S.gguf",
  lowT2v: "Wan2.2-T2V-A14B-LowNoise-Q4_K_S.gguf",
  i2vHighLora: "wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors",
  i2vLowLora: "wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors",
  t2vHighLora: "wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors",
  t2vLowLora: "wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors",
  clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "wan_2.1_vae.safetensors",
  checkpoint: "RealVisXL_V5.0_fp16.safetensors",
} as const;

const STABLE_NEGATIVE =
  "blurry, low quality, worst quality, static image, motionless, watermark, text overlay, deformed";

/** Video settings are the bounded values the reviewed graph was measured at.
    Anything else is rejected rather than silently clamped into a slow render. */
export const LOCAL_VIDEO_SIZES: readonly [number, number][] = [
  [832, 448],
  [448, 832],
  [1280, 704],
  [704, 1280],
];

export function toComfyGraph(plane: GenerationPlane, preset: LocalPreset, startImageUrl?: string): ComfyGraph {
  const prompt = plane.prompt.text;
  const seed = resolveComfySeed(Number(plane.settings.seed ?? -1));
  /* v0.02 - swap/edit presets read their face/character plate from media.reference,
     the same role the catalog entries already declare. */
  const referenceUrl = plane.media.reference?.[0]?.url ?? "";
  if (preset === "reactor-faceswap") return reactorSwap(startImageUrl ?? "", referenceUrl, {});
  if (preset === "character-ipadapter") return characterSwap(prompt, referenceUrl || (startImageUrl ?? ""), { seed });
  if (preset === "image-edit") return imageEdit(prompt, startImageUrl ?? "", { seed });
  if (preset === "krea2-turbo") return kreaGraph(prompt, seed, plane);
  if (preset === "flux-schnell") return fluxGraph(prompt, seed, plane);
  if (preset === "h3-t2v" || preset === "h3-i2v") return h3Graph(plane, preset, prompt, seed, startImageUrl) as ComfyGraph;
  if (preset === "ltx23-t2v") return ltxGraph(plane, prompt, seed) as ComfyGraph;
  if (preset === "realvis-sdxl") return sdxlGraph(prompt, seed, plane);
  return wanGraph(plane, preset, prompt, seed, startImageUrl);
}

function sdxlGraph(prompt: string, seed: number, plane: GenerationPlane): ComfyGraph {
  const width = readSize(plane, [1024, 1024]);
  const height = readSize(plane, [1024, 1024], "height");
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: WAN.checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: STABLE_NEGATIVE, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: seed < 0 ? 1 : seed,
        steps: 28,
        cfg: 6.5,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "witchcraft/image", images: ["6", 0] },
    },
  };
}

function wanGraph(
  plane: GenerationPlane,
  preset: LocalPreset,
  prompt: string,
  seed: number,
  startImageUrl?: string,
): ComfyGraph {
  const i2v = preset === "wan22-i2v";
  if (i2v && !startImageUrl) throw new Error("This preset needs a reference image to animate.");
  if (!i2v && startImageUrl) throw new Error("This preset animates from text only.");
  const [width, height] = readVideoSize(plane);
  const frames = readFrames(plane);
  const actualSeed = seed < 0 ? 1 : seed;
  const motion = readMotion(plane);

  const graph: ComfyGraph = {
    "1": {
      class_type: "UnetLoaderGGUF",
      inputs: { unet_name: i2v ? WAN.highNoise : WAN.highT2v },
    },
    "2": { class_type: "UnetLoaderGGUF", inputs: { unet_name: i2v ? WAN.lowNoise : WAN.lowT2v } },
    "3": {
      class_type: "LoraLoaderModelOnly",
      inputs: { lora_name: i2v ? WAN.i2vHighLora : WAN.t2vHighLora, strength_model: 1, model: ["1", 0] },
    },
    "4": {
      class_type: "LoraLoaderModelOnly",
      inputs: { lora_name: i2v ? WAN.i2vLowLora : WAN.t2vLowLora, strength_model: 1, model: ["2", 0] },
    },
    "5": { class_type: "ModelSamplingSD3", inputs: { shift: 5, model: ["3", 0] } },
    "6": { class_type: "ModelSamplingSD3", inputs: { shift: 5, model: ["4", 0] } },
    "7": { class_type: "CLIPLoader", inputs: { clip_name: WAN.clip, type: "wan", device: "default" } },
    "8": { class_type: "VAELoader", inputs: { vae_name: WAN.vae } },
    "9": { class_type: "CLIPTextEncode", inputs: { text: `${prompt}\n${motion}`, clip: ["7", 0] } },
    "10": { class_type: "CLIPTextEncode", inputs: { text: STABLE_NEGATIVE, clip: ["7", 0] } },
    "13": {
      class_type: i2v ? "WanImageToVideo" : "WanTextToVideo",
      inputs: {
        width,
        height,
        length: frames,
        batch_size: 1,
        positive: ["9", 0],
        negative: ["10", 0],
        vae: ["8", 0],
        ...(i2v ? { start_image: ["12", 0] } : {}),
      },
    },
    "14": {
      class_type: "KSamplerAdvanced",
      inputs: {
        steps: 4,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        add_noise: "enable",
        noise_seed: actualSeed,
        start_at_step: 0,
        end_at_step: 2,
        return_with_leftover_noise: "enable",
        model: ["5", 0],
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["13", 0],
      },
    },
    "15": {
      class_type: "KSamplerAdvanced",
      inputs: {
        steps: 4,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        add_noise: "disable",
        noise_seed: 0,
        start_at_step: 2,
        end_at_step: 4,
        return_with_leftover_noise: "disable",
        model: ["6", 0],
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["14", 0],
      },
    },
    "16": { class_type: "VAEDecode", inputs: { samples: ["15", 0], vae: ["8", 0] } },
    "17": {
      class_type: "VHS_VideoCombine",
      inputs: {
        frame_rate: 16,
        loop_count: 0,
        filename_prefix: i2v ? "witchcraft/i2v" : "witchcraft/t2v",
        format: "video/h264-mp4",
        pix_fmt: "yuv420p",
        crf: 19,
        save_metadata: true,
        trim_to_audio: false,
        pingpong: false,
        save_output: true,
        images: ["16", 0],
      },
    },
  };

  if (i2v) {
    graph["11"] = { class_type: "LoadImage", inputs: { image: "", [REFERENCE_FIELD]: startImageUrl } };
    graph["12"] = {
      class_type: "ImageResizeKJv2",
      inputs: {
        width,
        height,
        upscale_method: "lanczos",
        keep_proportion: "resize",
        pad_color: "0, 0, 0",
        crop_position: "center",
        divisible_by: 16,
        image: ["11", 0],
      },
    };
  }
  return graph;
}

function readVideoSize(plane: GenerationPlane): [number, number] {
  const raw = plane.settings.resolution;
  if (typeof raw !== "string") return LOCAL_VIDEO_SIZES[0];
  const found = LOCAL_VIDEO_SIZES.find(([w, h]) => `${w}x${h}` === raw);
  if (!found) throw new Error("That video size is not supported by the studio renderer.");
  return found;
}

function readSize(plane: GenerationPlane, fallback: [number, number], key = "width"): number {
  const raw = plane.settings[key];
  return typeof raw === "number" ? raw : fallback[0];
}

function readFrames(plane: GenerationPlane): number {
  const raw = Number(plane.settings.frames ?? 81);
  if (!Number.isInteger(raw) || raw < 25 || raw > 121) throw new Error("Choose a supported clip length.");
  // ComfyUI's Wan graphs want length = frames - 1 internally; the reviewed
  // graph is authored at 81 for a 5s clip at 16fps.
  return Math.round(((raw - 1) / 16) % 2) === 0 ? raw - 1 : raw;
}

function readMotion(plane: GenerationPlane): string {
  const raw = plane.settings.motion;
  if (raw === "still") return "locked-off camera, subject holds position, no movement";
  if (raw === "camera") return "smooth cinematic camera move, subject motion secondary";
  return "natural full-body motion, subject movement across frame, coherent choreography";
}

/** LOCAL MiniMax H3: the installed native-node graph. Frames are snapped to the
    legal 17k+5 grid by the adapter, so an out-of-grid request never reaches a
    live render; sizes are bounded to the set the installed graph was built at. */
function h3Graph(
  plane: GenerationPlane,
  preset: LocalPreset,
  prompt: string,
  seed: number,
  startImageUrl?: string,
) {
  const i2v = preset === "h3-i2v";
  if (i2v && !startImageUrl) throw new Error("This preset needs a reference image to animate.");
  if (!i2v && startImageUrl) throw new Error("This preset animates from text only.");
  const raw = plane.settings.resolution;
  const found = typeof raw === "string" ? H3_SIZES.find(([w, h]) => `${w}x${h}` === raw) : undefined;
  if (typeof raw === "string" && !found) throw new Error("That video size is not supported by the H3 renderer.");
  const [width, height] = found ?? H3_SIZES[0];
  const seconds = Number(plane.settings.duration ?? 5);
  // Throws for 6s/7s instead of silently rendering a shorter clip.
  const length = h3FramesForSeconds(seconds);
  return h3Video(
    { prompt: `${prompt} ${readMotion(plane)}`, width, height, length, seed: seed < 0 ? 1 : seed },
    preset as H3Mode,
    startImageUrl,
  );
}

/** The user-selected stack: LTX 2.3 22B dev Q6_K, 24fps, real subject motion.
    Sizes and length are bounded to the measured known-good configuration. */
function ltxGraph(plane: GenerationPlane, prompt: string, seed: number) {
  const raw = plane.settings.resolution;
  const found = typeof raw === "string" ? LTX_SIZES.find(([w, h]) => `${w}x${h}` === raw) : undefined;
  const [width, height] = found ?? LTX_SIZES[0];
  const seconds = Number(plane.settings.duration ?? 4);
  if (!(seconds >= 1 && seconds <= 6)) throw new Error("Choose a clip length between 1 and 6 seconds.");
  return ltx23TextToVideo({
    prompt: `${prompt} ${readMotion(plane)}`,
    width,
    height,
    fps: 24,
    seconds,
    seed: seed < 0 ? 1 : seed,
    steps: 28,
  });
}