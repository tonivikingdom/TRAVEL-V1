import {
  buildExternalOriginPreviewPayload,
  EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION,
  hashRoutePreviewPayload,
  systemClock,
  type Clock,
  authorizeExternalOriginPlanning,
  externalRouteOriginSnapshot,
} from '@travel/application';
import { loadExternalOriginPlanningContext } from './prisma-external-execution-origin-repository.js';
import { readTripAggregateRecord } from './prisma-trip-repository.js';
import type {
  CreateRoutePreviewResult,
  AdoptRoutePreviewResult,
  RouteCandidatePayload,
  RouteCandidateSnapshotDraft,
  RouteCandidateSnapshotRecord,
  RoutePlanningRepository,
  RoutePreviewRecord,
  SaveRouteCandidateSnapshotsResult,
  StoredRoutePreviewPayload,
  UndoRouteAdoptionResult,
} from '@travel/application';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';
import { adoptRoutePreview } from './prisma-route-adoption.js';
import { undoRouteAdoption } from './prisma-route-undo.js';
import { resolveLockedRouteCorridor } from './prisma-route-corridor.js';
import { resolveLockedConfirmedRouteExecutionOrigin } from './prisma-confirmed-route-execution-origin.js';

type Transaction = Prisma.TransactionClient;

interface AdvisoryLockRow {
  readonly locked: boolean;
}

interface LockedTripRow {
  readonly id: string;
  readonly version: number;
}

export class PrismaRoutePlanningRepository implements RoutePlanningRepository {
  constructor(
    private readonly client: PrismaClient,
    private readonly clock: Clock = systemClock,
  ) {}

