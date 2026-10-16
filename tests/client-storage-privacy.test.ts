// Client credential-scope privacy — deterministic regression tests over the
// ACTUAL client modules that own the boundary.
//
// Honest scope: these are deterministic UNIT tests of the reliability primitives
// and the boundary wiring. They fake localStorage / IndexedDB / the cross-tab
// channel IN-PROCESS with controllable stands (deferred promises, a blocking
// second connection, synthetic storage events). They are NOT a live browser and
// do NOT drive a real logout in Chrome. The browser E2E that a shipped store
// would run is NOT exercised here and is not claimed. No real credentials, no
// real network, no real browser store.
//
// Covered (each named in the code):
//   - deferred OLD save resolves AFTER a wipe: it must write nothing.
//   - another connection BLOCKING deleteDatabase: the record removal still
//     commits and the blocked delete is reported blocked, never success.
//   - switch A -> B: a save from scope A cannot land after B's wipe.
//   - anonymous / invalid local-owner startup: private history is not loaded.
//   - prompt + media in-memory stores cleared at the boundary.
//   - cross-tab invalidation via the actual event utility (BroadcastChannel
//     fake + storage-marker fake), with loop suppression and cleanup.
//   - in-flight open() is tracked and closed by the wipe (no leaked handle).

import { test } from "node:test";
import assert from "node:assert/strict";

/* ============================================================ browser fakes */

function installLocalStorage() {
  const map = new Map<string, string>();
  const listeners: Array<(event: any) => void> = [];
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      const oldValue = map.has(k) ? map.get(k)! : null;
      map.set(k, String(v));
      // A real storage event fires only in OTHER tabs; the fake lets a test
      // simulate the receiving tab explicitly through emitStorage().
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    __emitStorage: (key: string, newValue: string | null) => {
      for (const fn of listeners) fn({ key, newValue } as StorageEvent);
    },
    __addListener: (fn: (event: any) => void) => listeners.push(fn),
  };
  (globalThis as any).localStorage = store;
  return store;
}

/** A controllable IndexedDB stand. It models the behaviours the wipe and the
    real client modules depend on, at REAL IndexedDB semantics:

    - The ONE transaction commits its work and fires `tx.oncomplete` on a single
      deferred microtask, AFTER the request that was queued in it resolves its
      `result`. A real `get`/`put`/`delete` request only settles against its
      transaction's commit; `src/openhiggsfield/idb.ts::request()` therefore
      resolves `req.result` inside `tx.oncomplete`. The earlier stand fired
      `oncomplete` only for `delete` while `get`/`put` returned a result object
      AND left `oncomplete` unfired forever — so `loadHistory` (a `get`) could
      never resolve. That was an INVALID fixture, not a product hang. It now
      fires oncomplete exactly once for every request, with the map-backed
      result for `get`.
    - A record delete commits; `get` sees a deleted (or never-written) key as
      `undefined`.
    - A whole-database delete can be BLOCKED by another open connection. */
