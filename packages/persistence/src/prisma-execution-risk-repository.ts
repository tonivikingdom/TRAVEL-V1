import type {
  DesiredExecutionRisk,
  ExecutionRiskRecord,
  ExecutionRiskRepository,
  NotificationRecord,
  ReconcileExecutionRisksResult,
} from '@travel/application';

import {
  Prisma,
  type ExecutionRisk,
  type PrismaClient,
} from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;

interface LockedTripRow {
  readonly id: string;
  readonly version: number;
}

interface AdvisoryLockRow {
  readonly locked: boolean;
}

const SEVERITY_RANK = {
  UNKNOWN: 0,
  EXECUTABLE_RISK: 1,
  INFEASIBLE: 2,
} as const;

export class PrismaExecutionRiskRepository implements ExecutionRiskRepository {
  constructor(private readonly client: PrismaClient) {}

  async reconcile(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly basisTripVersion: number;
    readonly now: Date;
    readonly desiredRisks: readonly DesiredExecutionRisk[];
  }): Promise<ReconcileExecutionRisksResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await lockTrip(transaction, input.ownerUserId, input.tripId);
      if (trip === null) return { status: 'NOT_FOUND' };
      if (trip.version !== input.basisTripVersion) {
        return { status: 'VERSION_CONFLICT' };
      }

      const existingActive = await transaction.executionRisk.findMany({
        where: {
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
          resolvedAt: null,
        },
        orderBy: [{ fingerprint: 'asc' }, { lifecycleGeneration: 'asc' }],
      });
      const byFingerprint = new Map(
        existingActive.map((risk) => [risk.fingerprint, risk]),
      );
      const desiredFingerprints = new Set(
        input.desiredRisks.map((risk) => risk.fingerprint),
      );
      const notificationsCreated: NotificationRecord[] = [];

      for (const desired of [...input.desiredRisks].sort((left, right) =>
        compareText(left.fingerprint, right.fingerprint),
      )) {
        const existing = byFingerprint.get(desired.fingerprint);
        if (existing === undefined) {
          const latest = await transaction.executionRisk.findFirst({
            where: {
              ownerUserId: input.ownerUserId,
              tripId: input.tripId,
              fingerprint: desired.fingerprint,
            },
            orderBy: { lifecycleGeneration: 'desc' },
            select: { lifecycleGeneration: true },
          });
          const created = await transaction.executionRisk.create({
            data: {
              ownerUserId: input.ownerUserId,
              tripId: input.tripId,
              fingerprint: desired.fingerprint,
              lifecycleGeneration: (latest?.lifecycleGeneration ?? 0) + 1,
              kind: desired.kind,
              severity: desired.severity,
              status: 'OPEN',
              sourceNodeId: desired.sourceNodeId,
              sourceTransportEdgeId: desired.sourceTransportEdgeId,
              protectedNodeId: desired.protectedNodeId,
              protectedTransportEdgeId: desired.protectedTransportEdgeId,
              firstSeenAt: input.now,
              lastSeenAt: input.now,
              evaluationBasisTripVersion: input.basisTripVersion,
              lastEvidenceHash: desired.evidenceHash,
              evidenceRefs: [...desired.evidenceRefs],
              requiresRouteReevaluation: desired.requiresRouteReevaluation,
              notificationGeneration: 1,
            },
          });
          notificationsCreated.push(
            await createNotification(transaction, {
              risk: created,
              desired,
              now: input.now,
            }),
          );
          continue;
        }

        const severityEscalated =
          SEVERITY_RANK[desired.severity] > SEVERITY_RANK[existing.severity];
        const snoozeExpired =
          existing.status === 'SNOOZED' &&
          existing.snoozedUntil !== null &&
          existing.snoozedUntil.getTime() <= input.now.getTime();
        const shouldNotify = severityEscalated || snoozeExpired;
        const updated = await transaction.executionRisk.update({
          where: { id: existing.id },
          data: {
            kind: desired.kind,
            severity: desired.severity,
            sourceNodeId: desired.sourceNodeId,
            sourceTransportEdgeId: desired.sourceTransportEdgeId,
            protectedNodeId: desired.protectedNodeId,
            protectedTransportEdgeId: desired.protectedTransportEdgeId,
            lastSeenAt: input.now,
            evaluationBasisTripVersion: input.basisTripVersion,
            lastEvidenceHash: desired.evidenceHash,
            evidenceRefs: [...desired.evidenceRefs],
            requiresRouteReevaluation: desired.requiresRouteReevaluation,
            ...(shouldNotify
              ? {
                  status: 'OPEN' as const,
                  acknowledgedAt: severityEscalated
                    ? null
                    : existing.acknowledgedAt,
                  snoozedUntil: null,
                  notificationGeneration: { increment: 1 },
                }
              : {}),
          },
        });
        if (shouldNotify) {
          notificationsCreated.push(
            await createNotification(transaction, {
              risk: updated,
              desired,
              now: input.now,
            }),
          );
        }
      }

      const resolvedRisks: ExecutionRiskRecord[] = [];
      for (const existing of existingActive) {
        if (desiredFingerprints.has(existing.fingerprint)) continue;
        const resolved = await transaction.executionRisk.update({
          where: { id: existing.id },
          data: {
            status: 'RESOLVED',
            resolvedAt: input.now,
            snoozedUntil: null,
            lastSeenAt: input.now,
            evaluationBasisTripVersion: input.basisTripVersion,
          },
        });
        resolvedRisks.push(toRecord(resolved));
      }

      const activeRisks = await transaction.executionRisk.findMany({
        where: {
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
          resolvedAt: null,
        },
        orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }, { id: 'asc' }],
      });
      return {
        status: 'SUCCESS',
        activeRisks: orderRiskRecords(activeRisks.map(toRecord)),
        resolvedRisks,
        notificationsCreated,
      };
    });
  }

  async listActiveOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<readonly ExecutionRiskRecord[] | null> {
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: { id: true },
    });
    if (trip === null) return null;
    const risks = await this.client.executionRisk.findMany({
      where: {
        ownerUserId: input.ownerUserId,
        tripId: input.tripId,
        resolvedAt: null,
      },
      orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }, { id: 'asc' }],
    });
    return orderRiskRecords(risks.map(toRecord));
  }

  acknowledgeOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly riskId: string;
    readonly now: Date;
  }): Promise<ExecutionRiskRecord | null> {
    return this.changeOwnedRisk(input, async (transaction, risk) =>
      transaction.executionRisk.update({
        where: { id: risk.id },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedAt: risk.acknowledgedAt ?? input.now,
          snoozedUntil: null,
        },
      }),
    );
  }

  snoozeOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly riskId: string;
    readonly now: Date;
    readonly snoozedUntil: Date;
  }): Promise<ExecutionRiskRecord | null> {
    return this.changeOwnedRisk(input, async (transaction, risk) =>
      transaction.executionRisk.update({
        where: { id: risk.id },
        data: {
          status: 'SNOOZED',
          snoozedUntil: input.snoozedUntil,
        },
      }),
    );
  }

  private async changeOwnedRisk(
    input: {
      readonly ownerUserId: string;
      readonly tripId: string;
      readonly riskId: string;
    },
    change: (
      transaction: Transaction,
      risk: ExecutionRisk,
    ) => Promise<ExecutionRisk>,
  ): Promise<ExecutionRiskRecord | null> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await lockTrip(transaction, input.ownerUserId, input.tripId);
      if (trip === null) return null;
      const risks = await transaction.$queryRaw<ExecutionRisk[]>(Prisma.sql`
        SELECT *
        FROM "ExecutionRisk"
        WHERE "id" = ${input.riskId}::uuid
          AND "ownerUserId" = ${input.ownerUserId}::uuid
          AND "tripId" = ${input.tripId}::uuid
          AND "resolvedAt" IS NULL
        FOR UPDATE
      `);
      const risk = risks[0];
      return risk === undefined
        ? null
        : toRecord(await change(transaction, risk));
    });
  }
}

