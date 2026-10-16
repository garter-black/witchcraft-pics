import type { ModelEntry } from "./types";

const seed = { type: "range", min: -1, max: 2147483647, step: 1, default: -1 } as const;

/** Sizes the installed H3 graphs were authored at (see src/generation/h3.ts
    H3_SIZES). Kept identical so the catalog can never offer a size the graph
    cannot render. */
const H3_SIZES = ["960x544", "544x960", "832x480", "480x832"] as const;

/** H3 length is a 17k+5 grid (22..124). Local capacity is approximately 2-5s at
    24 fps; the adapter snaps UP to the grid and REJECTS anything longer, so a 6s
    request is never silently shortened and 6/7s are not offered. */
const H3_DURATION = { type: "range", min: 2, max: 5, step: 1, default: 5 } as const;

/** LOCAL MiniMax H3 text-to-video. This drives the studio GPU through the
    installed ComfyUI H3 nodes. It is NOT the hosted minimax-h3 route. */
export const H3_MODEL_T2V: ModelEntry = {
  id: "local-h3-t2v",
  provider: "local",
  surface: "video",
  label: "MiniMax H3 Motion — local GPU",
  roles: {},
  settings: {
    preset: { type: "enum", values: ["h3-t2v"], default: "h3-t2v" },
    resolution: { type: "enum", values: H3_SIZES, default: "960x544" },
    duration: H3_DURATION,
    motion: { type: "enum", values: ["full", "camera", "still"], default: "full" },
    seed,
  },
};

/** LOCAL MiniMax H3 image-to-video. Animates one same-origin reference image. */
export const H3_MODEL_I2V: ModelEntry = {
  id: "local-h3-i2v",
  provider: "local",
  surface: "video",
  label: "MiniMax H3 Animate — local GPU",
  roles: { start: 1 },
  settings: {
    preset: { type: "enum", values: ["h3-i2v"], default: "h3-i2v" },
    resolution: { type: "enum", values: H3_SIZES, default: "960x544" },
    duration: H3_DURATION,
    motion: { type: "enum", values: ["full", "camera", "still"], default: "full" },
    seed,
  },
};