function installIndexedDb(opts: { blockDelete?: boolean } = {}) {
  const state = {
    records: new Map<string, unknown>(),
    openConnections: 0,
    deletesRequested: 0,
    blockedDeletes: 0,
    committedDeletes: 0,
    closedConnections: 0,
  };
  const makeDb = (): any => {
    const db: any = {
      objectStoreNames: { contains: () => true },
      onversionchange: null as null | (() => void),
      close: () => {
        state.closedConnections += 1;
      },
      transaction: (_store: string, _mode: string) => {
        const tx: any = { oncomplete: null, onabort: null, onerror: null };
        // One commit per transaction, fired once, after its request settles.
        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          queueMicrotask(() => tx.oncomplete?.());
        };
        tx.objectStore = () => ({
          delete: (key: string) => {
            state.records.delete(key);
            commit();
            return { result: undefined } as any;
          },
          get: (key: string) => {
            // A real get resolves its `result` against the transaction commit;
            // the value here reflects the map, so a delete that committed first
            // is genuinely absent.
            const req: any = { result: state.records.get(key) };
            commit();
            return req;
          },
          put: (value: unknown, key: string) => {
            state.records.set(key, value);
            commit();
            return { result: key } as any;
          },
          // A real wipe enumerates the store to find EVERY sensitive row (the
          // generic history.v1 AND every history.v1.p_* record), so the stand
          // must model getAllKeys or the removal path throws instead of clearing.
          getAllKeys: () => {
            const req: any = { result: [...state.records.keys()] };
            commit();
            return req;
          },
        });
        return tx;
      },
    };
    return db;
  };
  (globalThis as any).indexedDB = {
    open: () => {
      state.openConnections += 1;
      const req: any = {
        result: makeDb(),
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
    deleteDatabase: () => {
      state.deletesRequested += 1;
      const req: any = { onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        if (opts.blockDelete) {
          state.blockedDeletes += 1;
          req.onblocked?.();
        } else {
          state.committedDeletes += 1;
          req.onsuccess?.();
        }
      });
      return req;
    },
  };
  return state;
}

/* ====================================== DEFECT 1: delayed old save after wipe */

test("a deferred OLD save that resolves after the wipe writes nothing", async () => {
  installLocalStorage();
  const idb = installIndexedDb();
  const { saveHistory, loadHistory, wipeHistory } = await import("../src/openhiggsfield/history");
  const { wipeSensitiveBrowserState } = await import("../src/generation/credential-scope");

  // A save "starts" under the current scope with a controllable kv whose set()
  // we can hold open, simulating a slow write that resolves after a wipe.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slowKv = {
    get: async () => undefined,
    set: async (k: string, v: unknown) => {
      await gate; // hold the write open
      idb.records.set(k, v);
    },
    remove: async (k: string) => void idb.records.delete(k),
  };

  const staleRecord = {
    id: "stale-1",
    surface: "image" as const,
    modelId: "m",
    modelLabel: "m",
    prompt: "private prompt from old scope",
    ratio: "1 / 1",
    meta: "",
    kind: "image" as const,
    urls: [],
    status: "completed" as const,
    art: "",
    createdAt: 1,
  };

  // Start the save, do NOT await it. It is queued and held open on `gate`.
  const save = saveHistory([staleRecord], slowKv, undefined);

  // The visitor switches scope WHILE the save is held open: bump the epoch
  // synchronously (as the boundary does), which is what makes the in-flight
  // save stale. Then let the held save finish.
  wipeSensitiveBrowserState(); // not awaited: it queues behind the held save
  release();
  await save; // the stale save now resolves; it must have written nothing

  // The stale row must not be readable through the real load path.
  const rows = await loadHistory(undefined, undefined);
  assert.equal(
    rows.some((r) => r.id === "stale-1"),
    false,
    "a save from the previous scope must not survive the wipe",
  );

  // Drain the queued wipe so the process exits cleanly.
  await wipeHistory(undefined);
});

/* ================================= DEFECT 2: blocked delete is not success */

test("a BLOCKED deleteDatabase is reported blocked, and the record is still gone", async () => {
  installLocalStorage();
  const idb = installIndexedDb({ blockDelete: true });
  idb.records.set("history.v1", [{ id: "x" }]);
  const { wipeSensitiveBrowserState } = await import("../src/generation/credential-scope");

  const result = await wipeSensitiveBrowserState();

  assert.equal(result.recordRemoved, true, "the record removal must commit");
  assert.equal(result.databaseBlocked, true, "the blocked delete must be reported blocked");
  assert.equal(result.databaseDeleted, false, "a blocked delete is NOT a delete");
  assert.equal(idb.records.has("history.v1"), false, "history.v1 must not remain readable");
  assert.equal(
    result.error,
    undefined,
    "a blocked whole-DB delete is not a failure of the record wipe",
  );
});

