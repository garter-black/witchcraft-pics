"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  beginLogin,
  endSession,
  fetchIdentity,
  IDENTITY_LOGIN_URL,
  identityViewKeyFrom,
  type Identity,
  type IdentityView,
} from "@/generation/identity";
import { hasPlatformCredentials, submitGeneration } from "@/generation/actions";
import { MissingCredentialsError } from "@/generation/credentials";
import { wipeClientState, completeScopeRemoval, resetPersistentStores, type WipeResult } from "@/generation/credential-scope";
import { runExclusive } from "@/generation/storage-boundary";
import { MODELS, getModel } from "@/generation/catalog";
import type { Surface } from "@/generation/catalog";
import type { Provider } from "@/generation/catalog/types";
import { assemblePlane } from "@/generation/plane";
import type { GenerationStatus } from "@/generation/platform";
import { POLL_DEADLINE_MS, stopWatching, watchRequest } from "@/generation/poll";
import { useActive } from "@/generation/stores/active";
import { useImagePrompt, useVideoPrompt } from "@/generation/stores/prompt";
import { useSettings } from "@/generation/stores/settings";

import { StudioWelcome } from "@/witchcraft/studio-shell";
import { Exaggerator } from "@/witchcraft/exaggerator";
import { GRAIN_URI, artFor } from "./artwork";
import { Composer } from "./composer";
import { fileNameFor, saveFile } from "./download";
import { KeyModal } from "./key-modal";
import { PlanControl, RendererBadge } from "./local-panel";
import {
  useImagePrompt as useImagePromptStore,
  useVideoPrompt as useVideoPromptStore,
} from "@/generation/stores/prompt";
import {
  CROSS_VIEWS,
  countSetting,
  durationBadge,
  metaOf,
  ratioToCss,
  type GalleryView,
} from "./data";
import { Gallery } from "./gallery";
import { loadHistory, mergeHistory, replaceRequest, saveHistory, stepRun, type RunRecord } from "./history";
import { currentEpoch, epochCurrent } from "@/generation/credential-scope";
import { onCredentialChange, notifyIdentityLogout, onIdentityLogout } from "@/generation/credential-events";
import { CloseIcon, UndoIcon } from "./icons";
import { SelectionBar, type SaveProgress } from "./selection-bar";
import { Topbar } from "./topbar";
import { Viewer } from "./viewer";

/* Long enough to read the bar and reach it; the drain line states the window. */
const UNDO_MS = 6000;

export interface ActiveRun {
  /** Identifies the skeleton this run occupies, so a batch clears one tile at
      a time as its own request settles. */
  id: string;
  surface: Surface;
  modelLabel: string;
  ratio: string;
  startedAt: number;
}

type RunDraft = {
  surface: Surface;
  modelId: string;
  modelLabel: string;
  prompt: string;
  ratio: string;
  meta: string;
  badge?: string;
  settings?: Record<string, unknown>;
  createdAt: number;
};

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function rowId(requestId: string, offset: number, count: number): string {
  return count > 1 ? `${requestId}#${offset}` : requestId;
}

function draftOf(record: RunRecord): RunDraft {
  return {
    surface: record.surface,
    modelId: record.modelId,
    modelLabel: record.modelLabel,
    prompt: record.prompt,
    ratio: record.ratio,
    meta: record.meta,
    badge: record.badge,
    settings: record.settings,
    createdAt: record.createdAt,
  };
}

function runningRows(requestId: string, count: number, draft: RunDraft): RunRecord[] {
  return Array.from({ length: count }, (_, offset) => {
    const id = rowId(requestId, offset, count);
    return {
      id,
      requestId,
      surface: draft.surface,
      modelId: draft.modelId,
      modelLabel: draft.modelLabel,
      prompt: draft.prompt,
      ratio: draft.ratio,
      meta: draft.meta,
      badge: draft.badge,
      kind: draft.surface,
      urls: [],
      status: "running",
      art: artFor(draft.surface, hueOf(id), id),
      createdAt: draft.createdAt,
      settings: draft.settings,
    };
  });
}

function terminalRows(requestId: string, draft: RunDraft, status: GenerationStatus): RunRecord[] {
  const urls =
    status.images?.map((image) => image.url) ?? (status.video ? [status.video.url] : []);
  const completed = status.status === "completed" && urls.length > 0;
  const base = status.requestId || requestId;
  const failure = completed ? undefined : failureText(status);
  const delivered: Array<string | null> = completed ? urls : [null];
  return delivered.map((url, offset) => {
    const id = rowId(base, offset, delivered.length);
    return {
      id,
      requestId: base,
      surface: draft.surface,
      modelId: draft.modelId,
      modelLabel: draft.modelLabel,
      prompt: draft.prompt,
      ratio: draft.ratio,
      meta: draft.meta,
      badge: draft.badge,
      kind: draft.surface,
      urls: url ? [url] : [],
      status: completed ? "completed" : "failed",
      error: failure,
      art: artFor(draft.surface, hueOf(id), id),
      createdAt: draft.createdAt,
      settings: draft.settings,
    };
  });
}

function failedRows(requestId: string, count: number, draft: RunDraft, error: string): RunRecord[] {
  return runningRows(requestId, count, draft).map((row) => ({
    ...row,
    status: "failed" as const,
    error,
  }));
}

function failureText(status: GenerationStatus): string {
  if (status.status === "nsfw") return "the platform flagged the result as NSFW";
  if (status.status === "canceled") return "the run was canceled";
  if (typeof status.error === "string" && status.error) return status.error;
  return "the platform reported a failure";
}

function describeError(caught: unknown, provider: Provider = 'higgsfield'): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (caught instanceof MissingCredentialsError || message.includes("Missing platform key")) {
    /* A visitor is never asked to bring the studio owner key. The local route
       is owner-restricted, so an anonymous caller is pointed at /free-access,
       not at owner credentials. Paid BYOK routes keep their own wording. */
    return provider === "local"
      ? "The studio renderer is owner-restricted and is not open to visitors. Explore provider signup options on Free access."
      : "Add your platform key to generate.";
  }
  if (/not_enough_credits|insufficient.?credits/i.test(message)) {
    return "Your generation account needs more credits. Add credits in that provider console, then return here to generate.";
  }
  return provider === "local"
    ? `Generation failed — ${message}. The studio renderer is owner-restricted; explore provider signup options on Free access.`
    : `Generation failed — ${message}. Try again; if it repeats, check the key in the sidebar.`;
}

