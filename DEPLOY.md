# Deploying to Cloudflare (Workers)

The build targets a Cloudflare **Worker** (Nitro `cloudflare-module` preset, via `@lovable.dev/vite-tanstack-config`).

## Build and deploy commands (Cloudflare → Workers & Pages → Settings → Builds)

- Build command: `npm run build`
- Deploy command: `npm run deploy`  (runs `nitro deploy --prebuilt`; `package.json` has this script)

`wrangler.json` in the project root is merged by Nitro into the generated config. It pins the Worker name
(`nazmul-studio-nazmul`, must match the Worker in the dashboard) and the `CONTENT` KV binding.

## Admin setup

The Studio stays locked ("The studio is locked until the server is set up") until all three exist.

1. **KV namespace bound as `CONTENT`.** The binding name must be exactly `CONTENT`.
   Already set in `wrangler.json` (namespace id `d1bcffb4466d4b0ea15f760c264d3e80`).
   If the Studio still says `CONTENT (KV namespace binding)` is missing, add it in the dashboard:
   Worker → Settings → Bindings → Add → KV namespace → variable name `CONTENT`.
2. **Secret `ADMIN_PASSWORD`**: the Studio login password, at least 12 characters.
3. **Secret `SESSION_SECRET`**: a random string of at least 32 characters.

Add the two secrets in the dashboard: Worker → Settings → Variables and Secrets → type *Secret*.
Never commit them to the repository. Names are matched ignoring case, spaces, dashes and underscores,
but use the exact names above. Redeploy (or save, which creates a new version) after adding them.

## Image uploads (R2)  *optional*

Uploaded images are stored in an R2 bucket bound as `MEDIA` when one exists. Without it, images are kept in the
`CONTENT` KV namespace instead and still work; the Studio shows a notice and offers "Move to R2" once R2 is connected.

To connect R2: enable R2 in the Cloudflare dashboard, create a bucket, and bind it to the Worker as `MEDIA`
(Settings → Bindings → R2 bucket). A deploy token needs the "Workers R2 Storage: Edit" permission if the deploy
creates the bucket itself.

## Troubleshooting

- `Missing script: "deploy"`: the deploy command is `npm run deploy` but `package.json` lacks the script.
- Studio says a name is missing but you added it: check spelling; the Studio lists look-alike names it received.
- A new Worker appears instead of updating: the `name` in `wrangler.json` differs from the dashboard Worker name.
