import {
  ApplicationError,
  type StoredObjectRecord,
  type StoredObjectCleanupClaim,
  type StoredObjectRepository,
} from '@travel/application';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

interface QuotaTotalRow {
  readonly total: bigint;
}

interface AdvisoryLockRow {
  readonly locked: boolean;
}

export class PrismaStoredObjectRepository implements StoredObjectRepository {
  constructor(private readonly client: PrismaClient) {}

  async claimCleanupBatch(
    input: Parameters<StoredObjectRepository['claimCleanupBatch']>[0],
  ): Promise<readonly StoredObjectCleanupClaim[]> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error('Cleanup batch size must be from 1 to 100');
    return this.client.$queryRaw<StoredObjectCleanupClaim[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id" FROM "StoredObject"
        WHERE "storageDeletedAt" IS NULL
          AND (("state" = 'PENDING' AND "createdAt" <= ${input.pendingBefore})
            OR "state" IN ('FAILED', 'DELETED'))
          AND ("cleanupNextAttemptAt" IS NULL OR "cleanupNextAttemptAt" <= ${input.now})
        ORDER BY "createdAt", "id"
        LIMIT ${input.limit} FOR UPDATE SKIP LOCKED
      )
      UPDATE "StoredObject" AS object
      SET "state" = CASE WHEN object."state" = 'PENDING'
            THEN 'FAILED'::"StoredObjectState" ELSE object."state" END,
          "cleanupAttempts" = object."cleanupAttempts" + 1,
          "cleanupNextAttemptAt" = ${input.leaseUntil}
      FROM candidates WHERE object."id" = candidates."id"
      RETURNING object."id", object."ownerUserId", object."storageKey", object."cleanupAttempts"
    `);
  }

  async claimObjectCleanup(
    input: Parameters<StoredObjectRepository['claimObjectCleanup']>[0],
  ): Promise<StoredObjectCleanupClaim | null> {
    const rows = await this.client.$queryRaw<
      StoredObjectCleanupClaim[]
    >(Prisma.sql`
      UPDATE "StoredObject" SET "cleanupAttempts" = "cleanupAttempts" + 1,
        "storageDeletedAt" = NULL, "cleanupNextAttemptAt" = ${input.leaseUntil}
      WHERE "id" = ${input.id}::uuid AND "ownerUserId" = ${input.ownerUserId}::uuid
        AND "state" IN ('FAILED', 'DELETED')
      RETURNING "id", "ownerUserId", "storageKey", "cleanupAttempts"
    `);
    return rows[0] ?? null;
  }

  async completeCleanup(
    input: Parameters<StoredObjectRepository['completeCleanup']>[0],
  ): Promise<boolean> {
    const updated = await this.client.storedObject.updateMany({
      where: {
        id: input.claim.id,
        ownerUserId: input.claim.ownerUserId,
        storageKey: input.claim.storageKey,
        cleanupAttempts: input.claim.cleanupAttempts,
        state: { in: ['FAILED', 'DELETED'] },
        storageDeletedAt: null,
      },
      data: {
        storageDeletedAt: input.now,
        cleanupNextAttemptAt: null,
        cleanupLastErrorCode: null,
      },
    });
    return updated.count === 1;
  }

  async failCleanup(
    input: Parameters<StoredObjectRepository['failCleanup']>[0],
  ): Promise<boolean> {
    const allowed = new Set([
      'INVALID_OBJECT_KEY',
      'OBJECT_EXISTS',
      'OBJECT_NOT_FOUND',
      'PATH_UNSAFE',
      'SIZE_MISMATCH',
      'SIZE_LIMIT_EXCEEDED',
      'WRITE_FAILED',
      'DELETE_FAILED',
      'PERSISTENCE_UNAVAILABLE',
    ]);
    const updated = await this.client.storedObject.updateMany({
      where: {
        id: input.claim.id,
        ownerUserId: input.claim.ownerUserId,
        storageKey: input.claim.storageKey,
        cleanupAttempts: input.claim.cleanupAttempts,
        state: { in: ['FAILED', 'DELETED'] },
        storageDeletedAt: null,
      },
      data: {
        cleanupNextAttemptAt: input.retryAt,
        cleanupLastErrorCode: allowed.has(input.errorCode)
          ? input.errorCode
          : 'DELETE_FAILED',
      },
    });
    return updated.count === 1;
  }

  async reserve(input: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly storageKey: string;
    readonly displayName: string;
    readonly mediaType: string;
    readonly declaredByteSize: number;
    readonly maxUserTotalBytes: number;
    readonly now: Date;
  }): Promise<StoredObjectRecord> {
    const result = await this.client.$transaction(async (transaction) => {
      const lockRows = await transaction.$queryRaw<
        AdvisoryLockRow[]
      >(Prisma.sql`
          SELECT TRUE AS locked
          FROM pg_advisory_xact_lock(hashtextextended(${input.ownerUserId}, 0))
        `);
      if (lockRows[0]?.locked !== true) {
        throw new Error('Failed to acquire the owner storage quota lock');
      }
      const totals = await transaction.$queryRaw<QuotaTotalRow[]>(Prisma.sql`
          SELECT COALESCE(
            SUM(COALESCE("byteSize", "declaredByteSize")), 0
          )::bigint AS total
          FROM "StoredObject"
          WHERE "ownerUserId" = ${input.ownerUserId}::uuid
            AND "state" IN ('PENDING', 'READY')
        `);
      const currentTotal = totals[0]?.total ?? 0n;
      if (
        currentTotal + BigInt(input.declaredByteSize) >
        BigInt(input.maxUserTotalBytes)
      ) {
        throw new ApplicationError(
          'QUOTA_EXCEEDED',
          '用户对象存储总量已超过限制。',
          409,
        );
      }
      return transaction.storedObject.create({
        data: {
          id: input.id,
          ownerUserId: input.ownerUserId,
          storageKey: input.storageKey,
          displayName: input.displayName,
          mediaType: input.mediaType,
          declaredByteSize: BigInt(input.declaredByteSize),
          createdAt: input.now,
        },
      });
    });
    return toStoredObjectRecord(result);
  }

  async markReady(input: {
    readonly id: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly now: Date;
  }): Promise<StoredObjectRecord> {
    const result = await this.client.$transaction(async (transaction) => {
      const updated = await transaction.storedObject.updateMany({
        where: { id: input.id, state: 'PENDING' },
        data: {
          state: 'READY',
          byteSize: BigInt(input.byteSize),
          sha256: input.sha256,
          readyAt: input.now,
        },
      });
      if (updated.count !== 1) {
        throw new Error('StoredObject is no longer pending');
      }
      return transaction.storedObject.findUniqueOrThrow({
        where: { id: input.id },
      });
    });
    return toStoredObjectRecord(result);
  }

  async markFailed(id: string): Promise<void> {
    await this.client.storedObject.updateMany({
      where: { id, state: 'PENDING' },
      data: { state: 'FAILED' },
    });
  }

  async findOwnedById(input: {
    readonly id: string;
    readonly ownerUserId: string;
  }): Promise<StoredObjectRecord | null> {
    const result = await this.client.storedObject.findFirst({
      where: { id: input.id, ownerUserId: input.ownerUserId },
    });
    return result === null ? null : toStoredObjectRecord(result);
  }

  async markDeleted(input: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly now: Date;
  }): Promise<StoredObjectRecord | null> {
    return this.client.$transaction(async (transaction) => {
      await transaction.storedObject.updateMany({
        where: {
          id: input.id,
          ownerUserId: input.ownerUserId,
          state: { not: 'DELETED' },
        },
        data: { state: 'DELETED', deletedAt: input.now },
      });
      const deleted = await transaction.storedObject.findFirst({
        where: { id: input.id, ownerUserId: input.ownerUserId },
      });
      return deleted === null ? null : toStoredObjectRecord(deleted);
    });
  }
}

function toStoredObjectRecord(record: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly storageKey: string;
  readonly state: 'PENDING' | 'READY' | 'FAILED' | 'DELETED';
  readonly displayName: string;
  readonly mediaType: string;
  readonly declaredByteSize: bigint;
  readonly byteSize: bigint | null;
  readonly sha256: string | null;
  readonly createdAt: Date;
  readonly readyAt: Date | null;
  readonly deletedAt: Date | null;
}): StoredObjectRecord {
  return {
    ...record,
    declaredByteSize: safeNumber(record.declaredByteSize),
    byteSize: record.byteSize === null ? null : safeNumber(record.byteSize),
  };
}

function safeNumber(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error('Stored object byte count is outside the safe range');
  }
  return converted;
}
