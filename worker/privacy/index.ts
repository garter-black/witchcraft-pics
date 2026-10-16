// worker/privacy/index.ts
// ============================================================================
// Live backend privacy seam. Wires the ACCEPTED per-person personal-library
// candidate (built into ./personal-library.bundle.mjs) into the studio worker.
//
// PROVENANCE (reproducible):
//   Source candidate: C:/Hecate-Umbra/work/witchcraft-privacy-repair-20261003/
//                     personal-library/candidate  (personal-finish MANIFEST,
//                     stage final-finish-freeze, 72/72 tests)
//   Bundle build (esbuild 0.28.2, already installed — no new dependency):
//     esbuild bundle-entry.mjs --bundle --format=esm --platform=browser \
//       --target=es2022 --legal-comments=eof --banner:js="…" --outfile=…
//     then append node_modules/jose/LICENSE.md (MIT, (c) 2018 Filip Skokan).
//   Bundle sha256 recorded in BUNDLE.md. jose 6.2.12 inlined; no absolute
//   filesystem import; no package/config change.
//
// TRUST: the bundle is the accepted candidate's own verified implementations of
// JWT verification, the p_<principal32>/ library, the hosted-ownership registry,
// the allowlisted mirror and the session/principal binding. This file adapts them
// to the live env shape and adds NO new crypto.
// ============================================================================

// @ts-expect-error — ESM bundle has no ambient .d.ts; the contract below is the review surface.
import * as core from "./personal-library.bundle.mjs";

export type PrincipalResult = {
  ok: true;
  principal: string;
  principalHex: string;
  segment: string; // 32-hex
  sub: string;
  issuer: string;
  exp: number;
  email?: string;
};
export type PrincipalDenial = { ok: false; reason: string; status?: number };

export type PrivacyEnv = {
  TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  MEDIA: unknown;
  MIRROR_ALLOWLIST?: string[] | string;
  ADMIN_RECOVERY_SUBJECT?: string;
};

const c = core as {
  verifyPrincipal: (
    token: string | null,
    env: { TEAM_DOMAIN?: string; ACCESS_AUD?: string },
    opts?: unknown,
  ) => Promise<PrincipalResult | PrincipalDenial>;
  accessAssertionFrom: (r: Request) => { token: string; source: "header" | "cookie" } | null;
  principalSegment: (issuer: string, sub: string) => Promise<string>;
  namespaceFor: (segment: string) => string;
  isLibraryKey: (k: unknown) => boolean;
  isLegacyKey: (k: unknown) => boolean;
  handleList: (m: unknown, s: string, u: URL, method?: string) => Promise<Response>;
  handleRead: (m: unknown, k: string, s: string, method?: string) => Promise<Response>;
  handleUpload: (m: unknown, s: string, r: Request) => Promise<Response>;
  handleDelete: (m: unknown, k: string, s: string) => Promise<Response>;
  libraryDenied: () => Response;
  methodNotAllowed: () => Response;
  jsonNoStore: (b: unknown, s?: number, e?: Record<string, string>, head?: boolean) => Response;
  registerRequest: (
    m: unknown,
    a: { requestId: string; subject: string; provider?: string; now?: number },
  ) => Promise<Record<string, unknown>>;
  partitionStatusIds: (
    m: unknown,
    ids: string[],
    s: string,
  ) => Promise<Array<{ requestId: string; allowed: boolean; reason: string; row?: Record<string, unknown> }>>;
  updateRegistryState: (m: unknown, id: string, p: Record<string, unknown>) => Promise<unknown>;
  resolveOutputUrl: (m: unknown, id: string, s: string) => Promise<{ url: string; contentType: string } | null>;
  mirrorOnce: (
    m: unknown,
    s: string,
    a: { upstreamUrl: string; contentType?: string; job: string },
    o?: { allowlist?: string[]; fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number },
  ) => Promise<{ ok: true; key: string; url: string; cached: boolean } | { ok: false; reason: string }>;
  sessionMatchesPrincipal: (env: unknown, s: string) => { ok: true } | { ok: false; reason: string };
  buildSessionEnvelope: (a: {
    principalSegment: string;
    provider: string;
    credential: unknown;
    issuedAt?: number;
  }) => Record<string, unknown>;
};

