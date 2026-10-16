/* The private owner sign-in surface at /owner.

   This is the ONLY place the studio owner connects their own renderer. It is
   deliberately kept off the public nav and is not linked from the studio, the
   world, the gallery or /free-access. Reaching it means typing the URL.

   What this is and is not:
   - It is an owner-only connection form for the studio's own machine. It is NOT
     user/account media isolation; the separate media-access privacy gap is
     unrelated to this page and is not fixed by moving the control here.
   - Route obscurity is not authentication. The real check stays server-side:
     POST /api/credentials?provider=local compares the submitted key and refuses
     a wrong one. This page only collects the secret into a password input.
   - The key is never displayed, echoed, logged, or stored in this component
     beyond the request. The field is always empty on load.

   A visitor without the owner key should use /free-access instead.

   Crawler handling: the served document is a single index.html, so a server
   X-Robots-Tag per-path is not available on this static surface. Instead this
   component installs a real <meta name="robots"> lifecycle for the lifetime of
   the route: noindex,nofollow is injected on mount and removed on unmount, so
   the tag is present exactly while /owner is rendered and cannot leak onto the
   public studio. This is defence-in-depth for discovery, NOT authentication —
   the route is a dedicated sign-in page, not an auth boundary. */

import { useEffect, useState, type FormEvent } from "react";

import { connectStudioOwner } from "@/generation/actions";

/** Manage the document's robots meta for one surface. Creates a tagged tag and
    restores the previous content on cleanup, so the policy never outlives the
    route that asked for it. */
function useRobotsMeta(content: string) {
  useEffect(() => {
    const head = document.head;
    const existing = head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const prior = existing?.getAttribute("content") ?? null;
    const meta = existing ?? head.appendChild(document.createElement("meta"));
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", content);
    return () => {
      if (prior === null) meta.remove();
      else meta.setAttribute("content", prior);
    };
  }, [content]);
}

export function OwnerAccess() {
  const [ownerKey, setOwnerKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useRobotsMeta("noindex, nofollow");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!ownerKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await connectStudioOwner(ownerKey.trim());
      setOwnerKey("");
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That owner key was not accepted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wc-owner" aria-labelledby="wc-owner-title">
      <a className="wc-owner-back" href="/">
        ← BACK TO WITCHCRAFT
      </a>

      <div className="wc-owner-panel">
        <span className="wc-owner-eyebrow">OWNER ACCESS</span>
        <h1 id="wc-owner-title">Owner sign-in</h1>
        <p className="wc-owner-copy">
          This page connects the studio's own renderer. It is for the studio owner. Visitors do
          not need it — see{" "}
          <a className="wc-owner-inline-link" href="/free-access">
            free access
          </a>{" "}
          to explore provider signup options for your own account.
        </p>

        <form className="wc-owner-form" onSubmit={(event) => void onSubmit(event)}>
          <label className="wc-owner-field">
            <span className="wc-owner-label">Studio owner key</span>
            <input
              className="wc-owner-input"
              name="owner_key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={ownerKey}
              onChange={(event) => setOwnerKey(event.target.value)}
              placeholder="Paste the owner key"
              aria-describedby="wc-owner-hint"
            />
          </label>
          <p id="wc-owner-hint" className="wc-owner-hint">
            Use your studio owner key to start an owner session. The field is cleared after a
            successful connection.
          </p>

          {error && (
            <div className="wc-owner-alert" role="alert">
              {error}
            </div>
          )}
          {done && !error && (
            <div className="wc-owner-ok" role="status">
              Owner session connected. You can return to the{" "}
              <a className="wc-owner-inline-link" href="/">
                studio
              </a>
              .
            </div>
          )}

          <button className="wc-owner-submit" type="submit" disabled={busy || !ownerKey.trim()}>
            {busy ? "Connecting…" : "Connect the studio"}
          </button>
        </form>
      </div>
    </main>
  );
}
