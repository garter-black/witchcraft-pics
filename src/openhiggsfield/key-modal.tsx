"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { clearPlatformCredentials, savePlatformCredentials } from "@/generation/actions";
import type {Provider} from '@/generation/catalog/types';

import { CloseIcon } from "./icons";

/* This modal only ever collects a visitor's own PAID provider key (RunPod,
   Higgsfield). The studio owner connection lives on its own /owner page, so no
   owner-key wording belongs here — a visitor must never be asked for the
   studio's owner credentials. */
const COPY:Record<Provider,{title:string;body:string;label:string}> = {
  local: {
    title: "Studio owner access",
    body: "The studio owner connection is handled privately on its own page. Visitors do not connect the studio renderer.",
    label: "Owner access key",
  },
  runpod: {
    title: "RunPod API key",
    body: "Connect your RunPod account with its rpa_ API key. Your key is encrypted for 24 hours. Creations use your own provider balance.",
    label: "API key",
  },
  higgsfield: {
    title: "Higgsfield API key",
    body: "Connect your Higgsfield account with its id:secret key. Your key is encrypted for 24 hours. Creations use your own provider balance.",
    label: "API key",
  },
};

export function KeyModal({
  provider,
  configured,
  onClose,
  onSaved,
  onCleared,
}: {
  provider: Provider;
  configured: boolean;
  onClose: () => void;
  onSaved: () => void;
  onCleared: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[provider] ?? COPY.higgsfield;

  useEffect(() => {
    ref.current?.showModal();
    panelRef.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await savePlatformCredentials({ api_key: apiKey },provider);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the key");
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    setBusy(true);
    setError(null);
    try {
      await clearPlatformCredentials(provider);
      setApiKey("");
      onCleared();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove the key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="ohf-keys-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div ref={panelRef} tabIndex={-1} className="ohf-dialog-panel ohf-keys-panel">
        <div className="ohf-keys-head">
          <div>
            <div id="ohf-keys-title" className="ohf-keys-title">
              {copy.title}
            </div>
            <p className="ohf-keys-copy">
              {copy.body} {configured ? (provider === "local" ? "Enter the owner key again to reconnect." : "Enter another key to replace it.") : ""}
            </p>
          </div>
          <button type="button" className="ohf-icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon size={13} />
          </button>
        </div>

        <form className="ohf-keys-form" onSubmit={(event) => void onSubmit(event)}>
          <label className="ohf-field">
            <div className="ohf-field-label">{copy.label}</div>
            <input
              className="ohf-input ohf-input--mono"
              name="api_key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>

          {error && (
            <div className="ohf-alert" role="alert">
              <span className="ohf-alert-text">{error}</span>
            </div>
          )}

          <div className="ohf-keys-actions">
            {configured && (
              <button type="button" className="ohf-btn-quiet" disabled={busy} onClick={() => void onClear()}>
                Remove key
              </button>
            )}
            <button type="submit" className="ohf-keys-save" disabled={busy || !apiKey.trim()}>
              {busy ? "Saving…" : configured ? (provider === "local" ? "Reconnect" : "Replace key") : "Save key"}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