  async saveCandidateSnapshots(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly basisVersion: number;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly snapshots: readonly RouteCandidateSnapshotDraft[];
  }): Promise<SaveRouteCandidateSnapshotsResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const tripStatus = await lockTrip(transaction, input);
      if (tripStatus !== 'SUCCESS') return { status: tripStatus };
      if (!(await isCurrentRouteCorridor(transaction, input, true))) {
        return { status: 'NOT_ADJACENT' };
      }
      const snapshots: RouteCandidateSnapshotRecord[] = [];
      for (const draft of input.snapshots) {
        const created = await transaction.routeCandidateSnapshot.create({
          data: {
            ownerUserId: input.ownerUserId,
            tripId: input.tripId,
            basisVersion: input.basisVersion,
            fromNodeId: input.fromNodeId,
            toNodeId: input.toNodeId,
            provider: draft.provider,
            providerCandidateRef: draft.providerCandidateRef,
            observedAt: draft.observedAt,
            providerValidUntil: draft.providerValidUntil,
            candidatePayload: toJson(draft.candidatePayload),
            candidateHash: draft.candidateHash,
            queryTimeCondition: toJson(draft.queryTimeCondition),
            createdAt: draft.createdAt,
            expiresAt: draft.expiresAt,
          },
        });
        snapshots.push(toSnapshotRecord(created));
      }
      return { status: 'SUCCESS', snapshots };
    });
  }

  async saveExternalOriginCandidateSnapshots(
    input: Parameters<
      NonNullable<
        RoutePlanningRepository['saveExternalOriginCandidateSnapshots']
      >
    >[0],
  ): Promise<SaveRouteCandidateSnapshotsResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const status = await lockTrip(transaction, input);
      if (status !== 'SUCCESS') return { status };
      const context = await loadExternalOriginPlanningContext(
        transaction,
        input,
      );
      if (context === null) return { status: 'NOT_FOUND' };
      if (
        context.origin === null ||
        authorizeExternalOriginPlanning(context, input.toNodeId) !==
          'AUTHORIZED' ||
        JSON.stringify(externalRouteOriginSnapshot(context.origin)) !==
          JSON.stringify(input.originSnapshot)
      )
        return { status: 'VERSION_CONFLICT' };
      const snapshots: RouteCandidateSnapshotRecord[] = [];
      for (const draft of input.snapshots) {
        const created = await transaction.routeCandidateSnapshot.create({
          data: {
            ownerUserId: input.ownerUserId,
            tripId: input.tripId,
            basisVersion: input.basisVersion,
            originKind: 'EXTERNAL_EXECUTION_ORIGIN',
            fromNodeId: null,
            fromExternalOriginId: input.externalOriginId,
            externalOriginSnapshot: toJson(input.originSnapshot),
            toNodeId: input.toNodeId,
            provider: draft.provider,
            providerCandidateRef: draft.providerCandidateRef,
            observedAt: draft.observedAt,
            providerValidUntil: draft.providerValidUntil,
            candidatePayload: toJson(draft.candidatePayload),
            candidateHash: draft.candidateHash,
            queryTimeCondition: toJson(draft.queryTimeCondition),
            createdAt: draft.createdAt,
            expiresAt: draft.expiresAt,
          },
        });
        snapshots.push(toSnapshotRecord(created));
      }
      return { status: 'SUCCESS', snapshots };
    });
  }

  async findSnapshotOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly snapshotId: string;
  }): Promise<RouteCandidateSnapshotRecord | null> {
    const snapshot = await this.client.routeCandidateSnapshot.findFirst({
      where: {
        id: input.snapshotId,
        tripId: input.tripId,
        ownerUserId: input.ownerUserId,
      },
    });
    return snapshot === null ? null : toSnapshotRecord(snapshot);
  }

  async createPreview(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly basisVersion: number;
    readonly snapshotId: string;
    readonly expectedCandidateHash: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly policyVersion: string;
    readonly previewPayload: StoredRoutePreviewPayload;
    readonly previewHash: string;
    readonly now: Date;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<CreateRoutePreviewResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const tripStatus = await lockTrip(transaction, input);
      if (tripStatus !== 'SUCCESS') return { status: tripStatus };
      const snapshot = await transaction.routeCandidateSnapshot.findFirst({
        where: {
          id: input.snapshotId,
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
        },
      });
      if (snapshot === null) return { status: 'NOT_FOUND' };
      if (snapshot.originKind !== 'ITINERARY_NODE')
        return { status: 'PREVIEW_UNSUPPORTED' };
      if (
        snapshot.basisVersion !== input.basisVersion ||
        snapshot.candidateHash !== input.expectedCandidateHash ||
        snapshot.fromNodeId !== input.fromNodeId ||
        snapshot.toNodeId !== input.toNodeId ||
        snapshot.expiresAt <= input.now ||
        (snapshot.providerValidUntil !== null &&
          snapshot.providerValidUntil <= input.now)
      ) {
        return { status: 'PREVIEW_STALE' };
      }
      if (!(await isCurrentRouteCorridor(transaction, input))) {
        return { status: 'NOT_ADJACENT' };
      }
      const preview = await transaction.routePreview.create({
        data: {
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
          basisVersion: input.basisVersion,
          candidateSnapshotId: input.snapshotId,
          candidateHash: input.expectedCandidateHash,
          policyVersion: input.policyVersion,
          previewPayload: toJson(input.previewPayload),
          previewHash: input.previewHash,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        },
      });
      return { status: 'SUCCESS', preview: toPreviewRecord(preview) };
    });
  }

  async createExternalOriginPreview(
    input: Parameters<
      NonNullable<RoutePlanningRepository['createExternalOriginPreview']>
    >[0],
  ): Promise<CreateRoutePreviewResult> {
    return this.client.$transaction(
      async (transaction) => {
        await lockOwner(transaction, input.ownerUserId);
        const tripStatus = await lockTrip(transaction, input);
        if (tripStatus === 'NOT_FOUND') return { status: tripStatus };
        if (tripStatus !== 'SUCCESS') return { status: 'PREVIEW_STALE' };
        const row = await transaction.routeCandidateSnapshot.findFirst({
          where: {
            id: input.snapshotId,
            ownerUserId: input.ownerUserId,
            tripId: input.tripId,
          },
        });
        if (row === null) return { status: 'NOT_FOUND' };
        const snapshot = toSnapshotRecord(row);
        if (snapshot.origin.type !== 'EXTERNAL_EXECUTION_ORIGIN')
          return { status: 'PREVIEW_UNSUPPORTED' };
        const now = new Date(
          Math.max(input.now.getTime(), this.clock.now().getTime()),
        );
        if (
          input.policyVersion !== EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION ||
          snapshot.basisVersion !== input.basisVersion ||
          snapshot.candidateHash !== input.expectedCandidateHash ||
          input.expiresAt <= now ||
          input.expiresAt > snapshot.expiresAt ||
          hashRoutePreviewPayload(input.previewPayload) !== input.previewHash
        )
          return { status: 'PREVIEW_STALE' };
        const trip = await readTripAggregateRecord(transaction, input);
        const context = await loadExternalOriginPlanningContext(transaction, {
          ...input,
          externalOriginId: snapshot.origin.externalOriginId,
        });
        if (trip === null || context === null)
          return { status: 'PREVIEW_STALE' };
        let lockedPayload: StoredRoutePreviewPayload;
        try {
          lockedPayload = buildExternalOriginPreviewPayload({
            trip,
            snapshot,
            context,
            now,
            sameHubWalkingLegIndexes: input.sameHubWalkingLegIndexes,
          });
        } catch {
          return { status: 'PREVIEW_STALE' };
        }
        if (hashRoutePreviewPayload(lockedPayload) !== input.previewHash)
          return { status: 'PREVIEW_STALE' };
        const preview = await transaction.routePreview.create({
          data: {
            ownerUserId: input.ownerUserId,
            tripId: input.tripId,
            basisVersion: input.basisVersion,
            candidateSnapshotId: input.snapshotId,
            candidateHash: input.expectedCandidateHash,
            policyVersion: input.policyVersion,
            previewPayload: toJson(lockedPayload),
            previewHash: input.previewHash,
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
          },
        });
        return { status: 'SUCCESS', preview: toPreviewRecord(preview) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async findPreviewOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly previewId: string;
  }): Promise<RoutePreviewRecord | null> {
    const preview = await this.client.routePreview.findFirst({
      where: {
        id: input.previewId,
        tripId: input.tripId,
        ownerUserId: input.ownerUserId,
      },
    });
    return preview === null ? null : toPreviewRecord(preview);
  }

  async adoptPreview(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly previewId: string;
    readonly baseTripVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly acceptedUserAdjustments: readonly {
      readonly intentId: string;
      readonly nodeId: string;
      readonly fromDurationSeconds: number;
      readonly toDurationSeconds: number;
    }[];
    readonly now: Date;
    readonly undoExpiresAt: Date;
  }): Promise<AdoptRoutePreviewResult> {
    return adoptRoutePreview(this.client, input);
  }

  async undoAdoption(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly targetOperationReceiptId: string;
    readonly baseTripVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<UndoRouteAdoptionResult> {
    return undoRouteAdoption(this.client, input);
  }
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
    throw new Error('Failed to acquire route-planning owner lock');
  }
}

