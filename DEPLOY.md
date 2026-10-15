# Deploying to Cloudflare Workers

The site runs as a Cloudflare Worker. The public pages work without any setup. The **Studio** (`/studio`) stays locked
until the Worker has a KV namespace named `CONTENT` and two secrets.

## Admin setup

### 1. The KV namespace (`CONTENT`)

`wrangler.jsonc` already binds your KV namespace "personal" to the name `CONTENT`, so a normal deploy picks it up.
The binding name must be exactly `CONTENT`.

To use a different namespace: `npx wrangler kv namespace create CONTENT`, then put the `id` it prints into
`wrangler.jsonc`.

To bind it by hand instead (works immediately, no deploy needed): Cloudflare dashboard → **Workers & Pages** → your
Worker → **Settings** → **Bindings** → **Add** → **KV namespace** → variable name `CONTENT` → choose the namespace →
**Deploy**. Keep the same binding in `wrangler.jsonc` too: a binding that exists only in the dashboard may be replaced
the next time the Worker is deployed from the repository.

The Worker's `name` in `wrangler.jsonc` has to match the Worker's name in the dashboard, or a deploy from the repository
can be refused.

### 2. The two secrets

| Name | What it is | Minimum length |
| --- | --- | --- |
| `ADMIN_PASSWORD` | the password you type to sign in to the Studio | 12 characters |
| `SESSION_SECRET` | a long random value that signs the sign-in cookie | 32 characters |

Add them under **Settings → Variables and Secrets** (type **Secret**), or with
`npx wrangler secret put ADMIN_PASSWORD` and `npx wrangler secret put SESSION_SECRET`.
A good `SESSION_SECRET`: `openssl rand -base64 48`. The names must be exact; the locked Studio page tells you if it
received something that looks like a misspelling.

### 3. Check

Deploy, then open `/studio`. A password box instead of "The studio is locked until the server is set up" means it
works. If something is still missing, the page lists exactly what.

The same KV namespace holds the published content, the last 10 versions, sign-in sessions, the failed-login counter and
the visitor log (see `ADAPTIVE-QUALITY.md`). On Cloudflare's free plan KV allows a limited number of writes a day
(about 1,000, as far as I know; check your plan), shared by all of these.

## Image uploads (R2)

Optional. Without R2, uploaded images are kept in KV as a fallback (the Studio says so). R2 is better for images.

1. Cloudflare dashboard → **R2** → enable it if it is not enabled yet (a payment method may be requested; usage inside
   the free allowance is not charged).
2. `npx wrangler r2 bucket create book-weaver-media`
3. In `wrangler.jsonc`, remove the `//` marks from the `r2_buckets` line (the comma goes on the line above it), then deploy.
4. Studio → **Media** → move existing images to R2 until it says nothing is left.

The binding name must be exactly `MEDIA`.
