export function interpretBucketCreate(result: { status: number | null; output: string }): { ok: boolean; created: boolean; hint?: string };