async function lockTrip(
  transaction: Transaction,
  input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly basisVersion: number;
  },
): Promise<'SUCCESS' | 'NOT_FOUND' | 'VERSION_CONFLICT'> {
  const rows = await transaction.$queryRaw<LockedTripRow[]>(Prisma.sql`
    SELECT "id", "version"
    FROM "Trip"
    WHERE "id" = ${input.tripId}::uuid
      AND "ownerUserId" = ${input.ownerUserId}::uuid
    FOR UPDATE
  `);
  const trip = rows[0];
  if (trip === undefined) return 'NOT_FOUND';
  return trip.version === input.basisVersion ? 'SUCCESS' : 'VERSION_CONFLICT';
}

async function isCurrentRouteCorridor(
  transaction: Transaction,
  input: {
    readonly tripId: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
  },
  authorizeSuffix = false,
): Promise<boolean> {
  const corridor = await resolveLockedRouteCorridor(
    transaction,
    input.tripId,
    input.fromNodeId,
    input.toNodeId,
  );
  if (corridor === null) return false;
  if (!authorizeSuffix || corridor.replacementScope !== 'SUFFIX') return true;
  const origin = await resolveLockedConfirmedRouteExecutionOrigin(
    transaction,
    input.tripId,
    corridor.sourceRouteAnchorFromNodeId!,
    corridor.sourceRouteAnchorToNodeId!,
  );
  return (
    origin.status === 'CONFIRMED_NODE' && origin.nodeId === input.fromNodeId
  );
}

export function toSnapshotRecord(snapshot: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly basisVersion: number;
  readonly originKind: 'ITINERARY_NODE' | 'EXTERNAL_EXECUTION_ORIGIN';
  readonly fromNodeId: string | null;
  readonly fromExternalOriginId: string | null;
  readonly externalOriginSnapshot: Prisma.JsonValue | null;
  readonly toNodeId: string;
  readonly provider: string;
  readonly providerCandidateRef: string | null;
  readonly observedAt: Date;
  readonly providerValidUntil: Date | null;
  readonly candidatePayload: Prisma.JsonValue;
  readonly candidateHash: string;
  readonly queryTimeCondition: Prisma.JsonValue;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}): RouteCandidateSnapshotRecord {
  const originShape =
    snapshot.originKind === 'ITINERARY_NODE'
      ? {
          fromNodeId: snapshot.fromNodeId!,
          origin: {
            type: 'ITINERARY_NODE' as const,
            nodeId: snapshot.fromNodeId!,
          },
        }
      : {
          fromNodeId: null,
          origin: {
            type: 'EXTERNAL_EXECUTION_ORIGIN' as const,
            externalOriginId: snapshot.fromExternalOriginId!,
            snapshot:
              snapshot.externalOriginSnapshot as unknown as import('@travel/contracts').ExternalRouteOriginSnapshot,
          },
        };
  return {
    ...snapshot,
    ...originShape,
    candidatePayload:
      snapshot.candidatePayload as unknown as RouteCandidatePayload,
    queryTimeCondition:
      snapshot.queryTimeCondition as unknown as RouteCandidateSnapshotRecord['queryTimeCondition'],
  };
}

function toPreviewRecord(preview: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly basisVersion: number;
  readonly candidateSnapshotId: string;
  readonly candidateHash: string;
  readonly policyVersion: string;
  readonly previewPayload: Prisma.JsonValue;
  readonly previewHash: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}): RoutePreviewRecord {
  return {
    ...preview,
    previewPayload:
      preview.previewPayload as unknown as StoredRoutePreviewPayload,
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
