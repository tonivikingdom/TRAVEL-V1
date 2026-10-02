import { randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { LocalFilesystemObjectStorage } from '../src/index.js';

vi.mock('node:fs/promises', { spy: true });

it('preserves the original upload error when partial cleanup fails and permits exact-key retry', async () => {
  const root = await filesystem.mkdtemp(
    join(tmpdir(), 'travel-storage-failed-cleanup-'),
  );
  const key = randomUUID();
  const storage = new LocalFilesystemObjectStorage(root);
  const remove = vi.mocked(filesystem.rm);
  try {
    remove.mockRejectedValueOnce(
      new Error('SYNTHETIC temporary cleanup unavailable'),
    );
    await expect(
      storage.put({
        objectKey: key,
        source: singleChunk(),
        declaredByteSize: 1,
        maxByteSize: 100,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect((await filesystem.stat(join(root, `.tmp-${key}`))).isFile()).toBe(
      true,
    );
    await storage.delete(key); // Same DB-owned key, no directory discovery.
    await expect(
      filesystem.stat(join(root, `.tmp-${key}`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    remove.mockRestore();
    await filesystem.rm(root, { recursive: true, force: true });
  }
});

async function* singleChunk() {
  yield Buffer.from('SYNTHETIC mismatch');
}
