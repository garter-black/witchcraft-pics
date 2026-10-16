/** Face swap, character swap and edit graphs for the studio PC.
 *
 *  ReActor swap   - LoadImage(target) + LoadImage(reference face)
 *                   -> ReActorFaceSwap -> optional face restore -> SaveImage
 *  IPAdapter      - IPAdapterModelLoader + CLIPVisionLoader + CLIPVisionEncode
 *                   -> IPAdapterAdvanced, conditions generation on a character face
 *  SDXL img2img   - CheckpointLoaderSimple + KSampler + VAEEncode/Decode
 *  LTX/H3 edit    - reuses the existing video graphs with the source frame as the
 *                   reference, which is how extend/restyle is expressed today.
 *
 *  Same contract as local-input.ts: fixed reviewed graphs only, no run-time graph
 *  building from user text. The PC may substitute exactly one field,
 *  REFERENCE_FIELD, and only with bytes it downloaded from a worker-authorised URL.
 */

import { REFERENCE_FIELD, type ComfyGraph } from "./local-input";

const SDXL_NEGATIVE =
  "blurry, low quality, worst quality, watermark, text overlay, deformed, extra fingers";

/** Face swap. `target` is the image to change, `reference` supplies the face. */
export function reactorSwap(
  targetUrl: string,
  referenceUrl: string,
  opts: { restore?: boolean; visibility?: number; gender?: "no" | "female" | "male" } = {},
): ComfyGraph {
  const restore = opts.restore ?? true;
  const graph: ComfyGraph = {
    "1": { class_type: "LoadImage", inputs: { image: "", [REFERENCE_FIELD]: targetUrl } },
    "2": { class_type: "LoadImage", inputs: { image: "", [REFERENCE_FIELD]: referenceUrl } },
    "3": {
      class_type: "ReActorFaceSwap",
      inputs: {
        enabled: true,
        input_image: ["1", 0],
        source_image: ["2", 0],
        swap_model: "inswapper_128.onnx",
        facedetection: "retinaface_resnet50",
        face_restore_model: restore ? "GFPGANv1.4.pth" : "none",
        face_restore_visibility: opts.visibility ?? 0.8,
        codeformer_weight: 0.5,
        detect_gender_input: opts.gender ?? "no",
        detect_gender_source: opts.gender ?? "no",
        input_faces_index: "0",
        source_faces_index: "0",
        console_log_level: 1,
      },
    },
    "4": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "witchcraft/faceswap" } },
  };
  return graph;
}

/** Character conditioning: IPAdapter conditions the generation on a character
 *  reference so the face survives instead of drifting (the 6 Oct face-drift defect).
 *  Wraps an SDXL txt2img so the caller gets a finished image, not just conditioning. */
export function characterSwap(
  prompt: string,
  characterUrl: string,
  opts: { width?: number; height?: number; steps?: number; seed?: number; weight?: number } = {},
): ComfyGraph {
  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  const steps = opts.steps ?? 28;
  const seed = opts.seed ?? 0;
  const weight = opts.weight ?? 0.8;

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "RealVisXL_V5.0_fp16.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "2n": { class_type: "CLIPTextEncode", inputs: { text: SDXL_NEGATIVE, clip: ["1", 1] } },
    "3": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "4": { class_type: "LoadImage", inputs: { image: "", [REFERENCE_FIELD]: characterUrl } },
    "5": {
      class_type: "IPAdapterModelLoader",
      inputs: { ipadapter_file: "ip-adapter-plus-face_sdxl_vit-h.safetensors" },
    },
    "6": {
      class_type: "CLIPVisionLoader",
      inputs: { clip_name: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors" },
    },
    "7": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["6", 0], image: ["4", 0], crop: "center" } },
    "8": {
      class_type: "IPAdapterAdvanced",
      inputs: {
        model: ["1", 0],
        ipadapter: ["5", 0],
        image: ["4", 0],
        weight,
        weight_type: "linear",
        combine_embeds: "concat",
        start_at: 0.0,
        end_at: 0.9,
        embeds_scaling: "V only",
        clip_vision: ["6", 0],
      },
    },
    "9": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg: 5.5,
        sampler_name: "dpmpp_2m_sde",
        scheduler: "karras",
        denoise: 1.0,
        model: ["8", 0],
        positive: ["2", 0],
        negative: ["2n", 0],
        latent_image: ["3", 0],
      },
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["1", 2] } },
    "11": { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: "witchcraft/character" } },
  };
}

/** Image edit / img2img. denoise 0.30-0.45 keeps structure; above ~0.45 the face
 *  drifts (measured 6 Oct). Clamped here rather than trusted from the client. */
export function imageEdit(
  prompt: string,
  sourceUrl: string,
  opts: { width?: number; height?: number; steps?: number; seed?: number; denoise?: number } = {},
): ComfyGraph {
  const denoise = Math.min(0.45, Math.max(0.2, opts.denoise ?? 0.4));
  const steps = opts.steps ?? 28;
  const seed = opts.seed ?? 0;

  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "RealVisXL_V5.0_fp16.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "2n": { class_type: "CLIPTextEncode", inputs: { text: SDXL_NEGATIVE, clip: ["1", 1] } },
    "3": { class_type: "LoadImage", inputs: { image: "", [REFERENCE_FIELD]: sourceUrl } },
    "4": { class_type: "VAEEncode", inputs: { pixels: ["3", 0], vae: ["1", 2] } },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps,
        cfg: 5.5,
        sampler_name: "dpmpp_2m_sde",
        scheduler: "karras",
        denoise,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["2n", 0],
        latent_image: ["4", 0],
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "witchcraft/imgedit" } },
  };
}