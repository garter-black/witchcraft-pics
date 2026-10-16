/* The credential-scope change signal, kept in its own leaf module so the
   mutation boundary (`actions.ts`), the wipe (`credential-scope.ts`) and the
   mounted studio can share one event name without importing each other.

   A credential change (save, replace, clear, or an owner reconnect) is a
   storage-scope boundary. The API call is not: the previous scope's browser
   history, media and prompts must be removed, and every mounted surface that
   could still be showing the old scope must be told.

   SAME TAB uses a `window` CustomEvent. ACROSS TABS a same-window event is
   insufficient: the credential cookie and the localStorage/IndexedDB stores are
   shared by every same-origin tab, so a key replace/clear in tab A must also
   invalidate tab B, which is still sitting on the previous scope. Two bounded
   cross-tab signals carry that:

   - `BroadcastChannel` when present: a structured, same-origin message.
   - a non-sensitive `localStorage` invalidation marker as the fallback and
     belt-and-braces for environments without `BroadcastChannel`. The marker
     holds ONLY a mutation id, a counter and an origin tag — NEVER a credential,
     a key, a prompt, or any private value. Its `storage` event fires in the
     OTHER tabs only (never the writer).

   ONE MUTATION, ONE INVALIDATION. Because BOTH transports carry the same
   mutation, a receiving tab would otherwise be told twice. Every notify mints a
   single unique MUTATION ID and puts it in BOTH payloads; a receiver keeps a
   BOUNDED ring of the mutation ids it has already acted on and drops a repeat
   from the second transport. The ring is a fixed capacity, never unbounded, so
   future mutations from the same page still work while duplicates collapse.

   LOOP SUPPRESSION: each notify also carries a per-page origin tag. A receiver
   ignores any payload whose origin tag it itself emitted, and the marker path
   additionally relies on the spec fact that `storage` fires only in other tabs.

   HONEST LIMIT: clearing mounted/persisted state for the current origin does
   NOT revoke media a person already downloaded before the switch. This module
   signals a scope change; it cannot un-download anything. */

/** Fired on `window` after a credential mutation has been observed at the
    boundary. The `detail` names the provider whose scope changed and carries the
    mutation id so same-tab and cross-tab listeners dedupe identically. */
export const CREDENTIAL_CHANGE_EVENT = "openhiggsfield:credentials-changed";

/** The non-sensitive cross-tab invalidation marker key. Holds a mutation id,
    a counter and an origin tag only. */
export const CREDENTIAL_CHANGE_MARKER = "openhiggsfield.scopeEpoch.v1";

export type CredentialChangeDetail = { provider: string; mutationId?: string };

type Marker = { counter: number; origin: string; mutationId: string };

/** Unique per page load, so a receiver can drop its own echoes. A randomly
    generated tag — not a credential and not derived from one. */
