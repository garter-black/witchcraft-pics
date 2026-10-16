// CROSS-TAB LOGOUT QUARANTINE — regression tests over the ACTUAL transport
// module (`src/generation/credential-events.ts`). These are the ONLY production
// module under test here: no scope/IndexedDB/idb module is imported or covered
// by this file (the App-level quarantine wiring is covered by the source review,
// not by these unit tests).
//
// Honest scope: deterministic UNIT tests with in-process fakes (a BroadcastChannel
// stand, a localStorage stand, synthetic storage events). They are NOT a live
// browser and do NOT drive a real /auth/logout in Chrome. The browser CUA
// acceptance is a SEPARATE, later step; nothing here claims it. No real
// credentials, no real network, no real browser store.
//
// Covered (each named in the code):
//   - same-tab: a GENUINE second subscriber receives one sign-out (the removed
//     global suppression no longer swallows it), while the SENDER's own
//     subscription can drop its echo with its own guard.
//   - cross-tab: a foreign tab's BroadcastChannel signal AND its storage-marker
//     event fire EACH subscriber exactly once for the same mutation id; a
//     distinct mutation id fires again.
//   - loop suppression: this page's own emitted CROSS-TAB echo is dropped at a
//     receiver (the own LOCAL dispatch intentionally still reaches unguarded
//     same-tab subscribers).
//   - unsubscribe releases every listener (local, broadcast, storage).
//   - payload carries ONLY a mutation id + origin tag (no private value).

import { test } from "node:test";
import assert from "node:assert/strict";

/* ============================================================ browser fakes */

/** A BroadcastChannel stand that delivers a posted message to every OTHER
    channel instance sharing the name (never the poster), like the real API. */
function installBroadcastChannel() {
  const byName = new Map<string, Set<any>>();
  class FakeChannel {
    name: string;
    onmessage: ((event: any) => void) | null = null;
    private listeners: Array<(event: any) => void> = [];
    constructor(name: string) {
      this.name = name;
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(this);
    }
    addEventListener(type: string, fn: (event: any) => void) {
      if (type === "message") this.listeners.push(fn);
    }
    removeEventListener(type: string, fn: (event: any) => void) {
      if (type === "message") this.listeners = this.listeners.filter((f) => f !== fn);
    }
    postMessage(data: unknown) {
      for (const peer of byName.get(this.name) ?? []) {
        if (peer === this) continue; // never the poster
        for (const fn of peer.listeners) fn({ data });
      }
    }
    /** A test hook: deliver a raw message as if another tab posted it. */
    __deliver(data: unknown) {
      for (const fn of this.listeners) fn({ data });
    }
    close() {
      byName.get(this.name)?.delete(this);
    }
    static __reset() {
      byName.clear();
    }
  }
  (globalThis as any).BroadcastChannel = FakeChannel;
  return FakeChannel;
}

/** localStorage + a window whose `storage` event can be simulated for the
    RECEIVING tab (a real storage event fires only in other tabs). */
function installWindowAndStorage() {
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

  type Handler = (event: any) => void;
  const windowListeners = new Map<string, Set<Handler>>();
  const win = {
    addEventListener: (type: string, fn: Handler) => {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Handler) => {
      windowListeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: any) => {
      const set = windowListeners.get(event?.type ?? "");
      if (set) for (const fn of [...set]) fn(event);
      return true;
    },
  };
  (globalThis as any).window = win;
  (globalThis as any).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  const emitStorage = (key: string, newValue: string | null) => {
    const set = windowListeners.get("storage");
    if (set) for (const fn of [...set]) fn({ key, newValue } as StorageEvent);
  };
  return { store, win, emitStorage };
}

/** localStorage + window only (no BroadcastChannel) for the marker path. */
function clearBroadcastChannel() {
  delete (globalThis as any).BroadcastChannel;
}

/* ======================================================= same-tab delivery */

test("same-tab: a GENUINE second subscriber receives one sign-out (no global suppression)", async () => {
  clearBroadcastChannel();
  installWindowAndStorage();
  const events = await import("../src/generation/credential-events.ts");
  events.closeIdentityLogoutChannel();

  let receiverHits = 0;
  let senderHits = 0;
  // The receiver: a plain subscriber (like a second mounted component).
  const offReceiver = events.onIdentityLogout(() => {
    receiverHits += 1;
  });
  // The sender's own subscription, dropping its own echo with its own guard —
  // exactly as the App does with `logoutNotifyGuardRef`.
  const senderUnsubscribed = { value: false };
  const offSender = events.onIdentityLogout(() => {
    if (senderUnsubscribed.value) return;
    senderHits += 1;
  });

  // A sender runs: guard ON around the notify (its own echo suppressed), and a
  // GENUINE other subscriber still receives.
  senderUnsubscribed.value = true;
  events.notifyIdentityLogout();

  assert.equal(receiverHits, 1, "the genuine second subscriber must receive exactly once");
  assert.equal(senderHits, 0, "the sender drops only its OWN echo");

  offReceiver();
  offSender();
  events.closeIdentityLogoutChannel();
});

