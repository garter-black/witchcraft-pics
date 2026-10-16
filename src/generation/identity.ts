/* The frontend identity helper.

   EXACT backend contract (worker/privacy/index.ts `identityView`, exercised by
   tests/identity-privacy.test.ts and tests/account-chain-privacy.test.ts):
   GET /api/identity -> 200, private,no-store
     { configured: boolean, authenticated: boolean,
       principal?: "p_<32hex>", loginUrl: "/auth/login", logoutUrl: "/auth/logout" }

   WHAT THIS IS FOR: the studio hashes history by the VERIFIED principal so two
   Google accounts on one shared browser never read each other's runs. But the
   frontend must NEVER invent an identity it was not given:
     - an anonymous caller stays anonymous;
     - a failed/absent/forged endpoint answer is a FAILURE, not a principal;
     - a legacy/generic history is never adopted as belonging to a new account.
   The helper returns a small tagged result, so a caller must handle the failure
   case explicitly instead of defaulting to a fabricated identity. */

export type Identity =
  | { status: "anonymous" }
  | { status: "authenticated"; principal: string }
  | { status: "legacy" }
  | { status: "failure"; reason: string };

export type IdentityView = {
  configured: boolean;
  authenticated: boolean;
  principal?: string;
  loginUrl: "/auth/login";
  logoutUrl: "/auth/logout";
};

const PRINCIPAL = /^p_[0-9a-f]{32}$/;

function isIdentityView(value: unknown): value is IdentityView {
  if (value === null || typeof value !== "object") return false;
  const view = value as Partial<IdentityView>;
  return (
    typeof view.configured === "boolean" &&
    typeof view.authenticated === "boolean" &&
    (view.principal === undefined || typeof view.principal === "string") &&
    view.loginUrl === "/auth/login" &&
    view.logoutUrl === "/auth/logout"
  );
}

/** Read the exact /api/identity contract and reduce it to a tagged identity.

    A network error, a non-200, a body that is not the exact contract, an
    authenticated answer whose `configured` is not true, an authenticated answer
    whose `principal` is missing or is not the verified `p_<32hex>` shape, or an
    endpoint that claims a principal with no verified flag — EVERY one of these
    is a `failure`, never a fabricated authenticated principal. Only a
    well-formed, CONFIGURED, authenticated response with a verified principal
    reduces to `authenticated`.

    BOUNDED: the fetch is aborted after `timeoutMs` (default 8s) so a stalled
    identity endpoint cannot hold the private first paint indefinitely. The
    deadline covers the WHOLE exchange — headers AND body. A stalled response
    that returns headers immediately but never finishes its body must also be
    bounded, so the timer is NOT cleared after `fetch` resolves; it stays armed
    through `response.json()` and is only cleared once the body has been read
    and validated. A timeout is a `failure`, and a failure keeps private content
    hidden. */
export async function fetchIdentity(
  timeoutMs = 8000,
  onView?: (view: IdentityView) => void,
): Promise<Identity> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch("/api/identity", {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (caught) {
      return {
        status: "failure",
        reason: timedOut
          ? `identity endpoint timed out after ${timeoutMs}ms`
          : caught instanceof Error
            ? caught.message
            : String(caught),
      };
    }
    if (!response.ok) {
      return { status: "failure", reason: `identity endpoint answered ${response.status}` };
    }
    // The deadline is STILL armed here: reading/parsing the body is part of the
    // bounded exchange, so a stalled body aborts instead of hanging first paint.
    let view: unknown;
    try {
      view = await response.json();
    } catch (caught) {
      return {
        status: "failure",
        reason: timedOut
          ? `identity endpoint body timed out after ${timeoutMs}ms`
          : "identity endpoint returned a non-JSON body",
      };
    }
    if (!isIdentityView(view)) {
      return { status: "failure", reason: "identity endpoint returned an unexpected shape" };
    }
    // Hand the caller the raw, validated view so it can key the scope on the
    // EXACT configured/authenticated/principal triple without re-parsing.
    onView?.(view);
    // An inconsistent contract — a principal claimed by an UNCONFIGURED endpoint,
    // or `authenticated` with `configured:false` — is a broken answer, not an
    // identity to trust. Never invent a principal from it.
    if (view.authenticated && !view.configured) {
      return { status: "failure", reason: "identity endpoint reported authenticated while unconfigured" };
    }
    // UNCONFIGURED and not authenticated: the identity layer is off on this
    // backend. This is the explicit LEGACY mode — pre-identity behaviour is
    // retained and NO identity is fabricated.
    if (!view.configured) return { status: "legacy" };
    // Configured but not authenticated: a real, honest anonymous session.
    if (!view.authenticated) return { status: "anonymous" };
    // Authenticated: the principal MUST be the verified shape. An authenticated
    // answer with no (or a malformed) principal is a broken/failed contract, not
    // a claim to trust.
    if (typeof view.principal !== "string" || !PRINCIPAL.test(view.principal)) {
      return { status: "failure", reason: "identity endpoint returned an invalid principal" };
    }
    return { status: "authenticated", principal: view.principal };
  } finally {
    // Only now that headers AND body are resolved and validated is the deadline
    // released.
    clearTimeout(timer);
  }
}

/** The login redirect for an anonymous visitor. Fixed, same-origin. */
export const IDENTITY_LOGIN_URL = "/auth/login";
/** The logout endpoint. The client MUST run its own storage wipe BEFORE
    navigating here, so the previous account's private history is gone before
    the auth session is cleared. */
export const IDENTITY_LOGOUT_URL = "/auth/logout";

/** Begin the fixed same-origin login flow. Never appends a caller-supplied
    next/return target (that would be an open redirect). */
export function beginLogin(): void {
  window.location.assign(IDENTITY_LOGIN_URL);
}

/** The configured/authenticated/principal triple as a single scope key. Used to
    decide whether an identity cycle actually changed scope, so an unchanged
    account does not re-wipe. */
export function identityViewKey(view: IdentityView | null): string | null {
  if (!view) return null;
  return `${view.configured ? "c" : "u"}:${view.authenticated ? "a" : "n"}:${view.authenticated ? (view.principal ?? "?") : "-"}`;
}

/** The scope key for a reduced Identity. `legacy`, `anonymous` and an
    authenticated principal each map to a distinct key; a failure maps to null
    so the next cycle re-fetches. */
export function identityViewKeyFrom(identity: Identity): string | null {
  if (identity.status === "failure") return null;
  if (identity.status === "legacy") return "u:n:-";
  if (identity.status === "anonymous") return "c:n:-";
  return `c:a:${identity.principal}`;
}

/** End the session: submit a NATIVE same-origin POST form to /auth/logout. A
    GET must never clear sessions (a cross-site subresource or top-level
    navigation can trigger one), and the backend rejects a non-POST with 405.
    The form is appended to the document only for the submit and removed
    immediately; it carries NO credentials and NO request targets. */
export function endSession(): void {
  if (typeof document === "undefined") return;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = IDENTITY_LOGOUT_URL;
  // No body fields: nothing sensitive is placed in the DOM.
  document.body.appendChild(form);
  form.submit();
  form.remove();
}
