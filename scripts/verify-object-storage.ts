import { createHash } from 'node:crypto';

import {
  ApplicationError,
  ObjectService,
  type Actor,
} from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaStoredObjectRepository,
} from '../packages/persistence/src/index.js';
import {
  LocalFilesystemObjectStorage,
  readObjectStorageConfig,
} from '../packages/storage/src/index.js';

const action = process.argv[2];
const objectId = process.argv[3];
const databaseUrl = requiredEnvironment('DATABASE_URL');
const syntheticEmail = requiredEnvironment('SYNTHETIC_STORAGE_OWNER_EMAIL');
const config = readObjectStorageConfig(process.env);

if (!config.enabled) {
  throw new Error('Object storage is not enabled for this environment');
}
if (!syntheticEmail.toLowerCase().includes('synthetic')) {
  throw new Error('Compose storage verification requires a SYNTHETIC owner');
}

const managed = createPrismaClient(databaseUrl);
try {
  const user = await managed.client.user.findUnique({
    where: { normalizedEmail: syntheticEmail.toLowerCase() },
  });
  if (user === null || user.status !== 'ACTIVE') {
    throw new Error('SYNTHETIC storage owner is missing or inactive');
  }
  const actor: Actor = {
    userId: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
  };
  const storage = new LocalFilesystemObjectStorage(config.root);
  const service = new ObjectService(
    new PrismaStoredObjectRepository(managed.client),
    storage,
    config,
  );

  switch (action) {
    case 'write': {
      const content = Buffer.from(
        'SYNTHETIC P1B2 PRIVATE OBJECT - NOT REAL USER DATA',
        'utf8',
      );
      const result = await service.store(actor, {
        displayName: 'SYNTHETIC-p1b2-compose.txt',
        mediaType: 'text/plain',
        declaredByteSize: content.byteLength,
        source: singleChunk(content),
      });
      writeResult({
        action,
        objectId: result.id,
        byteSize: result.byteSize,
        sha256: result.sha256,
      });
      break;
    }
    case 'verify': {
      const id = requiredObjectId(objectId);
      const result = await service.retrieve(actor, id);
      const content = await collect(result.content);
      const digest = createHash('sha256').update(content).digest('hex');
      if (
        result.metadata.state !== 'READY' ||
        result.metadata.byteSize !== content.byteLength ||
        result.metadata.sha256 !== digest ||
        !content.toString('utf8').startsWith('SYNTHETIC P1B2')
      ) {
        throw new Error(
          'Persisted object content or integrity metadata changed',
        );
      }
      writeResult({
        action,
        objectId: id,
        byteSize: content.byteLength,
        sha256: digest,
      });
      break;
    }
    case 'delete': {
      const id = requiredObjectId(objectId);
      const record = await managed.client.storedObject.findUnique({
        where: { id },
      });
      if (record === null) {
        throw new Error('SYNTHETIC StoredObject metadata is missing');
      }
      const deleted = await service.delete(actor, id);
      await service.delete(actor, id);
      if (
        deleted.state !== 'DELETED' ||
        (await storage.exists(record.storageKey))
      ) {
        throw new Error(
          'Object deletion did not remove both readable state and content',
        );
      }
      try {
        await service.retrieve(actor, id);
        throw new Error('Deleted object remained readable');
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          error.code !== 'OBJECT_NOT_READY'
        ) {
          throw error;
        }
      }
      writeResult({ action, objectId: id, state: deleted.state });
      break;
    }
    default:
      throw new Error(
        'Usage: verify-object-storage.ts write|verify|delete [objectId]',
      );
  }
} finally {
  await managed.close();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredObjectId(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('objectId is required');
  }
  return value;
}

async function* singleChunk(content: Uint8Array): AsyncIterable<Uint8Array> {
  yield content;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeResult(result: object): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
