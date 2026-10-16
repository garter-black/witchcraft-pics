/* The Exaggerator's pure state logic, kept apart from the component so it can
   be imported and tested without a JSX/CSS loader. The TSX re-exports these;
   the component is the only place that touches React. */

import type { Surface } from "./enhancer";

/* Preset ids must match the server planner's vocabulary, so an unknown preset
   has to fail there rather than silently degrade here. */
export type Preset = { id: string; label: string; surfaces: Surface[] };

export const PRESETS: readonly Preset[] = [
  { id: "editorial", label: "Editorial", surfaces: ["image"] },
  { id: "cinematic", label: "Cinematic", surfaces: ["image", "video"] },
  { id: "product", label: "Product", surfaces: ["image"] },
  { id: "action", label: "Action", surfaces: ["video"] },
  { id: "music-video", label: "Music video", surfaces: ["video"] },
];

export function presetsFor(surface: Surface): Preset[] {
  return PRESETS.filter((preset) => preset.surfaces.includes(surface));
}

export function defaultPreset(surface: Surface): string {
  return presetsFor(surface)[0]?.id ?? "cinematic";
}

export type Captured = {
  original: string;
  surface: Surface;
  modelId: string;
  preset: string;
  duration: number | null;
};

/** True when the composer's inputs still match what the preview was built from. */
export function isStale(captured: Captured, now: Captured): boolean {
  return (
    captured.original !== now.original ||
    captured.surface !== now.surface ||
    captured.modelId !== now.modelId ||
    captured.preset !== now.preset ||
    captured.duration !== now.duration
  );
}

/** The undo button survives exactly as long as the live prompt is the text we
    applied — any later edit stops it overwriting that edit. */
export function undoApplies(applied: string | null, live: string | null): boolean {
  return applied !== null && live !== null && applied === live;
}
