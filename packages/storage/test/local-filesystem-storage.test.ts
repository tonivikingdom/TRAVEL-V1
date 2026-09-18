import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalFilesystemObjectStorage, StorageError } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe('private local filesystem object storage', () => {
  it('streams an object through a temporary file and records integrity', async () => {
    const { root, storage } = await createStorage();
    const key = randomUUID();
    const result = await storage.put({
      objectKey: key,
      source: chunks('SYNTHETIC-', 'PRIVATE-OBJECT'),
      declaredByteSize: 24,
      maxByteSize: 100,
    });

    expect(result).toEqual({
      byteSize: 24,
      sha256:
        'd63e70bd03baa4ecfc1a9208dc555dcac7e44e93d592c402ee895358b946a798',
    });
    expect(await readFile(join(root, key), 'utf8')).toBe(
      'SYNTHETIC-PRIVATE-OBJECT',
    );
    expect(
      (await readdir(root)).filter((name) => name.startsWith('.tmp-')),
    ).toEqual([]);
  });

  it('rejects traversal, encoded traversal, and absolute paths', async () => {
    const { storage } = await createStorage();
    for (const key of [
      '../escape',
      '%2e%2e%2fescape',
      '/tmp/escape',
      'C:\\escape',
    ]) {
      await expect(storage.exists(key)).rejects.toMatchObject({
        code: 'INVALID_OBJECT_KEY',
      });
    }
  });

  it('rejects a symlink target instead of following it outside the root', async () => {
    const { root, storage } = await createStorage();
    const outside = await mkdtemp(join(tmpdir(), 'travel-v1-storage-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'SYNTHETIC_OUTSIDE', 'utf8');
    const key = randomUUID();
    await symlink(
      outside,
      join(root, key),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(storage.open(key)).rejects.toMatchObject({
      code: 'PATH_UNSAFE',
    });
    await expect(storage.delete(key)).rejects.toMatchObject({
      code: 'PATH_UNSAFE',
    });
  });

  it('cleans partial writes after size mismatch or overflow', async () => {
    const { root, storage } = await createStorage();
    await expect(
      storage.put({
        objectKey: randomUUID(),
        source: chunks('SYNTHETIC'),
        declaredByteSize: 1,
        maxByteSize: 100,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    await expect(
      storage.put({
        objectKey: randomUUID(),
        source: chunks('SYNTHETIC'),
        declaredByteSize: 4,
        maxByteSize: 4,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });
    expect(await readdir(root)).toEqual([]);
  });

  it('makes deletion idempotent and keeps missing objects unreadable', async () => {
    const { storage } = await createStorage();
    const key = randomUUID();
    await storage.put({
      objectKey: key,
      source: chunks('SYNTHETIC'),
      declaredByteSize: 9,
      maxByteSize: 100,
    });
    await storage.delete(key);
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.open(key)).rejects.toBeInstanceOf(StorageError);
  });
});

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), 'travel-v1-storage-test-'));
  roots.push(root);
  return { root, storage: new LocalFilesystemObjectStorage(root) };
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield Buffer.from(value, 'utf8');
  }
}
