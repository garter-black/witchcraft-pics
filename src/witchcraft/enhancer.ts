/* The prompt enhancer's client half.

   Contract (shared with the runtime lane — it owns the server side):

     POST /api/enhance
       { prompt, surface:'image'|'video', model, mode:'standard'|'extra',
         preset?, duration?, constraints? }
     → { ok:true, prompt, originalPrompt, changes:[...], source }
     ← { ok:false, reason }

   No silent rewriting: a failure (401/404/timeout/network) returns the real
   reason and the untouched original. The client never appends filler and
   calls it an enhancement. */

export type Surface = "image" | "video";
export type EnhanceMode = "standard" | "extra";

export type EnhanceRequest = {
  prompt: string;
  surface: Surface;
  model: string;
  mode: EnhanceMode;
  preset?: string;
  duration?: number;
  constraints?: string;
};

export type EnhanceResult = {
  ok: boolean;
  /** The rewritten prompt on success; the untouched original otherwise. */
  prompt: string;
  originalPrompt: string;
  /** Short, human-readable notes on what changed. */
  changes: string[];
  /** Where the text came from: the service, or nothing when the call failed. */
  source: "service" | "none";
  reason?: string;
};

/* The server planner times out at 45s; sit just above it. */
const TIMEOUT_MS = 55_000;

export async function requestEnhance(
  body: EnhanceRequest,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<EnhanceResult> {
  const original = body.prompt;
  const fail = (reason: string): EnhanceResult => ({
    ok: false,
    prompt: original,
    originalPrompt: original,
    changes: [],
    source: "none",
    reason,
  });

  // A pre-aborted signal must never start a request.
  if (opts.signal?.aborted) return fail("aborted");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch("/api/enhance", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const value = (await response.json().catch(() => null)) as Partial<EnhanceResult> | null;
    if (!response.ok || value?.ok !== true || typeof value.prompt !== "string" || !value.prompt.trim()) {
      const reason =
        response.status === 404 || response.status === 405 || response.status === 501
          ? "unavailable"
          : response.status === 401 || response.status === 403
            ? "unauthorized"
            : value?.reason || `http-${response.status}`;
      return fail(reason);
    }
    return {
      ok: true,
      prompt: value.prompt,
      originalPrompt: value.originalPrompt ?? original,
      changes: Array.isArray(value.changes) ? value.changes : [],
      source: "service",
      reason: value.reason,
    };
  } catch (caught) {
    if (opts.signal?.aborted) return fail("aborted");
    return fail(caught instanceof Error && caught.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Human label for a failed attempt, used by the panel's error line. */
export function enhanceFailureText(reason?: string): string {
  switch (reason) {
    case "unavailable":
      return "The enhancer service is not available yet. Your prompt is unchanged.";
    case "unauthorized":
      return "The enhancer needs an owner session. Your prompt is unchanged.";
    case "timeout":
      return "The enhancer did not answer in time. Your prompt is unchanged.";
    case "network":
      return "The enhancer could not be reached. Your prompt is unchanged.";
    case "aborted":
      return "The request was cancelled. Your prompt is unchanged.";
    default:
      return reason?.startsWith("http-")
        ? "The enhancer reported an error. Your prompt is unchanged."
        : "The enhancer could not run. Your prompt is unchanged.";
  }
}
