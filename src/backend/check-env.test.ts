import { it } from 'vitest';
it('checks globals', () => {
  console.log('Blob:', typeof Blob);
  console.log('Blob.prototype.stream:', typeof Blob.prototype.stream);
  console.log('ReadableStream:', typeof ReadableStream);
});