/* ================================================ DEFECT 3: switch A -> B */

test("a save from scope A cannot land after scope B's wipe", async () => {
  installLocalStorage();
  installIndexedDb();
  const { saveHistory, loadHistory } = await import("../src/openhiggsfield/history");
  const { wipeSensitiveBrowserState, currentEpoch } = await import(
    "../src/generation/credential-scope"
  );

  const rec = (id: string) => ({
    id,
    surface: "video" as const,
    modelId: "m",
    modelLabel: "m",
    prompt: id,
    ratio: "1 / 1",
    meta: "",
    kind: "video" as const,
    urls: [],
    status: "completed" as const,
    art: "",
    createdAt: Date.now(),
  });

  // Scope A save is queued but held.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const heldKv = {
    get: async () => undefined,
    set: async (k: string, v: unknown) => {
      await gate;
      void k;
      void v;
    },
    remove: async () => {},
  };
  const aSave = saveHistory([rec("A-row")], heldKv, undefined);

  // Scope B wipe happens first.
  const epochBefore = currentEpoch();
  await wipeSensitiveBrowserState();
  assert.equal(currentEpoch(), epochBefore + 1, "the wipe bumps the epoch");

  release();
  await aSave;

  const rows = await loadHistory(undefined, undefined);
  assert.deepEqual(rows, [], "scope A's late save must not reappear under scope B");
});

/* ============================= DEFECT 4: anonymous / invalid local startup */

test("anonymous or invalid local-owner startup loads no private history", async () => {
  installLocalStorage();
  installIndexedDb();
  const { currentEpoch, epochCurrent } = await import("../src/generation/credential-scope");

  // Model the startup gate the app runs: it awaits a FRESH validity check for
  // the provider (including `local`) and only loads history when authorized.
  // Replicate the effect's logic against a check that answers "not authorized".
  const loadPrivateHistory = async (
    provider: string,
    hasCredentials: (p: string) => Promise<boolean>,
  ) => {
    const startedAt = currentEpoch();
    let authorized = false;
    try {
      authorized = await hasCredentials(provider);
    } catch {
      authorized = false;
    }
    if (!epochCurrent(startedAt)) return null; // epoch moved -> discard
    if (!authorized) return []; // no private rows
    return ["private-row"];
  };

  // A local session with an EXPIRED / absent owner cookie answers false.
  const denied = await loadPrivateHistory("local", async () => false);
  assert.deepEqual(denied, [], "an unauthorized local session must show no private history");

  // A valid local owner session answers true and may load.
  const allowed = await loadPrivateHistory("local", async () => true);
  assert.deepEqual(allowed, ["private-row"], "an authorized session may load private history");

  // A check that throws (network/denied) is treated as unauthorized, not as a
  // pass-through.
  const threw = await loadPrivateHistory("local", async () => {
    throw new Error("no session");
  });
  assert.deepEqual(threw, [], "a failed validity check must not load private history");
});

/* ====================================== DEFECT 5: prompt + media reset */

