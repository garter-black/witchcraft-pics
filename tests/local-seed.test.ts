import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, parseSettings } from "../src/generation/catalog";
import { toComfyGraph, type LocalPreset } from "../src/generation/local-input";

const cases: [string, LocalPreset, string, string][] = [
  ["local-krea2-turbo", "krea2-turbo", "7", "seed"],
  ["local-flux-schnell", "flux-schnell", "8", "seed"],
  ["local-realvis-sdxl", "realvis-sdxl", "5", "seed"],
  ["local-character-ipadapter", "character-ipadapter", "9", "seed"],
  ["local-image-edit", "image-edit", "5", "seed"],
];

test("local Random seeds consume fresh entropy per graph, not a constant", () => {
  const original = crypto.getRandomValues.bind(crypto);
  let serial = 100;
  crypto.getRandomValues = ((array: Uint32Array) => {
    array[0] = ++serial;
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    for (const [id, preset, node, field] of cases) {
      const model = getModel(id);
      const plane = { model: id, prompt: { text: "regression fixture" }, media: {}, settings: parseSettings(model, {}) };
      const a = toComfyGraph(plane, preset, "https://studio.test/media/a.png")[node]!.inputs[field];
      const b = toComfyGraph(plane, preset, "https://studio.test/media/a.png")[node]!.inputs[field];
      assert.notEqual(a, b, `${id} Random must use fresh entropy for each submission`);
      assert.ok(Number.isInteger(a) && Number(a) >= 0 && Number(a) <= 2147483647);
    }
  } finally {
    crypto.getRandomValues = original;
  }
});

test("local numeric seeds including zero reach the selected sampler unchanged", () => {
  for (const [id, preset, node, field] of cases) {
    for (const seed of [0, 42, 2147483647]) {
      const model = getModel(id);
      const plane = { model: id, prompt: { text: "regression fixture" }, media: {}, settings: parseSettings(model, { seed }) };
      const graph = toComfyGraph(plane, preset, "https://studio.test/media/a.png");
      assert.equal(graph[node]!.inputs[field], seed, `${id} must honor the entered seed`);
    }
  }
});