export function OpenHiggsfieldApp({ fontClassName = "" }: { fontClassName?: string }) {
  const surface = useActive((state) => state.surface);
  const modelId = useActive((state) => state.model);
  const setModel = useActive((state) => state.setModel);
  const model = getModel(modelId);
  const provider = model.provider ?? 'higgsfield';
  const setSettings = useSettings((state) => state.set);

  /* BOTH prompt hooks are called UNCONDITIONALLY at the top of the component,
     before any early return or conditional JSX. A hook call inside the
     `verified ? (...) : (...)` render branch would change the hook count when
     `verified` flips, which is a runtime "Rendered more hooks than during the
     previous render" error even though a TS build passes. The active prompt is
     DERIVED from the two unconditional reads. */
  const imagePrompt = useImagePrompt();
  const videoPrompt = useVideoPrompt();
  const activePromptText = (surface === "image" ? imagePrompt : videoPrompt).text;

  const [history, setHistory] = useState<RunRecord[]>([]);
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [view, setView] = useState<GalleryView>(surface);
  const [focusNonce, setFocusNonce] = useState(0);
  /* TWO distinct gates, deliberately separated (the previous single flag caused a
     save-effect race that overwrote the namespaced cache with `[]`):
       - `identityReady` — the identity decision is SETTLED and permits a read.
       - `historyHydrated` — the ACTUAL namespaced load for the current principal
         has completed. Saves and resume are gated on THIS, never on the mere
         identity decision, so the save effect cannot fire `[]` over a cache that
         is about to be loaded. */
  const [identityReady, setIdentityReady] = useState(false);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  /* True while a required cleanup has FAILED and has not yet been retried to
     success. Private surfaces stay hidden until a retry confirms the wipe, so a
     failed logout cannot be followed by a same-principal re-validation that
     reveals the previous account's work. Cleared only by a successful wipe. */
  const [cleanupBlocked, setCleanupBlocked] = useState(false);
  /* Bumped on every settled cycle so the load effect re-runs even when
     `identityReady` was already true. */
  const [cycleNonce, setCycleNonce] = useState(0);
  /* Deleting drops the only copy of a run — the platform's result URLs are not
     re-derivable — so the records are held aside until the bar times out. */
  const [deleted, setDeleted] = useState<RunRecord[] | null>(null);
  /* Picked runs, in the order they were picked: the count stack shows the most
     recent sheets on top, and a range extends from the last one touched. */
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState<SaveProgress | null>(null);
  /* The PROVIDER credential is a SEPARATE privilege from the signed-in account:
     a Google sign-in proves storage identity, never owner/GPU spend. This lamp
     reports the provider key that Generate actually spends. */
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [ownerConnected, setOwnerConnected] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);

  /* ---------- identity (verified principal) ----------

     The run log belongs to the VERIFIED principal, not to the browser. Until a
     fresh GET /api/identity answers, `verified` is false and every private
     surface (composer, media, history, viewer) stays hidden — a shared browser
     must show no flash of the previous account's prompts or results on the
     first paint, before the async answer arrives. */
  const [identity, setIdentity] = useState<Identity | null>(null);
  /* True only once a full, current identity cycle has settled (success OR
     failure). A failure keeps private surfaces hidden, so the user is told
     rather than shown an empty studio by accident. */
  const [verified, setVerified] = useState(false);
  /* Reported failure text for inline, non-blocking messaging. */
  const [identityError, setIdentityError] = useState<string | null>(null);
  /* The principal history is keyed by. Undefined = anonymous scope. Only ever a
     verified p_<32hex>. */
  const principal = identity?.status === "authenticated" ? identity.principal : undefined;
  /* Legacy operator mode: the identity layer is NOT configured on this backend,
     so the pre-identity behaviour is retained. Provider credentials alone then
     decide private history, as before. */
  const legacy = identity?.status === "legacy";
  /* The login link is ALWAYS the fixed same-origin constant; it is never taken
     from a server answer (which cannot redirect anywhere but /auth/login). */
  const loginUrl = IDENTITY_LOGIN_URL;

  /* The latest identity cycle owns the right to commit. Every async callback
     captures the sequence it began under and refuses to write if a newer cycle
     started (a race between a slow cycle and a fresh one on account refresh). */
  const identitySeq = useRef(0);

  const galleryRef = useRef<HTMLDivElement>(null);
  const rangeAnchor = useRef<number | null>(null);
  const visibleRef = useRef<RunRecord[]>([]);
  /* Presses number their own skeletons, so two batches in flight together can
     never claim the same tile. */
  const press = useRef(0);
  const alive = useRef(true);
  const freshTimers = useRef<number[]>([]);
  const historyRef = useRef(history);
  historyRef.current = history;

  /* ---------- scope apply ----------

     One function owns BOTH the in-memory reset and the awaited, ordered removal
     of the previous scope's persisted history. ORDER IS LOAD-BEARING:
       1. reset the in-memory sensitive surfaces IMMEDIATELY;
       2. `wipeClientState()` bumps the epoch SYNCHRONOUSLY (invalidating every
          in-flight callback and stopping the previous scope's watches) and drops
          the sensitive localStorage keys — this MUST run BEFORE any await so a
          callback that settles during the wait is already stale;
       3. AWAIT `resetPersistentStores()` (in-memory store reset);
       4. AWAIT the ordered history-record removal and RETURN its result so the
          caller can FAIL CLOSED when the record could not be confirmed removed.
     The IndexedDB removal is queued through the SAME shared chain history writes
     use, so a save still in flight lands BEFORE the removal. */
  const applyScopeChange = useCallback(async (preservePrincipal?: string): Promise<WipeResult> => {
    // 1. Reset every in-memory sensitive surface immediately, during the wait,
    //    so the mounted gallery/media/prompt cannot keep showing the old scope.
    setHistory([]);
    setRuns([]);
    setDeleted(null);
    setSelected([]);
    setViewerId(null);
    setError(null);
    setFreshIds([]);
    setIdentityError(null);
    // 2. SYNCHRONOUS invalidation FIRST — BEFORE the first await. This is what
    //    makes an in-flight callback stale the instant the boundary is reached.
    const scope = wipeClientState();
    // 3. In-memory store reset.
    await resetPersistentStores();
    // STALE-CYCLE GUARD: a slower OLD cleanup can reach this point AFTER a newer
    // cycle already BUMPED the epoch again (e.g. a rapid account switch). If so,
    // this capture is superseded: running the destructive removal now would
    // delete the NEWER scope's freshly retained row (e.g. old retainA deleting
    // B's cache). The epoch check is the discriminator — a stale capture returns
    // a NON-success result (recordRemoved:false) and its caller's post-await
    // identitySeq check discards it; a superseded removal never runs.
    if (!epochCurrent(scope)) {
      return {
        epoch: scope,
        recordRemoved: false,
        databaseDeleted: false,
        databaseBlocked: false,
        error: "superseded",
      };
    }
    // 4. Awaited, ordered record removal. RETURNS the result (never swallowed).
    //    `preservePrincipal` (undefined for a full logout/cleanup retry) is the
    //    validated newly verified p_<32hex> whose OWN namespaced row is retained;
    //    the worker's completeScopeRemoval drops the generic key and every other
    //    principal's key. An undefined/invalid value is a full wipe.
    return runExclusive(() => {
      // Re-check INSIDE the queued work: the queue may have drained a newer
      // cycle's bump while this item waited, so the destructive call is guarded
      // at the moment it actually runs, not only at enqueue time.
      if (!epochCurrent(scope)) {
        return Promise.resolve<WipeResult>({
          epoch: scope,
          recordRemoved: false,
          databaseDeleted: false,
          databaseBlocked: false,
          error: "superseded",
        });
      }
      return completeScopeRemoval(scope, preservePrincipal);
    });
  }, []);

  /* ---------- identity cycle: fetch -> (maybe apply) -> reveal --------

     Ordering is load-bearing:
       1. HIDE private surfaces IMMEDIATELY (`setVerified(false)`) at the START
          of every validation, so on a re-check (visibility/account refresh) the
          previous account's private UI is not displayed while the 20s fetch is
          still pending;
       2. fetch the identity view;
       3. decide whether the effective scope actually CHANGED. A wipe runs ONLY
          on the initial unverified startup OR a confirmed change of principal
          (including transition to/from anonymous or legacy). A same-principal
          re-validation preserves the visitor's own current work — no wipe;
       4. if applying, AWAIT the wipe and FAIL CLOSED on a failed removal;
       5. only then set `identity`/`identityReady` (permitting the load effect)
          and, LAST, `verified` (revealing the private surfaces).
     `identityReady` is left FALSE while hidden so the load effect cannot run
     against a scope that is not yet settled; `historyHydrated` likewise stays
     FALSE until the namespaced load actually completes.

     A previously FAILED cleanup (`cleanupBlockedRef`) forces a retry even when
     the principal is unchanged — a failed logout must not be bypassed by a
     later same-principal re-validation. Reveal waits for a successful retry;
     a retry that succeeds clears the flag once, so there is no loop. */
  const runIdentityCycle = useCallback(
    async (opts: { apply: boolean; reason: string }) => {
      const seq = ++identitySeq.current;
      // Hide immediately and block both the load and the save/resume effects
      // until this cycle settles.
      setVerified(false);
      setIdentityReady(false);
      setHistoryHydrated(false);
      let view: IdentityView | null = null;
      const outcome = await fetchIdentity(20000, (v) => {
        view = v;
      });
      if (!alive.current || seq !== identitySeq.current) return;
      if (outcome.status === "failure") {
        // A broken/absent endpoint answer keeps private content HIDDEN and is
        // reported. The public world is preserved regardless. Any cleanup that
        // was pending stays pending — this failure path never reveals.
        setIdentityError(outcome.reason);
        return;
      }
      // The scope KEY this answer reduces to. An unchanged key means the same
      // account re-validated: preserve current work, do not wipe.
      const nextKey = identityViewKeyFrom(outcome);
      const changed = nextKey !== identityKeyRef.current;
      // A wipe is warranted on the first (unverified) decision, a real change,
      // OR a previous cleanup that has not yet been retried to success.
      const cleanupPending = cleanupBlockedRef.current;
      const shouldWipe =
        opts.apply && (identityKeyRef.current === null || changed || cleanupPending);
      if (shouldWipe) {
        // FAIL CLOSED SETUP: mark the cleanup as IN PROGRESS before it starts.
        // If the wipe THROWS, or its removal cannot be confirmed, the flag stays
        // set so the NEXT cycle retries a FULL wipe before any reveal — a
        // focus/visibility re-validation can never bypass it.
        cleanupBlockedRef.current = true;
        setCleanupBlocked(true);
        setVerified(false);
        // Retain ONLY the newly verified principal's own namespaced row so its
        // saved history survives a same-account boundary; unscoped and other
        // principals' keys still go. A pending-retry or a non-authenticated
        // outcome passes NO preserve key: the retry must do a FULL wipe and must
        // not re-retain state that belongs to a boundary that never confirmed.
        const preserve =
          !cleanupPending && outcome.status === "authenticated"
            ? outcome.principal
            : undefined;
        let result: WipeResult;
        try {
          result = await applyScopeChange(preserve);
        } catch (caught) {
          // A throw is a FAILED cleanup: stay blocked, stay hidden, report it.
          if (!alive.current || seq !== identitySeq.current) return;
          cleanupBlockedRef.current = true;
          setCleanupBlocked(true);
          setIdentity(outcome);
          setVerified(false);
          setIdentityError(
            caught instanceof Error
              ? `The previous library could not be cleared: ${caught.message}`
              : "The previous library could not be fully cleared on this device.",
          );
          return;
        }
        if (!alive.current || seq !== identitySeq.current) return;
        // FAIL CLOSED: a record that could not be confirmed removed leaves a
        // readable row; do NOT reveal private surfaces over it. The flag stays
        // set so the NEXT cycle retries it before any reveal.
        if (result.error || !result.recordRemoved) {
          cleanupBlockedRef.current = true;
          setCleanupBlocked(true);
          setIdentity(outcome);
          setVerified(false);
          setIdentityError("The previous library could not be fully cleared on this device.");
          return;
        }
        // The wipe succeeded: the pending block is cleared.
        cleanupBlockedRef.current = false;
        setCleanupBlocked(false);
      }
      if (!alive.current || seq !== identitySeq.current) return;
      // QUARANTINE RELEASE — DECIDE BEFORE ANY COMMIT. A sign-out (local or
      // cross-tab) set the latch so no late callback / old-principal focus
      // re-validation could reveal the previous account. It is released ONLY by
      // a genuinely NEW session: a verified ANONYMOUS result, or an authenticated
      // principal DISTINCT from the key CAPTURED when the quarantine was set. If
      // neither holds, NOTHING below runs — not the identity commit, not the
      // ready/load permit, not the cycle bump, not the reveal — so the old
      // principal stays hidden and the load effect cannot reload its history.
      if (logoutQuarantineRef.current) {
        const priorKey = quarantinedKeyRef.current;
        const isNewSession =
          outcome.status === "anonymous" ||
          (outcome.status === "authenticated" && priorKey !== null && nextKey !== priorKey);
        if (!isNewSession) {
          // The old principal re-validated while quarantined: stay hidden. Do NOT
          // record the identity or permit the load — a commit here is exactly the
          // reveal this latch exists to prevent.
          setVerified(false);
          setIdentityReady(false);
          setHistoryHydrated(false);
          return;
        }
        // A new, distinct session has settled: release the latch.
        logoutQuarantineRef.current = false;
        quarantinedKeyRef.current = null;
      }
      // Only an AUTHENTICATED principal is a storage identity. An anonymous or
      // legacy session never adopts another account's generic history.
      setIdentity(outcome);
      identityKeyRef.current = nextKey;
      setIdentityError(null);
      // Permit the load effect; the save/resume effects stay gated on the
      // ACTUAL hydration flag the load effect raises when the read completes.
      setIdentityReady(true);
      // Re-run the load effect on EVERY settled cycle, even when
      // `identityReady` was already true — otherwise a same-principal
      // re-validation would never re-read after a clean no-wipe settle.
      setCycleNonce((n) => n + 1);
      setVerified(true);
    },
    [applyScopeChange],
  );

  const identityKeyRef = useRef<string | null>(null);
  /* The current configured identity key. Held in a ref (not derived from the
     `identity` state) so the cycle can compare the NEXT answer to the CURRENT
     one without waiting for a re-render. A provider credential event does NOT
     change this — only the provider-credential effect re-runs for that. */

  /* A cleanup that failed and must be retried before any reveal. A ref (not
     derived from state) so the NEXT cycle can test it without a re-render, and
     so a logout's failure is visible to a cycle that starts before React has
     flushed the state update. */
  const cleanupBlockedRef = useRef(false);

  /* IDENTITY-LOGOUT QUARANTINE LATCH (synchronous).

     A sign-out — local OR signalled from another same-origin tab — is an
     IDENTITY boundary. The instant it is observed, private surfaces must be
     hidden and this tab's own in-flight identity work invalidated WITHOUT
     awaiting anything, and the tab must STAY private until a genuinely NEW,
     distinct session settles. This latch is the synchronous guard for BOTH the
     sender (signOut) and a cross-tab receiver: while it is true a late
     identity-cycle callback, a focus re-validation of the OLD principal, or a
     queued save cannot re-reveal the previous account's content.

     A plain module/ref boolean (not React state) is required because the
     receiver runs SYNCHRONOUSLY off a `window` event, before React flushes any
     state update. It is cleared ONLY by a settled cycle that is either a
     verified ANONYMOUS session or a NEW distinct principal — never by a
     same-principal re-check of the identity that just signed out. */
  const logoutQuarantineRef = useRef(false);

  /* The identity key captured AT the moment a sign-out (local or cross-tab)
     quarantined this tab. A quarantine release must be a GENUINELY NEW session:
     a verified ANONYMOUS result, or an authenticated principal DISTINCT from the
     one that was signed out. It is captured independent of `identityKeyRef`
     because the sender nulls `identityKeyRef` after a SUCCESSFUL wipe — without
     this capture a same-principal re-validation would compare against `null`
     and be treated as "new", re-revealing the account that just signed out.
     A `null` capture means the key was unknown at quarantine time: a later
     `null` (anonymous) is a legitimate fresh session, but a later authenticated
     key can NOT be proven distinct, so it does not release the latch. */
  const quarantinedKeyRef = useRef<string | null>(null);

  /* Sender re-entrancy guard for the LOCAL logout dispatch. `notifyIdentityLogout`
     fires a same-tab `window` event; without this, `signOut`'s own synchronous
     quarantine could fire TWICE (once directly, once via the receiver hook). Set
     SYNCHRONOUSLY around the notify call so the receiver hook can no-op for the
     sender's own echo while a genuine cross-tab receipt still runs it. */
  const logoutNotifyGuardRef = useRef(false);

  /* Subscribe to the explicit credential-change event the mutation boundary
     emits AFTER its awaited, reliable wipe. The boundary has ALREADY performed
     the wipe (epoch bump + awaited removal), so this handler must NOT repeat it
     — it only resets the in-memory surfaces and re-runs the provider-credential
     check, which is the privilege a key change actually affects. The verified
     account identity is separate: a provider-key change never signs a person in
     or out, so the identity cycle is not re-run here (no duplicate wipe, no
     event loop). */
  useEffect(() => {
    return onCredentialChange(() => {
      setHistory([]);
      setRuns([]);
      setDeleted(null);
      setSelected([]);
      setViewerId(null);
      setError(null);
      setFreshIds([]);
      // Cheap synchronous reset; the boundary already did the reliable wipe.
      void resetPersistentStores();
      // Re-check ONLY the provider credential that Generate spends.
      void (async () => {
        try {
          const [ready, owner] = await Promise.all([
            hasPlatformCredentials(provider), hasPlatformCredentials("local"),
          ]);
          setKeyConfigured(ready);
          setOwnerConnected(owner);
        } catch {
          setKeyConfigured(false);
          setOwnerConnected(false);
        }
      })();
    });
  }, [provider]);

  /* Subscribe to the IDENTITY-LOGOUT signal — from THIS tab (a second
     subscriber) and from every OTHER same-origin tab. A provider-key change is
     NOT an identity change and MUST NOT reach here; this is the separate sign-out
     boundary the credential effect above deliberately ignores.

     THE DEFECT THIS CLOSES: a native sign-out in tab A (the /auth/logout form
     POST that clears the shared cookie) left a SECOND mounted, visible tab B
     still rendering its own already-loaded private history, media and prompt
     until its OWN focus/visibility re-validation happened to fire — which does
     not happen while tab B simply sits in the foreground.

     RECEIVER DISCIPLINE (fail closed, SYNCHRONOUS): the handler does everything
     sensitive in the SAME tick, BEFORE any await, so a late callback cannot
     repaint old content during the pending logout:
       1. set the quarantine latch + hide every private surface;
       2. invalidate THIS tab's own identity sequence so an in-flight cycle
          cannot commit, and bump the scope epoch synchronously (stops watches,
          drops sensitive localStorage keys);
       3. reset the sensitive zustand stores synchronously;
       4. only THEN run the awaited, ordered record removal on the shared chain.

     The sender's own synchronous quarantine is NOT re-entered: `signOut` sets
     `logoutNotifyGuardRef` around its notify, so this handler no-ops for the
     sender's own echo while a genuine cross-tab receipt still runs it. A signal
     that arrives while the latch is already set is idempotent — the second call
     re-hides (cheap) and re-queues the same ordered removal (the epoch guard on
     the shared chain makes a superseded removal a no-op).

     The latch is CLEARED only by a settled identity cycle for a NEW distinct
     principal or a verified anonymous session (see `runIdentityCycle`), so a
     same-principal re-validation of the identity that just signed out cannot
     reveal it again. */
  useEffect(() => {
    return onIdentityLogout(() => {
      // Sender echo: signOut already ran its own synchronous quarantine.
      if (logoutNotifyGuardRef.current) return;
      // Capture the key being quarantined BEFORE it can be nulled. `changed`
      // compares against `identityKeyRef`, which the sender nulls after a
      // successful wipe — so capture the ref value at quarantine time; a
      // same-principal re-validation must not read null and look "new".
      if (!logoutQuarantineRef.current) {
        quarantinedKeyRef.current = identityKeyRef.current;
      }
      // Idempotent: a repeat signal re-hides and re-queues without harm.
      logoutQuarantineRef.current = true;
      // FAIL CLOSED SETUP: mark the cleanup as IN PROGRESS synchronously, so a
      // focus re-validation that races this removal cannot reveal the old
      // account, and a FAILED removal stays blocked for the next settled cycle.
      cleanupBlockedRef.current = true;
      setCleanupBlocked(true);
      // 1. Hide + reset sensitive in-memory surfaces NOW (before any await).
      setVerified(false);
      setIdentityReady(false);
      setHistoryHydrated(false);
      setHistory([]);
      setRuns([]);
      setDeleted(null);
      setSelected([]);
      setViewerId(null);
      setError(null);
      setFreshIds([]);
      setIdentityError(null);
      // 2. Cancel any in-flight identity cycle for THIS tab and CAPTURE this
      //    receiver's own sequence number, so a later continuation (success OR
      //    failure) can detect that a NEWER cycle has since claimed the slot and
      //    must not touch cleanupBlockedRef or raise a stale error.
      const recvSeq = ++identitySeq.current;
      // 3. Awaited, ordered FULL record removal through the SAME guarded path a
      //    local cycle uses: `applyScopeChange` runs the SYNCHRONOUS epoch bump /
      //    stopWatching / key removal FIRST, awaits the store reset, guards the
      //    epoch before AND inside the shared queue, and RETURNS the removal
      //    result so a failure can be detected rather than swallowed.
      void (async () => {
        try {
          const result = await applyScopeChange(undefined);
          // STALE GUARD: a newer identity cycle (a real B sign-in, or another
          // signal) may have claimed the sequence slot while this removal ran.
          // This continuation is then stale and must change nothing.
          if (recvSeq !== identitySeq.current) return;
          // A stale (superseded) capture returns recordRemoved:false with error
          // "superseded" — a NEWER cycle's win, not this one's failure.
          if (result.error === "superseded") return;
          if (result.error || !result.recordRemoved) {
            // Leave the block set; the next settled cycle retries a FULL wipe.
            setIdentityError("The previous library could not be fully cleared on this device.");
            return;
          }
          // The wipe succeeded and this receiver still owns the cycle: clear the
          // block. A last-writer race cannot wipe the NEW scope's row — the epoch
          // guard inside `applyScopeChange` already refused that.
          cleanupBlockedRef.current = false;
          setCleanupBlocked(false);
        } catch (caught) {
          // STALE GUARD: only report the failure if this receiver still owns the
          // sequence slot; a newer cycle must not inherit a stale error.
          if (recvSeq !== identitySeq.current) return;
          // A throw is a FAILED removal: stay blocked, stay hidden, report it.
          setIdentityError(
            caught instanceof Error
              ? `The previous library could not be cleared: ${caught.message}`
              : "The previous library could not be fully cleared on this device.",
          );
        }
      })();
    });
  }, [applyScopeChange]);

  /* The model picker can cross surfaces, so the scope follows it — unless the
     visitor parked on a scope that spans both. */
  useEffect(() => {
    setView((current) => (CROSS_VIEWS.has(current) ? current : surface));
  }, [surface]);

  /* Startup identity cycle: run once. It fetches /api/identity, applies a fresh
     scope wipe for the verified principal, then releases the history load. */
  useEffect(() => {
    void runIdentityCycle({ apply: true, reason: "startup" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* While hidden, re-check the account when the tab becomes visible again and
     when the account refreshes. A shared browser can have its account switched
     in another context while this tab sleeps; the cycle re-fetches, and if the
     principal changed it applies a fresh scope wipe BEFORE reloading. */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void runIdentityCycle({ apply: true, reason: "visibility" });
    };
    const onAccountRefresh = () => {
      void runIdentityCycle({ apply: true, reason: "accountrefreshed" });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onAccountRefresh);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onAccountRefresh);
    };
  }, [runIdentityCycle]);

  /* The provider credential that Generate spends, checked SEPARATELY from the
     signed-in account. This is the only effect a provider-key event re-runs. */
  useEffect(() => {
    if (!identityReady) return;
    let live = true;
    const startedAt = currentEpoch();
    void Promise.all([hasPlatformCredentials(provider), hasPlatformCredentials("local")])
      .then(([ready, owner]) => {
        if (live && epochCurrent(startedAt)) {
          setKeyConfigured(ready);
          setOwnerConnected(owner);
        }
      })
      .catch(() => {
        if (live && epochCurrent(startedAt)) {
          setKeyConfigured(false);
          setOwnerConnected(false);
        }
      });
    return () => {
      live = false;
    };
  }, [provider, identityReady, cycleNonce]);

  /* Load the run log for the VERIFIED principal, once the identity cycle has
     SETTLED (`identityReady`) — but this only ASKS for the read. The save and
     resume effects stay gated on `historyHydrated`, which THIS effect raises
     when the namespaced read actually completes, so a save cannot fire `[]`
     over a cache that is about to load. `cycleNonce` re-runs this effect on
     every settled cycle even when `identityReady` was already true. The read is
     keyed by the principal, so two accounts on one browser never read each
     other. In legacy (unconfigured identity) mode the pre-identity behaviour is
     retained: a current provider credential decides whether private history is
     shown. */
  useEffect(() => {
    if (!identityReady) return;
    let live = true;
    const startedAt = currentEpoch();
    // CONFIGURED anonymous: the identity layer IS on, but there is no verified
    // principal. This session must NOT read the generic `history.v1` key nor the
    // legacy localStorage copy (that key predates namespacing and belongs to no
    // account) — reading it here would attribute a stale browser-global log to
    // an anonymous visitor, and the save effect would then re-persist into it.
    // So the read and the save are both skipped: hydration is raised as an empty
    // settled scope so the save effect is a no-op rather than a generic write.
    const configuredAnonymous = !legacy && principal === undefined;
    void (async () => {
      if (configuredAnonymous) {
        if (live && epochCurrent(startedAt)) setHistoryHydrated(true);
        return;
      }
      if (legacy && !keyConfigured) {
        // Legacy mode with no current credential: show nothing private. The read
        // is settled (empty), so hydration may still be raised for a later save.
        if (live && epochCurrent(startedAt)) setHistoryHydrated(true);
        return;
      }
      try {
        const rows = await loadHistory(undefined, undefined, legacy ? undefined : principal);
        if (!live || !epochCurrent(startedAt)) return;
        // Commit the loaded rows AND raise hydration together, so the save
        // effect's first run always sees the hydrated cache, never an empty one.
        setHistory((current) => mergeHistory(rows, current));
      } catch {
        /* a denied store reads as empty */
      } finally {
        if (live && epochCurrent(startedAt)) setHistoryHydrated(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [identityReady, cycleNonce, legacy, principal, keyConfigured]);

  /* Persist the run log ONLY after the namespaced load has actually completed
     (`historyHydrated`). Gating on the identity DECISION alone (the old
     `historyLoaded`) let this effect run with an empty in-memory list before the
     load landed, overwriting the principal's own cache with `[]`. A CONFIGURED
     anonymous session skips the save entirely — it has no principal to key by,
     and writing the generic `history.v1` would let an anonymous visitor's runs
     leak into the browser-global log that a later account must never adopt. */
  useEffect(() => {
    if (!historyHydrated) return;
    if (!legacy && principal === undefined) return; // configured anonymous: no persistence
    void saveHistory(history, undefined, undefined, legacy ? undefined : principal);
  }, [historyHydrated, history, legacy, principal]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopWatching();
      for (const timer of freshTimers.current) clearTimeout(timer);
    };
  }, []);

  /* Each arrival blooms on its own clock: a batch lands over several seconds,
     and one shared timer would cut the last tile's entrance short. */
  const markFresh = useCallback((ids: string[]) => {
    setFreshIds((prev) => [...prev, ...ids]);
    freshTimers.current.push(
      window.setTimeout(
        () => setFreshIds((prev) => prev.filter((id) => !ids.includes(id))),
        900,
      ),
    );
  }, []);

  /* One watch per platform request, used both by Generate and by a reload that
     found running rows already in the log. */
  const resume = useCallback(
    async (requestId: string, draft: RunDraft, expected: number) => {
      // Capture the credential scope at the START. A poll that settles after a
      // logout belongs to the previous scope and must not write its history
      // back — `alive.current` covers unmount, not a credential change on a
      // mounted screen.
      const scopeEpoch = currentEpoch();
      // The PRINCIPAL is captured at operation START, with the epoch. A poll
      // that settles AFTER an account switch belongs to the previous scope and
      // must write to THAT principal's key, never the new one's.
      const scopePrincipal = legacy ? undefined : principal;
      try {
        const status = await watchRequest(requestId, {
          deadline: draft.createdAt + POLL_DEADLINE_MS,
        });
        if (!alive.current || !epochCurrent(scopeEpoch)) return;
        const records = terminalRows(requestId, draft, status);
        setHistory((prev) => {
          const next = replaceRequest(prev, requestId, records);
          void saveHistory(next, undefined, undefined, scopePrincipal);
          return next;
        });
        markFresh(records.filter((record) => record.status === "completed").map((record) => record.id));
        if (records.some((record) => record.status === "failed")) {
          const failure = records[0]?.error ?? "the platform reported a failure";
          setError(
            (prev) =>
              prev ?? `Run not delivered — ${failure}. Adjust the prompt or settings and retry.`,
          );
        }
      } catch (caught) {
        if (!alive.current || !epochCurrent(scopeEpoch)) return;
        const message = describeError(caught, provider);
        if (message.includes("platform key")) setKeysOpen(true);
        setHistory((prev) => {
          const next = replaceRequest(prev, requestId, failedRows(requestId, expected, draft, message));
          void saveHistory(next, undefined, undefined, scopePrincipal);
          return next;
        });
        setError((prev) => prev ?? message);
      }
    },
    [markFresh, provider, legacy, principal],
  );

  /* After the log hydrates, pick up any request that was still on the platform
     when the last session died. Generate starts its own watch; this is the
     refresh path. Gated on ACTUAL hydration, not the identity decision. */
  useEffect(() => {
    if (!historyHydrated) return;
    const groups = new Map<string, RunRecord[]>();
    for (const record of historyRef.current) {
      if (record.status !== "running" || !record.requestId) continue;
      const rows = groups.get(record.requestId) ?? [];
      rows.push(record);
      groups.set(record.requestId, rows);
    }
    for (const [requestId, rows] of groups) {
      void resume(requestId, draftOf(rows[0]!), rows.length);
    }
  }, [historyHydrated, resume]);

  const visible = useMemo(() => {
    if (view === "assets") return history;
    if (view === "favorites") return history.filter((record) => record.favorite === true);
    return history.filter((record) => record.surface === view);
  }, [history, view]);

  const switchView = useCallback(
    (next: GalleryView) => {
      setView(next);
      galleryRef.current?.scrollTo({ top: 0 });
      if (CROSS_VIEWS.has(next) || next === surface) return;
      const first = MODELS.find((entry) => entry.surface === next);
      if (first) setModel(first.id);
    },
    [setModel, surface],
  );

  /* Presses do not wait on each other. A press snapshots its own plane, opens
     its own skeletons and keeps its own watch, so the composer is free the
     moment the tiles appear and any number of runs can be in flight. */
  const generate = useCallback(async () => {
    if (!keyConfigured) {
      if (provider === "local") {
        window.location.assign("/owner");
        return;
      }
      setKeysOpen(true);
      setError("Add your platform key to generate.");
      return;
    }
    const plane = assemblePlane();
    if (!plane.prompt.text.trim()) return;

    const entry = getModel(plane.model);
    const ratio = ratioToCss(
      plane.settings.aspectRatio,
      entry.surface === "image" ? "4 / 3" : "16 / 9",
    );
    const meta = metaOf(entry, plane.settings);
    const badge = entry.surface === "video" ? durationBadge(plane.settings) : undefined;

    /* Batch size resolves to results, not to requests. A model that carries its
       own count answers one request with that many media; every other model is
       submitted once per result. Either way the grid opens the same number of
       skeletons, and each request clears the ones it owns. */
    const native = countSetting(entry);
    const expected = native
      ? Math.max(1, Number(plane.settings[native.key]) || 1)
      : useActive.getState().batch;
    const startedAt = Date.now();
    const seq = ++press.current;
    const pending: ActiveRun[] = Array.from({ length: expected }, (_, index) => ({
      id: `pending-${seq}-${index}`,
      surface: entry.surface,
      modelLabel: entry.label,
      ratio,
      startedAt,
    }));
    const slots = native
      ? [{ skeletons: pending.map((slot) => slot.id) }]
      : pending.map((slot) => ({ skeletons: [slot.id] }));
    const draft: RunDraft = {
      surface: entry.surface,
      modelId: entry.id,
      modelLabel: entry.label,
      prompt: plane.prompt.text.trim(),
      ratio,
      meta,
      badge,
      settings: plane.settings,
      createdAt: startedAt,
    };

    setError(null);
    /* Newest press on top, above whatever is still rendering from the last. */
    setRuns((prev) => [...pending, ...prev]);
    galleryRef.current?.scrollTo({ top: 0, behavior: "smooth" });

    const runOne = async (slot: { skeletons: string[] }) => {
      // Capture the credential scope at the START of the submit. A submit that
      // was already in flight when the visitor logged out belongs to the
      // previous scope; its success path must not write history back. The
      // PRINCIPAL is captured with it, so a late result writes to the key it
      // began under, never a newer account's key.
      const scopeEpoch = currentEpoch();
      const scopePrincipal = legacy ? undefined : principal;
      try {
        const queued = await submitGeneration(plane);
        if (!alive.current || !epochCurrent(scopeEpoch)) return;
        setHistory((prev) => {
          const next = [...runningRows(queued.requestId, slot.skeletons.length, draft), ...prev];
          void saveHistory(next, undefined, undefined, scopePrincipal);
          return next;
        });
        setRuns((prev) => prev.filter((active) => !slot.skeletons.includes(active.id)));
        await resume(queued.requestId, draft, slot.skeletons.length);
      } catch (caught) {
        if (!alive.current || !epochCurrent(scopeEpoch)) return;
        const message = describeError(caught, provider);
        if (message.includes("platform key")) setKeysOpen(true);
        setError((prev) => prev ?? message);
      } finally {
        if (alive.current && epochCurrent(scopeEpoch)) {
          setRuns((prev) => prev.filter((active) => !slot.skeletons.includes(active.id)));
        }
      }
    };

    await Promise.all(slots.map(runOne));
  }, [keyConfigured, provider, resume, legacy, principal]);

  /* Reuse restores the whole plane the run was made from — model, its dials,
     then the words. A reuse that dropped the ratio and resolution would
     re-render a different picture from the same prompt. */
  const retry = useCallback(
    (record: RunRecord) => {
      if (MODELS.some((entry) => entry.id === record.modelId)) {
        setModel(record.modelId);
        if (record.settings) setSettings(record.modelId, record.settings);
      }
      (record.surface === "image" ? useImagePrompt : useVideoPrompt).getState().setText(record.prompt);
      setViewerId(null);
      setError(null);
      setFocusNonce((n) => n + 1);
    },
    [setModel, setSettings],
  );

  const toggleFavorite = useCallback((record: RunRecord) => {
    setHistory((prev) =>
      prev.map((entry) =>
        entry.id === record.id ? { ...entry, favorite: !entry.favorite } : entry,
      ),
    );
  }, []);

  const deleteRuns = useCallback((records: RunRecord[]) => {
    if (records.length === 0) return;
    const ids = new Set(records.map((record) => record.id));
    setHistory((prev) => prev.filter((entry) => !ids.has(entry.id)));
    setDeleted(records);
  }, []);

  const deleteRun = useCallback((record: RunRecord) => deleteRuns([record]), [deleteRuns]);

  /* History is newest-first by construction, so the restored runs drop back
     into their own places rather than onto the top of the grid. */
  const restoreDeleted = useCallback(() => {
    if (!deleted) return;
    setHistory((prev) => {
      const here = new Set(prev.map((entry) => entry.id));
      const back = deleted.filter((entry) => !here.has(entry.id));
      if (back.length === 0) return prev;
      return [...prev, ...back].sort((a, b) => b.createdAt - a.createdAt);
    });
    setDeleted(null);
  }, [deleted]);

  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), UNDO_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleted(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [deleted]);

  /* ---------- picking runs ----------

     The grid is in selection mode whenever something is picked, so the mode has
     no switch of its own: the checkbox that appears on hover is the way in, and
     the toolbar's cross is the way out. */

  const pickedSet = useMemo(() => new Set(selected), [selected]);
  const byId = useMemo(() => new Map(history.map((record) => [record.id, record])), [history]);
  const pickedRecords = useMemo(
    () => selected.map((id) => byId.get(id)).filter((record) => record !== undefined),
    [selected, byId],
  );

  /* The range gesture walks the scope the visitor is looking at, and the walk
     happens inside the handler — reading it from a dependency would rebuild the
     callback on every history change and re-render all forty tiles with it. */
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  /* A run that left the grid cannot stay picked — deleted, aged out of the cap,
     or released from the shelf while the Favorites scope was the one on screen.
     The toolbar counts what the visitor can still see it acting on. */
  const visibleIds = useMemo(() => new Set(visible.map((record) => record.id)), [visible]);
  useEffect(() => {
    setSelected((prev) => {
      const next = prev.filter((id) => visibleIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [visibleIds]);

  /* Switching scope switches what "everything picked" means, so the selection
     does not travel with it. */
  useEffect(() => {
    setSelected([]);
    rangeAnchor.current = null;
  }, [view]);

  const clearPicked = useCallback(() => {
    setSelected([]);
    rangeAnchor.current = null;
  }, []);

  const togglePick = useCallback((id: string, index: number, range: boolean) => {
    const from = rangeAnchor.current;
    rangeAnchor.current = index;
    setSelected((prev) => {
      if (range && from !== null) {
        const span = visibleRef.current
          .slice(Math.min(from, index), Math.max(from, index) + 1)
          .filter((record) => record.status !== "running")
          .map((record) => record.id);
        const held = new Set(prev);
        return [...prev, ...span.filter((entry) => !held.has(entry))];
      }
      return prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id];
    });
  }, []);

  /* Escape leaves the selection the way it leaves every other transient layer
     in the studio. The viewer owns the key while it is open. */
  useEffect(() => {
    if (selected.length === 0 || viewerId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearPicked();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected.length, viewerId, clearPicked]);

  /* One keep for the whole selection: if every picked run is already kept the
     press releases them, which is what a pressed control has to mean. */
  const favoritePicked = useCallback(() => {
    const ids = new Set(selected);
    const keep = !pickedRecords.every((record) => record.favorite === true);
    setHistory((prev) =>
      prev.map((entry) => (ids.has(entry.id) ? { ...entry, favorite: keep } : entry)),
    );
  }, [selected, pickedRecords]);

  const deletePicked = useCallback(() => {
    deleteRuns(pickedRecords);
    clearPicked();
  }, [deleteRuns, pickedRecords, clearPicked]);

  /* One run, saved from its card. The refusal is reported through the strip the
     composer already reserves for it — a 32px button on a picture has no room
     to explain itself, and the viewer's own Download states what to do next. */
  const downloadRun = useCallback(async (record: RunRecord) => {
    const url = record.urls[0];
    if (!url) return;
    const ok = await saveFile(url, fileNameFor(record, 0));
    if (!ok) {
      setError(
        "The platform’s CDN refused the read, so this run could not be saved. Open it to save it from the browser instead.",
      );
    }
  }, []);

  /* Saved one at a time on purpose: browsers throttle a burst of downloads into
     a single "allow multiple files?" prompt and drop the rest, and a sequence is
     the only version that can report how far it got. */
  const downloadPicked = useCallback(async () => {
    const files = pickedRecords.filter((record) => record.urls[0]);
    if (files.length === 0) return;
    setSaving({ done: 0, total: files.length });
    let refused = 0;
    for (const [index, record] of files.entries()) {
      const ok = await saveFile(record.urls[0]!, fileNameFor(record, index));
      if (!ok) refused++;
      setSaving({ done: index + 1, total: files.length });
    }
    setSaving(null);
    if (refused > 0) {
      setError(
        refused === files.length
          ? "The platform’s CDN refused the read, so nothing could be saved. Open a run to save it from the browser instead."
          : `${refused} of ${files.length} files could not be saved — the platform’s CDN refused the read. Open those runs to save them from the browser.`,
      );
    }
  }, [pickedRecords]);

  /* An empty-gallery starter loads the composer and hands the visitor the
     caret; pressing Generate stays their call. */
  const applyStarter = useCallback(
    (text: string) => {
      (surface === "image" ? useImagePrompt : useVideoPrompt).getState().setText(text);
      setError(null);
      setFocusNonce((n) => n + 1);
    },
    [surface],
  );

  const openViewer = useCallback((id: string) => setViewerId(id), []);

  /* v0.02 FIX: SIGN IN used to call beginLogin(), which navigates to
     /auth/login - a Cloudflare Access route that 302s straight back to
     /studio. That is a dead loop: clicking SIGN IN appeared to do nothing and
     the owner key form at /owner was unreachable from the UI. The studio's own
     owner surface is /owner (route.ts readRoute -> "owner" -> OwnerAccess),
     so SIGN IN goes there. Identity-provider login remains available at its
     own entry point and is not what this button is for. */
  const signIn = useCallback(() => {
    window.location.assign("/owner");
  }, []);

  /* Sign out: (1) HIDE private surfaces and reset them SYNCHRONOUSLY first, so
     the previous account's private UI is not displayed during the awaited
     removal; (2) cancel callbacks by bumping the identity sequence so no
     in-flight cycle can commit; (3) run the synchronous epoch invalidation;
     (4) await the ordered history removal; (5) only on SUCCESS submit a native
     same-origin POST to /auth/logout. A cleanup failure is surfaced and the
     sensitive surfaces STAY hidden rather than a half-cleared session appearing
     signed out. Model presets/settings dials are preserved — only sensitive
     content is cleared. */
  const [signingOut, setSigningOut] = useState(false);
  const signOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    // Claim this sign-out's identity sequence slot and cancel any in-flight
    // cycle so a stale callback cannot commit, and so a NEWER cycle started
    // during the awaited wipe can supersede THIS logout's cookie-clearing POST.
    const seq = ++identitySeq.current;
    // 0. IDENTITY-LOGOUT QUARANTINE + CROSS-TAB SIGNAL, FIRST AND SYNCHRONOUS.
    //    Set this tab's own latch and emit the sign-out to every other
    //    same-origin tab BEFORE any await, so even a FAILED local cleanup still
    //    hides the second mounted tab (otherwise a failed logout would leave a
    //    second private tab visible until its own focus). A single signal is
    //    emitted IMMEDIATELY — never withheld until the wipe succeeds. The guard
    //    ref makes the receiver hook no-op for THIS tab's own local echo — the
    //    sender runs its quarantine directly, below, exactly once.
    logoutQuarantineRef.current = true;
    // Capture the key being quarantined BEFORE the successful sender wipe nulls
    // `identityKeyRef`, so a later same-principal re-validation cannot read null
    // and be mistaken for a genuinely new session (and re-reveal oldA).
    quarantinedKeyRef.current = identityKeyRef.current;
    logoutNotifyGuardRef.current = true;
    try {
      notifyIdentityLogout();
    } finally {
      logoutNotifyGuardRef.current = false;
    }
    // 1. Hide + reset sensitive in-memory surfaces NOW (before any await).
    setVerified(false);
    setIdentityReady(false);
    setHistoryHydrated(false);
    setHistory([]);
    setRuns([]);
    setDeleted(null);
    setSelected([]);
    setViewerId(null);
    setError(null);
    setFreshIds([]);
    // (identity sequence already claimed above; no second bump.)
    // FAIL CLOSED SETUP: mark the cleanup as IN PROGRESS before it starts. If the
    // wipe THROWS or its removal cannot be confirmed, the flag stays set, so a
    // later focus/visibility re-validation runs a FULL retry wipe and cannot
    // reveal the still-readable previous account's work.
    cleanupBlockedRef.current = true;
    setCleanupBlocked(true);
    // 3. Synchronous epoch invalidation + stopWatching, before the await.
    const scope = wipeClientState();
    try {
      await resetPersistentStores();
      // 4. Awaited, ordered FULL record removal. A logout passes NO preserve
      //    key: the previous account's own namespaced row must go too. THREE
      //    staleness guards bracketed around the removal: `alive` (unmounted),
      //    `seq` (a newer identity cycle), and `epochCurrent(scope)` (a provider
      //    credential boundary bumps the scope epoch WITHOUT touching
      //    identitySeq). A superseded logout must not delete a NEW scope's row
      //    nor submit the POST from an old cycle.
      if (!alive.current || seq !== identitySeq.current || !epochCurrent(scope)) return;
      const result = await runExclusive(() => {
        if (!alive.current || seq !== identitySeq.current || !epochCurrent(scope)) {
          return Promise.resolve<null>(null);
        }
        return completeScopeRemoval(scope);
      });
      // Superseded while queued or during the await: touch nothing (not the
      // block flag, not the POST) — the newer cycle owns it.
      if (!alive.current || result === null || seq !== identitySeq.current || !epochCurrent(scope)) {
        return;
      }
      if (result.error || !result.recordRemoved) {
        // The cleanup did NOT confirm. Stay blocked (flag already set) and do
        // NOT submit the logout form; the private surfaces remain hidden.
        setSigningOut(false);
        setIdentityError("Sign-out could not clear this browser's stored runs.");
        return;
      }
      // The wipe succeeded: the pending block is cleared, and the settled key is
      // forgotten so the NEXT cycle treats the cleared session as a fresh scope.
      cleanupBlockedRef.current = false;
      setCleanupBlocked(false);
      identityKeyRef.current = null;
      // 5. Only a confirmed clean wipe submits the native POST.
      endSession();
    } catch (caught) {
      // STALE GUARD: a newer cycle, a provider boundary, or an unmount must not
      // inherit a stale error or a stale signing-out state.
      if (!alive.current || seq !== identitySeq.current || !epochCurrent(scope)) return;
      // A THROW is a FAILED cleanup: stay blocked, stay hidden, report it. No
      // logout form is submitted.
      setSigningOut(false);
      setIdentityError(
        caught instanceof Error ? caught.message : "Sign-out failed.",
      );
    }
  }, [signingOut]);

  /* On the public studio, the local route has no visitor-facing key dialog:
     the owner connects at /owner, and everyone else is pointed to their own
     free provider. Only a real provider (RunPod/Higgsfield) opens a key modal. */
  const openKeys = useCallback(() => {
    if (provider === "local") {
      window.location.assign("/free-access");
      return;
    }
    setKeysOpen(true);
  }, [provider]);
  /* Applying a plan replaces the words in the composer the visitor is actually
     typing in, so what they generate is what they were shown. */
  const applyPlanPrompt = useCallback(
    (text: string) => {
      (surface === "image" ? useImagePromptStore : useVideoPromptStore).getState().setText(text);
      setError(null);
    },
    [surface],
  );
  const runGenerate = useCallback(() => void generate(), [generate]);
  const downloadSelection = useCallback(() => void downloadPicked(), [downloadPicked]);
  const dismissDeleted = useCallback(() => setDeleted(null), []);
  const viewerItem = viewerId
    ? (history.find((record) => record.id === viewerId && record.status !== "running") ?? null)
    : null;

  /* The walk follows the scope on screen, not the whole log: arrowing out of
     the viewer never lands on a run the grid behind it is not showing. At
     either end there is no neighbour to hand down, and the step goes quiet. */
  const viewable = useMemo(
    () => visible.filter((record) => record.status !== "running"),
    [visible],
  );
  const prevRun = viewerId ? stepRun(viewable, viewerId, -1) : null;
  const nextRun = viewerId ? stepRun(viewable, viewerId, 1) : null;

  const runsHere = useMemo(
    () => runs.filter((active) => view === "assets" || active.surface === view),
    [runs, view],
  );
  const busy = runs.length > 0 || history.some((record) => record.status === "running");

  return (
    <div className={`ohf ${fontClassName}`} style={{ "--ohf-grain": GRAIN_URI } as React.CSSProperties}>
      <div className="ohf-shell">
        <main className="ohf-main">
          {provider === 'local' && (
            <div className="ohf-local-strip">
              <RendererBadge connected={keyConfigured} />
              {!keyConfigured && (
                <p className="ohf-local-restricted" role="status">
                  The studio renderer is owner-restricted and is not open to visitors.
                  {" "}
                  <a className="ohf-local-free" href="/free-access">
                    Explore free provider signup options&nbsp;→
                  </a>
                </p>
              )}
            </div>
          )}
          <Topbar
            view={view}
            onView={switchView}
            busy={busy}
            keyConfigured={keyConfigured}
            local={provider === "local"}
            onKeys={openKeys}
            loginUrl={loginUrl}
            onLogin={signIn}
            onLogout={() => void signOut()}
            accountLabel={
              identity?.status === "authenticated" ? "Signed in" : "Sign in"
            }
            authenticated={identity?.status === "authenticated"}
            ownerConnected={ownerConnected}
          />

          {/* Private surfaces (history grid, viewer, composer, media) stay
              hidden until the identity cycle settles. A verified principal, a
              confirmed anonymous session, or a decided legacy mode all reveal
              them; an unresolved fetch or a reported failure keeps them hidden
              so a shared browser never shows the previous account's runs.
              The public world — navigation, gallery presets, model selection —
              is preserved throughout. */}
          {verified ? (
            <>
              {visible.length === 0 && runsHere.length === 0 && !CROSS_VIEWS.has(view) && <StudioWelcome />}
              <Gallery
                view={view}
                surface={surface}
                items={visible}
                runs={runsHere}
                freshIds={freshIds}
                picked={pickedSet}
                onOpen={openViewer}
                onPick={togglePick}
                onReuse={retry}
                onFavorite={toggleFavorite}
                onDownload={downloadRun}
                onDelete={deleteRun}
                onStarter={applyStarter}
                galleryRef={galleryRef}
              />

              <Composer
                surface={surface}
                model={model}
                generating={busy}
                error={error}
                focusNonce={focusNonce}
                history={history}
                selecting={selected.length > 0}
                selection={
                  <SelectionBar
                    records={pickedRecords}
                    saving={saving}
                    onDownload={downloadSelection}
                    onFavorite={favoritePicked}
                    onDelete={deletePicked}
                    onClose={clearPicked}
                  />
                }
                onError={setError}
                onGenerate={runGenerate}
                planControl={
                  <>
                    <PlanControl
                      surface={surface === "image" ? "image" : "video"}
                      prompt={activePromptText}
                      onApply={applyPlanPrompt}
                      onError={setError}
                    />
                    <Exaggerator surface={surface} />
                  </>
                }
                notice={
                  deleted && (
                    <UndoBar
                      records={deleted}
                      onUndo={restoreDeleted}
                      onDismiss={dismissDeleted}
                    />
                  )
                }
              />
            </>
          ) : (
            <div className="ohf-shell-lock" role="status" aria-live="polite">
              {identityError
                ? `Private library unavailable — ${identityError}`
                : "Verifying your account…"}
            </div>
          )}
        </main>

        {verified && viewerItem && (
          <Viewer
            item={viewerItem}
            onPrev={prevRun ? () => setViewerId(prevRun.id) : undefined}
            onNext={nextRun ? () => setViewerId(nextRun.id) : undefined}
            onClose={() => setViewerId(null)}
            onReuse={() => retry(viewerItem)}
            onFavorite={() => toggleFavorite(viewerItem)}
            /* The viewer is released along with the run, so undoing the
               delete restores it to the grid and not back over the studio. */
            onDelete={() => {
              setViewerId(null);
              deleteRun(viewerItem);
            }}
          />
        )}
        {keysOpen && provider !== 'local' && (
          <KeyModal
            key={provider}
            provider={provider}
            configured={keyConfigured}
            onClose={() => setKeysOpen(false)}
            onSaved={() => {
              /* Replacing a key IS a credential-scope change: the mutation
                 boundary (savePlatformCredentials) already performed the
                 awaited, reliable wipe and emitted the credential-change event
                 before this resolves, and the subscription above resets the
                 in-memory scope. This callback only reflects the key state. */
              setKeyConfigured(true);
              setKeysOpen(false);
              setError(null);
            }}
            onCleared={() => {
              /* clearPlatformCredentials ran the same boundary cleanup. */
              setKeyConfigured(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

/* Deletion's receipt, in the strip the composer already reserves for the
   generation error — the studio gains no second floating layer. The hairline
   drains across the bar so the window to change your mind is visible, not
   guessed at. */
function UndoBar({
  records,
  onUndo,
  onDismiss,
}: {
  records: RunRecord[];
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const one = records.length === 1 ? records[0] : null;
  /* The words name the run to the person who wrote them; the model does not —
     a grid made on one model reads back as the same label over and over. Runs
     submitted without a prompt keep the model as their only name. The verb
     leads so a long prompt loses its tail to the ellipsis, not the sentence. */
  const subject = one
    ? one.prompt
      ? `“${one.prompt}”`
      : `${one.modelLabel} run`
    : `${records.length} runs`;

  return (
    <div className="ohf-undo" role="status">
      <span
        className="ohf-undo-drain"
        style={{ animationDuration: `${UNDO_MS}ms` }}
        aria-hidden
      />
      <span className="ohf-undo-text">{`Deleted ${subject}`}</span>
      <button type="button" className="ohf-undo-act" onClick={onUndo}>
        <UndoIcon />
        Undo
      </button>
      <button
        type="button"
        className="ohf-icon-btn ohf-icon-btn--ghost"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
