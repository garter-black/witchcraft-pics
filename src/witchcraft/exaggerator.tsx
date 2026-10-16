"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ModelEntry, Surface as ModelSurface } from "@/generation/catalog";
import { parseSettings, getModel } from "@/generation/catalog";
import { useActive } from "@/generation/stores/active";
import { useImagePrompt, useVideoPrompt } from "@/generation/stores/prompt";
import { useSettings } from "@/generation/stores/settings";

import { enhanceFailureText, requestEnhance } from "./enhancer";
import type { EnhanceMode, Surface } from "./enhancer";
import { PRESETS, defaultPreset, isStale, presetsFor, undoApplies, type Captured, type Preset } from "./exaggerator-logic";
import "./exaggerator.css";

/* The pure state helpers live in exaggerator-logic.ts so they can be tested
   without this file's JSX/CSS imports; re-export them for existing callers. */
export { PRESETS, defaultPreset, isStale, presetsFor, undoApplies };
export type { Captured, Preset };

type Phase = "idle" | "loading" | "ready" | "error";

export function Exaggerator({ surface }: { surface: ModelSurface }) {
  /* `surface` arrives as the catalog's Surface union, which is already the
     enhancer's own Surface; the stores below are chosen by the same value. */
  return <ExaggeratorInner surface={surface as Surface} />;
}

/* Stable empty record: a selector that returns a fresh object on every snapshot
   makes useSyncExternalStore re-render forever. One shared constant never
   changes identity, so an unconfigured model reads as "no settings yet". */
const EMPTY_SETTINGS: Record<string, unknown> = Object.freeze({});

