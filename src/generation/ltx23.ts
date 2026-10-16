// LTX 2.3 text-to-video preset.
//
// This is the EXISTING verified graph from D:/AI/workflows/blackstar-ltx23-t2v.api.json
// (the 22B dev Q6_K stack that produced PG500353144's 1280x704 / 97 frame / 24fps
// combat render in ~984s). Node classes and wiring are reproduced exactly; only
// the primitive values (prompt, width, height, fps, duration, seed) are parameterised.
// No graph is derived at run time and nothing here accepts a caller-supplied node.

export type LtxParams = {
  prompt: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  seed: number;
  steps: number;
};

export const LTX_SIZES: readonly [number, number][] = [
  [1280, 704],
  [704, 1280],
  [832, 480],
  [480, 832],
];

const NEGATIVE =
  "blurry, distorted anatomy, low quality, cartoon, video game, subtitles, watermark, oversaturated, frozen motion";

export function ltx23TextToVideo(p: LtxParams): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const frames = Math.max(1, Math.round(p.seconds * p.fps));
  return {
    "1": { class_type: "PrimitiveStringMultiline", inputs: { value: p.prompt } },
    "2": { class_type: "PrimitiveInt", inputs: { value: p.width } },
    "3": { class_type: "PrimitiveInt", inputs: { value: p.height } },
    "4": { class_type: "PrimitiveFloat", inputs: { value: p.fps } },
    "5": { class_type: "PrimitiveFloat", inputs: { value: p.seconds } },
    "6": { class_type: "BlackstarFrameCount", inputs: { seconds: ["5", 0], fps: ["4", 0] } },
    "7": { class_type: "RandomNoise", inputs: { noise_seed: p.seed } },
    "10": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "ltx-2.3-22b-dev-Q6_K.gguf" } },
    "11": {
      class_type: "DualCLIPLoaderGGUF",
      inputs: {
        clip_name1: "gemma-3-12b-it-qat-UD-Q4_K_XL.gguf",
        clip_name2: "ltx-2.3-22b-dev_embeddings_connectors.safetensors",
        type: "ltxv",
      },
    },
    "12": { class_type: "VAELoader", inputs: { vae_name: "ltx-2.3-22b-dev_video_vae.safetensors" } },
    "13": {
      class_type: "VAELoaderKJ",
      inputs: { vae_name: "ltx-2.3-22b-dev_audio_vae.safetensors", device: "cpu", weight_dtype: "fp32" },
    },
    "14": { class_type: "CLIPTextEncode", inputs: { text: ["1", 0], clip: ["11", 0] } },
    "15": { class_type: "CLIPTextEncode", inputs: { text: NEGATIVE, clip: ["11", 0] } },
    "16": {
      class_type: "LTXVConditioning",
      inputs: { frame_rate: ["4", 0], positive: ["14", 0], negative: ["15", 0] },
    },
    "17": {
      class_type: "EmptyLTXVLatentVideo",
      inputs: { width: ["2", 0], height: ["3", 0], length: ["6", 0], batch_size: 1 },
    },
    "18": {
      class_type: "LTXVEmptyLatentAudio",
      inputs: { frames_number: ["6", 0], frame_rate: ["4", 0], batch_size: 1, audio_vae: ["13", 0] },
    },
    "19": {
      class_type: "LTXVConcatAVLatent",
      inputs: { video_latent: ["17", 0], audio_latent: ["18", 0] },
    },
    "20": {
      class_type: "LTXVDualCFGGuider",
      inputs: { model: ["10", 0], positive: ["16", 0], negative: ["16", 1], video_cfg: 3, audio_cfg: 7 },
    },
    "21": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler_ancestral" } },
    "22": {
      class_type: "LTXVScheduler",
      inputs: { steps: p.steps, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent: ["17", 0] },
    },
    "23": {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["7", 0],
        guider: ["20", 0],
        sampler: ["21", 0],
        sigmas: ["22", 0],
        latent_image: ["19", 0],
      },
    },
    "24": { class_type: "LTXVSeparateAVLatent", inputs: { av_latent: ["23", 0] } },
    "25": {
      class_type: "VAEDecodeTiled",
      inputs: {
        samples: ["24", 0],
        vae: ["12", 0],
        tile_size: 512,
        overlap: 64,
        temporal_size: 32,
        temporal_overlap: 8,
      },
    },
    "26": { class_type: "LTXVAudioVAEDecode", inputs: { samples: ["24", 1], audio_vae: ["13", 0] } },
    "27": { class_type: "CreateVideo", inputs: { images: ["25", 0], fps: ["4", 0], audio: ["26", 0] } },
    "28": { class_type: "SaveVideo", inputs: { video: ["27", 0], filename_prefix: "witchcraft/ltx23", format: "auto", codec: "auto" } },
  };
}
