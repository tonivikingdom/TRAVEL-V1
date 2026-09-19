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
} from '@travel/application';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';
import { adoptRoutePreview } from './prisma-route-adoption.js';

type Transaction = Prisma.TransactionClient;

interface AdvisoryLockRow {
  readonly locked: boolean;
}

interface LockedTripRow {
  readonly id: string;
  readonly version: number;
}

export class PrismaRoutePlanningRepository implements RoutePlanningRepository {
  constructor(private readonly client: PrismaClient) {}

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
      if (!(await isAdjacentPlacePair(transaction, input))) {
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
      if (!(await isAdjacentPlacePair(transaction, input))) {
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
    readonly now: Date;
  }): Promise<AdoptRoutePreviewResult> {
    return adoptRoutePreview(this.client, input);
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

async function isAdjacentPlacePair(
  transaction: Transaction,
  input: {
    readonly tripId: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
  },
): Promise<boolean> {
  const nodes = await transaction.itineraryNode.findMany({
    where: { tripId: input.tripId },
    select: { id: true, kind: true, source: true, adoptedRouteId: true },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const fromIndex = nodes.findIndex((node) => node.id === input.fromNodeId);
  const from = nodes[fromIndex];
  const toIndex = nodes.findIndex((node) => node.id === input.toNodeId);
  const to = nodes[toIndex];
  const endpointsValid =
    fromIndex >= 0 &&
    from?.kind === 'PLACE_VISIT' &&
    toIndex > fromIndex &&
    to?.kind === 'PLACE_VISIT';
  if (!endpointsValid) return false;
  if (toIndex === fromIndex + 1) return true;
  const route = await transaction.adoptedRoute.findFirst({
    where: {
      tripId: input.tripId,
      anchorFromNodeId: input.fromNodeId,
      anchorToNodeId: input.toNodeId,
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  return (
    route !== null &&
    nodes
      .slice(fromIndex + 1, toIndex)
      .every(
        (node) =>
          node.kind === 'PLACE_VISIT' &&
          node.source === 'ROUTE_GENERATED' &&
          node.adoptedRouteId === route.id,
      )
  );
}

function toSnapshotRecord(snapshot: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly basisVersion: number;
  readonly fromNodeId: string;
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
  return {
    ...snapshot,
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