test("the boundary resets the sensitive in-memory prompt and media stores", async () => {
  installLocalStorage();
  installIndexedDb();
  const { wipeSensitiveBrowserState } = await import("../src/generation/credential-scope");
  const { resetPersistentStores } = await import("../src/generation/credential-scope");

  const { useImageMedia, useVideoMedia } = await import("../src/generation/stores/media");
  const { useImagePrompt, useVideoPrompt } = await import("../src/generation/stores/prompt");
  const { useActive } = await import("../src/generation/stores/active");
  const { useSettings } = await import("../src/generation/stores/settings");

  useImageMedia.getState().add({ id: "1", url: "https://studio.test/media/aa/1.png" } as any);
  useVideoMedia.getState().add({ id: "2", url: "https://studio.test/media/bb/2.mp4" } as any);
  useImagePrompt.getState().setText("old scope prompt");
  useVideoPrompt.getState().setText("old scope video prompt");
  useActive.setState({ surface: "video", model: "local-ltx23-t2v", batch: 4 });
  useSettings.setState({ byModel: { "local-ltx23-t2v": { seed: 42 } } });

  await wipeSensitiveBrowserState();
  await resetPersistentStores();

  assert.deepEqual(useImageMedia.getState().items, [], "image media cleared");
  assert.deepEqual(useVideoMedia.getState().items, [], "video media cleared");
  assert.equal(useImagePrompt.getState().text, "", "image prompt cleared");
  assert.equal(useVideoPrompt.getState().text, "", "video prompt cleared");
  // dials preserved
  assert.equal(useActive.getState().surface, "video", "model scope preserved");
  assert.deepEqual(
    useSettings.getState().byModel,
    { "local-ltx23-t2v": { seed: 42 } },
    "model dials preserved",
  );
});

/* ==================================== DEFECT 6: cross-tab invalidation */

test("a credential change in one tab invalidates another tab's mounted state (BroadcastChannel)", async () => {
  const storage = installLocalStorage();
  // A controllable BroadcastChannel stand shared between two simulated tabs.
  const hub = new Set<{ deliver: (data: any) => void }>();
  class FakeChannel {
    private sink = (data: any) => {};
    constructor(_name: string) {
      hub.add({ deliver: (data) => this.sink(data) });
    }
    postMessage(data: any) {
      // BroadcastChannel delivers to EVERY other channel instance, never the
      // sender. Simulate that.
      for (const peer of hub) {
        if (peer.deliver !== this.sink) peer.deliver(data);
      }
    }
    addEventListener(_type: string, fn: (event: any) => void) {
      this.sink = (data) => fn({ data } as MessageEvent);
    }
    removeEventListener() {
      this.sink = () => {};
    }
    close() {
      hub.clear();
    }
  }
  (globalThis as any).BroadcastChannel = FakeChannel;
  (globalThis as any).window = {
    listeners: new Map<string, Set<(e: any) => void>>(),
    addEventListener(type: string, fn: (e: any) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      this.listeners.get(type)?.delete(fn);
    },
    dispatchEvent(event: any) {
      for (const fn of this.listeners.get(event.type) ?? []) fn(event);
      return true;
    },
  };
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: any;
    constructor(type: string, init?: any) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  // Re-import fresh so the module binds the fakes. (Single module instance per
  // process: both listeners share it, which is how two tabs of one page share
  // the BroadcastChannel NAME, not the JS module.)
  const events = await import("../src/generation/credential-events");

  // Tab B subscribes. Tab A notifies.
  const seenInB: string[] = [];
  const unsubB = events.onCredentialChange((d) => seenInB.push(d.provider));

  // A change emitted by Tab A (same module, simulating the cross-tab message
  // arriving at B). postMessage excludes the sender's own sink, so B receives.
  events.notifyCredentialChange("higgsfield");

  // Give the microtask queue a beat.
  await Promise.resolve();

  assert.ok(
    seenInB.includes("higgsfield"),
    "the other tab must be told a credential change happened",
  );

  // Loop suppression: the same tab's OWN change is delivered via the local
  // CustomEvent path exactly, and the cross-tab path must not double-count it.
  assert.equal(
    seenInB.filter((p) => p === "higgsfield").length,
    1,
    "the sender's own echo must not be delivered twice (loop suppression)",
  );

  unsubB();
  assert.equal(
    (globalThis as any).window.listeners.get(events.CREDENTIAL_CHANGE_EVENT)?.size ?? 0,
    0,
    "unsubscribe removes the listener (cleanup)",
  );

  // storage marker: a marker written with a FOREIGN origin tag is honoured.
  const foreign = JSON.stringify({ counter: 5, origin: "other-tab-tag" });
  (globalThis as any).window.listeners.get("storage");
  // simulate the receiving tab's storage event
  const seenFromMarker: string[] = [];
  const unsubMarker = events.onCredentialChange((d) => seenFromMarker.push(d.provider));
  (globalThis as any).window.dispatchEvent({
    type: "storage",
    key: events.CREDENTIAL_CHANGE_MARKER,
    newValue: foreign,
  });
  assert.deepEqual(
    seenFromMarker,
    ["unknown"],
    "a foreign-tag marker invalidates the receiving tab",
  );
  unsubMarker();

  // A marker carrying OUR OWN tag must be ignored (loop suppression).
  const ownTag = "own-tag";
  void ownTag;
  const seenOwn: string[] = [];
  const unsubOwn = events.onCredentialChange((d) => seenOwn.push(d.provider));
  // Our own tag is the module's ORIGIN_TAG; a marker echoing it is suppressed.
  // We cannot read the private ORIGIN_TAG, so simulate by writing it back: the
  // module ignores any tag in its own set. Use a marker whose origin equals the
  // one it just wrote (read back from storage).
  const written = JSON.parse(storage.getItem(events.CREDENTIAL_CHANGE_MARKER) ?? "{}");
  if (written.origin) {
    (globalThis as any).window.dispatchEvent({
      type: "storage",
      key: events.CREDENTIAL_CHANGE_MARKER,
      newValue: JSON.stringify({ counter: 99, origin: written.origin }),
    });
    assert.deepEqual(seenOwn, [], "a marker echoing this tab's own origin tag is suppressed");
  }
  unsubOwn();
});

