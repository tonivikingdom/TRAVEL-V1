import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ObjectService,
  StoredObjectReconciliationService,
  DEFAULT_OBJECT_CLEANUP_CONFIG,
  type Actor,
} from '@travel/application';
import {
  createPrismaClient,
  PrismaStoredObjectRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import {
  LocalFilesystemObjectStorage,
  StorageError,
  type ObjectStorage,
} from '@travel/storage';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const INITIAL = new Date('2030-02-01T00:00:00Z');

describe('DB-authoritative stored-object reconciliation', () => {
  let managed: ManagedPrismaClient;
  let repository: PrismaStoredObjectRepository;
  let storage: LocalFilesystemObjectStorage;
  let root: string;
  let actor: Actor;
  let now: Date;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
    repository = new PrismaStoredObjectRepository(managed.client);
  });
  beforeEach(async () => {
    // Maintenance is Trip-independent. Isolate only the storage fixtures owned by this suite.
    await managed.client.storedObject.deleteMany();
    const email = `synthetic-reconciliation-${randomUUID()}@synthetic.example.test`;
    const user = await managed.client.user.create({
      data: { email, normalizedEmail: email },
    });
    actor = { userId: user.id, email, role: 'USER', status: 'ACTIVE' };
    root = await mkdtemp(join(tmpdir(), 'travel-storage-reconciliation-'));
    storage = new LocalFilesystemObjectStorage(root);
    now = new Date(INITIAL);
  });
  afterEach(async () => {
    await managed.client.storedObject.deleteMany({
      where: { ownerUserId: actor.userId },
    });
    await managed.client.user.delete({ where: { id: actor.userId } });
    await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    await managed.close();
  });

  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const reconcile = (provider: ObjectStorage = storage, batchSize = 25) =>
    new StoredObjectReconciliationService(
      repository,
      provider,
      { ...DEFAULT_OBJECT_CLEANUP_CONFIG, batchSize },
      () => now,
    ).reconcile();
  const claim = (limit = 25) =>
    repository.claimCleanupBatch({
      now,
      pendingBefore: new Date(now.getTime() - 1_800_000),
      leaseUntil: new Date(now.getTime() + 60_000),
      limit,
    });
  const read = (id: string) =>
    managed.client.storedObject.findUniqueOrThrow({ where: { id } });
  async function reserve(bytes = 10, maximum = 1_000, createdAt = now) {
    return repository.reserve({
      id: randomUUID(),
      ownerUserId: actor.userId,
      storageKey: randomUUID(),
      displayName: 'SYNTHETIC.txt',
      mediaType: 'text/plain',
      declaredByteSize: bytes,
      maxUserTotalBytes: maximum,
      now: createdAt,
    });
  }
  function objectService(provider: ObjectStorage = storage) {
    return new ObjectService(
      repository,
      provider,
      {
        maxFileBytes: 1_000,
        maxUserTotalBytes: 10_000,
        allowedMediaTypes: new Set(['text/plain']),
      },
      { now: () => now },
    );
  }
  async function physical(key: string) {
    await storage.put({
      objectKey: key,
      source: chunks('SYNTHETIC'),
      declaredByteSize: 9,
      maxByteSize: 100,
    });
  }
  function withDelete(remove: ObjectStorage['delete']): ObjectStorage {
    return {
      put: storage.put.bind(storage),
      open: storage.open.bind(storage),
      stat: storage.stat.bind(storage),
      exists: storage.exists.bind(storage),
      delete: remove,
    };
  }

  it('releases stale quota at claim before physical deletion; fresh PENDING and READY retain quota', async () => {
    const stale = await reserve(10, 20, new Date(now.getTime() - 1_800_000));
    const fresh = await reserve(5, 20);
    const ready = await reserve(5, 20);
    await repository.markReady({
      id: ready.id,
      byteSize: 5,
      sha256: 'a'.repeat(64),
      now,
    });
    await expect(reserve(1, 20)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    const claims = await claim();
    expect(claims.map((row) => row.id)).toEqual([stale.id]);
    expect(await read(stale.id)).toMatchObject({
      state: 'FAILED',
      storageDeletedAt: null,
      cleanupAttempts: 1,
    });
    await reserve(10, 20); // Release is independent of physical-delete success.
    await expect(reserve(1, 20)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect((await read(fresh.id)).state).toBe('PENDING');
    expect((await read(ready.id)).state).toBe('READY');
    await repository.markDeleted({
      id: fresh.id,
      ownerUserId: actor.userId,
      now,
    });
    await reserve(5, 20); // DELETED and FAILED consume no quota.
  });

  it('reclaims missing objects and exact orphan keys without touching fresh, READY or unknown files', async () => {
    const missing = await reserve(
      10,
      1_000,
      new Date(now.getTime() - 1_800_000),
    );
    const orphan = await reserve(
      10,
      1_000,
      new Date(now.getTime() - 1_800_001),
    );
    const fresh = await reserve();
    const ready = await reserve();
    await repository.markReady({
      id: ready.id,
      byteSize: 10,
      sha256: 'a'.repeat(64),
      now,
    });
    await physical(orphan.storageKey);
    await writeFile(
      join(root, `.tmp-${orphan.storageKey}`),
      'SYNTHETIC partial',
    );
    const unknown = randomUUID();
    await physical(unknown);
    expect(await reconcile()).toEqual({
      claimed: 2,
      cleaned: 2,
      failed: 0,
      fenced: 0,
    });
    for (const id of [missing.id, orphan.id])
      expect(await read(id)).toMatchObject({
        state: 'FAILED',
        storageDeletedAt: now,
        cleanupNextAttemptAt: null,
        cleanupLastErrorCode: null,
      });
    expect(await storage.exists(orphan.storageKey)).toBe(false);
    expect(await storage.exists(unknown)).toBe(true);
    expect((await read(fresh.id)).cleanupAttempts).toBe(0);
    expect((await read(ready.id)).cleanupAttempts).toBe(0);
    expect((await reconcile()).claimed).toBe(0);
  });

  it.each(['FAILED', 'DELETED'] as const)(
    'retries %s deletion failure with sanitized bounded backoff, continuing other candidates',
    async (state) => {
      const failed = await reserve();
      const other = await reserve();
      await physical(failed.storageKey);
      await managed.client.storedObject.update({
        where: { id: failed.id },
        data: {
          state,
          deletedAt: state === 'DELETED' ? now : null,
          cleanupAttempts: 30,
        },
      });
      await repository.markFailed(other.id);
      const provider = withDelete(async (key) => {
        if (key === failed.storageKey)
          throw new Error('SECRET /outside/credentials');
        await storage.delete(key);
      });
      expect(await reconcile(provider)).toEqual({
        claimed: 2,
        cleaned: 1,
        failed: 1,
        fenced: 0,
      });
      expect(await read(failed.id)).toMatchObject({
        state,
        storageDeletedAt: null,
        cleanupLastErrorCode: 'DELETE_FAILED',
        cleanupNextAttemptAt: new Date(now.getTime() + 3_600_000),
      });
      expect((await reconcile()).claimed).toBe(0);
      advance(3_600_000);
      expect((await reconcile()).cleaned).toBe(1);
      expect(await storage.exists(failed.storageKey)).toBe(false);
      expect((await read(failed.id)).cleanupLastErrorCode).toBeNull();
    },
  );

  it('recovers a crashed claim after lease expiry without permanent quota consumption', async () => {
    const row = await reserve(10, 10, new Date(now.getTime() - 1_800_000));
    await physical(row.storageKey);
    expect(await claim()).toHaveLength(1); // Simulate process exit before provider delete.
    expect((await reconcile()).claimed).toBe(0);
    await reserve(10, 10);
    advance(60_000);
    expect((await reconcile()).cleaned).toBe(1);
    expect(await read(row.id)).toMatchObject({
      state: 'FAILED',
      cleanupAttempts: 2,
      storageDeletedAt: now,
    });
  });

  it('recovers a crash after provider delete before DB completion through missing-object delete', async () => {
    const row = await reserve(10, 1_000, new Date(now.getTime() - 1_800_000));
    await physical(row.storageKey);
    const [claimed] = await claim();
    await storage.delete(claimed!.storageKey);
    advance(60_000);
    expect((await reconcile()).cleaned).toBe(1);
    expect((await read(row.id)).cleanupAttempts).toBe(2);
  });

  it('two workers claim disjoint bounded batches with deterministic attempts', async () => {
    const rows = await Promise.all(
      Array.from({ length: 6 }, () =>
        reserve(10, 1_000, new Date(now.getTime() - 1_800_000)),
      ),
    );
    const called: string[] = [];
    const started = deferred();
    const release = deferred();
    const provider = withDelete(async (key) => {
      called.push(key);
      if (called.length === 2) started.resolve();
      await release.promise;
      await storage.delete(key);
    });
    const a = reconcile(provider, 3);
    const b = reconcile(provider, 3);
    await started.promise;
    expect((await reconcile()).claimed).toBe(0);
    release.resolve();
    expect(await Promise.all([a, b])).toEqual(
      Array.from({ length: 2 }, () => ({
        claimed: 3,
        cleaned: 3,
        failed: 0,
        fenced: 0,
      })),
    );
    expect(new Set(called).size).toBe(6);
    for (const row of rows)
      expect((await read(row.id)).cleanupAttempts).toBe(1);
  });

  it('SKIP LOCKED skips an independently row-locked eligible record', async () => {
    const locked = await reserve(
      10,
      1_000,
      new Date(now.getTime() - 1_800_000),
    );
    const other = await reserve(10, 1_000, new Date(now.getTime() - 1_800_000));
    const started = deferred();
    const release = deferred();
    const transaction = managed.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "StoredObject" WHERE "id"=${locked.id}::uuid FOR UPDATE`;
      started.resolve();
      await release.promise;
    });
    await started.promise;
    try {
      expect((await claim()).map((row) => row.id)).toEqual([other.id]);
    } finally {
      release.resolve();
      await transaction;
    }
  });

  it('fences late success/failure after a newer claim completes, including incorrect owner/key', async () => {
    const row = await reserve(10, 1_000, new Date(now.getTime() - 1_800_000));
    const [a] = await claim();
    advance(60_000);
    const [b] = await claim();
    expect(b!.cleanupAttempts).toBe(2);
    expect(await repository.completeCleanup({ claim: b!, now })).toBe(true);
    const completed = await read(row.id);
    expect(
      await repository.completeCleanup({
        claim: a!,
        now: new Date(now.getTime() + 1),
      }),
    ).toBe(false);
    expect(
      await repository.failCleanup({
        claim: a!,
        retryAt: now,
        errorCode: 'DELETE_FAILED',
      }),
    ).toBe(false);
    expect(
      await repository.completeCleanup({
        claim: { ...b!, ownerUserId: randomUUID() },
        now,
      }),
    ).toBe(false);
    expect(
      await repository.completeCleanup({
        claim: { ...b!, storageKey: randomUUID() },
        now,
      }),
    ).toBe(false);
    expect(await read(row.id)).toEqual(completed);
  });

  it('late successful put cannot resurrect READY and reopens cleanup even after previous physical deletion', async () => {
    const started = deferred();
    const release = deferred();
    const provider: ObjectStorage = {
      ...withDelete(storage.delete.bind(storage)),
      put: async (input) => {
        started.resolve();
        await release.promise;
        return storage.put(input);
      },
    };
    const pending = objectService(provider).store(actor, {
      displayName: 'SYNTHETIC slow.txt',
      mediaType: 'text/plain',
      declaredByteSize: 9,
      source: chunks('SYNTHETIC'),
    });
    // Register rejection immediately to avoid unhandled-promise timing.
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await started.promise;
    const row = await managed.client.storedObject.findFirstOrThrow({
      where: { ownerUserId: actor.userId },
    });
    advance(1_800_000);
    expect((await reconcile()).cleaned).toBe(1);
    release.resolve();
    await rejected;
    expect(await read(row.id)).toMatchObject({
      state: 'FAILED',
      cleanupAttempts: 2,
      storageDeletedAt: now,
    });
    expect(await storage.exists(row.storageKey)).toBe(false);
  });

  it('preserves the upload error when immediate failure cleanup fails and Worker later retries', async () => {
    const provider: ObjectStorage = {
      ...withDelete(async () => {
        throw new Error('private delete failure');
      }),
      put: async (input) => {
        await physical(input.objectKey);
        throw new StorageError('SIZE_MISMATCH', 'SYNTHETIC mismatch');
      },
    };
    await expect(
      objectService(provider).store(actor, {
        displayName: 'SYNTHETIC fail.txt',
        mediaType: 'text/plain',
        declaredByteSize: 10,
        source: chunks('SYNTHETIC'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400 });
    const row = await managed.client.storedObject.findFirstOrThrow({
      where: { ownerUserId: actor.userId },
    });
    expect(row).toMatchObject({
      state: 'FAILED',
      storageDeletedAt: null,
      cleanupLastErrorCode: 'DELETE_FAILED',
    });
    advance(5_000);
    expect((await reconcile()).cleaned).toBe(1);
    expect(await storage.exists(row.storageKey)).toBe(false);
  });

  it('keeps explicit deletion logical and retryable after physical delete failure', async () => {
    const service = objectService();
    const row = await service.store(actor, {
      displayName: 'SYNTHETIC delete.txt',
      mediaType: 'text/plain',
      declaredByteSize: 9,
      source: chunks('SYNTHETIC'),
    });
    await expect(
      objectService(
        withDelete(async () => {
          throw new Error('SYNTHETIC unavailable');
        }),
      ).delete(actor, row.id),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', httpStatus: 503 });
    const deleted = await read(row.id);
    expect(deleted).toMatchObject({ state: 'DELETED', storageDeletedAt: null });
    await expect(service.retrieve(actor, row.id)).rejects.toMatchObject({
      code: 'OBJECT_NOT_READY',
    });
    advance(5_000);
    expect((await reconcile()).cleaned).toBe(1);
    expect((await read(row.id)).deletedAt).toEqual(deleted.deletedAt);
  });

  it('records synchronous cleanup success and never offers a READY object to cleanup', async () => {
    const service = objectService();
    const ready = await service.store(actor, {
      displayName: 'SYNTHETIC ready.txt',
      mediaType: 'text/plain',
      declaredByteSize: 9,
      source: chunks('SYNTHETIC'),
    });
    expect(
      await repository.claimObjectCleanup({
        id: ready.id,
        ownerUserId: actor.userId,
        leaseUntil: now,
      }),
    ).toBeNull();
    await service.delete(actor, ready.id);
    expect((await read(ready.id)).storageDeletedAt).toEqual(now);
    await expect(
      service.store(actor, {
        displayName: 'SYNTHETIC mismatch.txt',
        mediaType: 'text/plain',
        declaredByteSize: 1,
        source: chunks('SYNTHETIC'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(
      await managed.client.storedObject.findFirstOrThrow({
        where: { ownerUserId: actor.userId, state: 'FAILED' },
      }),
    ).toMatchObject({ storageDeletedAt: now });
  });

  it('keeps a failed DB completion retryable after physical deletion and cleans the next key', async () => {
    const first = await reserve();
    const second = await reserve();
    await repository.markFailed(first.id);
    await repository.markFailed(second.id);
    await physical(first.storageKey);
    const complete = repository.completeCleanup.bind(repository);
    repository.completeCleanup = async (input) => {
      if (input.claim.id === first.id)
        throw new Error('SYNTHETIC DB completion outage');
      return complete(input);
    };
    try {
      expect(await reconcile()).toEqual({
        claimed: 2,
        cleaned: 1,
        failed: 1,
        fenced: 0,
      });
      expect(await read(first.id)).toMatchObject({
        storageDeletedAt: null,
        cleanupLastErrorCode: 'PERSISTENCE_UNAVAILABLE',
      });
      expect(await storage.exists(first.storageKey)).toBe(false);
    } finally {
      repository.completeCleanup = complete;
    }
    advance(5_000);
    expect((await reconcile()).cleaned).toBe(1);
  });
});

async function* chunks(value: string) {
  yield Buffer.from(value);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