const ORIGIN_TAG = (() => {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `t${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
})();

/** Bounded, module-scoped sequence for the mutation ids this page mints. The id
    is namespaced by the origin tag so ids never collide across pages. */
let mutationSeq = 0;
function nextMutationId(): string {
  mutationSeq += 1;
  return `${ORIGIN_TAG}:${mutationSeq}`;
}

/** True when a tag was emitted by THIS page, so its own echo is suppressed. */
function isOwnOriginTag(tag: string): boolean {
  return tag === ORIGIN_TAG;
}

/** Bounded per-RECEIVER dedup. Each `onCredentialChange` subscriber owns its own
    fixed-capacity ring of the mutation ids it has already handled, so a mutation
    carried by BOTH transports (broadcast + storage marker) fires that subscriber
    exactly once — while a second subscriber in the same tab still receives the
    same mutation, and future mutations from the same page still work. The ring
    is a fixed capacity, never unbounded. */
const DEDUP_CAPACITY = 64;
type DedupRing = (mutationId: string | undefined) => boolean;
function makeDedupRing(): DedupRing {
  const order: string[] = [];
  const seen = new Set<string>();
  return (mutationId: string | undefined): boolean => {
    // No id: cannot dedupe, so treat as new (never silently swallow a signal).
    if (!mutationId) return true;
    if (seen.has(mutationId)) return false; // duplicate transport for THIS receiver
    seen.add(mutationId);
    order.push(mutationId);
    while (order.length > DEDUP_CAPACITY) {
      const evicted = order.shift()!;
      seen.delete(evicted);
    }
    return true;
  };
}

let channel: BroadcastChannel | null = null;
let channelTried = false;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (channelTried) return channel;
  channelTried = true;
  try {
    channel = new BroadcastChannel(CREDENTIAL_CHANGE_EVENT);
  } catch {
    channel = null;
  }
  return channel;
}

function readMarker(): Marker | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(CREDENTIAL_CHANGE_MARKER);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Marker>;
    if (
      typeof parsed.counter !== "number" ||
      typeof parsed.origin !== "string" ||
      typeof parsed.mutationId !== "string"
    ) {
      return null;
    }
    return { counter: parsed.counter, origin: parsed.origin, mutationId: parsed.mutationId };
  } catch {
    return null;
  }
}

function writeMarker(next: Marker): void {
  try {
    if (typeof localStorage === "undefined") return;
    // Only a mutation id, counter and origin tag — never a credential.
    localStorage.setItem(CREDENTIAL_CHANGE_MARKER, JSON.stringify(next));
  } catch {
    /* private mode or a denied store */
  }
}

function dispatchLocal(provider: string, mutationId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CredentialChangeDetail>(CREDENTIAL_CHANGE_EVENT, {
      detail: { provider, mutationId },
    }),
  );
}

/** Tell every mounted surface — in this tab AND every other same-origin tab —
    that a credential scope changed. The mutation boundary calls this AFTER the
    awaited cleanup, so a listener can re-read and find nothing of the previous
    scope left. One mutation id travels on both cross-tab transports, so a
    receiving tab invalidates exactly once. */
export function notifyCredentialChange(provider: string): void {
  const mutationId = nextMutationId();

  // 1. This tab, synchronously.
  dispatchLocal(provider, mutationId);

  const payload: CredentialChangeDetail & { origin: string } = {
    provider,
    mutationId,
    origin: ORIGIN_TAG,
  };

  // 2. Other tabs, via a structured channel when available.
  const bc = getChannel();
  if (bc) {
    try {
      bc.postMessage(payload);
    } catch {
      /* channel closed or not cloneable — the marker still carries it */
    }
  }

  // 3. Other tabs, via the non-sensitive marker. Bump the counter so a repeat
  //    still produces a distinct write (and thus a distinct storage event).
  const current = readMarker();
  writeMarker({ counter: (current?.counter ?? 0) + 1, origin: ORIGIN_TAG, mutationId });
}

/** True when a tag was emitted by THIS page, so its own echo is suppressed. */
export function isOwnCredentialChangeTag(tag: string): boolean {
  return isOwnOriginTag(tag);
}

/** Deliver a cross-tab signal to ONE subscriber at most once per mutation id,
    suppressing this page's own echoes. Each subscriber passes its own dedup ring,
    so a mutation carried by BOTH transports fires that subscriber once, while
    every other subscriber still receives it. */
function deliverCrossTab(
  dedup: DedupRing,
  listener: (detail: CredentialChangeDetail) => void,
  input: { origin?: unknown; provider?: unknown; mutationId?: unknown },
): void {
  if (typeof input.origin !== "string" || isOwnOriginTag(input.origin)) return;
  const mutationId = typeof input.mutationId === "string" ? input.mutationId : undefined;
  if (!dedup(mutationId)) return; // deduped second transport for THIS subscriber
  listener({
    provider: typeof input.provider === "string" ? input.provider : "unknown",
    ...(mutationId ? { mutationId } : {}),
  });
}

/** Subscribe to credential-scope changes from this tab's own mutations AND from
    other same-origin tabs. Every subscriber gets each mutation EXACTLY ONCE:
    dedup is per-subscriber (its own bounded ring), so the first transport does
    not consume the id out from under a later subscriber in the same tab. Returns
    an unsubscribe function that also releases the cross-tab listeners. No-op
    when there is no window (SSR). */
export function onCredentialChange(listener: (detail: CredentialChangeDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};

  // This subscriber's own bounded dedup ring (never a shared, listening-dropping
  // module set).
  const dedup = makeDedupRing();

  // Same-tab custom event.
  const localHandler = (event: Event) => {
    listener((event as CustomEvent<CredentialChangeDetail>).detail);
  };
  window.addEventListener(CREDENTIAL_CHANGE_EVENT, localHandler);

  // Cross-tab: BroadcastChannel.
  const bc = getChannel();
  const bcHandler = (event: MessageEvent) => {
    const data = (event.data ?? null) as
      | { origin?: unknown; provider?: unknown; mutationId?: unknown }
      | null;
    if (!data) return;
    deliverCrossTab(dedup, listener, data);
  };
  bc?.addEventListener("message", bcHandler);

  // Cross-tab: localStorage marker (per spec, `storage` fires in OTHER tabs).
  const storageHandler = (event: StorageEvent) => {
    if (event.key !== CREDENTIAL_CHANGE_MARKER || event.newValue === null) return;
    try {
      const parsed = JSON.parse(event.newValue) as Partial<Marker>;
      deliverCrossTab(dedup, listener, {
        origin: parsed.origin,
        provider: "unknown",
        mutationId: parsed.mutationId,
      });
    } catch {
      /* a malformed marker is ignored, not acted on */
    }
  };
  window.addEventListener("storage", storageHandler);

  return () => {
    window.removeEventListener(CREDENTIAL_CHANGE_EVENT, localHandler);
    bc?.removeEventListener("message", bcHandler);
    window.removeEventListener("storage", storageHandler);
  };
}

/** Release the shared cross-tab channel. Exposed for tests and for a caller that
    wants to tear the module down; not required for correctness. */
export function closeCredentialChannel(): void {
  try {
    channel?.close();
  } catch {
    /* already closed */
  }
  channel = null;
  channelTried = false;
}

/* ==================================================================== */
/* IDENTITY / LOGOUT SIGNAL                                             */
/* ==================================================================== */

/* A SIGN-OUT is an IDENTITY boundary, not a provider-credential change, and it
   has its own cross-tab signal — kept SEPARATE from the credential signal above
   so a provider-key replace/clear never pretends to be a Google identity, and a
   Google sign-out never pretends to be a provider mutation.

   THE DEFECT THIS CLOSES: a native sign-out in tab A (the /auth/logout form
   POST that clears the shared cookie) left a SECOND mounted, VISIBLE tab B still
   rendering its own already-loaded private history, media and prompt. Tab B only
   hid when its OWN focus/visibilitychange re-validation happened to fire, which
   does not happen while tab B simply sits in the foreground — a real, observed
   same-origin cross-tab privacy failure.

   The transport mirrors the credential signal above (BroadcastChannel plus a
   non-sensitive localStorage marker, per-page origin tag loop suppression, a
   bounded per-receiver dedup ring). The payload carries ONLY a mutation id and
   (for the marker) an origin tag — NEVER a principal, a credential, a prompt or
   any private value. A receiving tab must FAIL CLOSED: hide its private surfaces
   and invalidate its own in-flight work SYNCHRONOUSLY, before any await. */

/** Fired on `window` (this tab) and across same-origin tabs after a sign-out is
    initiated, so every OTHER mounted tab invalidates its private surfaces
    without waiting for its own focus re-validation. */
export const IDENTITY_LOGOUT_EVENT = "openhiggsfield:identity-logout";

/** The non-sensitive cross-tab logout marker key. Holds a mutation id, a
    counter and an origin tag only — never a principal or any credential. */
export const IDENTITY_LOGOUT_MARKER = "openhiggsfield.identityLogout.v1";

type LogoutMarker = { counter: number; origin: string; mutationId: string };

/* SENDER SELF-ECHO GUARD is the SENDER's own responsibility, not a global one.

   `notifyIdentityLogout` dispatches a SAME-TAB `window` CustomEvent so every
   OTHER same-tab subscriber learns a sign-out started. But the sender ALSO
   holds its own `onIdentityLogout` subscription: without a guard the sender's
   local dispatch would re-enter its own receiver and run a SECOND, duplicate
   quarantine/wipe on top of the synchronous one signOut already performed.

   An earlier revision suppressed that echo with a plain module counter
   (`logoutNotifyDepth`) held > 0 around the whole dispatch. That ALSO swallowed
   the event for every GENUINE other same-tab subscriber — the exact signal this
   transport exists to deliver — while its comment claimed they still received
   it. The suppression is removed here. The SENDER now drops its own echo with
   its own per-subscription guard set synchronously around the notify call
   (App: `logoutNotifyGuardRef`), so a genuine second subscriber in this tab is
   never suppressed. Cross-tab transports are unaffected either way: they carry
   the origin tag, which a receiver uses to drop its own echo. */

let logoutChannel: BroadcastChannel | null = null;
let logoutChannelTried = false;
function getLogoutChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (logoutChannelTried) return logoutChannel;
  logoutChannelTried = true;
  try {
    logoutChannel = new BroadcastChannel(IDENTITY_LOGOUT_EVENT);
  } catch {
    logoutChannel = null;
  }
  return logoutChannel;
}

function readLogoutMarker(): LogoutMarker | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(IDENTITY_LOGOUT_MARKER);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LogoutMarker>;
    if (
      typeof parsed.counter !== "number" ||
      typeof parsed.origin !== "string" ||
      typeof parsed.mutationId !== "string"
    ) {
      return null;
    }
    return { counter: parsed.counter, origin: parsed.origin, mutationId: parsed.mutationId };
  } catch {
    return null;
  }
}

function writeLogoutMarker(next: LogoutMarker): void {
  try {
    if (typeof localStorage === "undefined") return;
    // Only a mutation id, counter and origin tag — never a principal.
    localStorage.setItem(IDENTITY_LOGOUT_MARKER, JSON.stringify(next));
  } catch {
    /* private mode or a denied store */
  }
}

/** Tell every mounted surface — in this tab AND every other same-origin tab —
    that a sign-out was initiated, so a hidden/revealed tab invalidates its own
    private surfaces immediately instead of after its next focus. The caller
    runs its OWN synchronous quarantine FIRST; this only carries the signal. One
    mutation id travels on both transports, so a receiving tab invalidates once.

    The SAME-TAB local dispatch reaches every subscriber, including any OTHER
    one in this tab. The SENDER drops its own echo with its own per-subscription
    guard (`logoutNotifyGuardRef`, set synchronously around this call), not with
    a global suppression counter — see the note above. Cross-tab transports are
    unaffected: their origin tag already suppresses the sender's echo at the
    receiver. */
export function notifyIdentityLogout(): void {
  const mutationId = nextMutationId();

  // 1. This tab, synchronously. Every subscriber in this tab is notified; the
  //    sender suppresses only ITS OWN echo via its own guard ref.
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<void>(IDENTITY_LOGOUT_EVENT, { detail: undefined }),
    );
  }

  const payload = { mutationId, origin: ORIGIN_TAG };

  // 2. Other tabs, via a structured channel when available.
  const bc = getLogoutChannel();
  if (bc) {
    try {
      bc.postMessage(payload);
    } catch {
      /* channel closed or not cloneable — the marker still carries it */
    }
  }

  // 3. Other tabs, via the non-sensitive marker. Bump the counter so a repeat
  //    still produces a distinct write (and thus a distinct storage event).
  const current = readLogoutMarker();
  writeLogoutMarker({ counter: (current?.counter ?? 0) + 1, origin: ORIGIN_TAG, mutationId });
}

/** Subscribe to sign-out signals from this tab AND other same-origin tabs. A
    cross-tab signal is delivered to ONE subscriber at most once per mutation id
    (this subscriber's own bounded ring), suppressing this page's own echo. The
    listener receives no data — a logout is a signal, not a payload. Same-tab
    custom events additionally fire from the local dispatch in
    `notifyIdentityLogout`. Returns an unsubscribe that releases every listener.
    No-op when there is no window (SSR). */
export function onIdentityLogout(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const dedup = makeDedupRing();

  const localHandler = () => {
    // The sender suppresses its OWN local echo with its own guard ref
    // (App: `logoutNotifyGuardRef`), so no global suppression is needed here.
    // Every genuine subscriber in this tab — including a second one — receives
    // the sign-out.
    listener();
  };
  window.addEventListener(IDENTITY_LOGOUT_EVENT, localHandler);

  const bc = getLogoutChannel();
  const bcHandler = (event: MessageEvent) => {
    const data = (event.data ?? null) as { origin?: unknown; mutationId?: unknown } | null;
    if (!data || typeof data.origin !== "string" || isOwnOriginTag(data.origin)) return;
    const mutationId = typeof data.mutationId === "string" ? data.mutationId : undefined;
    if (!dedup(mutationId)) return;
    listener();
  };
  bc?.addEventListener("message", bcHandler);

  const storageHandler = (event: StorageEvent) => {
    if (event.key !== IDENTITY_LOGOUT_MARKER || event.newValue === null) return;
    try {
      const parsed = JSON.parse(event.newValue) as Partial<LogoutMarker>;
      if (typeof parsed.origin !== "string" || isOwnOriginTag(parsed.origin)) return;
      const mutationId = typeof parsed.mutationId === "string" ? parsed.mutationId : undefined;
      if (!dedup(mutationId)) return;
      listener();
    } catch {
      /* a malformed marker is ignored, not acted on */
    }
  };
  window.addEventListener("storage", storageHandler);

  return () => {
    window.removeEventListener(IDENTITY_LOGOUT_EVENT, localHandler);
    bc?.removeEventListener("message", bcHandler);
    window.removeEventListener("storage", storageHandler);
  };
}

/** Release the shared logout channel. Exposed for tests and teardown. */
export function closeIdentityLogoutChannel(): void {
  try {
    logoutChannel?.close();
  } catch {
    /* already closed */
  }
  logoutChannel = null;
  logoutChannelTried = false;
}

/* COORDINATOR CORRECTION (03:56Z): the sign-out signal is emitted at the START
   of signOut — BEFORE the awaited cleanup — so a FAILED cleanup still hides the
   other mounted tab (otherwise a failed logout would leave a second private tab
   visible until its own focus). `notifyIdentityLogout` is scoped to the
   identity/logout boundary and carries no provider/principal; the receiver
   fails closed and a pending/unfinished cleanup cannot re-reveal old content. */
