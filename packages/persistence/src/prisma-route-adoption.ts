import {
  hashRouteCandidateSnapshot,
  hashRoutePreviewPayload,
  compareCanonicalDwellAdjustments,
  compareCanonicalText,
  type AdoptRoutePreviewResult,
  type OperationReceiptRecord,
  type StoredRoutePreviewPayload,
} from '@travel/application';
import type {
  RouteAdoptDayOccurrenceSnapshot,
  RouteAdoptDayProjectionSnapshot,
  RouteAdoptDeltaV3,
  RouteAdoptGeneratedNodeSnapshot,
  RouteAdoptNodePlacementSnapshot,
  RoutePreviewGeneratedNodePlanView,
} from '@travel/contracts';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;

interface LockedTripRow {
  readonly id: string;
  readonly version: number;
  readonly effectiveStartDate: Date | null;
  readonly effectiveEndDate: Date | null;
}

interface AdvisoryLockRow {
  readonly locked: boolean;
}

interface AdoptionInput {
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
}

interface ReceiptDelta {
  schemaVersion: 'route-adopt-delta-v3';
  createdNodeIds: string[];
  reusedNodeIds: string[];
  removedGeneratedNodes: RouteAdoptGeneratedNodeSnapshot[];
  createdTransportEdgeIds: string[];
  archivedTransportHistoryIds: string[];
  createdDayProjections: RouteAdoptDayProjectionSnapshot[];
  removedDayProjections: RouteAdoptDayProjectionSnapshot[];
  affectedDayOccurrenceIds: string[];
  beforeCorridorNodeIds: string[];
  afterCorridorNodeIds: string[];
  beforeDayOccurrences: RouteAdoptDayOccurrenceSnapshot[];
  beforeNodePlacements: RouteAdoptNodePlacementSnapshot[];
  beforeGeneratedNodes: RouteAdoptGeneratedNodeSnapshot[];
  beforeOwnedDates: string[];
  beforeEffectiveStartDate: string | null;
  beforeEffectiveEndDate: string | null;
  previousActiveAdoptedRouteId: string | null;
  createdPlaceIds: string[];
  createdDayOccurrenceIds: string[];
  userDwellAdjustments: {
    intentId: string;
    nodeId: string;
    beforeDurationSeconds: number;
    afterDurationSeconds: number;
    beforeLocked: boolean;
  }[];
}

