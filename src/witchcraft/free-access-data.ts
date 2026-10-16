/* The free-access surface's data, in one place.

   Source: C:/Hecate-Umbra/work/witchcraft-access-20261002/FREE-OPTIONS.md
   (CORRECTED 2 Oct 2026). This file is the CONSERVATIVE subset: where the
   corrected research says a claim is unproven, the claim is not made here.

   Hard rules applied (root review):
   - No "the studio never stores a key" claim: the studio seals a visitor's
     provider credential into an encrypted ~24h cookie, so it DOES hold it for
     up to 24 hours. Nothing here says otherwise.
   - No provider is described as working in the studio: every entry is signup
     only, integration pending.
   - No free image/video/3D promise for Pollinations (its catalogue prices
     those models in Pollen; no $0 media model was confirmed).
   - Gemini: only free TEXT (and audio) capabilities are established; no free
     image or VIDEO generation is verified here. It is NOT claimed to be
     text-only, because a free audio tier exists.
   - Cloudflare Workers AI: on the Free plan the 10,000 daily Neurons simply
     STOP until the 00:00 UTC reset; on a Paid plan the same allowance is
     followed by BILLED overage. The two plans are described distinctly.
   - No "unlimited" / "no rate limit" headline.

   NO key value is ever listed here — a free tier is a personal, account-scoped
   secret. This file links out; it does not carry secrets. */

export type FreeOption = {
  /** Stable id, used as a React key and for tests. */
  id: string;
  /** Human name of the provider. */
  name: string;
  /** What the visitor could generate there, in plain words. */
  capabilities: string;
  /** The exact free offering, quoted from current official docs. */
  offer: string;
  /** The documented limits of the free tier. */
  limits: string;
  /** Whether a card/billing account is required as documented. */
  card: string;
  /** Where the visitor signs up and mints their own key. */
  signupUrl: string;
  /** Official documentation. */
  docsUrl: string;
  /** False for every option today: signup only, no studio integration yet. */
  supportedHere: boolean;
};

/* Ordered by usable media access, matching the research's own priority. */
export const FREE_OPTIONS: readonly FreeOption[] = [
  {
    id: "pollinations",
    name: "Pollinations",
    capabilities: "Image, video and 3D models exist, but the catalogue prices them in Pollen — no free image, video or 3D claim is made here.",
    offer: "Some models cost 0 Pollen; paid models draw down prepaid Pollen ($1 ≈ 1 Pollen).",
    limits: "Generation requires an API key; model listing is open. Account balance and fair-use still apply.",
    card: "Registration and a key are required for generation.",
    signupUrl: "https://enter.pollinations.ai/keys",
    docsUrl: "https://gen.pollinations.ai/docs",
    supportedHere: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    capabilities: "Free text models for prompts and shot planning; no free image or video model verified here.",
    offer: "Text models with a :free suffix cost $0.",
    limits: "20 requests/min and 50/day, rising to 1,000/day once 10 credits are purchased.",
    card: "No card needed to start.",
    signupUrl: "https://openrouter.ai",
    docsUrl: "https://openrouter.ai/docs/api-reference/limits",
    supportedHere: false,
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    capabilities: "Text generation, text-to-image, embeddings and speech.",
    offer: "On the Free plan, 10,000 Neurons per day are included; on a Paid plan the same daily allowance is included and further usage is billed as overage.",
    limits: "The daily allowance resets at 00:00 UTC. On the Free plan, work stops once 10,000 Neurons are used until the reset; on a Paid plan, usage beyond the allowance is billed as overage. Either way, a small margin.",
    card: "Free Workers plan needs no card; some models require the Paid plan.",
    signupUrl: "https://dash.cloudflare.com",
    docsUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    supportedHere: false,
  },
  {
    id: "gemini",
    name: "Google Gemini (AI Studio)",
    capabilities: "Free text models for prompts and shot planning; no free image or video model verified here.",
    offer: "Text models list “Free of charge” in the official free-tier pricing column.",
    limits:
      "Metered per project (RPM/TPM/RPD); exact free numbers are shown live in AI Studio. Free-tier content is used to improve Google’s products.",
    card: "Free tier needs no billing; a paid tier requires linking a billing account.",
    signupUrl: "https://aistudio.google.com/apikey",
    docsUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    supportedHere: false,
  },
] as const;

/* Providers the studio can already use today. These are existing lanes, not
   new free options, and their wording must not imply free credits. RunPod and
   Higgsfield are owner-funded paid routes; Local is the studio's own machine. */
export type SupportedLane = {
  id: string;
  name: string;
  wording: string;
  paid: boolean;
};

export const SUPPORTED_LANES: readonly SupportedLane[] = [
  {
    id: "local",
    name: "Studio renderer",
    wording: "The studio's own local renderer. It is owner-restricted — it is not open to visitors and is not a no-key option for the public.",
    paid: false,
  },
  {
    id: "runpod",
    name: "RunPod",
    wording:
      "Connect your own RunPod account and pay-per-use balance with a personal rpa_ key. A paid route — not a free credit, and not owner-funded for visitors.",
    paid: true,
  },
  {
    id: "higgsfield",
    name: "Higgsfield",
    wording:
      "Connect your own Higgsfield account with a personal id:secret key. A paid route — not a free credit, and not owner-funded for visitors.",
    paid: true,
  },
] as const;

/** Honesty caveats shown on the page, aligned with the corrected research. */
export const FREE_CAVEATS: readonly string[] = [
  "A free tier means a free account, not a shared key. Create your own account and mint your own key at the provider.",
  "None of these providers are wired into the studio yet — treat them as signup options pending integration.",
  "Only what each provider's own docs prove is claimed here; limits, model rosters and key rules change often.",
] as const;
