"use client";

import { useCallback, useEffect, useState } from "react";

import {
  fetchRendererState,
  hasPlatformCredentials,
  requestPlan,
  type RendererState,
} from "@/generation/actions";

/* ---------- renderer presence ---------- */

export function RendererBadge({ connected }: { connected: boolean }) {
  const [state, setState] = useState<RendererState | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      fetchRendererState()
        .then((next) => {
          if (live) setState(next);
        })
        .catch(() => {
          if (live) setState(null);
        });
    void read();
    // A renderer that is mid-render must not be declared offline between beats.
    const timer = window.setInterval(read, 20000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const online = state?.renderer?.online === true;
  const busy = state?.renderer?.detail?.busy === true;
  const elapsed = Number(state?.renderer?.detail?.elapsedSeconds ?? 0) || 0;
  const label = !state
    ? "Studio renderer — checking"
    : online
      ? busy
        ? `Studio renderer online — rendering${elapsed ? `, ${Math.round(elapsed / 60)}m` : ""}`
        : "Studio renderer online"
      : "Studio renderer offline";
  return (
    <span
      className="ohf-renderer-badge"
      data-state={online ? (busy ? "busy" : "online") : "offline"}
      role="status"
      title={connected ? undefined : "The studio renderer is owner-restricted and is not open to visitors."}
    >
      <span className="ohf-renderer-dot" aria-hidden />
      {label}
    </span>
  );
}

/* ---------- owner connect ----------

   The owner connection form was moved to its own private /owner surface
   (src/witchcraft/owner-access.tsx). The public studio no longer renders any
   owner-key field: a visitor cannot be asked for the studio's credentials, and
   an owner reaches their sign-in only by typing /owner. */

/* ---------- prompt and shot planning ---------- */

export function PlanControl({
  surface,
  prompt,
  onApply,
  onError,
}: {
  surface: "image" | "video";
  prompt: string;
  onApply: (prompt: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const improve = useCallback(async () => {
    if (!prompt.trim()) {
      onError("Write a prompt first, then improve it.");
      return;
    }
    setBusy(true);
    try {
      const reply = await requestPlan({
        prompt: prompt.trim(),
        surface,
        ...(surface === "video" ? { seconds: 4 } : {}),
      });
      if (!reply.ok) {
        onError(reply.reason ?? "The planner is not answering right now.");
        return;
      }
      const plan = reply.plan;
      if (!plan?.prompt) {
        onError("The planner did not return a usable plan.");
        return;
      }
      onApply(plan.prompt);
      setShot(plan.shots[0] ? `${plan.shots[0].description} — ${plan.shots[0].motion}` : null);
      setOpen(true);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "The planner could not be reached.");
    } finally {
      setBusy(false);
    }
  }, [prompt, surface, onApply, onError]);

  return (
    <div className="ohf-plan">
      <button type="button" className="ohf-btn-quiet" onClick={() => void improve()} disabled={busy}>
        {busy ? "Planning…" : "Improve prompt & shot plan"}
      </button>
      {open && shot && (
        <p className="ohf-plan-shot" role="status">
          Shot plan: {shot}
        </p>
      )}
    </div>
  );
}

export { hasPlatformCredentials };
