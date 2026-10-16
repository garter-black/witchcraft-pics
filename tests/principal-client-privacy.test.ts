// PRINCIPAL CLIENT PRIVACY — the identity-aware client boundary, over the
// ACTUAL client modules (identity helper, historical namespace, storage chain).
//
// Honest scope: deterministic UNIT tests with in-process fakes (fetch stand,
// localStorage/IndexedDB stands). They are NOT a live browser and do NOT drive
// a real Cloudflare Access logout. No real credentials, no real network, no
// real browser store.
//
// Covered (each named in the code):
//   - fetchIdentity: exact contract -> authenticated; anonymous; and EVERY
//     failure (network, non-200, bad shape, configured:false authenticated:true,
//     invalid principal) reduces to failure/anonymous, never an invented
//     principal.
//   - fetchIdentity is BOUNDED: a stalled endpoint aborts and returns failure.
//   - history namespacing: A and B have SEPARATE keys; a generic legacy history
//     is NEVER adopted under a principal; anonymous reads only the anon scope.
//   - scope invalidation runs SYNCHRONOUSLY before the awaited removal, even
//     while an earlier deferred write still blocks the shared queue.

import { test } from "node:test";
import assert from "node:assert/strict";

/* ============================================================ browser fakes */

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
  return store;
}

/** Real-semantics IndexedDB stand: every get/put/delete completes its
    transaction and fires tx.oncomplete exactly once with a map-backed result.
    `blockDelete` models another context holding the database open, so
    deleteDatabase reports `blocked` (never a completed delete). */