async function createNotification(
  transaction: Transaction,
  input: {
    readonly risk: ExecutionRisk;
    readonly desired: DesiredExecutionRisk;
    readonly now: Date;
  },
): Promise<NotificationRecord> {
  return transaction.notificationEvent.create({
    data: {
      ownerUserId: input.risk.ownerUserId,
      kind: 'EXECUTION_RISK',
      dedupeKey: `execution-risk:${input.risk.id}:${input.risk.severity}:${input.risk.notificationGeneration}`,
      title: input.desired.notificationTitle,
      body: input.desired.notificationBody,
      occurredAt: input.now,
    },
  });
}

async function lockOwner(
  transaction: Transaction,
  ownerUserId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<AdvisoryLockRow[]>(Prisma.sql`
    SELECT TRUE AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 2))
  `);
  if (rows[0]?.locked !== true) {
    throw new Error('Failed to acquire the owner execution-risk lock');
  }
}

async function lockTrip(
  transaction: Transaction,
  ownerUserId: string,
  tripId: string,
): Promise<LockedTripRow | null> {
  const rows = await transaction.$queryRaw<LockedTripRow[]>(Prisma.sql`
    SELECT "id", "version"
    FROM "Trip"
    WHERE "id" = ${tripId}::uuid
      AND "ownerUserId" = ${ownerUserId}::uuid
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

function toRecord(risk: ExecutionRisk): ExecutionRiskRecord {
  return {
    ...risk,
    evidenceRefs: parseEvidenceRefs(risk.evidenceRefs),
  };
}

function parseEvidenceRefs(value: Prisma.JsonValue): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('ExecutionRisk evidenceRefs invariant is broken');
  }
  return value as string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderRiskRecords(
  risks: readonly ExecutionRiskRecord[],
): readonly ExecutionRiskRecord[] {
  return [...risks].sort(
    (left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      left.firstSeenAt.getTime() - right.firstSeenAt.getTime() ||
      compareText(left.id, right.id),
  );
}
