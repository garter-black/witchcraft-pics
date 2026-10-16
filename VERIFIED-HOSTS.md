# VERIFIED-HOSTS.md — provider OUTPUT host evidence for MIRROR_ALLOWLIST

Scope: this file records which provider *output* hosts are supported by PRIMARY
public documentation or by an EXISTING committed non-customer fixture already in
this repository. It exists so the live `MIRROR_ALLOWLIST` is set from evidence,
never guessed, never a wildcard. **Nothing here was produced by contacting a
provider, reading a customer object, or spending money.**

The mirror (`worker/privacy/hosted-output.ts`, backed by the accepted
`mirrorOnce` in `personal-library.bundle.mjs`) fetches ONE canonical provider
output URL that the server recorded from the AUTHENTICATED provider status
response, and refuses any host not on the configured allowlist. An empty/absent
allowlist is an explicit fail-closed `unsupported` state — it never falls back to
the raw provider URL.

## What a "verified output host" means

A host is accepted here only when it is named either by a provider's official
documentation as the location of a completed output URL, or by a real captured
provider response shape already committed to this repo that is not customer data.
A provider's *API base* (where you submit and poll) is NOT evidence of the
*output* host — outputs are commonly served from a separate CDN/storage host.

## Higgsfield (provider: `higgsfield`)

Primary source read: `https://docs.higgsfield.ai/docs/api-reference/overview`
(retrieved 3 Oct 2026) and the model pages it indexes, e.g.
`https://docs.higgsfield.ai/docs/models/seedance-2/image-to-video`.

Established from primary docs:
- API base (submit/poll/cancel): `https://api.higgsfield.ai` — this matches the
  live config value `HF_API_BASE_URL` in `wrangler.jsonc` and `worker/runpod.ts`
  is unrelated. This is the API host, NOT an output host.
- The docs' completed-response example is `{ "video": { "url": "https://example.com/output.mp4" } }`
  — a PLACEHOLDER. The primary docs do **NOT** name a concrete output CDN host.

Conclusion: **the Higgsfield OUTPUT host is UNVERIFIED.** Do NOT set it from
guesswork. Before enabling Higgsfield output mirroring, the operator must obtain
the real output host from a live completed Higgsfield response (an authorized
generation) or from provider support, and record it here with its date.

## RunPod (provider: `runpod`)

Primary source read: `https://docs.runpod.io/reference/runpod-apis`
(retrieved 3 Oct 2026): a completed job's `output` "contains the URLs to the
cloud storage that will let you download each image." The docs confirm the shape
(`output[].image_url` / `output.image_url`, video via a URL string) but the API
reference example itself uses placeholder hosts (`https://job.results1`).

Existing committed NON-CUSTOMER fixture in this repo:
- `tests/runpod.test.ts:36` — a real captured RunPod `COMPLETED` shape:
  `output.result = "https://d2h7xmz5gqybh9.cloudfront.net/predictions/<id>/1.mp4"`
  → RunPod video/result outputs are served from a **CloudFront distribution** on
  `*.cloudfront.net` (the distribution subdomain is provider-side, not fixed).
- `tests/runpod.test.ts:38` — `mapRunpodStatus('wan-2-6-t2i', { output:{ image_url:"https://image.runpod.ai/result.png" }})`
  → RunPod image outputs are served from `image.runpod.ai`.

Conclusion from evidence:
- Image outputs: `image.runpod.ai` (exact host — verified by committed fixture).
- Video/result outputs: `*.cloudfront.net`. CloudFront is a shared CDN suffix
  across many sites, so allowlisting `.cloudfront.net` is broad. Prefer, where
  the operator can confirm it, the specific distribution host
  (`d2h7xmz5gqybh9.cloudfront.net`) over the whole suffix.

## Suggested MIRROR_ALLOWLIST (operator sets; helper invents nothing)

Evidence-backed candidates to place in `MIRROR_ALLOWLIST` (CSV/space), subject
to the operator's live confirmation:

```
image.runpod.ai
d2h7xmz5gqybh9.cloudfront.net
```

- `image.runpod.ai` — verified by the committed RunPod fixture.
- `d2h7xmz5gqybh9.cloudfront.net` — the specific CloudFront distribution seen in
  the committed RunPod fixture. Confirm it is stable for the account's endpoints
  before relying on it; the mirror revalidates every redirect hop against this
  allowlist, so an unexpected distribution host will simply fail closed.

**Do NOT add:** `api.higgsfield.ai` / `api.runpod.ai` (API hosts, not output
hosts), any wildcard (`*.cloudfront.net` only if the operator accepts the breadth
and understands it matches every site on CloudFront), `.com`/`.ai`/bare TLDs, or
any guessed Higgsfield CDN host.

## Explicitly unverified (do NOT set from assumption)

- Any Higgsfield output CDN host (docs use `example.com`).
- RunPod "S3/Backblaze" style outputs (`*.backblazeb2.com`, `*.s3.*.amazonaws.com`)
  appear in RunPod *tutorials* for user-configured buckets — these are NOT
  RunPod-managed output hosts and are account-specific; not allowlisted here.
- Any numeric/edge IP form of the above.

## Resource contract (PRIMARY Cloudflare docs, retrieved 3 Oct 2026)

- `https://developers.cloudflare.com/workers/platform/limits/` — Worker memory:
  **128 MB per isolate**; simultaneous outgoing connections: 6. Both apply here.
- `https://developers.cloudflare.com/r2/api/workers/workers-api-usage/` —
  "Workers have a memory limit of 128 MB per Worker and loading particularly
  large files into a Worker's memory multiple times may reach this limit …
  consider using Streams."
- The accepted candidate's `mirrorOnce` buffers chunks into an array plus a
  contiguous copy, so its **peak is ~2× the object size**. With a 128 MB isolate,
  a 32 MiB per-object cap gives a ~64 MiB peak for a single mirror, leaving
  headroom for the rest of the isolate. Hence the helper adopts
  `MAX_MIRROR_BYTES_HARD = 32 MiB` and mirrors at most 8 objects per batch,
  **sequentially** (never `Promise.all` over many ids), so buffers never multiply
  with batch size. This is a LIVE-path resource decision, distinct from the
  candidate's own 64 MiB constant which we do not change.

## What this file does NOT claim

- No live provider compatibility was tested (no generation, no real output URL
  was fetched).
- No customer/media object was read.
- No guarantee about provider-side retention or CDN privacy. Mirroring outputs
  into our own private R2 namespace does **not** delete the provider-hosted
  original, and does **not** stop someone who holds the SAME provider credential
  from using that provider directly. No upstream media deletion is authorized.
