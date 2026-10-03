import { randomUUID } from 'node:crypto';
import {
  ApplicationError,
  projectStaticBackup,
  toTripView,
  type StaticBackupRepository,
} from '@travel/application';
import type {
  FlightSnapshotView,
  GenerateStaticBackupRequest,
  StaticBackupView,
} from '@travel/contracts';
import { Prisma, type PrismaClient } from './generated/prisma/client.js';
import { readTripAggregateRecord } from './prisma-trip-repository.js';

export class PrismaStaticBackupRepository implements StaticBackupRepository {
  constructor(private readonly client: PrismaClient) {}
  async latest(ownerUserId: string, tripId: string) {
    const trip = await this.client.trip.findFirst({
      where: { id: tripId, ownerUserId },
      select: {
        staticBackups: {
          orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { artifact: true },
        },
      },
    });
    return trip
      ? {
          backup:
            (trip.staticBackups[0]?.artifact as unknown as StaticBackupView) ??
            null,
        }
      : null;
  }
  async generate(
    ownerUserId: string,
    tripId: string,
    input: GenerateStaticBackupRequest,
  ): Promise<StaticBackupView> {
    const replay = async (tx: Prisma.TransactionClient) => {
      const row = await tx.tripStaticBackup.findFirst({
        where: { ownerUserId, tripId, idempotencyKey: input.idempotencyKey },
      });
      if (!row) return null;
      if (row.tripVersion !== input.baseTripVersion)
        throw new ApplicationError(
          'IDEMPOTENCY_CONFLICT',
          '该重试标识已用于其他版本。',
          409,
        );
      return row.artifact as unknown as StaticBackupView;
    };
    try {
      return await this.client.$transaction(
        async (tx) => {
          const record = await readTripAggregateRecord(tx, {
            ownerUserId,
            tripId,
          });
          if (!record)
            throw new ApplicationError('NOT_FOUND', '旅行不存在。', 404);
          const existing = await replay(tx);
          if (existing) return existing;
          if (record.version !== input.baseTripVersion)
            throw new ApplicationError(
              'VERSION_CONFLICT',
              '行程已变化，请重新载入后更新备份。',
              409,
            );
          const bindings = await tx.flightBinding.findMany({
            where: {
              ownerUserId,
              tripId,
              transportEdge: { mode: 'FLIGHT', provider: 'aerodatabox' },
            },
            select: {
              transportEdgeId: true,
              providerFlightRef: true,
              transportEdge: { select: { providerRef: true } },
              selectedSnapshot: true,
              latestSnapshot: true,
            },
          });
          const id = randomUUID(),
            generatedAt = new Date();
          const artifact = projectStaticBackup(
            toTripView(record),
            bindings
              .filter(
                (f) => f.providerFlightRef === f.transportEdge.providerRef,
              )
              .map((f) => ({
                transportEdgeId: f.transportEdgeId,
                selectedSnapshot:
                  f.selectedSnapshot as unknown as FlightSnapshotView,
                savedSnapshot:
                  f.latestSnapshot as unknown as FlightSnapshotView,
              })),
            id,
            generatedAt.toISOString(),
          );
          if (Buffer.byteLength(JSON.stringify(artifact)) > 1048576)
            throw new ApplicationError(
              'PAYLOAD_TOO_LARGE',
              '行程备份超过 1 MiB，请缩减资料后重试。',
              413,
            );
          const sizes = await tx.$queryRaw<{ byteSize: number }[]>(
            Prisma.sql`SELECT octet_length(${JSON.stringify(artifact)}::jsonb::text) AS "byteSize"`,
          );
          if (!sizes[0] || sizes[0].byteSize > 1048576)
            throw new ApplicationError(
              'PAYLOAD_TOO_LARGE',
              '行程备份超过 1 MiB，请缩减资料后重试。',
              413,
            );
          await tx.tripStaticBackup.create({
            data: {
              id,
              ownerUserId,
              tripId,
              tripVersion: record.version,
              generatedAt,
              idempotencyKey: input.idempotencyKey,
              artifact: artifact as unknown as Prisma.InputJsonValue,
            },
          });
          return artifact;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const existing = await replay(this.client);
        if (existing) return existing;
      }
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2034'
      )
        throw new ApplicationError(
          'VERSION_CONFLICT',
          '行程在生成时变化，请重新载入后重试。',
          409,
        );
      throw e;
    }
  }
}