export const verifyPrincipal = c.verifyPrincipal;
export const accessAssertionFrom = c.accessAssertionFrom;
export const principalSegment = c.principalSegment;
export const namespaceFor = c.namespaceFor;
export const isLibraryKey = c.isLibraryKey;
export const isLegacyKey = c.isLegacyKey;
export const handleList = c.handleList;
export const handleRead = c.handleRead;
export const handleUpload = c.handleUpload;
export const handleDelete = c.handleDelete;
export const libraryDenied = c.libraryDenied;
export const methodNotAllowed = c.methodNotAllowed;
export const jsonNoStore = c.jsonNoStore;
export const registerRequest = c.registerRequest;
export const partitionStatusIds = c.partitionStatusIds;
export const updateRegistryState = c.updateRegistryState;
export const resolveOutputUrl = c.resolveOutputUrl;
export const mirrorOnce = c.mirrorOnce;
export const sessionMatchesPrincipal = c.sessionMatchesPrincipal;
export const buildSessionEnvelope = c.buildSessionEnvelope;

/** True only when the identity layer is configured. Absent => fail closed. */
export function identityConfigured(env: PrivacyEnv): boolean {
  return (
    typeof env.TEAM_DOMAIN === "string" &&
    env.TEAM_DOMAIN.trim().length > 0 &&
    typeof env.ACCESS_AUD === "string" &&
    env.ACCESS_AUD.trim().length > 0
  );
}

/** Normalize MIRROR_ALLOWLIST (array or CSV/space). Empty => mirror refuses. */
export function normalizeAllowlist(raw: string[] | string | undefined): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Resolve the caller's verified principal, or a ready-to-send denial.
 * FAIL CLOSED: unconfigured identity => 503; absent/invalid token => 401.
 */
export async function requirePrincipal(
  request: Request,
  env: PrivacyEnv,
): Promise<{ ok: true; principal: PrincipalResult } | { ok: false; response: Response }> {
  if (!identityConfigured(env)) {
    return { ok: false, response: jsonNoStore({ error: "Identity is not configured." }, 503) };
  }
  const extracted = accessAssertionFrom(request);
  const res = await verifyPrincipal(extracted ? extracted.token : null, env);
  if (res.ok) return { ok: true, principal: res };
  return { ok: false, response: jsonNoStore({ error: "Authentication required." }, 401) };
}

/** The `p_<principal32>` namespace for a verified principal result. */
export function segmentFor(principal: PrincipalResult): string {
  return namespaceFor(principal.segment);
}

/**
 * The `GET /api/identity` response — the frontend contract. Private,no-store,
 * no-spend. NEVER returns email, a raw JWT, a key, or a caller-supplied subject.
 * Missing config / absent / invalid token all resolve to unauthenticated.
 */
export type IdentityView = {
  configured: boolean;
  authenticated: boolean;
  principal?: string; // only when verified: p_<32hex>
  loginUrl: "/auth/login";
  logoutUrl: "/auth/logout";
};

export async function identityView(request: Request, env: PrivacyEnv): Promise<IdentityView> {
  const base: IdentityView = {
    configured: identityConfigured(env),
    authenticated: false,
    loginUrl: "/auth/login",
    logoutUrl: "/auth/logout",
  };
  if (!base.configured) return base;
  const extracted = accessAssertionFrom(request);
  const res = await verifyPrincipal(extracted ? extracted.token : null, env);
  if (!res.ok) return base;
  return { ...base, authenticated: true, principal: namespaceFor(res.segment) };
}
