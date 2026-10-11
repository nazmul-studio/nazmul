// Decides what to do with the outcome of `wrangler r2 bucket create <name>`.
//
// The deploy must never be blocked by images: if the bucket cannot be created, the site still deploys (without the
// MEDIA binding) and the Studio says image storage is not set up. Pure, so it can be tested without wrangler.

/**
 * @param {{ status: number | null, output: string }} result  exit status and combined stdout/stderr of the command
 * @returns {{ ok: boolean, created: boolean, hint?: string }}
 */
export function interpretBucketCreate({ status, output }) {
  const text = String(output ?? "");
  if (status === 0) return { ok: true, created: true };
  if (/already exists|already own|\b10004\b/i.test(text)) return { ok: true, created: false };
  if (/enable r2|r2 is not enabled|purchase r2|subscribe to r2|\b10042\b/i.test(text)) {
    return {
      ok: false,
      created: false,
      hint:
        "R2 is not enabled for this Cloudflare account. Open the Cloudflare dashboard → R2 and enable it " +
        "(a payment method may be requested; usage inside the free allowance is not charged), then deploy again.",
    };
  }
  if (/authenticat|unauthori[sz]ed|forbidden|permission|\b10000\b|\b10001\b|not logged in/i.test(text)) {
    return {
      ok: false,
      created: false,
      hint:
        "This login or API token cannot manage R2. Give the token the “Workers R2 Storage: Edit” permission " +
        "(or run `npx wrangler login` again), or create the bucket in the dashboard and deploy again.",
    };
  }
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean);
  return { ok: false, created: false, hint: firstLine ?? `wrangler exited with status ${status ?? "unknown"}.` };
}