function installIndexedDb(opts: { blockDelete?: boolean } = {}) {
  const state = { records: new Map<string, unknown>(), closedConnections: 0, blockedDeletes: 0, committedDeletes: 0 };
  const makeDb = (): any => ({
    objectStoreNames: { contains: () => true },
    onversionchange: null,
    close: () => {
      state.closedConnections += 1;
    },
    transaction: () => {
      const tx: any = { oncomplete: null, onabort: null, onerror: null };
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
          return { result: undefined };
        },
        get: (key: string) => {
          const req: any = { result: state.records.get(key) };
          commit();
          return req;
        },
        put: (value: unknown, key: string) => {
          state.records.set(key, value);
          commit();
          return { result: key };
        },
        /* MAP-BACKED getAllKeys with the SAME deferred commit as get/put/delete.
           listHistoryKeys uses this; without it the shim returned no keys and
           the removal test's recordRemoved read false — an INVALID fixture, not
           a production defect. */
        getAllKeys: () => {
          const req: any = { result: [...state.records.keys()] };
          commit();
          return req;
        },
      });
      return tx;
    },
  });
  (globalThis as any).indexedDB = {
    open: () => {
      const req: any = { result: makeDb(), error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
    deleteDatabase: () => {
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

/** Install a fetch stand and restore it after the fn. */
async function withFetch(impl: (url: string, init?: any) => Promise<Response>, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  (globalThis as any).fetch = ((input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    return impl(url, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/* ================================================== fetchIdentity contract */

test("fetchIdentity: the exact authenticated contract yields the verified principal", async () => {
  const { fetchIdentity } = await import("../src/generation/identity");
  const principal = "p_" + "a".repeat(32);
  await withFetch(
    async () =>
      new Response(JSON.stringify({ configured: true, authenticated: true, principal, loginUrl: "/auth/login", logoutUrl: "/auth/logout" }), { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      const id = await fetchIdentity();
      assert.deepEqual(id, { status: "authenticated", principal });
    },
  );
});

test("fetchIdentity: configured but not authenticated is an honest anonymous session", async () => {
  const { fetchIdentity } = await import("../src/generation/identity");
  await withFetch(
    async () =>
      new Response(JSON.stringify({ configured: true, authenticated: false, loginUrl: "/auth/login", logoutUrl: "/auth/logout" }), { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      const id = await fetchIdentity();
      assert.deepEqual(id, { status: "anonymous" });
    },
  );
});

test("fetchIdentity: configured:false + authenticated:true is a FAILURE, never an invented principal", async () => {
  const { fetchIdentity } = await import("../src/generation/identity");
  await withFetch(
    async () =>
      new Response(JSON.stringify({ configured: false, authenticated: true, principal: "p_" + "b".repeat(32), loginUrl: "/auth/login", logoutUrl: "/auth/logout" }), { status: 200, headers: { "content-type": "application/json" } }),
    async () => {
      const id = await fetchIdentity();
      assert.equal(id.status, "failure", "an unconfigured endpoint cannot authenticate anyone");
    },
  );
});

test("fetchIdentity: authenticated with a malformed/missing principal is a FAILURE", async () => {
  const { fetchIdentity } = await import("../src/generation/identity");
  const badBodies = [
    { configured: true, authenticated: true, loginUrl: "/auth/login", logoutUrl: "/auth/logout" }, // no principal
    { configured: true, authenticated: true, principal: "not-a-principal", loginUrl: "/auth/login", logoutUrl: "/auth/logout" },
    { configured: true, authenticated: true, principal: "p_" + "Z".repeat(32), loginUrl: "/auth/login", logoutUrl: "/auth/logout" }, // non-hex
    { configured: true, authenticated: true, principal: "p_" + "a".repeat(31), loginUrl: "/auth/login", logoutUrl: "/auth/logout" }, // short
  ];
  for (const body of badBodies) {
    await withFetch(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      async () => {
        const id = await fetchIdentity();
        assert.equal(id.status, "failure", `must reject: ${JSON.stringify(body)}`);
      },
    );
  }
});

test("fetchIdentity: network error, non-200, and a non-object body are all FAILURES (never anonymous-adopted)", async () => {
  const { fetchIdentity } = await import("../src/generation/identity");
  // network error
  await withFetch(async () => { throw new Error("offline"); }, async () => {
    const id = await fetchIdentity();
    assert.equal(id.status, "failure");
  });
  // 500
  await withFetch(async () => new Response("nope", { status: 500 }), async () => {
    const id = await fetchIdentity();
    assert.equal(id.status, "failure");
  });
  // wrong shape
  await withFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }), async () => {
    const id = await fetchIdentity();
    assert.equal(id.status, "failure");
  });
});

test("fetchIdentity is BOUNDED: a stalled endpoint aborts and returns failure", async () => {
  const { fetchIdentity } = await import("../src/generation/identity");
  await withFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        // Never resolves on its own; only the abort signal can settle it.
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    async () => {
      const started = Date.now();
      const id = await fetchIdentity(30); // 30ms bound
      const elapsed = Date.now() - started;
      assert.equal(id.status, "failure", "a stalled identity endpoint is a failure");
      assert.ok(elapsed < 2000, `must settle near the bound, not hang (took ${elapsed}ms)`);
    },
  );
});

test("fetchIdentity is BOUNDED across the BODY: headers arrive at once, the stalled body aborts the deadline", async () => {
  const { fetchIdentity } = await import("../src/generation/identity");
  // Discriminating fixture: the response HEADERS resolve immediately (so the
  // deadline must NOT be cleared after fetch resolves), while the JSON BODY
  // hangs until the abort signal fires. Only a deadline that stays armed
  // through `response.json()` bounds this; a timer cleared after headers would
  // hang here forever. The body records that it actually began.
  let bodyBegan = false;
  let aborted = false;
  await withFetch(
    (_url, init) => {
      const signal: AbortSignal | undefined = init?.signal;
      const body = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
        // Never resolves; only abort settles it.
      });
      const response = {
        ok: true,
        status: 200,
        json: () => {
          bodyBegan = true;
          return body;
        },
      } as unknown as Response;
      return Promise.resolve(response);
    },
    async () => {
      const started = Date.now();
      const id = await fetchIdentity(30); // 30ms bound
      const elapsed = Date.now() - started;
      assert.equal(bodyBegan, true, "the body read must actually have been attempted");
      assert.equal(aborted, true, "the deadline must fire the abort while the body is stalled");
      assert.equal(id.status, "failure", "a stalled body is a failure, never an identity");
      assert.ok(elapsed < 2000, `the body deadline must settle near the bound (took ${elapsed}ms)`);
    },
  );
});

/* ======================================== principal-namespaced history ===== */

function rec(id: string) {
  return {
    id,
    surface: "image" as const,
    modelId: "m",
    modelLabel: "m",
    prompt: id,
    ratio: "1 / 1",
    meta: "",
    kind: "image" as const,
    urls: [],
    status: "completed" as const,
    art: "",
    createdAt: Date.now(),
  };
}

test("history namespacing: A and B have SEPARATE keys and cannot read each other", async () => {
  installLocalStorage();
  installIndexedDb();
  const { saveHistory, loadHistory, historyKeyFor } = await import("../src/openhiggsfield/history");
  const { memoryKv } = await import("../src/openhiggsfield/idb");

  const pA = "p_" + "1".repeat(32);
  const pB = "p_" + "2".repeat(32);
  assert.notEqual(historyKeyFor(pA), historyKeyFor(pB), "distinct principals use distinct keys");
  assert.equal(historyKeyFor(undefined), "history.v1", "anonymous uses the generic key");

  // Save under A using an in-memory kv shared across calls (stand the IDB).
  const kv = memoryKv();
  await saveHistory([rec("a-row")], kv, undefined, pA);
  await saveHistory([rec("b-row")], kv, undefined, pB);

  const aRows = await loadHistory(kv, undefined, pA);
  const bRows = await loadHistory(kv, undefined, pB);
  assert.deepEqual(aRows.map((r) => r.id), ["a-row"], "A sees only A's history");
  assert.deepEqual(bRows.map((r) => r.id), ["b-row"], "B sees only B's history");

  const anonRows = await loadHistory(kv, undefined, undefined);
  assert.deepEqual(anonRows, [], "anonymous sees neither principal's rows");
});

test("history namespacing: a generic legacy history is NEVER adopted under a new principal", async () => {
  installLocalStorage();
  installIndexedDb();
  const { loadHistory, LEGACY_HISTORY_KEY } = await import("../src/openhiggsfield/history");
  const { memoryKv } = await import("../src/openhiggsfield/idb");

  // A legacy generic localStorage copy, as a pre-namespacing browser would hold.
  const legacy = installLocalStorage();
  legacy.setItem(LEGACY_HISTORY_KEY, JSON.stringify([rec("legacy-row")]));

  const kv = memoryKv();
  const pA = "p_" + "3".repeat(32);
  const rows = await loadHistory(kv, legacy as any, pA);
  assert.deepEqual(rows, [], "a legacy generic history is not attributed to a new account");
});

/* ================ synchronous invalidation BEFORE the awaited removal ====== */

test("scope invalidation runs SYNCHRONOUSLY before the awaited removal, even while an earlier write blocks the queue", async () => {
  installLocalStorage();
  installIndexedDb();
  const { currentEpoch, epochCurrent, wipeClientState, completeScopeRemoval } = await import(
    "../src/generation/credential-scope"
  );
  const { runExclusive, barrier } = await import("../src/generation/storage-boundary");

  // An earlier write occupies the shared queue and is held open.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const heldWrite = runExclusive(async () => {
    await gate;
  });

  const epochBefore = currentEpoch();
  const startedCallback = epochBefore; // a callback that began under the old scope

  // Reproduce the boundary's ORDER: synchronous invalidation FIRST (outside the
  // queue), then the awaited removal queued behind the held write.
  const scope = wipeClientState();
  const removal = runExclusive(() => completeScopeRemoval(scope));

  // The queue is still blocked by the held write, yet the scope is ALREADY
  // invalidated: the epoch moved and the old callback is stale NOW.
  assert.equal(currentEpoch(), epochBefore + 1, "the epoch bumps synchronously, before the queue drains");
  assert.equal(epochCurrent(startedCallback), false, "an old callback is stale immediately, not after the queue drains");

  release();
  await heldWrite;
  const result = await removal;
  await barrier();
  assert.equal(result.recordRemoved, true, "the awaited removal still commits behind the earlier write");
});

/* ============= completeScopeRemoval(bumped, preservePrincipal?) ============ */

test("completeScopeRemoval retains ONLY the verified principal's own row and removes the generic + every other principal", async () => {
  installLocalStorage();
  const idb = installIndexedDb();
  const { completeScopeRemoval } = await import("../src/generation/credential-scope");

  const pA = "p_" + "1".repeat(32);
  const pB = "p_" + "2".repeat(32);
  // Seed the generic legacy row AND a row for each principal.
  idb.records.set("history.v1", [{ id: "generic" }]);
  idb.records.set(`history.v1.${pA}`, [{ id: "A" }]);
  idb.records.set(`history.v1.${pB}`, [{ id: "B" }]);

  const result = await completeScopeRemoval(1, pA);

  assert.equal(result.recordRemoved, true, "removal of the non-retained rows must commit");
  assert.equal(idb.records.has(`history.v1.${pA}`), true, "the retained principal's own row must SURVIVE");
  assert.equal(idb.records.has("history.v1"), false, "the generic legacy row must be removed");
  assert.equal(idb.records.has(`history.v1.${pB}`), false, "every OTHER principal's row must be removed");
  // Retaining a row means the whole-DB delete is skipped: it would drop the keep.
  assert.equal(result.databaseDeleted, false, "whole-DB delete is skipped when a principal is retained");
  assert.equal(result.databaseBlocked, false, "no blocked delete is reported when the delete was skipped");
});

test("completeScopeRemoval with an INVALID preservePrincipal falls back to the full wipe (generic + all principals + whole-DB delete)", async () => {
  installLocalStorage();
  const idb = installIndexedDb();
  const { completeScopeRemoval } = await import("../src/generation/credential-scope");

  const pA = "p_" + "1".repeat(32);
  idb.records.set("history.v1", [{ id: "generic" }]);
  idb.records.set(`history.v1.${pA}`, [{ id: "A" }]);

  // A malformed principal MUST NOT be honoured as a retention key.
  const result = await completeScopeRemoval(1, "not-a-principal");

  assert.equal(result.recordRemoved, true);
  assert.equal(idb.records.has("history.v1"), false, "the generic row is removed");
  assert.equal(idb.records.has(`history.v1.${pA}`), false, "no row is retained for an invalid principal");
  assert.equal(result.databaseDeleted, true, "an invalid principal preserves the default full wipe (whole-DB delete)");
});

test("completeScopeRemoval default (undefined) preserves the full wipe incl whole-DB delete reporting", async () => {
  installLocalStorage();
  const idb = installIndexedDb();
  const { completeScopeRemoval } = await import("../src/generation/credential-scope");

  idb.records.set("history.v1", [{ id: "generic" }]);

  const result = await completeScopeRemoval(1);

  assert.equal(result.recordRemoved, true);
  assert.equal(idb.records.has("history.v1"), false, "the default wipe removes the generic row");
  assert.equal(result.databaseDeleted, true, "the default full wipe still attempts and reports the whole-DB delete");
});

test("completeScopeRemoval still reliably removes the remaining default keys when the whole-DB delete is BLOCKED", async () => {
  installLocalStorage();
  const idb = installIndexedDb({ blockDelete: true });
  const { completeScopeRemoval } = await import("../src/generation/credential-scope");

  const pA = "p_" + "1".repeat(32);
  idb.records.set("history.v1", [{ id: "generic" }]);
  idb.records.set(`history.v1.${pA}`, [{ id: "A" }]);

  const result = await completeScopeRemoval(1);

  // A blocked whole-DB delete must NOT stop the per-record removal: the
  // readable rows are gone even though the database remains.
  assert.equal(result.recordRemoved, true, "the per-record removal commits despite the blocked DB delete");
  assert.equal(result.databaseBlocked, true, "the blocked DB delete is reported blocked");
  assert.equal(result.databaseDeleted, false, "a blocked delete is not a delete");
  assert.equal(idb.records.has("history.v1"), false, "the generic row is removed even when the DB delete is blocked");
  assert.equal(idb.records.has(`history.v1.${pA}`), false, "the principal row is removed even when the DB delete is blocked");
});

/* ==================== TWO subscribers, ONE foreign id, both transports ===== */

test("two subscribers on ONE foreign credential change each receive it once across BroadcastChannel AND storage", async () => {
  const storage = installLocalStorage();
  // A controllable BroadcastChannel hub that models MANY listeners on ONE
  // channel name (each subscriber adds its own listener); deliver() fans a
  // message out to every listener EXCEPT the sender's own.
  const hub = new Set<{ id: number; deliver: (data: any) => void }>();
  let listenerSeq = 0;
  class FakeChannel {
    private readonly myId = ++listenerSeq;
    private sink: ((data: any) => void) | null = null;
    constructor(_name: string) {}
    postMessage(data: any) {
      for (const peer of hub) if (peer.id !== this.myId) peer.deliver(data);
    }
    addEventListener(_type: string, fn: (event: any) => void) {
      // EACH addEventListener registers a DISTINCT listener — never overwrite.
      const entry = { id: this.myId, deliver: (data: any) => fn({ data } as MessageEvent) };
      this.sink = entry.deliver;
      hub.add(entry);
    }
    removeEventListener() {
      for (const peer of hub) if (peer.deliver === this.sink) hub.delete(peer);
      this.sink = null;
    }
    close() {}
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

  const events = await import("../src/generation/credential-events");

  // TWO independent subscribers, each with its OWN bounded dedup ring.
  const ids1: Array<string | undefined> = [];
  const ids2: Array<string | undefined> = [];
  const unsub1 = events.onCredentialChange((d) => ids1.push(d.mutationId));
  const unsub2 = events.onCredentialChange((d) => ids2.push(d.mutationId));

  // A FOREIGN origin (never this page's tag) so nothing is loop-suppressed. The
  // SAME mutation id is carried by BOTH cross-tab transports. Each subscriber
  // must see the id EXACTLY ONCE — the second transport collapses in that
  // subscriber's own dedup ring. Delivered from a foreign channel peer (bc) and
  // replayed as the storage marker, both with the identical id.
  const FOREIGN = "foreign-tab-origin";
  const deliverForeign = (mutationId: string) => {
    // 1. BroadcastChannel: a peer channel posts it; our two subscriber listeners
    //    registered on the shared hub each receive it.
    const peer = new FakeChannel(events.CREDENTIAL_CHANGE_EVENT) as any;
    peer.postMessage({ origin: FOREIGN, provider: "higgsfield", mutationId });
    // 2. storage marker: the SAME id, foreign origin.
    (globalThis as any).window.dispatchEvent({
      type: "storage",
      key: events.CREDENTIAL_CHANGE_MARKER,
      newValue: JSON.stringify({ counter: 1, origin: FOREIGN, mutationId }),
    });
  };

  const id1 = "foreign-id-1";
  deliverForeign(id1);
  await Promise.resolve();

  assert.deepEqual(ids1, [id1], "subscriber 1 receives the foreign id exactly once across both transports");
  assert.deepEqual(ids2, [id1], "subscriber 2 receives the SAME foreign id exactly once across both transports");

  // A NEW, distinct foreign id must reach BOTH subscribers again — dedup is
  // per-receiver and must not swallow a genuinely new mutation.
  const id2 = "foreign-id-2";
  deliverForeign(id2);
  await Promise.resolve();

  assert.deepEqual(ids1, [id1, id2], "subscriber 1 receives the NEW foreign id again");
  assert.deepEqual(ids2, [id1, id2], "subscriber 2 receives the NEW foreign id again");

  // Eviction proof: the dedup ring is BOUNDED at 64. After 65+ distinct foreign
  // ids, the OLDEST (id1) falls out of the ring, so re-delivering id1 is treated
  // as new again — while each of the 65 is delivered exactly once as it arrives.
  const beforeLen1 = ids1.length;
  const beforeLen2 = ids2.length;
  for (let n = 0; n < 65; n++) deliverForeign(`foreign-evic-${n}`);
  await Promise.resolve();
  assert.equal(ids1.length, beforeLen1 + 65, "each of the 65 new foreign ids reaches subscriber 1 once");
  assert.equal(ids2.length, beforeLen2 + 65, "each of the 65 new foreign ids reaches subscriber 2 once");

  const evictLen1 = ids1.length;
  const evictLen2 = ids2.length;
  deliverForeign(id1); // evicted -> accepted again as new
  await Promise.resolve();
  assert.equal(ids1.length, evictLen1 + 1, "the evicted old id is accepted again (bounded ring), subscriber 1");
  assert.equal(ids2.length, evictLen2 + 1, "the evicted old id is accepted again (bounded ring), subscriber 2");
  assert.equal(ids1[ids1.length - 1], id1, "the re-accepted id is the old evicted one");

  unsub1();
  unsub2();
  assert.equal(
    (globalThis as any).window.listeners.get(events.CREDENTIAL_CHANGE_EVENT)?.size ?? 0,
    0,
    "both subscribers clean up their same-tab listeners",
  );
});