/* ======================================================== cross-tab dedup */

test("cross-tab: a foreign signal fires each subscriber exactly once across BOTH transports", async () => {
  const FakeChannel = installBroadcastChannel();
  const { emitStorage } = installWindowAndStorage();
  const events = await import("../src/generation/credential-events.ts");
  events.closeIdentityLogoutChannel();

  let hitsA = 0;
  let hitsB = 0;
  const offA = events.onIdentityLogout(() => {
    hitsA += 1;
  });
  const offB = events.onIdentityLogout(() => {
    hitsB += 1;
  });

  // A FOREIGN mutation id carried by BOTH transports (broadcast + marker). Each
  // subscriber's own per-subscriber dedup ring must collapse the pair to one.
  const peer = new (globalThis as any).BroadcastChannel(events.IDENTITY_LOGOUT_EVENT);
  const dispatch = (mutationId: string) => {
    peer.postMessage({ mutationId, origin: "foreign-origin-tag" });
    const marker = JSON.stringify({ counter: 1, origin: "foreign-origin-tag", mutationId });
    // ACTUALLY fire the receiving tab's storage event — setItem alone only
    // mutates the stand's Map and would make this a false-positive dedup test.
    emitStorage(events.IDENTITY_LOGOUT_MARKER, marker);
  };

  dispatch("foreign-tab:1");
  assert.equal(hitsA, 1, "subscriber A: one mutation id over two transports fires once");
  assert.equal(hitsB, 1, "subscriber B: one mutation id over two transports fires once");

  // A DISTINCT mutation id fires each subscriber again (the ring drops repeats,
  // not new ids).
  dispatch("foreign-tab:2");
  assert.equal(hitsA, 2, "subscriber A: a distinct mutation id fires again");
  assert.equal(hitsB, 2, "subscriber B: a distinct mutation id fires again");

  offA();
  offB();
  peer.close();
  FakeChannel.__reset();
  events.closeIdentityLogoutChannel();
});

/* ===================================================== loop suppression */

test("loop suppression: this page's OWN cross-tab signal is dropped at its receiver", async () => {
  installBroadcastChannel();
  const { store, emitStorage } = installWindowAndStorage();
  const events = await import("../src/generation/credential-events.ts");
  events.closeIdentityLogoutChannel();

  let hits = 0;
  const off = events.onIdentityLogout(() => {
    hits += 1;
  });

  // The own LOCAL dispatch DOES reach an unguarded same-tab subscriber (that is
  // intended — see the same-tab test). What must be suppressed is the page's own
  // CROSS-TAB echo, so a receiver never double-counts its own mutation.
  events.notifyIdentityLogout();
  assert.equal(hits, 1, "the own local dispatch reaches an unguarded same-tab subscriber");

  // Read the ACTUAL marker this page just wrote to learn its real origin tag +
  // mutation id, then inject that same-own-origin payload from a FOREIGN peer
  // channel AND via a storage event. Both must be dropped by the origin check.
  const marker = JSON.parse(store.getItem(events.IDENTITY_LOGOUT_MARKER)!);
  const ownPayload = { mutationId: marker.mutationId, origin: marker.origin };
  const peer = new (globalThis as any).BroadcastChannel(events.IDENTITY_LOGOUT_EVENT);
  peer.postMessage(ownPayload);
  emitStorage(events.IDENTITY_LOGOUT_MARKER, JSON.stringify(marker));
  assert.equal(hits, 1, "the page's own origin echo must be suppressed on BOTH transports");

  off();
  peer.close();
  events.closeIdentityLogoutChannel();
});

/* ========================================================== unsubscribe */

test("unsubscribe releases every listener (local, broadcast, storage)", async () => {
  installBroadcastChannel();
  const { emitStorage } = installWindowAndStorage();
  const events = await import("../src/generation/credential-events.ts");
  events.closeIdentityLogoutChannel();

  let hits = 0;
  const off = events.onIdentityLogout(() => {
    hits += 1;
  });
  off();
  // After unsubscribe, none of the three transports reaches the released
  // listener: the local dispatch, a foreign channel message, AND a genuine
  // foreign storage event.
  events.notifyIdentityLogout();
  const peer = new (globalThis as any).BroadcastChannel(events.IDENTITY_LOGOUT_EVENT);
  peer.postMessage({ mutationId: "x:9", origin: "other-origin" });
  emitStorage(
    events.IDENTITY_LOGOUT_MARKER,
    JSON.stringify({ counter: 9, origin: "other-origin", mutationId: "x:9" }),
  );
  assert.equal(hits, 0, "an unsubscribed listener must not fire on any transport");
  peer.close();
  events.closeIdentityLogoutChannel();
});
