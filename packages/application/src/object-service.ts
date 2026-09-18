import { randomUUID } from 'node:crypto';

import { StorageError, type ObjectStorage } from '@travel/storage';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type { StoredObjectRecord, StoredObjectRepository } from './ports.js';

export interface ObjectServiceConfig {
  readonly maxFileBytes: number;
  readonly maxUserTotalBytes: number;
  readonly allowedMediaTypes: ReadonlySet<string>;
}

export interface ObjectServiceOptions {
  readonly now?: () => Date;
  readonly generateId?: () => string;
  readonly generateStorageKey?: () => string;
}

export interface StoredObjectView {
  readonly id: string;
  readonly state: StoredObjectRecord['state'];
  readonly displayName: string;
  readonly mediaType: string;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly createdAt: string;
  readonly readyAt: string | null;
  readonly deletedAt: string | null;
}

export class ObjectService {
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly generateStorageKey: () => string;

  constructor(
    private readonly repository: StoredObjectRepository,
    private readonly storage: ObjectStorage,
    private readonly config: ObjectServiceConfig,
    options: ObjectServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.generateStorageKey = options.generateStorageKey ?? randomUUID;
  }

  async store(
    actor: Actor,
    input: {
      readonly displayName: string;
      readonly mediaType: string;
      readonly declaredByteSize: number;
      readonly source: AsyncIterable<Uint8Array>;
    },
  ): Promise<StoredObjectView> {
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const displayName = validateDisplayName(input.displayName);
    const mediaType = input.mediaType.trim().toLowerCase();
    if (!this.config.allowedMediaTypes.has(mediaType)) {
      throw new ApplicationError(
        'UNSUPPORTED_MEDIA_TYPE',
        '该文件类型不在允许列表中。',
        415,
      );
    }
    if (
      !Number.isSafeInteger(input.declaredByteSize) ||
      input.declaredByteSize < 0
    ) {
      throw new ApplicationError('VALIDATION_ERROR', '文件大小无效。', 400);
    }
    if (input.declaredByteSize > this.config.maxFileBytes) {
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        '文件超过单文件大小限制。',
        413,
      );
    }

    const reserved = await this.repository.reserve({
      id: this.generateId(),
      ownerUserId: actor.userId,
      storageKey: this.generateStorageKey(),
      displayName,
      mediaType,
      declaredByteSize: input.declaredByteSize,
      maxUserTotalBytes: this.config.maxUserTotalBytes,
      now: this.now(),
    });

    try {
      const integrity = await this.storage.put({
        objectKey: reserved.storageKey,
        source: input.source,
        declaredByteSize: input.declaredByteSize,
        maxByteSize: this.config.maxFileBytes,
      });
      return toStoredObjectView(
        await this.repository.markReady({
          id: reserved.id,
          byteSize: integrity.byteSize,
          sha256: integrity.sha256,
          now: this.now(),
        }),
      );
    } catch (error) {
      await Promise.allSettled([
        this.storage.delete(reserved.storageKey),
        this.repository.markFailed(reserved.id),
      ]);
      throw storageApplicationError(error);
    }
  }

  async retrieve(
    actor: Actor,
    objectId: string,
  ): Promise<{
    readonly metadata: StoredObjectView;
    readonly content: AsyncIterable<Uint8Array>;
  }> {
    const object = await this.requireOwned(
      actor,
      objectId,
      'READ_PRIVATE_RESOURCE',
    );
    if (object.state !== 'READY') {
      throw new ApplicationError('OBJECT_NOT_READY', '文件当前不可读取。', 409);
    }
    return {
      metadata: toStoredObjectView(object),
      content: await this.storage.open(object.storageKey),
    };
  }

  async delete(actor: Actor, objectId: string): Promise<StoredObjectView> {
    const object = await this.requireOwned(
      actor,
      objectId,
      'WRITE_PRIVATE_RESOURCE',
    );
    const deleted = await this.repository.markDeleted({
      id: object.id,
      ownerUserId: actor.userId,
      now: this.now(),
    });
    if (deleted === null) {
      throw new ApplicationError('NOT_FOUND', '存储对象不存在。', 404);
    }
    try {
      await this.storage.delete(object.storageKey);
    } catch (error) {
      throw storageApplicationError(error);
    }
    return toStoredObjectView(deleted);
  }

  private async requireOwned(
    actor: Actor,
    objectId: string,
    action: 'READ_PRIVATE_RESOURCE' | 'WRITE_PRIVATE_RESOURCE',
  ): Promise<StoredObjectRecord> {
    requireUuid(objectId);
    authorize(actor, action, {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const object = await this.repository.findOwnedById({
      id: objectId,
      ownerUserId: actor.userId,
    });
    if (object === null) {
      throw new ApplicationError('NOT_FOUND', '存储对象不存在。', 404);
    }
    return object;
  }
}

function toStoredObjectView(record: StoredObjectRecord): StoredObjectView {
  return {
    id: record.id,
    state: record.state,
    displayName: record.displayName,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    sha256: record.sha256,
    createdAt: record.createdAt.toISOString(),
    readyAt: record.readyAt?.toISOString() ?? null,
    deletedAt: record.deletedAt?.toISOString() ?? null,
  };
}

function storageApplicationError(error: unknown): ApplicationError {
  if (error instanceof StorageError) {
    if (error.code === 'SIZE_LIMIT_EXCEEDED') {
      return new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        '实际文件大小超过限制。',
        413,
      );
    }
    if (error.code === 'SIZE_MISMATCH') {
      return new ApplicationError(
        'VALIDATION_ERROR',
        '声明大小与实际文件大小不一致。',
        400,
      );
    }
  }
  return new ApplicationError(
    'STORAGE_UNAVAILABLE',
    '对象存储暂时不可用。',
    503,
    true,
  );
}

function validateDisplayName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 255 ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new ApplicationError('VALIDATION_ERROR', '文件显示名无效。', 400);
  }
  return normalized;
}

function requireUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ApplicationError('VALIDATION_ERROR', '存储对象 ID 无效。', 400);
  }
}