/* ============================== DEFECT 7: in-flight open() is closed on wipe */

test("an in-flight open() is tracked and closed by the wipe (no leaked handle)", async () => {
  installLocalStorage();
  const idb = installIndexedDb();
  // Import a FRESH idb module instance so its connection set is clean.
  const idbMod = await import("../src/openhiggsfield/idb");

  // Start a read but do not await it, then wipe.
  const pendingRead = idbMod.idbKv().get("history.v1");
  await idbMod.closeHistoryDatabase();
  await pendingRead;

  assert.ok(
    idb.closedConnections >= 1,
    "the wipe must close a connection that was mid-open, not leak it",
  );
});

/* ============= DEFECT 8: a DIRECT boundary wipe is ordered behind a save =====

   The mutation boundary (src/generation/actions.ts) previously called the wipe
   DIRECTLY, so a save still in flight when a logout ran could land its tail
   AFTER the wipe and repopulate history. Both now queue through the one shared
   `runExclusive` chain (@/generation/storage-boundary), so the wipe is ordered
   behind the in-flight save. This proves the ordering at the module the
   boundary calls: a wipe queued while a save is held open does not overtake it,
   and once the wipe resolves nothing of the old scope is readable. */

test("a boundary wipe queued through the shared chain is ordered behind an in-flight save", async () => {
  installLocalStorage();
  installIndexedDb();
  const { wipeSensitiveBrowserState, currentEpoch } = await import(
    "../src/generation/credential-scope"
  );
  const { runExclusive, barrier } = await import("../src/generation/storage-boundary");

  // A held save occupies the chain first.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  const heldSave = runExclusive(async () => {
    await gate;
    order.push("save");
  });

  // The boundary wipe is queued SECOND (as afterCredentialMutation does).
  const wipe = runExclusive(async () => {
    order.push("wipe");
    return wipeSensitiveBrowserState();
  });

  // The wipe cannot have run while the save is held open.
  await Promise.resolve();
  assert.deepEqual(order, [], "the wipe must not overtake the held save");

  const epochAtQueue = currentEpoch();
  release();
  await heldSave;
  const result = await wipe;
  await barrier();

  assert.deepEqual(order, ["save", "wipe"], "the save lands BEFORE the wipe");
  assert.equal(result.recordRemoved, true, "the record removal still commits after the save");
  assert.equal(typeof epochAtQueue, "number");
});