export async function adoptRoutePreview(
  client: PrismaClient,
  input: AdoptionInput,
): Promise<AdoptRoutePreviewResult> {
  try {
    return await client.$transaction(
      async (transaction) => executeAdoption(transaction, input),
      // The owner advisory lock and Trip row lock are the serialization
      // boundary. READ COMMITTED intentionally takes a fresh snapshot after a
      // waiter acquires that advisory lock, so a second device observes the
      // first commit and returns VERSION_CONFLICT instead of attempting a
      // stale serializable transaction.
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (error) {
    if (error instanceof AdoptionAbort) return { status: error.status };
    if (isDateOwnershipConflict(error)) return { status: 'DATE_OWNED' };
    throw error;
  }
}

async function executeAdoption(
  transaction: Transaction,
  input: AdoptionInput,
): Promise<AdoptRoutePreviewResult> {
  await lockOwner(transaction, input.ownerUserId);
  const existingReceipt = await transaction.operationReceipt.findFirst({
    where: {
      ownerUserId: input.ownerUserId,
      tripId: input.tripId,
      operationType: 'ROUTE_ADOPT',
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (existingReceipt !== null) {
    if (existingReceipt.requestHash !== input.requestHash) {
      return { status: 'IDEMPOTENCY_CONFLICT' };
    }
    return {
      status: 'SUCCESS',
      receipt: toReceiptRecord(existingReceipt),
      idempotentReplay: true,
    };
  }

  const tripRows = await transaction.$queryRaw<LockedTripRow[]>(Prisma.sql`
    SELECT "id", "version", "effectiveStartDate", "effectiveEndDate"
    FROM "Trip"
    WHERE "id" = ${input.tripId}::uuid
      AND "ownerUserId" = ${input.ownerUserId}::uuid
    FOR UPDATE
  `);
  const lockedTrip = tripRows[0];
  if (lockedTrip === undefined) return { status: 'NOT_FOUND' };
  if (lockedTrip.version !== input.baseTripVersion) {
    return { status: 'VERSION_CONFLICT' };
  }

  const preview = await transaction.routePreview.findFirst({
    where: {
      id: input.previewId,
      tripId: input.tripId,
      ownerUserId: input.ownerUserId,
    },
    include: { candidateSnapshot: true },
  });
  if (preview === null) return { status: 'NOT_FOUND' };
  if (
    preview.policyVersion !== 'route-adoption-preview-v3' ||
    preview.expiresAt <= input.now ||
    preview.candidateSnapshot.expiresAt <= input.now ||
    (preview.candidateSnapshot.providerValidUntil !== null &&
      preview.candidateSnapshot.providerValidUntil <= input.now) ||
    preview.basisVersion !== input.baseTripVersion ||
    preview.candidateHash !== preview.candidateSnapshot.candidateHash
  ) {
    return { status: 'PREVIEW_STALE' };
  }

  const payload =
    preview.previewPayload as unknown as StoredRoutePreviewPayload;
  if (
    preview.previewHash === null ||
    hashRoutePreviewPayload(payload) !== preview.previewHash ||
    payload.policyVersion !== 'route-adoption-preview-v3' ||
    payload.tripId !== input.tripId ||
    payload.basisVersion !== input.baseTripVersion ||
    payload.candidateSnapshotId !== preview.candidateSnapshotId ||
    payload.candidateHash !== preview.candidateHash ||
    hashRouteCandidateSnapshot({
      tripId: input.tripId,
      basisVersion: input.baseTripVersion,
      fromNodeId: preview.candidateSnapshot.fromNodeId,
      toNodeId: preview.candidateSnapshot.toNodeId,
      provider: preview.candidateSnapshot.provider,
      observedAt: preview.candidateSnapshot.observedAt.toISOString(),
      candidatePayload: preview.candidateSnapshot
        .candidatePayload as unknown as StoredRoutePreviewPayload['candidate'],
    }) !== preview.candidateSnapshot.candidateHash
  ) {
    return { status: 'PREVIEW_STALE' };
  }

  const plan = requireCurrentPlan(payload);
  if (plan.protectedBlockingNodes.length > 0) {
    return { status: 'PREVIEW_BLOCKED' };
  }
  const corridor = await validateCurrentCorridor(
    transaction,
    input.tripId,
    plan,
  );
  if (corridor === null) return { status: 'PREVIEW_STALE' };

  const [
    beforeOccurrenceRows,
    beforeNodeRows,
    beforeOwnershipRows,
    beforeGeneratedRows,
  ] = await Promise.all([
    transaction.dayOccurrence.findMany({
      where: { tripId: input.tripId },
      select: { id: true, localDate: true, sequence: true },
      orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
    }),
    transaction.itineraryNode.findMany({
      where: { tripId: input.tripId },
      select: { id: true, dayOccurrenceId: true, position: true },
      orderBy: [
        { dayOccurrence: { sequence: 'asc' } },
        { position: 'asc' },
        { id: 'asc' },
      ],
    }),
    transaction.dateOwnership.findMany({
      where: { tripId: input.tripId, ownerUserId: input.ownerUserId },
      select: { localDate: true },
      orderBy: { localDate: 'asc' },
    }),
    transaction.itineraryNode.findMany({
      where: {
        tripId: input.tripId,
        id: { in: corridor.nodeIds },
        source: 'ROUTE_GENERATED',
      },
      include: { temporalValues: true, timeIntents: true },
      orderBy: { id: 'asc' },
    }),
  ]);
  if (
    beforeGeneratedRows.some(
      (node) =>
        !node.autoReplaceable ||
        node.userModifiedAt !== null ||
        (node.note !== null && node.note.trim() !== '') ||
        node.timeIntents.length > 0,
    )
  ) {
    return { status: 'PREVIEW_BLOCKED' };
  }

  if (
    !sameAdjustments(
      plan.requiredUserAdjustments,
      input.acceptedUserAdjustments,
    )
  ) {
    return { status: 'USER_ADJUSTMENT_REQUIRED' };
  }
  const adjustmentRows = await transaction.userTimeIntent.findMany({
    where: {
      id: { in: plan.requiredUserAdjustments.map((item) => item.intentId) },
      tripId: input.tripId,
      kind: 'MIN_DWELL',
      operator: 'MINIMUM',
    },
    select: {
      id: true,
      nodeId: true,
      durationSeconds: true,
      locked: true,
    },
  });
  adjustmentRows.sort((left, right) => compareCanonicalText(left.id, right.id));
  if (
    adjustmentRows.length !== plan.requiredUserAdjustments.length ||
    adjustmentRows.some((row, index) => {
      const expected = plan.requiredUserAdjustments[index];
      return (
        expected === undefined ||
        row.id !== expected.intentId ||
        row.nodeId !== expected.nodeId ||
        row.durationSeconds !== expected.fromDurationSeconds
      );
    })
  ) {
    return { status: 'PREVIEW_STALE' };
  }
  if (
    beforeGeneratedRows.some((node) =>
      node.temporalValues.some((value) => value.layer === 'ACTUAL'),
    )
  ) {
    return { status: 'FACT_PROTECTED' };
  }
  const beforeGeneratedNodes = beforeGeneratedRows.map(toGeneratedNodeSnapshot);

  const removedNodes = await transaction.itineraryNode.findMany({
    where: { id: { in: plan.nodesToRemove.map((node) => node.nodeId) } },
    include: { temporalValues: true, timeIntents: true, place: true },
  });
  if (
    removedNodes.length !== plan.nodesToRemove.length ||
    removedNodes.some(
      (node) =>
        node.tripId !== input.tripId ||
        node.source !== 'ROUTE_GENERATED' ||
        !node.autoReplaceable ||
        node.userModifiedAt !== null ||
        (node.note !== null && node.note.trim() !== '') ||
        node.timeIntents.length > 0 ||
        node.temporalValues.some((value) => value.layer === 'ACTUAL'),
    )
  ) {
    return { status: 'PREVIEW_BLOCKED' };
  }

  const oldEdges = await transaction.transportEdge.findMany({
    where: { id: { in: plan.willReplaceTransportEdgeIds } },
    include: { temporalValues: true, dayProjections: true },
  });
  if (
    oldEdges.length !== plan.willReplaceTransportEdgeIds.length ||
    oldEdges.some(
      (edge) =>
        edge.tripId !== input.tripId ||
        edge.temporalValues.some((value) => value.layer === 'ACTUAL'),
    )
  ) {
    return oldEdges.some((edge) =>
      edge.temporalValues.some((value) => value.layer === 'ACTUAL'),
    )
      ? { status: 'FACT_PROTECTED' }
      : { status: 'PREVIEW_STALE' };
  }

  if (plan.currentAdoptedRouteId !== null) {
    const replacement = await transaction.adoptedRoute.updateMany({
      where: {
        id: plan.currentAdoptedRouteId,
        tripId: input.tripId,
        anchorFromNodeId: plan.anchorFromNodeId,
        anchorToNodeId: plan.anchorToNodeId,
        status: 'ACTIVE',
      },
      data: { status: 'REPLACED', replacedAt: input.now },
    });
    if (replacement.count !== 1) {
      throw new AdoptionAbort('PREVIEW_STALE');
    }
  }

  const adoptedRoute = await transaction.adoptedRoute.create({
    data: {
      tripId: input.tripId,
      anchorFromNodeId: plan.anchorFromNodeId,
      anchorToNodeId: plan.anchorToNodeId,
      sourcePreviewId: preview.id,
      candidateSnapshotId: preview.candidateSnapshotId,
      candidateHash: preview.candidateHash,
      policyVersion: preview.policyVersion,
      status: 'ACTIVE',
      createdAt: input.now,
    },
  });
  const receipt = await transaction.operationReceipt.create({
    data: {
      ownerUserId: input.ownerUserId,
      tripId: input.tripId,
      operationType: 'ROUTE_ADOPT',
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      baseTripVersion: input.baseTripVersion,
      resultingTripVersion: input.baseTripVersion + 1,
      previewId: preview.id,
      adoptedRouteId: adoptedRoute.id,
      targetOperationReceiptId: null,
      undoExpiresAt: input.undoExpiresAt,
      delta: {},
      createdAt: input.now,
    },
  });

  const delta: ReceiptDelta = {
    schemaVersion: 'route-adopt-delta-v3',
    createdNodeIds: [],
    reusedNodeIds: [],
    removedGeneratedNodes: beforeGeneratedNodes.filter((node) =>
      plan.nodesToRemove.some((removed) => removed.nodeId === node.id),
    ),
    createdTransportEdgeIds: [],
    archivedTransportHistoryIds: [],
    createdDayProjections: [],
    removedDayProjections: oldEdges.flatMap((edge) =>
      edge.dayProjections.map((projection) => ({
        transportEdgeId: edge.id,
        dayOccurrenceId: projection.dayOccurrenceId,
        role: projection.role,
      })),
    ),
    affectedDayOccurrenceIds: [],
    beforeCorridorNodeIds: corridor.nodeIds,
    afterCorridorNodeIds: [],
    beforeDayOccurrences: beforeOccurrenceRows.map((occurrence) => ({
      id: occurrence.id,
      localDate: localDate(occurrence.localDate),
      sequence: occurrence.sequence,
    })),
    beforeNodePlacements: beforeNodeRows.map((node) => ({
      nodeId: node.id,
      dayOccurrenceId: node.dayOccurrenceId,
      position: node.position,
    })),
    beforeGeneratedNodes,
    beforeOwnedDates: beforeOwnershipRows.map((ownership) =>
      localDate(ownership.localDate),
    ),
    beforeEffectiveStartDate:
      lockedTrip.effectiveStartDate === null
        ? null
        : localDate(lockedTrip.effectiveStartDate),
    beforeEffectiveEndDate:
      lockedTrip.effectiveEndDate === null
        ? null
        : localDate(lockedTrip.effectiveEndDate),
    previousActiveAdoptedRouteId: plan.currentAdoptedRouteId,
    createdPlaceIds: [],
    createdDayOccurrenceIds: [],
    userDwellAdjustments: adjustmentRows.map((row, index) => ({
      intentId: row.id,
      nodeId: row.nodeId,
      beforeDurationSeconds: row.durationSeconds!,
      afterDurationSeconds:
        plan.requiredUserAdjustments[index]!.toDurationSeconds,
      beforeLocked: row.locked,
    })),
  };

  for (const adjustment of delta.userDwellAdjustments) {
    await transaction.userTimeIntent.update({
      where: { id: adjustment.intentId },
      data: { durationSeconds: adjustment.afterDurationSeconds },
    });
  }

  for (const edge of oldEdges) {
    const history = await transaction.transportEdgeHistory.create({
      data: {
        originalTransportEdgeId: edge.id,
        tripId: edge.tripId,
        originalFromNodeId: edge.fromNodeId,
        originalToNodeId: edge.toNodeId,
        mode: edge.mode,
        fixedService: edge.fixedService,
        serviceLabel: edge.serviceLabel,
        note: edge.note,
        source: edge.source,
        adoptedRouteId: edge.adoptedRouteId,
        provider: edge.provider,
        providerRef: edge.providerRef,
        originalCreatedAt: edge.createdAt,
        invalidatedAt: input.now,
        invalidationReason: 'USER_REPLACED',
        temporalValues: {
          create: edge.temporalValues.map((value) => ({
            layer: value.layer,
            pointKind: value.pointKind,
            instant: value.instant,
            timeZone: value.timeZone,
            sourceKind: value.sourceKind,
            sourceRef: value.sourceRef,
            observedAt: value.observedAt,
            originalCreatedAt: value.createdAt,
            originalUpdatedAt: value.updatedAt,
          })),
        },
      },
    });
    delta.archivedTransportHistoryIds.push(history.id);
    await transaction.transportEdge.delete({ where: { id: edge.id } });
  }
  await transaction.itineraryNode.deleteMany({
    where: { id: { in: removedNodes.map((node) => node.id) } },
  });

  const resolvedNodes = await resolveGeneratedNodes(transaction, {
    ownerUserId: input.ownerUserId,
    tripId: input.tripId,
    adoptedRouteId: adoptedRoute.id,
    receiptId: receipt.id,
    provider: preview.candidateSnapshot.provider,
    anchorFromNodeId: plan.anchorFromNodeId,
    anchorToNodeId: plan.anchorToNodeId,
    nodes: plan.nodePlans,
    now: input.now,
  });
  delta.createdNodeIds.push(...resolvedNodes.createdNodeIds);
  delta.reusedNodeIds.push(...resolvedNodes.reusedNodeIds);
  delta.createdPlaceIds.push(...resolvedNodes.createdPlaceIds);
  delta.createdDayOccurrenceIds.push(...resolvedNodes.createdDayOccurrenceIds);
  delta.affectedDayOccurrenceIds.push(...resolvedNodes.affectedOccurrenceIds);

  const refs = new Map<string, string>([
    ['FROM_NODE', plan.anchorFromNodeId],
    ['TO_NODE', plan.anchorToNodeId],
    ...resolvedNodes.refs.entries(),
  ]);
  for (const [segmentIndex, segment] of plan.segments.entries()) {
    const fromNodeId = refs.get(segment.fromRef);
    const toNodeId = refs.get(segment.toRef);
    if (fromNodeId === undefined || toNodeId === undefined) {
      throw new AdoptionAbort('PREVIEW_STALE');
    }
    const edge = await transaction.transportEdge.create({
      data: {
        tripId: input.tripId,
        fromNodeId,
        toNodeId,
        mode: segment.mode,
        fixedService: segment.fixedService,
        serviceLabel: segment.serviceLabel,
        note: null,
        source: 'ADOPTED_ROUTE',
        adoptedRouteId: adoptedRoute.id,
        provider: preview.candidateSnapshot.provider,
        providerRef: segment.providerRef,
      },
    });
    delta.createdTransportEdgeIds.push(edge.id);
    const sourceRef = `snapshot:${preview.candidateSnapshotId}/candidate:${payload.candidate.candidateId}/leg:${segment.legIndex ?? segmentIndex}`;
    const temporalValues = [
      segment.departure === null
        ? null
        : {
            transportEdgeId: edge.id,
            layer: 'PLANNED' as const,
            pointKind: 'DEPARTURE' as const,
            instant: new Date(segment.departure.instant),
            timeZone: segment.departure.timeZone,
            sourceKind: 'ADOPTED_TRANSPORT_FACT' as const,
            sourceRef,
            observedAt: preview.candidateSnapshot.observedAt,
          },
      segment.arrival === null
        ? null
        : {
            transportEdgeId: edge.id,
            layer: 'PLANNED' as const,
            pointKind: 'ARRIVAL' as const,
            instant: new Date(segment.arrival.instant),
            timeZone: segment.arrival.timeZone,
            sourceKind: 'ADOPTED_TRANSPORT_FACT' as const,
            sourceRef,
            observedAt: preview.candidateSnapshot.observedAt,
          },
    ].filter((value) => value !== null);
    if (temporalValues.length > 0) {
      await transaction.temporalValue.createMany({ data: temporalValues });
    }
    const projections = await createTransportDayProjections(
      transaction,
      input.tripId,
      edge.id,
      fromNodeId,
      toNodeId,
    );
    delta.createdDayProjections.push(...projections);
    delta.affectedDayOccurrenceIds.push(
      ...projections.map((projection) => projection.dayOccurrenceId),
    );
  }

  await assertCurrentAdjacency(transaction, input.tripId);
  const range = await reconcileDateOwnership(
    transaction,
    input.ownerUserId,
    input.tripId,
  );
  await transaction.trip.update({
    where: { id: input.tripId },
    data: {
      effectiveStartDate: range.minimum,
      effectiveEndDate: range.maximum,
      version: { increment: 1 },
    },
  });
  delta.afterCorridorNodeIds = [
    plan.anchorFromNodeId,
    ...plan.nodePlans.map((planNode) => resolvedNodes.refs.get(planNode.ref)!),
    plan.anchorToNodeId,
  ];
  delta.affectedDayOccurrenceIds = [...new Set(delta.affectedDayOccurrenceIds)];
  const completeDelta: RouteAdoptDeltaV3 = delta;
  const finalReceipt = await transaction.operationReceipt.update({
    where: { id: receipt.id },
    data: { delta: completeDelta as unknown as Prisma.InputJsonValue },
  });
  await transaction.outboxEvent.create({
    data: {
      type: 'ROUTE_ADOPTED',
      aggregateType: 'AdoptedRoute',
      aggregateId: adoptedRoute.id,
      tripId: input.tripId,
      operationReceiptId: receipt.id,
      payload: {
        operationReceiptId: receipt.id,
        tripId: input.tripId,
        resultingTripVersion: input.baseTripVersion + 1,
        adoptedRouteId: adoptedRoute.id,
      },
      createdAt: input.now,
    },
  });
  return {
    status: 'SUCCESS',
    receipt: toReceiptRecord(finalReceipt),
    idempotentReplay: false,
  };
}

function requireCurrentPlan(payload: StoredRoutePreviewPayload) {
  const summary = payload.changeSummary;
  if (
    summary.routeCorridor === undefined ||
    summary.nodesToCreate === undefined ||
    summary.nodesToReuse === undefined ||
    summary.nodesToRemove === undefined ||
    summary.protectedBlockingNodes === undefined ||
    summary.willReplaceTransportEdgeIds === undefined ||
    !Array.isArray(summary.proposedSegments)
  ) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  return {
    anchorFromNodeId: summary.routeCorridor.anchorFromNodeId,
    anchorToNodeId: summary.routeCorridor.anchorToNodeId,
    currentNodeIds: [...summary.routeCorridor.currentNodeIds],
    currentAdoptedRouteId: summary.routeCorridor.currentAdoptedRouteId,
    nodesToRemove: [...summary.nodesToRemove],
    protectedBlockingNodes: [...summary.protectedBlockingNodes],
    willReplaceTransportEdgeIds: [...summary.willReplaceTransportEdgeIds],
    nodePlans: [...summary.nodesToCreate, ...summary.nodesToReuse].sort(
      (left, right) => refIndex(left.ref) - refIndex(right.ref),
    ),
    segments: [...summary.proposedSegments],
    requiredUserAdjustments: [...(summary.requiredUserAdjustments ?? [])].sort(
      compareCanonicalDwellAdjustments,
    ),
  };
}

async function validateCurrentCorridor(
  transaction: Transaction,
  tripId: string,
  plan: ReturnType<typeof requireCurrentPlan>,
): Promise<{ readonly nodeIds: string[] } | null> {
  const nodes = await transaction.itineraryNode.findMany({
    where: { tripId },
    select: { id: true, kind: true, source: true, adoptedRouteId: true },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const fromIndex = nodes.findIndex(
    (node) => node.id === plan.anchorFromNodeId,
  );
  const toIndex = nodes.findIndex((node) => node.id === plan.anchorToNodeId);
  if (fromIndex < 0 || toIndex <= fromIndex) return null;
  const corridor = nodes.slice(fromIndex, toIndex + 1);
  if (
    corridor[0]?.kind !== 'PLACE_VISIT' ||
    corridor.at(-1)?.kind !== 'PLACE_VISIT' ||
    !sameArray(
      corridor.map((node) => node.id),
      plan.currentNodeIds,
    )
  ) {
    return null;
  }
  if (
    plan.currentAdoptedRouteId !== null &&
    corridor
      .slice(1, -1)
      .some(
        (node) =>
          node.source !== 'ROUTE_GENERATED' ||
          node.adoptedRouteId !== plan.currentAdoptedRouteId,
      )
  ) {
    return null;
  }
  if (plan.currentAdoptedRouteId !== null) {
    const [currentRoute, activeRouteCount] = await Promise.all([
      transaction.adoptedRoute.findFirst({
        where: {
          id: plan.currentAdoptedRouteId,
          tripId,
          anchorFromNodeId: plan.anchorFromNodeId,
          anchorToNodeId: plan.anchorToNodeId,
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
      transaction.adoptedRoute.count({
        where: {
          tripId,
          anchorFromNodeId: plan.anchorFromNodeId,
          anchorToNodeId: plan.anchorToNodeId,
          status: 'ACTIVE',
        },
      }),
    ]);
    if (currentRoute === null || activeRouteCount !== 1) return null;
  } else {
    const activeRouteCount = await transaction.adoptedRoute.count({
      where: {
        tripId,
        anchorFromNodeId: plan.anchorFromNodeId,
        anchorToNodeId: plan.anchorToNodeId,
        status: 'ACTIVE',
      },
    });
    if (activeRouteCount !== 0) return null;
  }
  const expectedPairs = corridor.slice(0, -1).map((node, index) => ({
    fromNodeId: node.id,
    toNodeId: corridor[index + 1]!.id,
  }));
  const edges = await transaction.transportEdge.findMany({
    where: { tripId, OR: expectedPairs },
    select: {
      id: true,
      fromNodeId: true,
      toNodeId: true,
      source: true,
      adoptedRouteId: true,
    },
    orderBy: { id: 'asc' },
  });
  if (
    plan.currentAdoptedRouteId !== null &&
    (edges.length !== expectedPairs.length ||
      edges.some(
        (edge) =>
          edge.source !== 'ADOPTED_ROUTE' ||
          edge.adoptedRouteId !== plan.currentAdoptedRouteId,
      ))
  ) {
    return null;
  }
  const edgeIds = edges.map((edge) => edge.id);
  if (!sameArray(edgeIds, [...plan.willReplaceTransportEdgeIds].sort())) {
    return null;
  }
  return { nodeIds: corridor.map((node) => node.id) };
}

function sameAdjustments(
  expected: readonly {
    readonly intentId: string;
    readonly nodeId: string;
    readonly fromDurationSeconds: number;
    readonly toDurationSeconds: number;
  }[],
  actual: readonly {
    readonly intentId: string;
    readonly nodeId: string;
    readonly fromDurationSeconds: number;
    readonly toDurationSeconds: number;
  }[],
): boolean {
  const normalizedActual = [...actual].sort(compareCanonicalDwellAdjustments);
  return (
    expected.length === normalizedActual.length &&
    expected.every((value, index) => {
      const candidate = normalizedActual[index];
      return (
        candidate !== undefined &&
        candidate.intentId === value.intentId &&
        candidate.nodeId === value.nodeId &&
        candidate.fromDurationSeconds === value.fromDurationSeconds &&
        candidate.toDurationSeconds === value.toDurationSeconds
      );
    })
  );
}

async function resolveGeneratedNodes(
  transaction: Transaction,
  input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly adoptedRouteId: string;
    readonly receiptId: string;
    readonly provider: string;
    readonly anchorFromNodeId: string;
    readonly anchorToNodeId: string;
    readonly nodes: readonly RoutePreviewGeneratedNodePlanView[];
    readonly now: Date;
  },
) {
  const anchorNodes = await transaction.itineraryNode.findMany({
    where: { id: { in: [input.anchorFromNodeId, input.anchorToNodeId] } },
    include: { dayOccurrence: true },
  });
  const from = anchorNodes.find((node) => node.id === input.anchorFromNodeId);
  const to = anchorNodes.find((node) => node.id === input.anchorToNodeId);
  if (from === undefined || to === undefined)
    throw new AdoptionAbort('PREVIEW_STALE');

  const refs = new Map<string, string>();
  const createdNodeIds: string[] = [];
  const reusedNodeIds: string[] = [];
  const createdPlaceIds: string[] = [];
  const createdDayOccurrenceIds: string[] = [];
  const affectedOccurrenceIds = new Set<string>([
    from.dayOccurrenceId,
    to.dayOccurrenceId,
  ]);
  let lastCreatedDate: string | null = null;
  let lastCreatedOccurrenceId: string | null = null;
  for (const plan of input.nodes) {
    let occurrenceId = plan.dayOccurrenceId;
    if (occurrenceId !== null) {
      const occurrence = await transaction.dayOccurrence.findFirst({
        where: { id: occurrenceId, tripId: input.tripId },
      });
      if (
        occurrence === null ||
        localDate(occurrence.localDate) !== plan.localDate
      ) {
        throw new AdoptionAbort('PREVIEW_STALE');
      }
    } else if (plan.localDate === localDate(from.dayOccurrence.localDate)) {
      occurrenceId = from.dayOccurrenceId;
    } else if (plan.localDate === localDate(to.dayOccurrence.localDate)) {
      occurrenceId = to.dayOccurrenceId;
    } else if (
      lastCreatedDate === plan.localDate &&
      lastCreatedOccurrenceId !== null
    ) {
      occurrenceId = lastCreatedOccurrenceId;
    } else {
      const reusableOccurrence = await transaction.dayOccurrence.findFirst({
        where: {
          tripId: input.tripId,
          localDate: parseLocalDate(plan.localDate),
          sequence: {
            gt: from.dayOccurrence.sequence,
            lt: to.dayOccurrence.sequence,
          },
          nodes: { none: {} },
          transportProjections: { none: { role: 'OCCUPIED' } },
        },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      });
      if (reusableOccurrence !== null) {
        occurrenceId = reusableOccurrence.id;
        lastCreatedDate = plan.localDate;
        lastCreatedOccurrenceId = reusableOccurrence.id;
      } else {
        const maximum = await transaction.dayOccurrence.aggregate({
          where: { tripId: input.tripId },
          _max: { sequence: true },
        });
        const occurrence = await transaction.dayOccurrence.create({
          data: {
            tripId: input.tripId,
            localDate: parseLocalDate(plan.localDate),
            sequence: (maximum._max.sequence ?? -1) + 100,
          },
        });
        occurrenceId = occurrence.id;
        createdDayOccurrenceIds.push(occurrence.id);
        lastCreatedDate = plan.localDate;
        lastCreatedOccurrenceId = occurrence.id;
      }
    }
    affectedOccurrenceIds.add(occurrenceId);
    if (plan.action === 'REUSE') {
      if (plan.nodeId === null) throw new AdoptionAbort('PREVIEW_STALE');
      const node = await transaction.itineraryNode.findFirst({
        where: {
          id: plan.nodeId,
          tripId: input.tripId,
          source: 'ROUTE_GENERATED',
        },
      });
      if (node === null) throw new AdoptionAbort('PREVIEW_STALE');
      await transaction.itineraryNode.update({
        where: { id: node.id },
        data: {
          dayOccurrenceId: occurrenceId,
          position: 1_000_000 + refIndex(plan.ref),
          adoptedRouteId: input.adoptedRouteId,
          provider: input.provider,
          providerPlaceRef: plan.providerPlaceRef,
          providerHubRef: plan.providerHubRef,
          sourceOperationId: input.receiptId,
        },
      });
      refs.set(plan.ref, node.id);
      reusedNodeIds.push(node.id);
      continue;
    }
    if (
      plan.location.latitude === null ||
      plan.location.longitude === null ||
      plan.location.name.trim() === ''
    ) {
      throw new AdoptionAbort('PREVIEW_STALE');
    }
    const place = await transaction.place.create({
      data: {
        ownerUserId: input.ownerUserId,
        name: plan.location.name,
        latitude: plan.location.latitude,
        longitude: plan.location.longitude,
        address: null,
      },
    });
    const node = await transaction.itineraryNode.create({
      data: {
        tripId: input.tripId,
        dayOccurrenceId: occurrenceId,
        kind: 'PLACE_VISIT',
        position: 1_000_000 + refIndex(plan.ref),
        placeId: place.id,
        note: null,
        source: 'ROUTE_GENERATED',
        adoptedRouteId: input.adoptedRouteId,
        provider: input.provider,
        providerPlaceRef: plan.providerPlaceRef,
        providerHubRef: plan.providerHubRef,
        sourceOperationId: input.receiptId,
        autoReplaceable: true,
      },
    });
    refs.set(plan.ref, node.id);
    createdNodeIds.push(node.id);
    createdPlaceIds.push(place.id);
  }

  await rewriteOccurrenceAndNodeOrder(transaction, input.tripId, {
    anchorFromNodeId: input.anchorFromNodeId,
    anchorToNodeId: input.anchorToNodeId,
    routeNodeIds: input.nodes.map((node) => refs.get(node.ref)!),
  });
  return {
    refs,
    createdNodeIds,
    reusedNodeIds,
    createdPlaceIds,
    createdDayOccurrenceIds,
    affectedOccurrenceIds: [...affectedOccurrenceIds],
  };
}

async function rewriteOccurrenceAndNodeOrder(
  transaction: Transaction,
  tripId: string,
  input: {
    readonly anchorFromNodeId: string;
    readonly anchorToNodeId: string;
    readonly routeNodeIds: readonly string[];
  },
): Promise<void> {
  const nodes = await transaction.itineraryNode.findMany({
    where: { tripId },
    select: { id: true, dayOccurrenceId: true },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const fromIndex = nodes.findIndex(
    (node) => node.id === input.anchorFromNodeId,
  );
  const toIndex = nodes.findIndex((node) => node.id === input.anchorToNodeId);
  if (fromIndex < 0 || toIndex < 0) throw new AdoptionAbort('PREVIEW_STALE');
  const routeSet = new Set(input.routeNodeIds);
  const withoutRoute = nodes.filter((node) => !routeSet.has(node.id));
  const fromWithout = withoutRoute.findIndex(
    (node) => node.id === input.anchorFromNodeId,
  );
  const toWithout = withoutRoute.findIndex(
    (node) => node.id === input.anchorToNodeId,
  );
  if (fromWithout < 0 || toWithout <= fromWithout) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  const routeNodes = input.routeNodeIds.map((id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node === undefined) throw new AdoptionAbort('PREVIEW_STALE');
    return node;
  });
  const ordered = [...withoutRoute];
  ordered.splice(fromWithout + 1, 0, ...routeNodes);

  const allOccurrences = await transaction.dayOccurrence.findMany({
    where: { tripId },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  });
  const fromOccurrenceId = ordered.find(
    (node) => node.id === input.anchorFromNodeId,
  )?.dayOccurrenceId;
  const toOccurrenceId = ordered.find(
    (node) => node.id === input.anchorToNodeId,
  )?.dayOccurrenceId;
  if (fromOccurrenceId === undefined || toOccurrenceId === undefined) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  const baseOrder = allOccurrences.map((occurrence) => occurrence.id);
  const fromOccurrenceIndex = baseOrder.indexOf(fromOccurrenceId);
  const toOccurrenceIndex = baseOrder.indexOf(toOccurrenceId);
  if (fromOccurrenceIndex < 0 || toOccurrenceIndex < fromOccurrenceIndex) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  const routeOccurrenceIds = [
    ...new Set(routeNodes.map((node) => node.dayOccurrenceId)),
  ].filter((id) => id !== fromOccurrenceId && id !== toOccurrenceId);
  const occurrenceOrder =
    fromOccurrenceId === toOccurrenceId
      ? baseOrder
      : [
          ...baseOrder.slice(0, fromOccurrenceIndex),
          fromOccurrenceId,
          ...routeOccurrenceIds,
          ...baseOrder
            .slice(fromOccurrenceIndex + 1, toOccurrenceIndex)
            .filter((id) => !routeOccurrenceIds.includes(id)),
          toOccurrenceId,
          ...baseOrder
            .slice(toOccurrenceIndex + 1)
            .filter((id) => !routeOccurrenceIds.includes(id)),
        ];
  const offset = allOccurrences.length * 2 + 100;
  await transaction.$executeRaw(Prisma.sql`
    UPDATE "DayOccurrence"
    SET "sequence" = "sequence" + ${offset}
    WHERE "tripId" = ${tripId}::uuid
  `);
  for (const [sequence, occurrenceId] of occurrenceOrder.entries()) {
    await transaction.dayOccurrence.update({
      where: { id: occurrenceId },
      data: { sequence },
    });
    const nodeIds = ordered
      .filter((node) => node.dayOccurrenceId === occurrenceId)
      .map((node) => node.id);
    if (nodeIds.length === 0) continue;
    await transaction.$executeRaw(Prisma.sql`
      UPDATE "ItineraryNode"
      SET "position" = "position" + ${nodeIds.length * 2 + 100}
      WHERE "dayOccurrenceId" = ${occurrenceId}::uuid
    `);
    for (const [position, nodeId] of nodeIds.entries()) {
      await transaction.itineraryNode.update({
        where: { id: nodeId },
        data: { position },
      });
    }
  }
}

async function createTransportDayProjections(
  transaction: Transaction,
  tripId: string,
  transportEdgeId: string,
  fromNodeId: string,
  toNodeId: string,
) {
  const nodes = await transaction.itineraryNode.findMany({
    where: { id: { in: [fromNodeId, toNodeId] }, tripId },
    include: { dayOccurrence: true },
  });
  const from = nodes.find((node) => node.id === fromNodeId);
  const to = nodes.find((node) => node.id === toNodeId);
  if (from === undefined || to === undefined)
    throw new AdoptionAbort('PREVIEW_STALE');
  if (to.dayOccurrence.sequence < from.dayOccurrence.sequence) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  const occurrences = await transaction.dayOccurrence.findMany({
    where: {
      tripId,
      sequence: {
        gte: from.dayOccurrence.sequence,
        lte: to.dayOccurrence.sequence,
      },
    },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  });
  const rows = occurrences.map((occurrence, index) => ({
    tripId,
    transportEdgeId,
    dayOccurrenceId: occurrence.id,
    role:
      occurrences.length === 1
        ? ('SAME_DAY' as const)
        : index === 0
          ? ('START' as const)
          : index === occurrences.length - 1
            ? ('END' as const)
            : ('OCCUPIED' as const),
  }));
  await transaction.transportDayProjection.createMany({ data: rows });
  return rows;
}

async function assertCurrentAdjacency(
  transaction: Transaction,
  tripId: string,
): Promise<void> {
  const nodes = await transaction.itineraryNode.findMany({
    where: { tripId },
    select: { id: true },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const adjacency = new Set<string>();
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    adjacency.add(`${nodes[index]!.id}:${nodes[index + 1]!.id}`);
  }
  const edges = await transaction.transportEdge.findMany({
    where: { tripId },
    select: { fromNodeId: true, toNodeId: true },
  });
  if (
    edges.some((edge) => !adjacency.has(`${edge.fromNodeId}:${edge.toNodeId}`))
  ) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
}

async function reconcileDateOwnership(
  transaction: Transaction,
  ownerUserId: string,
  tripId: string,
) {
  const occurrences = await transaction.dayOccurrence.findMany({
    where: { tripId },
    select: {
      id: true,
      localDate: true,
      sequence: true,
      _count: { select: { nodes: true, transportProjections: true } },
    },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  });
  const hasContent = (occurrence: (typeof occurrences)[number]) =>
    occurrence._count.nodes > 0 || occurrence._count.transportProjections > 0;
  const first = occurrences.findIndex(hasContent);
  const last = occurrences.findLastIndex(hasContent);
  if (first < 0 || last < first) throw new AdoptionAbort('PREVIEW_STALE');
  const retained = occurrences.slice(first, last + 1);
  await transaction.dayOccurrence.deleteMany({
    where: { tripId, id: { notIn: retained.map((item) => item.id) } },
  });
  const minimum = new Date(
    Math.min(...retained.map((item) => item.localDate.getTime())),
  );
  const maximum = new Date(
    Math.max(...retained.map((item) => item.localDate.getTime())),
  );
  const conflict = await transaction.dateOwnership.findFirst({
    where: {
      ownerUserId,
      localDate: { gte: minimum, lte: maximum },
      NOT: { tripId },
    },
  });
  if (conflict !== null) throw new AdoptionAbort('DATE_OWNED');
  await transaction.dateOwnership.deleteMany({ where: { tripId } });
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO "DateOwnership" ("ownerUserId", "localDate", "tripId")
    SELECT ${ownerUserId}::uuid, day::date, ${tripId}::uuid
    FROM generate_series(${minimum}::date, ${maximum}::date, interval '1 day') AS day
  `);
  return { minimum, maximum };
}

async function lockOwner(
  transaction: Transaction,
  ownerUserId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<AdvisoryLockRow[]>(Prisma.sql`
    SELECT TRUE AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 2))
  `);
  if (rows[0]?.locked !== true)
    throw new Error('Route adoption owner lock failed');
}

function toReceiptRecord(receipt: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly operationType: 'ROUTE_ADOPT' | 'ROUTE_UNDO';
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly baseTripVersion: number;
  readonly resultingTripVersion: number;
  readonly previewId: string;
  readonly adoptedRouteId: string;
  readonly targetOperationReceiptId: string | null;
  readonly undoExpiresAt: Date | null;
  readonly delta: Prisma.JsonValue;
  readonly createdAt: Date;
}): OperationReceiptRecord {
  return {
    ...receipt,
    delta: receipt.delta as unknown as OperationReceiptRecord['delta'],
  };
}

function refIndex(ref: string): number {
  const match = /^TRANSFER_(\d+)$/u.exec(ref);
  if (match === null) throw new AdoptionAbort('PREVIEW_STALE');
  return Number(match[1]);
}

function toGeneratedNodeSnapshot(node: {
  readonly id: string;
  readonly tripId: string;
  readonly dayOccurrenceId: string;
  readonly kind: 'PLACE_VISIT' | 'FREE_ACTION';
  readonly position: number;
  readonly placeId: string | null;
  readonly note: string | null;
  readonly source: 'USER_PLANNED' | 'ROUTE_GENERATED';
  readonly adoptedRouteId: string | null;
  readonly provider: string | null;
  readonly providerPlaceRef: string | null;
  readonly providerHubRef: string | null;
  readonly sourceOperationId: string | null;
  readonly autoReplaceable: boolean;
  readonly userModifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): RouteAdoptGeneratedNodeSnapshot {
  if (
    node.kind !== 'PLACE_VISIT' ||
    node.source !== 'ROUTE_GENERATED' ||
    node.placeId === null ||
    node.adoptedRouteId === null ||
    node.provider === null ||
    node.sourceOperationId === null
  ) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  return {
    id: node.id,
    tripId: node.tripId,
    dayOccurrenceId: node.dayOccurrenceId,
    kind: node.kind,
    position: node.position,
    placeId: node.placeId,
    note: node.note,
    source: node.source,
    adoptedRouteId: node.adoptedRouteId,
    provider: node.provider,
    providerPlaceRef: node.providerPlaceRef,
    providerHubRef: node.providerHubRef,
    sourceOperationId: node.sourceOperationId,
    autoReplaceable: node.autoReplaceable,
    userModifiedAt: node.userModifiedAt?.toISOString() ?? null,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}

function parseLocalDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || localDate(date) !== value) {
    throw new AdoptionAbort('PREVIEW_STALE');
  }
  return date;
}

function localDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isDateOwnershipConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target).includes('DateOwnership')
  );
}

class AdoptionAbort extends Error {
  constructor(
    readonly status: Exclude<AdoptRoutePreviewResult['status'], 'SUCCESS'>,
  ) {
    super(status);
  }
}
