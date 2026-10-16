# Witchcraft studio deployment

This working branch is a rebrand and spatial interface for the complete OpenHiggsfield model catalogue. The original upstream README and source history remain available. Model display names may change; provider identifiers must remain stable.

## Sites and archives

- `witchcraft.pics`: 2D studio.
- `witchcraft.video`: 3D world; its workshops use the same studio and generation API.
- `old.witchcraft.pics`: original Pages deployment behind the original edge worker.
- `old.witchcraft.video`: original video worker.

The archive services must stay separate from the new worker. Updating the original video worker would also change its archive and must be avoided.

## Build and local check

Install the locked dependencies with `npm ci`. Run `npm test` and `npm run build`. The build includes a TypeScript check and produces `dist/`. Use Wrangler local development for the API and R2 bindings. Set a private, random `SESSION_SECRET` of at least 32 characters in an ignored `.dev.vars` file.

The 3D bundle is loaded only for the world. WebGL starts after entry, caps pixel ratio at 1, pauses while a workshop is open or the page is hidden, and supports reduced motion. Local `?world=1&inspect=1` automatically pauses ten seconds after entry for a bounded visual inspection. This parameter does not enable automatic pausing on production hostnames.

## Production dependencies

The intended worker is `witchcraft-studio-v1`, configured in `wrangler.jsonc`. The media binding requires a distinct `witchcraft-studio-media` R2 bucket. Set a new server-side `SESSION_SECRET` with Wrangler's secret command. Do not deploy anyone's Higgsfield credentials as shared environment variables.

Visitors provide their own funded provider key. The worker verifies the key, encrypts it in a host-only, Secure, HttpOnly, SameSite=Strict cookie for 24 hours and forwards generation requests to the provider. A balance failure prevents generation even when authentication succeeds. The two domains have separate host-only credentials and separate browser storage.

The media bucket is private. The worker exposes uploaded media at unguessable HTTPS URLs so the model provider can retrieve it. File upload accepts approved media types up to 20 MB. Treat these URLs as shareable bearer links; do not present the media as private once a URL is shared. No automatic deletion policy is configured.

## Planned cutover and rollback

1. Confirm both archived sites and their source backup before changing routes.
2. Create the new R2 bucket, set the new session secret and deploy the new worker to a preview URL. Verify static assets, headers, credential handling, upload retrieval and generation against a funded test account.
3. Route only `witchcraft.pics/*` and `witchcraft.video/*` to the new worker. Do not change archive routes, the old worker's source, or the original Pages project.
4. Verify both apex domains and both archives in the browser after the route changes.
5. To roll back, restore the pictures apex route to `pbi-edge` and remove the new video apex route, allowing the existing original video custom-domain worker to serve again. Use the saved route inventory to verify IDs immediately before any change.

Production cutover has not been executed at this checkpoint. The two existing apex sites still serve their original versions.

## Attribution

OpenHiggsfield: https://github.com/wide-trace/open-higgsfield, by wide-trace. The README permits self-hosting and changing the studio; the checked revision contains no standalone license file. Higgsfield co-founder Alex Mashrabov is credited separately and is not asserted to be the repository author.

Huntress: Wilson / neilhancart, https://sketchfab.com/3d-models/huntress-19ceb83a896c4d668b0f30a6fc58d563, CC BY 4.0. The copied asset has repaired animation metadata and optimized textures/buffer storage. Original geometry, skeleton and animation samples are retained. The credits page identifies these modifications and links the license.
