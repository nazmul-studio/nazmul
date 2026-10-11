// Request-body reading with a hard size cap that is enforced while streaming.

/**
 * Reads the whole body, or returns null if it is larger than `max` bytes. A client that omits or lies about
 * Content-Length cannot make the Worker buffer more than `max` (plus one chunk).
 */
export async function readBytesLimited(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}
