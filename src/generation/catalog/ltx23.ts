import type { ModelEntry } from "./types";

const seed = { type: "range", min: -1, max: 2147483647, step: 1, default: -1 } as const;

/** The user's selected local stack: LTX 2.3 22B dev Q6_K. This reproduces the
    known-good run in PG500353144 (1280x704, 24fps, 28 steps). It renders real
    subject motion; it is not an image pan and not a language model. */
export const LTX23_MODEL: ModelEntry = {
  id: "local-ltx23-t2v",
  provider: "local",
  surface: "video",
  label: "LTX 2.3 Motion — local GPU (24fps)",
  roles: {},
  settings: {
    preset: { type: "enum", values: ["ltx23-t2v"], default: "ltx23-t2v" },
    resolution: { type: "enum", values: ["1280x704", "704x1280", "832x480", "480x832"], default: "1280x704" },
    duration: { type: "range", min: 2, max: 6, step: 1, default: 4 },
    motion: { type: "enum", values: ["full", "camera", "still"], default: "full" },
    seed,
  },
};