function ExaggeratorInner({ surface }: { surface: Surface }) {
  const modelId = useActive((state) => state.model);
  const prompt = (surface === "image" ? useImagePrompt : useVideoPrompt)((state) => state.text);
  const setText = (surface === "image" ? useImagePrompt : useVideoPrompt)((state) => state.setText);
  const model = getModel(modelId);
  /* Select the stable byModel object, then derive the fallback outside the
     selector — the fallback is never part of what the store compares. */
  const byModel = useSettings((state) => state.byModel);
  const settings = byModel[modelId] ?? EMPTY_SETTINGS;
  const duration = durationOf(model, settings);

  const [on, setOn] = useState(false);
  const [preset, setPreset] = useState<string>(() => defaultPreset(surface));
  const [phase, setPhase] = useState<Phase>("idle");
  const [enhanced, setEnhanced] = useState("");
  const [changes, setChanges] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  /* Monotonic request identity: only the newest request may touch the UI. */
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  /* The text Apply replaced, captured locally — the provider's echo is never
     trusted to restore the visitor's own whitespace. Held as a ref so Undo can
     survive a toggle change without a re-render depending on it. */
  const undoOriginal = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  /* A preset that no longer fits the surface falls back to the surface default. */
  useEffect(() => {
    if (!presetsFor(surface).some((entry) => entry.id === preset)) setPreset(defaultPreset(surface));
  }, [surface, preset]);

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    seq.current += 1;
  }, []);

  /* Toggling off, changing any input, or unmounting abandons the request and
     its preview — never the visitor's words. Toggle state is NOT in this list:
     flipping it must not throw away an applied enhancement's undo. */
  useEffect(() => {
    cancel();
    setPhase("idle");
    setEnhanced("");
    setChanges([]);
    setError(null);
    setCaptured(null);
  }, [surface, modelId, preset, duration, prompt, cancel]);

  /* Undo restores into the surface the text came from. A surface or model
     change retires it, so it can never drop words into a different plane by
     coincidence. */
  useEffect(() => {
    setApplied(null);
    undoOriginal.current = null;
  }, [surface, modelId]);

  const preview = useCallback(async () => {
    const words = prompt;
    if (!words.trim()) {
      setError("Write a prompt first, then preview an enhancement.");
      setPhase("error");
      return;
    }
    cancel();
    const ticket = seq.current;
    const controller = new AbortController();
    abort.current = controller;
    const snapshot: Captured = { original: words, surface, modelId, preset, duration };
    setPhase("loading");
    setError(null);
    const result = await requestEnhance(
      {
        prompt: words,
        surface,
        model: modelId,
        mode: "extra" as EnhanceMode,
        preset,
        ...(duration !== null ? { duration } : {}),
        ...(duration !== null ? { constraints: `clip_length_seconds=${duration}` } : {}),
      },
      { signal: controller.signal },
    );
    if (!mounted.current || ticket !== seq.current) return; // a stale promise must not paint
    if (!result.ok) {
      setPhase("error");
      setError(enhanceFailureText(result.reason));
      return;
    }
    setCaptured(snapshot);
    setEnhanced(result.prompt);
    setChanges(result.changes);
    setPhase("ready");
  }, [prompt, surface, modelId, preset, duration, cancel]);

  const apply = useCallback(() => {
    if (!captured || !enhanced) return;
    const now: Captured = { original: prompt, surface, modelId, preset, duration };
    if (isStale(captured, now)) return; // input moved under the preview
    setText(enhanced); // restores nothing but what the visitor sees
    setApplied(enhanced);
    setPhase("idle");
    setCaptured(null);
    setEnhanced("");
    setChanges([]);
  }, [captured, enhanced, prompt, surface, modelId, preset, duration, setText]);

  const discard = useCallback(() => {
    cancel();
    setPhase("idle");
    setCaptured(null);
    setEnhanced("");
    setChanges([]);
    setError(null);
  }, [cancel]);

  const undo = useCallback(() => {
    if (!undoApplies(applied, prompt)) return;
    const original = undoOriginal.current;
    if (original === null) return;
    setText(original);
    setApplied(null);
    undoOriginal.current = null;
  }, [applied, prompt, setText]);

  /* Reading the ref during render is fine here: the value only changes on Apply
     and Undo, both of which already re-render through state. */
  const stale = captured ? isStale(captured, { original: prompt, surface, modelId, preset, duration }) : false;
  const canUndo = undoApplies(applied, prompt) && undoOriginal.current !== null;
  const options = presetsFor(surface);

  return (
    <div className="ohf-exag" data-on={on}>
      <div className="ohf-exag-head">
        <label className="ohf-exag-toggle">
          <input
            type="checkbox"
            checked={on}
            onChange={(event) => {
              /* The toggle only governs whether the tool is shown. Turning it
                 off abandons a pending preview (via discard) but leaves an
                 already-applied prompt and its Undo intact. */
              const next = event.target.checked;
              setOn(next);
              if (!next) discard();
            }}
          />
          <span className="ohf-exag-name">Witchcraft Prompt Totally Extra Exaggerator</span>
        </label>
        {canUndo && (
          <button type="button" className="ohf-exag-undo" onClick={undo}>
            Undo
          </button>
        )}
      </div>

      {on && (
        <div className="ohf-exag-body">
          <div className="ohf-exag-controls">
            <label className="ohf-exag-field">
              <span>Preset</span>
              <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                {options.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ohf-exag-preview"
              onClick={() => void preview()}
              disabled={phase === "loading" || !prompt.trim()}
            >
              {phase === "loading" ? "Enhancing…" : "Preview enhancement"}
            </button>
          </div>

          {phase === "error" && error && (
            <p className="ohf-exag-error" role="alert">
              {error}
            </p>
          )}

          {phase === "ready" && (
            <div className="ohf-exag-panel" role="region" aria-label="Enhanced prompt preview">
              {stale && (
                <p className="ohf-exag-stale" role="status">
                  The prompt or settings changed since this preview — preview again to apply.
                </p>
              )}
              <p className="ohf-exag-text">{enhanced}</p>
              {changes.length > 0 && (
                <ul className="ohf-exag-changes">
                  {changes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
              <div className="ohf-exag-actions">
                <button
                  type="button"
                  className="ohf-exag-apply"
                  onClick={() => {
                    undoOriginal.current = captured?.original ?? null;
                    apply();
                  }}
                  disabled={stale}
                >
                  Apply
                </button>
                <button type="button" className="ohf-exag-discard" onClick={discard}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The video duration the run would use, when the model declares one. A range
    stores a number; an enum may declare numeric strings, so those convert. */
function durationOf(model: ModelEntry, values: Record<string, unknown>): number | null {
  const field = model.settings.duration;
  if (!field) return null;
  const parsed = parseSettings(model, values).duration;
  if (typeof parsed === "number") return parsed;
  if (typeof parsed === "string") {
    const n = Number(parsed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
