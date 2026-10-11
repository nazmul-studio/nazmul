// Builds the app and deploys the Nitro output to Cloudflare Workers.
//
//   npm run deploy                                    build + deploy
//   node scripts/deploy-cloudflare.mjs --skip-build   deploy an existing build
//
// Settings live in cloudflare.json (workerName, kvNamespaceId, r2BucketName) and can be overridden with the
// WORKER_NAME, CONTENT_KV_ID and R2_BUCKET environment variables (R2_BUCKET= empty turns image storage off). For CI, set CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID; locally, run `npx wrangler login` once.
//
// The KV namespace is bound as CONTENT (the admin Studio stores published content there). The R2 bucket is
// created if needed and bound as MEDIA (uploaded images).
// Secrets (ADMIN_PASSWORD, SESSION_SECRET) are never in files: see DEPLOY.md.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { interpretBucketCreate } from "./r2-bucket.mjs";

const config = ".output/server/wrangler.json";
const shell = process.platform === "win32";

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const settings = existsSync("cloudflare.json") ? JSON.parse(readFileSync("cloudflare.json", "utf8")) : {};
const name = process.env.WORKER_NAME || settings.workerName || "nazmul-portfolio";
const kvId = (process.env.CONTENT_KV_ID || settings.kvNamespaceId || "").trim();
// An explicitly empty R2_BUCKET switches image storage off; unset falls back to cloudflare.json.
const bucket = (process.env.R2_BUCKET ?? settings.r2BucketName ?? "").trim();

if (!process.argv.includes("--skip-build")) run("npm", ["run", "build"]);

if (!existsSync(config)) {
  console.error(`\nMissing ${config} — the build did not produce a Cloudflare Worker config.`);
  if (existsSync(".output")) {
    console.error(`Contents of .output: ${readdirSync(".output").join(", ") || "(empty)"}`);
  }
  console.error("See DEPLOY.md → 'Troubleshooting'.");
  process.exit(1);
}

if (kvId) {
  const wrangler = JSON.parse(readFileSync(config, "utf8"));
  const others = (wrangler.kv_namespaces ?? []).filter((b) => b.binding !== "CONTENT");
  wrangler.kv_namespaces = [...others, { binding: "CONTENT", id: kvId }];
  writeFileSync(config, JSON.stringify(wrangler, null, 2));
  console.log(`Bound KV namespace ${kvId} as CONTENT.`);
} else {
  console.warn(
    "\n⚠️  No KV namespace id (cloudflare.json → kvNamespaceId). The site will deploy, but the Studio\n" +
      "   cannot publish changes until you create a namespace and set it. See DEPLOY.md → 'Admin setup'.\n",
  );
}

if (bucket) {
  // `bucket create` is idempotent for our purposes: "already exists" counts as success.
  const created = spawnSync("npx", ["--yes", "wrangler@4", "r2", "bucket", "create", bucket], { encoding: "utf8", shell });
  const output = `${created.stdout ?? ""}${created.stderr ?? ""}`;
  const outcome = interpretBucketCreate({ status: created.status, output });
  if (outcome.ok) {
    console.log(outcome.created ? `Created R2 bucket ${bucket}.` : `R2 bucket ${bucket} already exists.`);
    const wrangler = JSON.parse(readFileSync(config, "utf8"));
    const others = (wrangler.r2_buckets ?? []).filter((b) => b.binding !== "MEDIA");
    wrangler.r2_buckets = [...others, { binding: "MEDIA", bucket_name: bucket }];
    writeFileSync(config, JSON.stringify(wrangler, null, 2));
    console.log(`Bound R2 bucket ${bucket} as MEDIA.`);
  } else {
    console.warn(
      `\n⚠️  Image storage is NOT connected (R2 bucket "${bucket}").\n   ${outcome.hint}\n` +
        "   The site still deploys. Until R2 is connected, uploaded images are kept in the site's own backup storage (KV)\n   and the Studio says so; use Media → Move to R2 afterwards. See DEPLOY.md → 'Image uploads (R2)'.\n",
    );
  }
}

run("npx", ["--yes", "wrangler@4", "deploy", "--config", config, "--name", name]);
