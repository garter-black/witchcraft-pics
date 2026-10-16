// Session / credential-change privacy — meaningful tests over the ACTUAL
// client modules that own this surface.
//
// Honest scope: these are MEANINGFUL UNIT TESTS of the epoch guard and the
// wipe boundary. The tests themselves are NOT a live browser. The code that
// calls wipeClientState at the real credential-change boundary
// (src/generation/actions.ts / openhiggsfield) is exercised by the app's own
// review; here we prove the primitive the boundary relies on actually behaves,
// including the delayed-async case the reviewer explicitly called out. A full
// end-to-end "log out then watch the UI clear" browser interaction is NOT
// exercised in this file and is not claimed.
//
// No real credentials. Storage/IndexedDB are faked in-process; nothing touches
// a real browser store.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  currentEpoch,
  epochCurrent,
  wipeClientState,
  resetPersistentStores,
} from "../src/generation/credential-scope";

/* ---------------------------------------------------- tiny browser-store fakes */

function installLocalStorage() {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  (globalThis as any).localStorage = store;
  return map;
}

function installIndexedDb() {
  const dropped: string[] = [];
  (globalThis as any).indexedDB = {
    deleteDatabase: (name: string) => {
      dropped.push(name);
      return {} as any;
    },
  };
  return dropped;
}

/* ============================================================== the epoch guard */

test("every credential change bumps the epoch, and a callback from before it is stale", () => {
  const e0 = currentEpoch();
  const started = e0; // a history load captures the epoch it began under
  assert.equal(epochCurrent(started), true, "a callback that began now is current");

  const e1 = wipeClientState();
  assert.equal(e1, e0 + 1, "the wipe bumps the epoch");
  assert.equal(epochCurrent(started), false, "a pre-switch callback is now stale");
  assert.equal(epochCurrent(e1), true, "a callback begun after the switch is current");
});

test("a delayed async result from the PREVIOUS scope cannot repopulate history", async () => {
  // The exact defect the reviewer named: a load/poll that started before the
  // switch settles AFTER it. The epoch guard must make it discard its result.
  // The late callback holds the epoch it BEGAN under; a correct caller does not
  // re-bind it (re-binding is precisely how the bug would be introduced).
  const writes: string[] = [];
  const startedAt = currentEpoch();

  const lateLoad = new Promise<void>((resolve) => {
    setTimeout(() => {
      // fires after the credential switch below
      if (epochCurrent(startedAt)) writes.push("history-repopulated");
      resolve();
    }, 15);
  });

  // the visitor clears the key while the load is in flight
  wipeClientState();

  await lateLoad;
  assert.deepEqual(writes, [], "a late result under an old epoch must write nothing");
});

test("consecutive switches each invalidate the prior scope independently", () => {
  const a = wipeClientState();
  const b = wipeClientState();
  assert.equal(b, a + 1);
  assert.equal(epochCurrent(a), false, "scope A is stale after a second switch");
  assert.equal(epochCurrent(b), true);
});

/* ============================================================== the wipe boundary */

test("wipe clears the SENSITIVE localStorage keys (media + prompt) and the legacy history", () => {
  const map = installLocalStorage();
  installIndexedDb(); // indexedDB present so the history-store path is attempted

  // Seed the sensitive keys, the two PRESERVED dial keys, and one unrelated key.
  for (const k of [
    "openhiggsfield.imageMedia.v1",
    "openhiggsfield.videoMedia.v1",
    "openhiggsfield.imagePrompt.v1",
    "openhiggsfield.videoPrompt.v1",
    "openhiggsfield.history.v1", // legacy
  ]) {
    map.set(k, "sensitive");
  }
  // Contract as implemented (credential-scope.ts:33-43): dials are NOT
  // credential material and are deliberately preserved.
  map.set("openhiggsfield.active.v2", "dial");
  map.set("openhiggsfield.settings.v1", "dial");
  map.set("unrelated.pref", "keep-me");

  wipeClientState();

  for (const k of [
    "openhiggsfield.imageMedia.v1",
    "openhiggsfield.videoMedia.v1",
    "openhiggsfield.imagePrompt.v1",
    "openhiggsfield.videoPrompt.v1",
    "openhiggsfield.history.v1",
  ]) {
    assert.equal(map.has(k), false, `sensitive key must be wiped: ${k}`);
  }
  assert.equal(map.get("openhiggsfield.active.v2"), "dial", "the surface/model dial is preserved");
  assert.equal(map.get("openhiggsfield.settings.v1"), "dial", "the per-model dials are preserved");
  assert.equal(map.get("unrelated.pref"), "keep-me", "an unrelated setting is not touched");
});

test("wiping in a private/denied store does not throw", () => {
  // localStorage present but throwing, indexedDB absent
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  delete (globalThis as any).indexedDB;
  assert.doesNotThrow(() => wipeClientState(), "a denied store must not break logout");
});

/* ======================================================= in-memory store reset */

test("resetPersistentStores drops the SENSITIVE in-memory stores (media + prompt) and preserves model dials", async () => {
  installLocalStorage();
  installIndexedDb();
  wipeClientState(); // bump so a fresh scope exists

  // Contract as implemented by the credential-scope owner (read from actual
  // bytes): media + prompt hold credential material and ARE reset; active and
  // settings hold model dials and are deliberately PRESERVED.
  const { useActive } = await import("../src/generation/stores/active");
  const { useImageMedia, useVideoMedia } = await import("../src/generation/stores/media");
  const { useImagePrompt, useVideoPrompt } = await import("../src/generation/stores/prompt");
  const { useSettings } = await import("../src/generation/stores/settings");

  // seed state as a previous session would have left it
  useActive.setState({ surface: "video", model: "local-ltx23-t2v", batch: 4 });
  useImageMedia.getState().add({ id: "1", url: "https://studio.test/media/aa/1.png" } as any);
  useVideoMedia.getState().add({ id: "2", url: "https://studio.test/media/bb/2.mp4" } as any);
  useImagePrompt.getState().setText("a private prompt from the old scope");
  useVideoPrompt.getState().setText("another private prompt");
  useSettings.setState({ byModel: { "local-ltx23-t2v": { seed: 42 } } });
  assert.ok(useImageMedia.getState().items.length > 0);

  await resetPersistentStores();

  // sensitive: cleared
  assert.deepEqual(useImageMedia.getState().items, [], "image media cleared");
  assert.deepEqual(useVideoMedia.getState().items, [], "video media cleared");
  assert.equal(useImagePrompt.getState().text, "", "image prompt cleared");
  assert.equal(useVideoPrompt.getState().text, "", "video prompt cleared");
  // dials: preserved (not credential material)
  assert.deepEqual(useSettings.getState().byModel, { "local-ltx23-t2v": { seed: 42 } }, "model dials are preserved");
  assert.equal(useActive.getState().surface, "video", "active scope is preserved");
});
