/* The app's whole routing surface, in one place.

   Witchcraft is a single-page app with no router dependency: the served
   document is always index.html (the Worker's SPA fallback answers every
   unmatched path with it), so the only thing that decides which surface the
   visitor sees is location.pathname. These helpers keep that decision in one
   testable function instead of scattering string compares through the shell.

   Paths are Canonical:
     /            → the studio (witchcraft.pics) or the world (witchcraft.video)
     /prompts     → the prompt gallery
     /prompts/    → the same, normalised
     /credits     → the studio credits page
     /free-access → signup options for a visitor's own free provider account
     /owner       → the private owner sign-in surface
   An unknown path is treated as the studio, never as a 404 page — a mis-typed
   URL degrades to the home surface rather than a dead end. */

export type Route = "home" | "prompts" | "credits" | "free" | "owner";

/** Normalise a pathname: collapse slashes, drop the trailing one, lower-case.
    Trailing-slash folding is what makes `/prompts/` refresh behave. */
export function normalisePath(pathname: string): string {
  const clean = (pathname || "/").split("?")[0]!.split("#")[0]!.toLowerCase();
  const squashed = clean.replace(/\/{2,}/g, "/");
  if (squashed.length > 1 && squashed.endsWith("/")) return squashed.slice(0, -1);
  return squashed === "" ? "/" : squashed;
}

/** A cross-surface handoff for "use in studio": the prompt text, its surface,
    and the studio's agreed model. Carried on history state — never storage —
    so a browser that blocks storage cannot lose the handoff, and a reload
    simply drops it (the studio then opens on its last-used surface). */
export type StudioIntent = {
  surface: "image" | "video";
  model: string;
  text: string;
};

export function readIntent(state: unknown = typeof history !== "undefined" ? history.state : null): StudioIntent | null {
  const intent = (state as { studioIntent?: unknown } | null)?.studioIntent;
  if (!intent || typeof intent !== "object") return null;
  const candidate = intent as Partial<StudioIntent>;
  if (candidate.surface !== "image" && candidate.surface !== "video") return null;
  if (typeof candidate.model !== "string" || typeof candidate.text !== "string") return null;
  return { surface: candidate.surface, model: candidate.model, text: candidate.text };
}

/** Replace the current home state with the handoff, then render. `replace`
    keeps the gallery entry in history so Back returns to /prompts. */
export function openStudio(intent: StudioIntent): void {
  const next = ROUTE_PATHS.home + location.search;
  const here = location.pathname + location.search;
  /* pushState, not replaceState: the gallery entry must survive so the
     browser's Back button returns to /prompts rather than a dead frame. If the
     studio is already the current entry, there is nothing to push and the
     intent is written onto it in place. */
  if (next === here) history.replaceState({ studioIntent: intent }, "", next);
  else history.pushState({ studioIntent: intent }, "", next);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** Adopt a handoff at most once: returns the intent and strips `studioIntent`
    from the CURRENT history entry, so Back/Forward cannot replay a stale prompt
    over the visitor's later edits. The rest of the state — a chosen world —
    is kept. */
export function consumeIntent(): StudioIntent | null {
  const intent = readIntent(typeof history !== "undefined" ? history.state : null);
  if (!intent || typeof history === "undefined") return intent;
  const rest = (history.state && typeof history.state === "object") ? { ...history.state } : {};
  delete (rest as { studioIntent?: unknown }).studioIntent;
  const next = Object.keys(rest).length ? rest : null;
  if (next === null) history.replaceState(null, "", location.href);
  else history.replaceState(next, "", location.href);
  return intent;
}

export function readRoute(pathname: string = typeof location !== "undefined" ? location.pathname : "/"): Route {
  const path = normalisePath(pathname);
  if (path === "/prompts") return "prompts";
  if (path === "/credits") return "credits";
  if (path === "/free-access") return "free";
  if (path === "/owner") return "owner";
  return "home";
}

export const ROUTE_PATHS: Record<Route, string> = {
  home: "/",
  prompts: "/prompts",
  credits: "/credits",
  free: "/free-access",
  owner: "/owner",
};

/* Push a new history entry and render. Every in-app navigation goes through
   here so back/forward can never leave the app pointing at a surface the URL
   disagrees with. A no-op against the current URL avoids duplicate entries
   (pressing GALLERY twice must not stack two history frames). */
export function navigate(route: Route): void {
  const next = ROUTE_PATHS[route] + location.search;
  const here = location.pathname + location.search;
  if (next !== here) history.pushState({ route }, "", next);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** Subscribe to back/forward and every navigate() call. */
export function onRouteChange(listener: () => void): () => void {
  addEventListener("popstate", listener);
  return () => removeEventListener("popstate", listener);
}
