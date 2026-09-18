import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ObjectService, type Actor } from '@travel/application';
import {
  createPrismaClient,
  PrismaStoredObjectRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import { LocalFilesystemObjectStorage } from '@travel/storage';
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
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P1B2 integration tests');
}

const NOW = new Date('2030-02-01T00:00:00.000Z');

describe('StoredObject metadata and local storage integration', () => {
  let managed: ManagedPrismaClient;
  let root: string;
  let service: ObjectService;
  let userA: Actor;
  let userB: Actor;
  let admin: Actor;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await managed.client.transportEdgeHistoryTimeValue.deleteMany();
    await managed.client.transportEdgeHistory.deleteMany();
    await managed.client.temporalValue.deleteMany();
    await managed.client.transportEdge.deleteMany();
    await managed.client.itineraryNode.deleteMany();
    await managed.client.dateOwnership.deleteMany();
    await managed.client.trip.deleteMany();
    await managed.client.place.deleteMany();
    await managed.client.storedObject.deleteMany();
    await managed.client.notificationEvent.deleteMany();
    await managed.client.session.deleteMany();
    await managed.client.userPreference.deleteMany();
    await managed.client.invitation.deleteMany();
    await managed.client.user.deleteMany();
    [userA, userB, admin] = await Promise.all([
      createActor(
        managed,
        'synthetic-storage-a@synthetic.example.test',
        'USER',
      ),
      createActor(
        managed,
        'synthetic-storage-b@synthetic.example.test',
        'USER',
      ),
      createActor(
        managed,
        'synthetic-storage-admin@synthetic.example.test',
        'ADMIN',
      ),
    ]);
    root = await mkdtemp(join(tmpdir(), 'travel-v1-storage-integration-'));
    service = createService(managed, root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await managed.close();
  });

  it('streams content, persists only metadata, and verifies integrity', async () => {
    const stored = await store(service, userA, 'SYNTHETIC_PRIVATE_OBJECT');
    expect(stored).toMatchObject({
      state: 'READY',
      mediaType: 'text/plain',
      byteSize: 24,
    });
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const retrieved = await service.retrieve(userA, stored.id);
    expect(await collect(retrieved.content)).toBe('SYNTHETIC_PRIVATE_OBJECT');

    const binaryColumns = await managed.client.$queryRaw<
      Array<{ column_name: string }>
    >`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'StoredObject'
        AND data_type = 'bytea'
    `;
    expect(binaryColumns).toEqual([]);
    const persistedMetadata =
      await managed.client.storedObject.findFirstOrThrow();
    expect(
      Object.values(persistedMetadata)
        .filter((value): value is string => typeof value === 'string')
        .join('\n'),
    ).not.toContain('SYNTHETIC_PRIVATE_OBJECT');
  });

  it('hides an owner object from other users and ADMIN', async () => {
    const stored = await store(service, userB, 'SYNTHETIC_OWNER_B');
    await expect(service.retrieve(userA, stored.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.retrieve(admin, stored.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.delete(userA, stored.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.delete(admin, stored.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const ownerResult = await service.retrieve(userB, stored.id);
    expect(await collect(ownerResult.content)).toBe('SYNTHETIC_OWNER_B');
  });

  it('fails size mismatches without leaving a READY or partial file', async () => {
    await expect(
      service.store(userA, {
        displayName: 'SYNTHETIC mismatch.txt',
        mediaType: 'text/plain',
        declaredByteSize: 1,
        source: chunks('SYNTHETIC_TOO_LONG'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await managed.client.storedObject.findFirstOrThrow()).state).toBe(
      'FAILED',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a stream failure and cleans the temporary file', async () => {
    await expect(
      service.store(userA, {
        displayName: 'SYNTHETIC partial.txt',
        mediaType: 'text/plain',
        declaredByteSize: 20,
        source: failingChunks(),
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect((await managed.client.storedObject.findFirstOrThrow()).state).toBe(
      'FAILED',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('enforces the media allowlist and single-file limit', async () => {
    await expect(
      service.store(userA, {
        displayName: 'SYNTHETIC blocked.exe',
        mediaType: 'application/x-msdownload',
        declaredByteSize: 1,
        source: chunks('x'),
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    const strict = createService(managed, root, {
      maxFileBytes: 3,
      maxUserTotalBytes: 100,
    });
    await expect(
      strict.store(userA, {
        displayName: 'SYNTHETIC too-large.txt',
        mediaType: 'text/plain',
        declaredByteSize: 4,
        source: chunks('four'),
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(await managed.client.storedObject.count()).toBe(0);
  });

  it('enforces per-user total quota', async () => {
    const strict = createService(managed, root, {
      maxFileBytes: 10,
      maxUserTotalBytes: 10,
    });
    await store(strict, userA, '123456');
    await expect(store(strict, userA, '12345')).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
  });

  it('serializes concurrent reservations so quota cannot be oversold', async () => {
    const strict = createService(managed, root, {
      maxFileBytes: 10,
      maxUserTotalBytes: 10,
    });
    const results = await Promise.allSettled([
      store(strict, userA, '123456'),
      store(strict, userA, 'abcdef'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await managed.client.storedObject.count({ where: { state: 'READY' } }),
    ).toBe(1);
  });

  it('keeps file and metadata readable across client and adapter recreation', async () => {
    const stored = await store(service, userA, 'SYNTHETIC_RESTART_OBJECT');
    const second = createPrismaClient(databaseUrl);
    try {
      const restarted = createService(second, root);
      const retrieved = await restarted.retrieve(userA, stored.id);
      expect(await collect(retrieved.content)).toBe('SYNTHETIC_RESTART_OBJECT');
      expect(retrieved.metadata.sha256).toBe(stored.sha256);
    } finally {
      await second.close();
    }
  });

  it('deletes idempotently and never reads a DELETED object', async () => {
    const stored = await store(service, userA, 'SYNTHETIC_DELETE_OBJECT');
    const first = await service.delete(userA, stored.id);
    const second = await service.delete(userA, stored.id);
    expect(first.state).toBe('DELETED');
    expect(second.deletedAt).toBe(first.deletedAt);
    await expect(service.retrieve(userA, stored.id)).rejects.toMatchObject({
      code: 'OBJECT_NOT_READY',
    });
    expect(await readdir(root)).toEqual([]);
  });
});

function createService(
  managed: ManagedPrismaClient,
  root: string,
  overrides: { maxFileBytes?: number; maxUserTotalBytes?: number } = {},
) {
  return new ObjectService(
    new PrismaStoredObjectRepository(managed.client),
    new LocalFilesystemObjectStorage(root),
    {
      maxFileBytes: overrides.maxFileBytes ?? 1_000,
      maxUserTotalBytes: overrides.maxUserTotalBytes ?? 10_000,
      allowedMediaTypes: new Set(['text/plain']),
    },
    { now: () => NOW },
  );
}

async function createActor(
  managed: ManagedPrismaClient,
  email: string,
  role: 'ADMIN' | 'USER',
): Promise<Actor> {
  const user = await managed.client.user.create({
    data: { email, normalizedEmail: email, role },
  });
  return { userId: user.id, email, role, status: 'ACTIVE' };
}

function store(service: ObjectService, actor: Actor, content: string) {
  return service.store(actor, {
    displayName: 'SYNTHETIC private.txt',
    mediaType: 'text/plain',
    declaredByteSize: Buffer.byteLength(content),
    source: chunks(content),
  });
}

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield Buffer.from(value, 'utf8');
  }
}

async function* failingChunks(): AsyncIterable<Uint8Array> {
  yield Buffer.from('SYNTHETIC_PARTIAL', 'utf8');
  throw new Error('SYNTHETIC_STREAM_FAILURE');
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
