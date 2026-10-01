import {
  externalGeneratedNodeFacts,
  externalGroundTransitExecutionFacts,
  lockExternalGroundTransitExecutionRows,
  hashExternalRouteAudit,
  lockExternalRouteMutationRows,
} from './prisma-external-route-state.js';
import { nodeDeletionReferenceInclude } from './prisma-node-deletion-protection.js';
import type {
  OperationReceiptRecord,
  UndoRouteAdoptionResult,
} from '@travel/application';
import { compareCanonicalText } from '@travel/application';
import type {
  RouteAdoptDeltaV2,
  RouteAdoptDeltaV3,
  RouteAdoptDeltaV4,
  RouteAdoptDeltaV5,
  RouteUndoDeltaV3,
  RouteAdoptGeneratedNodeSnapshot,
  RouteUndoDeltaV2,
} from '@travel/contracts';

import { hashPreservedRoutePrefix } from './prisma-route-prefix.js';
import { resolveCurrentRouteReplacementCorridor } from '@travel/domain';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;
type RouteAdoptUndoBasis =
  RouteAdoptDeltaV2 | RouteAdoptDeltaV3 | RouteAdoptDeltaV4 | RouteAdoptDeltaV5;

interface UndoInput {
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly targetOperationReceiptId: string;
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly now: Date;
}

interface LockedTripRow {
  readonly id: string;
  readonly version: number;
}

interface AdvisoryLockRow {
  readonly locked: boolean;
}

export async function undoRouteAdoption(
  client: PrismaClient,
  input: UndoInput,
): Promise<UndoRouteAdoptionResult> {
  try {
    return await client.$transaction(
      async (transaction) => executeUndo(transaction, input),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (error) {
    if (error instanceof UndoAbort) return { status: error.status };
    if (isExpectedUndoConstraint(error)) return { status: 'UNDO_CONFLICT' };
    throw error;
  }
}

async function executeUndo(
  transaction: Transaction,
  input: UndoInput,
): Promise<UndoRouteAdoptionResult> {
  await lockOwner(transaction, input.ownerUserId);
  const existingReceipt = await transaction.operationReceipt.findFirst({
    where: {
      ownerUserId: input.ownerUserId,
      tripId: input.tripId,
      operationType: 'ROUTE_UNDO',
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
    SELECT "id", "version"
    FROM "Trip"
    WHERE "id" = ${input.tripId}::uuid
      AND "ownerUserId" = ${input.ownerUserId}::uuid
    FOR UPDATE
  `);
  const trip = tripRows[0];
  if (trip === undefined) return { status: 'NOT_FOUND' };

  const target = await transaction.operationReceipt.findFirst({
    where: {
      id: input.targetOperationReceiptId,
      ownerUserId: input.ownerUserId,
      tripId: input.tripId,
    },
  });
  if (target === null) return { status: 'NOT_FOUND' };
  if (target.operationType !== 'ROUTE_ADOPT') {
    return { status: 'UNDO_UNAVAILABLE' };
  }
  const delta = parseRouteAdoptDelta(target.delta, target.adoptedRouteId);
  if (delta === null || target.undoExpiresAt === null) {
    return { status: 'UNDO_UNAVAILABLE' };
  }
  if (input.now >= target.undoExpiresAt) return { status: 'UNDO_EXPIRED' };
  if (
    trip.version !== input.baseTripVersion ||
    trip.version !== target.resultingTripVersion ||
    input.baseTripVersion !== target.resultingTripVersion
  ) {
    return { status: 'UNDO_CONFLICT' };
  }
  const priorUndo = await transaction.operationReceipt.findUnique({
    where: { targetOperationReceiptId: target.id },
    select: { id: true },
  });
  if (priorUndo !== null) return { status: 'UNDO_CONFLICT' };

  if (delta.schemaVersion === 'route-adopt-delta-v5') {
    await lockExternalRouteMutationRows(
      transaction,
      input.tripId,
      [
        ...delta.createdNodeIds,
        ...delta.reusedNodeIds,
        ...delta.preservedPrefixNodeIds,
      ],
      [
        ...delta.createdTransportEdgeIds,
        ...delta.preservedPrefixTransportEdgeIds,
      ],
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "AdoptedRoute" WHERE "tripId"=${input.tripId}::uuid AND "id" IN (${target.adoptedRouteId}::uuid, ${delta.sourceAdoptedRouteId}::uuid) ORDER BY "id" FOR UPDATE`,
    );
    await lockExternalGroundTransitExecutionRows(
      transaction,
      input.tripId,
      target.adoptedRouteId,
    );
  }
  const state = await validateCurrentUndoState(
    transaction,
    input,
    target,
    delta,
  );
  if (state === null) return { status: 'UNDO_CONFLICT' };

  const leaveActive = await transaction.adoptedRoute.updateMany({
    where: {
      id: target.adoptedRouteId,
      tripId: input.tripId,
      status: 'ACTIVE',
    },
    data: {
      status: 'UNDONE',
      replacedAt: null,
      undoneAt: input.now,
      ...(delta.schemaVersion === 'route-adopt-delta-v5'
        ? { anchorFromNodeId: null }
        : {}),
    },
  });
  if (leaveActive.count !== 1) throw new UndoAbort('UNDO_CONFLICT');

  await transaction.transportEdge.deleteMany({
    where: {
      id: { in: [...delta.createdTransportEdgeIds] },
      tripId: input.tripId,
    },
  });
  await transaction.itineraryNode.deleteMany({
    where: { id: { in: [...delta.createdNodeIds] }, tripId: input.tripId },
  });

  for (const placeId of delta.createdPlaceIds) {
    const place = await transaction.place.findFirst({
      where: { id: placeId, ownerUserId: input.ownerUserId },
      select: { id: true, _count: { select: { visits: true } } },
    });
    if (place === null || place._count.visits !== 0) {
      throw new UndoAbort('UNDO_CONFLICT');
    }
    await transaction.place.delete({ where: { id: place.id } });
  }

  let restoredOccurrenceIds: string[];
  let restoredNodeIds: string[];
  if (delta.schemaVersion === 'route-adopt-delta-v5') {
    restoredOccurrenceIds = await restoreDayOccurrences(
      transaction,
      input.tripId,
      delta,
      input.now,
    );
    restoredNodeIds = await restoreGeneratedNodes(
      transaction,
      input.tripId,
      delta,
    );
    await restoreNodePlacements(transaction, input.tripId, delta);
  }
  const removedCreatedOccurrenceIds: string[] = [];
  for (const occurrenceId of delta.createdDayOccurrenceIds) {
    const occurrence = await transaction.dayOccurrence.findFirst({
      where: { id: occurrenceId, tripId: input.tripId },
      select: {
        id: true,
        _count: { select: { nodes: true, transportProjections: true } },
      },
    });
    if (occurrence === null) continue;
    if (
      occurrence._count.nodes !== 0 ||
      occurrence._count.transportProjections !== 0
    ) {
      throw new UndoAbort('UNDO_CONFLICT');
    }
    await transaction.dayOccurrence.delete({ where: { id: occurrence.id } });
    removedCreatedOccurrenceIds.push(occurrence.id);
  }

  if (delta.schemaVersion !== 'route-adopt-delta-v5') {
    restoredOccurrenceIds = await restoreDayOccurrences(
      transaction,
      input.tripId,
      delta,
      input.now,
    );
    restoredNodeIds = await restoreGeneratedNodes(
      transaction,
      input.tripId,
      delta,
    );
    await restoreNodePlacements(transaction, input.tripId, delta);
  }
  const restoredTransportEdgeIds: string[] = [];
  for (const history of state.histories) {
    await transaction.transportEdge.create({
      data: {
        id: history.originalTransportEdgeId,
        tripId: history.tripId,
        fromNodeId: history.originalFromNodeId,
        toNodeId: history.originalToNodeId,
        mode: history.mode,
        fixedService: history.fixedService,
        serviceLabel: history.serviceLabel,
        note: history.note,
        source: history.source,
        adoptedRouteId: history.adoptedRouteId,
        provider: history.provider,
        providerRef: history.providerRef,
        createdAt: history.originalCreatedAt,
      },
    });
    if (history.temporalValues.length > 0) {
      await transaction.temporalValue.createMany({
        data: history.temporalValues.map((value) => ({
          transportEdgeId: history.originalTransportEdgeId,
          layer: value.layer,
          pointKind: value.pointKind,
          instant: value.instant,
          timeZone: value.timeZone,
          sourceKind: value.sourceKind,
          sourceRef: value.sourceRef,
          observedAt: value.observedAt,
          createdAt: value.originalCreatedAt,
          updatedAt: value.originalUpdatedAt,
        })),
      });
    }
    const projections = delta.removedDayProjections.filter(
      (projection) =>
        projection.transportEdgeId === history.originalTransportEdgeId,
    );
    if (projections.length > 0) {
      await transaction.transportDayProjection.createMany({
        data: projections.map((projection) => ({
          tripId: input.tripId,
          transportEdgeId: history.originalTransportEdgeId,
          dayOccurrenceId: projection.dayOccurrenceId,
          role: projection.role,
        })),
      });
    }
    restoredTransportEdgeIds.push(history.originalTransportEdgeId);
    await transaction.transportEdgeHistory.delete({
      where: { id: history.id },
    });
  }

  if (delta.previousActiveAdoptedRouteId !== null) {
    const restoredRoute = await transaction.adoptedRoute.updateMany({
      where: {
        id: delta.previousActiveAdoptedRouteId,
        tripId: input.tripId,
        status: 'REPLACED',
      },
      data: { status: 'ACTIVE', replacedAt: null, undoneAt: null },
    });
    if (restoredRoute.count !== 1) throw new UndoAbort('UNDO_CONFLICT');
  }

  await transaction.job.updateMany({
    where: {
      type: 'GROUND_TRANSIT_MONITOR',
      payloadRef: target.adoptedRouteId,
      status: 'QUEUED',
    },
    data: {
      status: 'CANCELLED',
      cancelRequested: true,
      cancelledAt: input.now,
      completedAt: input.now,
    },
  });
  await transaction.job.updateMany({
    where: {
      type: 'GROUND_TRANSIT_MONITOR',
      payloadRef: target.adoptedRouteId,
      status: 'RUNNING',
    },
    data: { cancelRequested: true },
  });

  await restoreDateOwnership(transaction, input, delta);
  const restoredUserTimeIntentIds: string[] = [];
  if (delta.schemaVersion !== 'route-adopt-delta-v2') {
    for (const adjustment of delta.userDwellAdjustments) {
      const restored = await transaction.userTimeIntent.updateMany({
        where: {
          id: adjustment.intentId,
          tripId: input.tripId,
          nodeId: adjustment.nodeId,
          kind: 'MIN_DWELL',
          operator: 'MINIMUM',
          durationSeconds: adjustment.afterDurationSeconds,
          locked: adjustment.beforeLocked,
        },
        data: { durationSeconds: adjustment.beforeDurationSeconds },
      });
      if (restored.count !== 1) throw new UndoAbort('UNDO_CONFLICT');
      restoredUserTimeIntentIds.push(adjustment.intentId);
    }
  }
  await assertAdjacency(transaction, input.tripId);
  await transaction.trip.update({
    where: { id: input.tripId },
    data: {
      effectiveStartDate:
        delta.beforeEffectiveStartDate === null
          ? null
          : parseLocalDate(delta.beforeEffectiveStartDate),
      effectiveEndDate:
        delta.beforeEffectiveEndDate === null
          ? null
          : parseLocalDate(delta.beforeEffectiveEndDate),
      version: { increment: 1 },
    },
  });

  const undoDelta: RouteUndoDeltaV2 = {
    schemaVersion: 'route-undo-delta-v2',
    targetOperationReceiptId: target.id,
    undoneAdoptedRouteId: target.adoptedRouteId,
    restoredAdoptedRouteId: delta.previousActiveAdoptedRouteId,
    removedCreatedNodeIds: [...delta.createdNodeIds],
    restoredNodeIds: restoredNodeIds!,
    removedCreatedTransportEdgeIds: [...delta.createdTransportEdgeIds],
    restoredTransportEdgeIds,
    restoredDayOccurrenceIds: restoredOccurrenceIds!,
    removedAdoptCreatedDayOccurrenceIds: removedCreatedOccurrenceIds,
    restoredOwnedDates: [...delta.beforeOwnedDates],
    restoredUserTimeIntentIds,
  };
  if (
    delta.schemaVersion === 'route-adopt-delta-v5' &&
    (await hashPreservedRoutePrefix(
      transaction,
      input.tripId,
      delta.preservedPrefixNodeIds,
      delta.preservedPrefixTransportEdgeIds,
    )) !== delta.preservedPrefixHash
  )
    throw new UndoAbort('UNDO_CONFLICT');
  const completeUndoDelta: RouteUndoDeltaV2 | RouteUndoDeltaV3 =
    delta.schemaVersion === 'route-adopt-delta-v5'
      ? {
          ...undoDelta,
          schemaVersion: 'route-undo-delta-v3',
          dematerializedExternalOriginNodeId: delta.materializedOriginNodeId,
          dematerializedExternalOriginPlaceId: delta.materializedOriginPlaceId,
          retainedExternalOriginId: delta.externalOriginId,
        }
      : undoDelta;
  const undoReceipt = await transaction.operationReceipt.create({
    data: {
      ownerUserId: input.ownerUserId,
      tripId: input.tripId,
      operationType: 'ROUTE_UNDO',
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      baseTripVersion: input.baseTripVersion,
      resultingTripVersion: input.baseTripVersion + 1,
      previewId: target.previewId,
      adoptedRouteId: target.adoptedRouteId,
      targetOperationReceiptId: target.id,
      undoExpiresAt: null,
      delta: completeUndoDelta as unknown as Prisma.InputJsonValue,
      createdAt: input.now,
    },
  });
  await transaction.outboxEvent.create({
    data: {
      type: 'ROUTE_UNDONE',
      aggregateType: 'AdoptedRoute',
      aggregateId: target.adoptedRouteId,
      tripId: input.tripId,
      operationReceiptId: undoReceipt.id,
      payload: {
        targetOperationReceiptId: target.id,
        undoneAdoptedRouteId: target.adoptedRouteId,
        restoredAdoptedRouteId: delta.previousActiveAdoptedRouteId,
        resultingTripVersion: input.baseTripVersion + 1,
      },
      createdAt: input.now,
    },
  });
  return {
    status: 'SUCCESS',
    receipt: toReceiptRecord(undoReceipt),
    idempotentReplay: false,
  };
}

async function validateCurrentUndoState(
  transaction: Transaction,
  input: UndoInput,
  target: {
    readonly id: string;
    readonly previewId: string;
    readonly adoptedRouteId: string;
  },
  delta: RouteAdoptUndoBasis,
) {
  if (delta.schemaVersion !== 'route-adopt-delta-v2') {
    const intents = await transaction.userTimeIntent.findMany({
      where: {
        id: { in: delta.userDwellAdjustments.map((item) => item.intentId) },
        tripId: input.tripId,
      },
      select: {
        id: true,
        nodeId: true,
        kind: true,
        operator: true,
        durationSeconds: true,
        locked: true,
      },
    });
    intents.sort((left, right) => compareCanonicalText(left.id, right.id));
    const expected = [...delta.userDwellAdjustments].sort((left, right) =>
      compareCanonicalText(left.intentId, right.intentId),
    );
    if (
      intents.length !== expected.length ||
      intents.some((intent, index) => {
        const adjustment = expected[index];
        return (
          adjustment === undefined ||
          intent.id !== adjustment.intentId ||
          intent.nodeId !== adjustment.nodeId ||
          intent.kind !== 'MIN_DWELL' ||
          intent.operator !== 'MINIMUM' ||
          intent.durationSeconds !== adjustment.afterDurationSeconds ||
          intent.locked !== adjustment.beforeLocked
        );
      })
    ) {
      return null;
    }
  }
  const targetRoute = await transaction.adoptedRoute.findFirst({
    where: {
      id: target.adoptedRouteId,
      tripId: input.tripId,
      status: 'ACTIVE',
    },
  });
  if (targetRoute === null || targetRoute.anchorFromNodeId === null)
    return null;
  if (
    delta.schemaVersion === 'route-adopt-delta-v5' &&
    (targetRoute.anchorOriginKind !== 'EXTERNAL_EXECUTION_ORIGIN' ||
      targetRoute.policyVersion !== 'route-external-origin-preview-v2' ||
      targetRoute.anchorFromNodeId !== delta.materializedOriginNodeId ||
      targetRoute.anchorFromExternalOriginId !== delta.externalOriginId ||
      targetRoute.anchorToNodeId !== delta.destinationNodeId ||
      hashExternalRouteAudit(targetRoute.anchorFromSnapshot) !==
        hashExternalRouteAudit(delta.materializedOriginAnchorSnapshot))
  )
    return null;
  if (
    delta.schemaVersion === 'route-adopt-delta-v4' &&
    (delta.replacementAnchorFromNodeId !== targetRoute.anchorFromNodeId ||
      delta.replacementAnchorToNodeId !== targetRoute.anchorToNodeId ||
      delta.sourceRouteAnchorToNodeId !== targetRoute.anchorToNodeId ||
      delta.beforeCorridorNodeIds[0] !== targetRoute.anchorFromNodeId ||
      delta.beforeCorridorNodeIds.at(-1) !== targetRoute.anchorToNodeId ||
      (delta.previousActiveAdoptedRouteId === null &&
        delta.replacementScope === 'SUFFIX'))
  )
    return null;
  if (
    delta.afterCorridorNodeIds[0] !== targetRoute.anchorFromNodeId ||
    delta.afterCorridorNodeIds.at(-1) !== targetRoute.anchorToNodeId ||
    delta.beforeGeneratedNodes.some(
      (snapshot) => snapshot.tripId !== input.tripId,
    )
  ) {
    return null;
  }

  const currentNodes = await transaction.itineraryNode.findMany({
    where: { tripId: input.tripId },
    select: { id: true },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const fromIndex = currentNodes.findIndex(
    (node) => node.id === targetRoute.anchorFromNodeId,
  );
  const toIndex = currentNodes.findIndex(
    (node) => node.id === targetRoute.anchorToNodeId,
  );
  if (
    fromIndex < 0 ||
    toIndex <= fromIndex ||
    !sameArray(
      currentNodes.slice(fromIndex, toIndex + 1).map((node) => node.id),
      delta.afterCorridorNodeIds,
    )
  ) {
    return null;
  }

  const expectedCurrentNodeIds = new Set(
    delta.beforeNodePlacements
      .map((placement) => placement.nodeId)
      .filter(
        (nodeId) =>
          !delta.removedGeneratedNodes.some((removed) => removed.id === nodeId),
      )
      .concat(delta.createdNodeIds),
  );
  if (
    currentNodes.length !== expectedCurrentNodeIds.size ||
    currentNodes.some((node) => !expectedCurrentNodeIds.has(node.id))
  ) {
    return null;
  }

  const [createdNodes, reusedNodes, createdEdges, histories, occurrences] =
    await Promise.all([
      transaction.itineraryNode.findMany({
        where: { id: { in: [...delta.createdNodeIds] }, tripId: input.tripId },
        include: {
          temporalValues: true,
          timeIntents: true,
          ...(delta.schemaVersion === 'route-adopt-delta-v5'
            ? nodeDeletionReferenceInclude
            : {
                _count: {
                  select: {
                    routeSnapshotsFrom: true,
                    routeSnapshotsTo: true,
                    adoptedRouteAnchorFrom: true,
                    adoptedRouteAnchorTo: true,
                  },
                },
              }),
        },
      }),
      transaction.itineraryNode.findMany({
        where: { id: { in: [...delta.reusedNodeIds] }, tripId: input.tripId },
        include: { temporalValues: true, timeIntents: true },
      }),
      transaction.transportEdge.findMany({
        where: {
          id: { in: [...delta.createdTransportEdgeIds] },
          tripId: input.tripId,
        },
        include: { temporalValues: true, dayProjections: true },
      }),
      transaction.transportEdgeHistory.findMany({
        where: {
          id: { in: [...delta.archivedTransportHistoryIds] },
          tripId: input.tripId,
        },
        include: { temporalValues: true },
        orderBy: { id: 'asc' },
      }),
      transaction.dayOccurrence.findMany({
        where: { tripId: input.tripId },
        select: { id: true },
      }),
    ] as const);
  if (
    createdNodes.length !== delta.createdNodeIds.length ||
    reusedNodes.length !== delta.reusedNodeIds.length ||
    createdEdges.length !== delta.createdTransportEdgeIds.length ||
    histories.length !== delta.archivedTransportHistoryIds.length
  ) {
    return null;
  }
  if (
    createdNodes.some(
      (node) =>
        node.source !== 'ROUTE_GENERATED' ||
        node.adoptedRouteId !== target.adoptedRouteId ||
        node.sourceOperationId !== target.id ||
        !node.autoReplaceable ||
        node.userModifiedAt !== null ||
        (node.note !== null && node.note.trim() !== '') ||
        node.timeIntents.length > 0 ||
        node.temporalValues.some((value) => value.layer === 'ACTUAL'),
    ) ||
    reusedNodes.some(
      (node) =>
        node.source !== 'ROUTE_GENERATED' ||
        node.adoptedRouteId !== target.adoptedRouteId ||
        node.sourceOperationId !== target.id ||
        !node.autoReplaceable ||
        node.userModifiedAt !== null ||
        (node.note !== null && node.note.trim() !== '') ||
        node.timeIntents.length > 0 ||
        node.temporalValues.some((value) => value.layer === 'ACTUAL'),
    )
  ) {
    return null;
  }
  if (
    createdNodes.some(
      (node) =>
        node.temporalValues.length > 0 ||
        node._count.routeSnapshotsFrom > 0 ||
        node._count.routeSnapshotsTo > 0 ||
        node._count.adoptedRouteAnchorFrom >
          (delta.schemaVersion === 'route-adopt-delta-v5' &&
          node.id === delta.materializedOriginNodeId
            ? 1
            : 0) ||
        node._count.adoptedRouteAnchorTo > 0,
    )
  ) {
    return null;
  }
  if (
    createdEdges.some(
      (edge) =>
        edge.source !== 'ADOPTED_ROUTE' ||
        edge.adoptedRouteId !== target.adoptedRouteId ||
        edge.temporalValues.some(
          (value) =>
            value.layer !== 'PLANNED' ||
            value.sourceKind !== 'ADOPTED_TRANSPORT_FACT',
        ),
    )
  ) {
    return null;
  }
  const corridorPairs = new Set(
    delta.afterCorridorNodeIds
      .slice(0, -1)
      .map(
        (nodeId, index) =>
          `${nodeId}:${delta.afterCorridorNodeIds[index + 1]!}`,
      ),
  );
  if (
    createdEdges.length !== corridorPairs.size ||
    createdEdges.some(
      (edge) => !corridorPairs.has(`${edge.fromNodeId}:${edge.toNodeId}`),
    )
  ) {
    return null;
  }
  const expectedCurrentProjectionKeys = new Set(
    delta.createdDayProjections.map(
      (projection) =>
        `${projection.transportEdgeId}:${projection.dayOccurrenceId}:${projection.role}`,
    ),
  );
  const currentProjectionKeys = createdEdges.flatMap((edge) =>
    edge.dayProjections.map(
      (projection) =>
        `${edge.id}:${projection.dayOccurrenceId}:${projection.role}`,
    ),
  );
  if (
    currentProjectionKeys.length !== expectedCurrentProjectionKeys.size ||
    currentProjectionKeys.some((key) => !expectedCurrentProjectionKeys.has(key))
  ) {
    return null;
  }
  const historyIds = new Set(histories.map((history) => history.id));
  if (
    delta.archivedTransportHistoryIds.some((id) => !historyIds.has(id)) ||
    histories.some(
      (history) =>
        !delta.beforeCorridorNodeIds.includes(history.originalFromNodeId) ||
        !delta.beforeCorridorNodeIds.includes(history.originalToNodeId),
    ) ||
    delta.removedDayProjections.some(
      (projection) =>
        !histories.some(
          (history) =>
            history.originalTransportEdgeId === projection.transportEdgeId,
        ),
    )
  ) {
    return null;
  }
  const allowedOccurrenceIds = new Set([
    ...delta.beforeDayOccurrences.map((occurrence) => occurrence.id),
    ...delta.createdDayOccurrenceIds,
  ]);
  if (
    occurrences.some((occurrence) => !allowedOccurrenceIds.has(occurrence.id))
  ) {
    return null;
  }

  if (delta.previousActiveAdoptedRouteId !== null) {
    const previous = await transaction.adoptedRoute.findFirst({
      where: {
        id: delta.previousActiveAdoptedRouteId,
        tripId: input.tripId,
        anchorFromNodeId:
          delta.schemaVersion === 'route-adopt-delta-v4' ||
          delta.schemaVersion === 'route-adopt-delta-v5'
            ? delta.sourceRouteAnchorFromNodeId
            : targetRoute.anchorFromNodeId,
        anchorToNodeId: targetRoute.anchorToNodeId,
        status: 'REPLACED',
      },
    });
    if (previous === null) return null;
    if (
      delta.schemaVersion === 'route-adopt-delta-v5' &&
      !(await validateV5Corridor(
        transaction,
        input.tripId,
        targetRoute,
        previous,
        delta,
        histories,
      ))
    )
      return null;
    if (
      delta.schemaVersion === 'route-adopt-delta-v4' &&
      !(await validateV4Corridor(
        transaction,
        input.tripId,
        targetRoute,
        previous,
        delta,
        histories,
        createdEdges,
      ))
    )
      return null;
  }
  if (delta.beforeOwnedDates.length > 0) {
    const conflicts = await transaction.dateOwnership.count({
      where: {
        ownerUserId: input.ownerUserId,
        localDate: {
          in: delta.beforeOwnedDates.map(parseLocalDate),
        },
        NOT: { tripId: input.tripId },
      },
    });
    if (conflicts > 0) return null;
  }
  for (const placeId of delta.createdPlaceIds) {
    const visits = await transaction.itineraryNode.findMany({
      where: { placeId },
      select: { id: true, tripId: true },
    });
    if (
      visits.some(
        (visit) =>
          visit.tripId !== input.tripId ||
          !delta.createdNodeIds.includes(visit.id),
      )
    ) {
      return null;
    }
  }
  return { histories };
}

async function restoreDayOccurrences(
  transaction: Transaction,
  tripId: string,
  delta: RouteAdoptUndoBasis,
  now: Date,
): Promise<string[]> {
  const current = await transaction.dayOccurrence.findMany({
    where: { tripId },
    select: { id: true },
  });
  const beforeIds = new Set(delta.beforeDayOccurrences.map((item) => item.id));
  if (
    current.some(
      (occurrence) =>
        !beforeIds.has(occurrence.id) &&
        !(
          delta.schemaVersion === 'route-adopt-delta-v5' &&
          delta.createdDayOccurrenceIds.includes(occurrence.id)
        ),
    )
  ) {
    throw new UndoAbort('UNDO_CONFLICT');
  }
  const offset = delta.beforeDayOccurrences.length * 4 + 10_000;
  await transaction.$executeRaw(Prisma.sql`
    UPDATE "DayOccurrence"
    SET "sequence" = "sequence" + ${offset}
    WHERE "tripId" = ${tripId}::uuid
  `);
  const currentIds = new Set(current.map((item) => item.id));
  const restored: string[] = [];
  for (const occurrence of delta.beforeDayOccurrences) {
    if (!currentIds.has(occurrence.id)) {
      await transaction.dayOccurrence.create({
        data: {
          id: occurrence.id,
          tripId,
          localDate: parseLocalDate(occurrence.localDate),
          sequence: occurrence.sequence,
          createdAt: now,
          updatedAt: now,
        },
      });
      restored.push(occurrence.id);
      continue;
    }
    await transaction.dayOccurrence.update({
      where: { id: occurrence.id },
      data: {
        localDate: parseLocalDate(occurrence.localDate),
        sequence: occurrence.sequence,
      },
    });
  }
  return restored;
}

async function restoreGeneratedNodes(
  transaction: Transaction,
  tripId: string,
  delta: RouteAdoptUndoBasis,
): Promise<string[]> {
  const restored: string[] = [];
  const temporaryPositionBase =
    delta.beforeNodePlacements.length * 4 + 1_000_000;
  for (const [
    snapshotIndex,
    snapshot,
  ] of delta.beforeGeneratedNodes.entries()) {
    const temporaryPosition = temporaryPositionBase + snapshotIndex;
    const current = await transaction.itineraryNode.findUnique({
      where: { id: snapshot.id },
    });
    if (current === null) {
      const place = await transaction.place.findUnique({
        where: { id: snapshot.placeId },
        select: { id: true },
      });
      if (place === null) throw new UndoAbort('UNDO_CONFLICT');
      await transaction.itineraryNode.create({
        data: {
          id: snapshot.id,
          tripId,
          dayOccurrenceId: snapshot.dayOccurrenceId,
          kind: snapshot.kind,
          position: temporaryPosition,
          placeId: snapshot.placeId,
          note: snapshot.note,
          source: snapshot.source,
          adoptedRouteId: snapshot.adoptedRouteId,
          provider: snapshot.provider,
          providerPlaceRef: snapshot.providerPlaceRef,
          providerHubRef: snapshot.providerHubRef,
          sourceOperationId: snapshot.sourceOperationId,
          autoReplaceable: snapshot.autoReplaceable,
          userModifiedAt:
            snapshot.userModifiedAt === null
              ? null
              : new Date(snapshot.userModifiedAt),
          createdAt: new Date(snapshot.createdAt),
          updatedAt: new Date(snapshot.updatedAt),
        },
      });
      restored.push(snapshot.id);
      continue;
    }
    if (
      current.tripId !== tripId ||
      !delta.reusedNodeIds.includes(snapshot.id)
    ) {
      throw new UndoAbort('UNDO_CONFLICT');
    }
    await transaction.itineraryNode.update({
      where: { id: snapshot.id },
      data: {
        dayOccurrenceId: snapshot.dayOccurrenceId,
        position: temporaryPosition,
        adoptedRouteId: snapshot.adoptedRouteId,
        provider: snapshot.provider,
        providerPlaceRef: snapshot.providerPlaceRef,
        providerHubRef: snapshot.providerHubRef,
        sourceOperationId: snapshot.sourceOperationId,
        autoReplaceable: snapshot.autoReplaceable,
        note: snapshot.note,
        userModifiedAt:
          snapshot.userModifiedAt === null
            ? null
            : new Date(snapshot.userModifiedAt),
      },
    });
    restored.push(snapshot.id);
  }
  return restored;
}

async function restoreNodePlacements(
  transaction: Transaction,
  tripId: string,
  delta: RouteAdoptUndoBasis,
): Promise<void> {
  const current = await transaction.itineraryNode.findMany({
    where: { tripId },
    select: { id: true },
  });
  const placementIds = new Set(
    delta.beforeNodePlacements.map((placement) => placement.nodeId),
  );
  if (
    current.length !== placementIds.size ||
    current.some((node) => !placementIds.has(node.id))
  ) {
    throw new UndoAbort('UNDO_CONFLICT');
  }
  const offset = delta.beforeNodePlacements.length * 4 + 10_000;
  await transaction.$executeRaw(Prisma.sql`
    UPDATE "ItineraryNode"
    SET "position" = "position" + ${offset}
    WHERE "tripId" = ${tripId}::uuid
  `);
  for (const placement of delta.beforeNodePlacements) {
    const updated = await transaction.itineraryNode.updateMany({
      where: { id: placement.nodeId, tripId },
      data: {
        dayOccurrenceId: placement.dayOccurrenceId,
        position: placement.position,
      },
    });
    if (updated.count !== 1) throw new UndoAbort('UNDO_CONFLICT');
  }
}

async function restoreDateOwnership(
  transaction: Transaction,
  input: UndoInput,
  delta: RouteAdoptUndoBasis,
): Promise<void> {
  if (delta.beforeOwnedDates.length > 0) {
    const conflict = await transaction.dateOwnership.findFirst({
      where: {
        ownerUserId: input.ownerUserId,
        localDate: { in: delta.beforeOwnedDates.map(parseLocalDate) },
        NOT: { tripId: input.tripId },
      },
      select: { tripId: true },
    });
    if (conflict !== null) throw new UndoAbort('UNDO_CONFLICT');
  }
  await transaction.dateOwnership.deleteMany({
    where: { tripId: input.tripId },
  });
  if (delta.beforeOwnedDates.length > 0) {
    await transaction.dateOwnership.createMany({
      data: delta.beforeOwnedDates.map((date) => ({
        ownerUserId: input.ownerUserId,
        tripId: input.tripId,
        localDate: parseLocalDate(date),
      })),
    });
  }
}

async function assertAdjacency(
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
    throw new UndoAbort('UNDO_CONFLICT');
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
  if (rows[0]?.locked !== true) throw new Error('Route undo owner lock failed');
}

async function validateV4Corridor(
  transaction: Transaction,
  tripId: string,
  currentRoute: {
    id: string;
    tripId: string;
    status: string;
    anchorFromNodeId: string | null;
    anchorToNodeId: string;
  },
  previous: {
    id: string;
    tripId: string;
    anchorFromNodeId: string | null;
    anchorToNodeId: string;
  },
  delta: RouteAdoptDeltaV4,
  histories: readonly {
    originalTransportEdgeId: string;
    originalFromNodeId: string;
    originalToNodeId: string;
    source: string;
    adoptedRouteId: string | null;
  }[],
  createdEdges: readonly { id: string }[],
): Promise<boolean> {
  if (
    currentRoute.anchorFromNodeId === null ||
    previous.anchorFromNodeId === null
  )
    return false;
  const [nodes, edges] = await Promise.all([
    transaction.itineraryNode.findMany({
      where: { tripId },
      orderBy: [
        { dayOccurrence: { sequence: 'asc' } },
        { position: 'asc' },
        { id: 'asc' },
      ],
    }),
    transaction.transportEdge.findMany({ where: { tripId } }),
  ]);
  const after = resolveCurrentRouteReplacementCorridor(
    tripId,
    nodes,
    edges,
    [currentRoute],
    currentRoute.anchorFromNodeId,
    currentRoute.anchorToNodeId,
  );
  if (
    after === null ||
    !sameArray(after.replacementNodeIds, delta.afterCorridorNodeIds) ||
    !sameArray(
      [...after.replacementTransportEdgeIds].sort(),
      createdEdges.map((edge) => edge.id).sort(),
    )
  )
    return false;
  const prefix = delta.preservedPrefixNodeIds;
  if (delta.replacementScope === 'SUFFIX') {
    const start = nodes.findIndex(
      (node) => node.id === previous.anchorFromNodeId,
    );
    const end = nodes.findIndex(
      (node) => node.id === currentRoute.anchorFromNodeId,
    );
    if (
      start < 0 ||
      end <= start ||
      !sameArray(
        nodes.slice(start, end + 1).map((node) => node.id),
        prefix,
      )
    )
      return false;
  } else if (
    prefix.length !== 0 ||
    delta.preservedPrefixTransportEdgeIds.length !== 0 ||
    previous.anchorFromNodeId !== currentRoute.anchorFromNodeId
  )
    return false;
  if (
    (await hashPreservedRoutePrefix(
      transaction,
      tripId,
      prefix,
      delta.preservedPrefixTransportEdgeIds,
    )) !== delta.preservedPrefixHash
  )
    return false;
  if (
    !sameArray(
      histories.map((history) => history.originalTransportEdgeId).sort(),
      [...delta.archivedTransportEdgeIds].sort(),
    ) ||
    histories.some(
      (history) =>
        history.source !== 'ADOPTED_ROUTE' ||
        history.adoptedRouteId !== previous.id,
    )
  )
    return false;
  const beforeIds = [...prefix.slice(0, -1), ...delta.beforeCorridorNodeIds];
  const beforeNodes = beforeIds.map(
    (id) =>
      delta.beforeGeneratedNodes.find((node) => node.id === id) ??
      nodes.find((node) => node.id === id),
  );
  if (beforeNodes.some((node) => node === undefined)) return false;
  const oldEdges = [
    ...edges.filter((edge) =>
      delta.preservedPrefixTransportEdgeIds.includes(edge.id),
    ),
    ...histories.map((history) => ({
      id: history.originalTransportEdgeId,
      tripId,
      fromNodeId: history.originalFromNodeId,
      toNodeId: history.originalToNodeId,
      source: history.source,
      adoptedRouteId: history.adoptedRouteId,
    })),
  ];
  const original = resolveCurrentRouteReplacementCorridor(
    tripId,
    beforeNodes as NonNullable<(typeof beforeNodes)[number]>[],
    oldEdges,
    [{ ...previous, status: 'ACTIVE' }],
    currentRoute.anchorFromNodeId,
    currentRoute.anchorToNodeId,
  );
  return (
    original !== null &&
    original.replacementScope === delta.replacementScope &&
    original.sourceRouteAnchorFromNodeId ===
      delta.sourceRouteAnchorFromNodeId &&
    original.sourceRouteAnchorToNodeId === delta.sourceRouteAnchorToNodeId &&
    sameArray(original.replacementNodeIds, delta.beforeCorridorNodeIds) &&
    sameArray(original.preservedPrefixNodeIds, prefix) &&
    sameArray(
      original.preservedPrefixTransportEdgeIds,
      delta.preservedPrefixTransportEdgeIds,
    ) &&
    sameArray(
      [...original.replacementTransportEdgeIds].sort(),
      [...delta.archivedTransportEdgeIds].sort(),
    )
  );
}

export function parseRouteAdoptDelta(
  value: Prisma.JsonValue,
  targetAdoptedRouteId?: string,
): RouteAdoptUndoBasis | null {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 'route-adopt-delta-v2' &&
      value.schemaVersion !== 'route-adopt-delta-v3' &&
      value.schemaVersion !== 'route-adopt-delta-v4' &&
      value.schemaVersion !== 'route-adopt-delta-v5')
  ) {
    return null;
  }
  if (
    !isUniqueUuidArray(value.createdNodeIds) ||
    !isUniqueUuidArray(value.reusedNodeIds) ||
    !isUniqueUuidArray(value.createdTransportEdgeIds) ||
    !isUniqueUuidArray(value.archivedTransportHistoryIds) ||
    !isUniqueUuidArray(value.affectedDayOccurrenceIds) ||
    !isUniqueUuidArray(value.beforeCorridorNodeIds) ||
    !isUniqueUuidArray(value.afterCorridorNodeIds) ||
    !isUniqueStringArray(value.beforeOwnedDates) ||
    !isUniqueUuidArray(value.createdPlaceIds) ||
    !isUniqueUuidArray(value.createdDayOccurrenceIds) ||
    !Array.isArray(value.removedGeneratedNodes) ||
    !Array.isArray(value.createdDayProjections) ||
    !Array.isArray(value.removedDayProjections) ||
    !Array.isArray(value.beforeDayOccurrences) ||
    !Array.isArray(value.beforeNodePlacements) ||
    !Array.isArray(value.beforeGeneratedNodes) ||
    !nullableUuid(value.previousActiveAdoptedRouteId) ||
    !nullableLocalDate(value.beforeEffectiveStartDate) ||
    !nullableLocalDate(value.beforeEffectiveEndDate) ||
    !value.beforeOwnedDates.every(isLocalDate) ||
    !value.beforeDayOccurrences.every(isDayOccurrenceSnapshot) ||
    !value.beforeNodePlacements.every(isNodePlacementSnapshot) ||
    !value.beforeGeneratedNodes.every(isGeneratedNodeSnapshot) ||
    !value.removedGeneratedNodes.every(isGeneratedNodeSnapshot) ||
    !value.createdDayProjections.every(isProjectionSnapshot) ||
    !value.removedDayProjections.every(isProjectionSnapshot)
  ) {
    return null;
  }
  if (
    value.schemaVersion !== 'route-adopt-delta-v2' &&
    (!Array.isArray(value.userDwellAdjustments) ||
      !value.userDwellAdjustments.every(isDwellAdjustment))
  ) {
    return null;
  }
  if (
    value.schemaVersion === 'route-adopt-delta-v4' &&
    ((value.replacementScope !== 'FULL_CORRIDOR' &&
      value.replacementScope !== 'SUFFIX') ||
      !isUuid(value.sourceRouteAnchorFromNodeId) ||
      !isUuid(value.sourceRouteAnchorToNodeId) ||
      !isUuid(value.replacementAnchorFromNodeId) ||
      !isUuid(value.replacementAnchorToNodeId) ||
      !isUniqueUuidArray(value.preservedPrefixNodeIds) ||
      !isUniqueUuidArray(value.preservedPrefixTransportEdgeIds) ||
      !isUniqueUuidArray(value.archivedTransportEdgeIds) ||
      typeof value.preservedPrefixHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.preservedPrefixHash))
  )
    return null;
  if (
    value.schemaVersion === 'route-adopt-delta-v5' &&
    !validV5Shape(value, targetAdoptedRouteId)
  )
    return null;
  const delta = value as unknown as RouteAdoptUndoBasis;
  if (delta.schemaVersion === 'route-adopt-delta-v4') {
    if (
      delta.sourceRouteAnchorToNodeId !== delta.replacementAnchorToNodeId ||
      delta.beforeCorridorNodeIds[0] !== delta.replacementAnchorFromNodeId ||
      delta.beforeCorridorNodeIds.at(-1) !== delta.replacementAnchorToNodeId ||
      delta.afterCorridorNodeIds[0] !== delta.replacementAnchorFromNodeId ||
      delta.afterCorridorNodeIds.at(-1) !== delta.replacementAnchorToNodeId
    )
      return null;
    if (
      delta.replacementScope === 'FULL_CORRIDOR'
        ? delta.sourceRouteAnchorFromNodeId !==
            delta.replacementAnchorFromNodeId ||
          delta.preservedPrefixNodeIds.length !== 0 ||
          delta.preservedPrefixTransportEdgeIds.length !== 0
        : delta.previousActiveAdoptedRouteId === null ||
          delta.preservedPrefixNodeIds.length < 2 ||
          delta.preservedPrefixNodeIds[0] !==
            delta.sourceRouteAnchorFromNodeId ||
          delta.preservedPrefixNodeIds.at(-1) !==
            delta.replacementAnchorFromNodeId ||
          delta.preservedPrefixTransportEdgeIds.length !==
            delta.preservedPrefixNodeIds.length - 1
    )
      return null;
  }

  if (
    delta.beforeCorridorNodeIds.length < 2 ||
    delta.afterCorridorNodeIds.length < 2 ||
    new Set(delta.beforeDayOccurrences.map((item) => item.id)).size !==
      delta.beforeDayOccurrences.length ||
    new Set(delta.beforeNodePlacements.map((item) => item.nodeId)).size !==
      delta.beforeNodePlacements.length ||
    new Set(delta.beforeGeneratedNodes.map((item) => item.id)).size !==
      delta.beforeGeneratedNodes.length ||
    delta.removedGeneratedNodes.some(
      (snapshot) =>
        !delta.beforeGeneratedNodes.some((before) => before.id === snapshot.id),
    )
  ) {
    return null;
  }
  return delta;
}

function isDwellAdjustment(value: unknown): boolean {
  return (
    isRecord(value) &&
    isUuid(value.intentId) &&
    isUuid(value.nodeId) &&
    Number.isSafeInteger(value.beforeDurationSeconds) &&
    Number(value.beforeDurationSeconds) > 0 &&
    Number.isSafeInteger(value.afterDurationSeconds) &&
    Number(value.afterDurationSeconds) > 0 &&
    Number(value.afterDurationSeconds) < Number(value.beforeDurationSeconds) &&
    typeof value.beforeLocked === 'boolean'
  );
}

function isDayOccurrenceSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isUuid(value.id) &&
    isLocalDate(value.localDate) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0
  );
}

function isNodePlacementSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isUuid(value.nodeId) &&
    isUuid(value.dayOccurrenceId) &&
    Number.isSafeInteger(value.position) &&
    Number(value.position) >= 0
  );
}

function isGeneratedNodeSnapshot(
  value: unknown,
): value is RouteAdoptGeneratedNodeSnapshot {
  return (
    isRecord(value) &&
    isUuid(value.id) &&
    isUuid(value.tripId) &&
    isUuid(value.dayOccurrenceId) &&
    value.kind === 'PLACE_VISIT' &&
    Number.isSafeInteger(value.position) &&
    Number(value.position) >= 0 &&
    isUuid(value.placeId) &&
    nullableString(value.note) &&
    value.source === 'ROUTE_GENERATED' &&
    isUuid(value.adoptedRouteId) &&
    typeof value.provider === 'string' &&
    nullableString(value.providerPlaceRef) &&
    nullableString(value.providerHubRef) &&
    isUuid(value.sourceOperationId) &&
    typeof value.autoReplaceable === 'boolean' &&
    nullableTimestamp(value.userModifiedAt) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function isProjectionSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isUuid(value.transportEdgeId) &&
    isUuid(value.dayOccurrenceId) &&
    (value.role === 'SAME_DAY' ||
      value.role === 'START' ||
      value.role === 'OCCUPIED' ||
      value.role === 'END')
  );
}

function isUniqueStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}

function isUniqueUuidArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isUuid) &&
    new Set(value).size === value.length
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableUuid(value: unknown): boolean {
  return value === null || isUuid(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function nullableTimestamp(value: unknown): boolean {
  return value === null || isTimestamp(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nullableLocalDate(value: unknown): boolean {
  return value === null || isLocalDate(value);
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && localDate(parsed) === value;
}

function parseLocalDate(value: string): Date {
  if (!isLocalDate(value)) throw new UndoAbort('UNDO_UNAVAILABLE');
  return new Date(`${value}T00:00:00.000Z`);
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

function isExpectedUndoConstraint(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2003' || error.code === 'P2025')
  );
}

class UndoAbort extends Error {
  constructor(
    readonly status: Exclude<UndoRouteAdoptionResult['status'], 'SUCCESS'>,
  ) {
    super(status);
  }
}

function validV5Shape(
  value: Record<string, unknown>,
  targetAdoptedRouteId?: string,
): boolean {
  const ids = [
    'externalOriginId',
    'sourceGroundTransitLegExecutionId',
    'sourceAdoptedRouteId',
    'sourceTransportEdgeId',
    'sourceRouteAnchorFromNodeId',
    'sourceRouteAnchorToNodeId',
    'sourceDivergenceNodeId',
    'destinationNodeId',
    'materializedOriginNodeId',
    'materializedOriginPlaceId',
    'materializedOriginDayOccurrenceId',
  ];
  if (
    value.replacementScope !== 'EXTERNAL_ORIGIN' ||
    ids.some((key) => !isUuid(value[key])) ||
    ![
      'preservedPrefixNodeIds',
      'preservedPrefixTransportEdgeIds',
      'replacementNodeIds',
      'archivedTransportEdgeIds',
      'archivableProviderActualTransportEdgeIds',
    ].every((key) => isUniqueUuidArray(value[key])) ||
    !['preservedPrefixHash', 'archivedSuffixHash'].every(
      (key) =>
        typeof value[key] === 'string' &&
        /^[a-f0-9]{64}$/u.test(value[key] as string),
    ) ||
    !Array.isArray(value.afterGeneratedNodeFacts) ||
    !value.afterGeneratedNodeFacts.every(isRecord) ||
    !Array.isArray(value.afterGroundTransitLegFacts) ||
    !value.afterGroundTransitLegFacts.every(isRecord) ||
    !isUniqueUuidArray(value.createdGroundTransitTransportEdgeIds) ||
    !isRecord(value.materializedOriginAnchorSnapshot)
  )
    return false;
  const d = value as unknown as RouteAdoptDeltaV5;
  const anchor = d.materializedOriginAnchorSnapshot;
  const legs = d.afterGroundTransitLegFacts;
  if (
    !isUniqueUuidArray(legs.map((leg) => leg.id)) ||
    !isUniqueUuidArray(legs.map((leg) => leg.transportEdgeId)) ||
    !sameArray(
      legs.map((leg) => String(leg.transportEdgeId)).sort(),
      [...d.createdGroundTransitTransportEdgeIds].sort(),
    ) ||
    d.createdGroundTransitTransportEdgeIds.some(
      (id) => !d.createdTransportEdgeIds.includes(id),
    ) ||
    new Set(legs.map((leg) => leg.adoptedRouteId)).size > 1 ||
    legs.some(
      (leg) =>
        !isUuid(leg.tripId) ||
        !isUuid(leg.adoptedRouteId) ||
        leg.adoptedRouteId === d.sourceAdoptedRouteId ||
        (targetAdoptedRouteId !== undefined &&
          leg.adoptedRouteId !== targetAdoptedRouteId) ||
        (leg.mode !== 'RAIL' && leg.mode !== 'BUS') ||
        !Array.isArray(leg.observations) ||
        leg.observations.length !== 0 ||
        !Array.isArray(leg.stateTransitions) ||
        leg.stateTransitions.length !== 1 ||
        leg.state !== 'PENDING' ||
        !leg.stateTransitions.every(
          (t) =>
            isRecord(t) &&
            isUuid(t.id) &&
            t.legExecutionId === leg.id &&
            t.fromState === null &&
            t.toState === 'PENDING' &&
            t.source === 'ROUTE_ADOPT' &&
            t.evidenceRef === `adopted-route:${String(leg.adoptedRouteId)}`,
        ),
    )
  )
    return false;
  return (
    anchor.schemaVersion === 'external-adopted-route-anchor-v1' &&
    isRecord(anchor.externalOrigin) &&
    anchor.externalOrigin.schema === 'external-route-origin-v1' &&
    anchor.externalOrigin.externalOriginId === d.externalOriginId &&
    anchor.externalOrigin.sourceAdoptedRouteId === d.sourceAdoptedRouteId &&
    anchor.externalOrigin.sourceTransportEdgeId === d.sourceTransportEdgeId &&
    anchor.externalOrigin.sourceGroundTransitLegExecutionId ===
      d.sourceGroundTransitLegExecutionId &&
    anchor.materializedNodeId === d.materializedOriginNodeId &&
    anchor.materializedPlaceId === d.materializedOriginPlaceId &&
    anchor.materializedDayOccurrenceId ===
      d.materializedOriginDayOccurrenceId &&
    isLocalDate(anchor.localDate) &&
    d.previousActiveAdoptedRouteId === d.sourceAdoptedRouteId &&
    d.sourceRouteAnchorToNodeId === d.destinationNodeId &&
    sameArray(d.beforeCorridorNodeIds, d.replacementNodeIds) &&
    d.beforeCorridorNodeIds[0] === d.sourceDivergenceNodeId &&
    d.beforeCorridorNodeIds.at(-1) === d.destinationNodeId &&
    d.afterCorridorNodeIds[0] === d.materializedOriginNodeId &&
    d.afterCorridorNodeIds.at(-1) === d.destinationNodeId &&
    d.preservedPrefixNodeIds.length >= 1 &&
    d.preservedPrefixNodeIds[0] === d.sourceRouteAnchorFromNodeId &&
    d.preservedPrefixNodeIds.at(-1) === d.sourceDivergenceNodeId &&
    d.preservedPrefixTransportEdgeIds.length ===
      d.preservedPrefixNodeIds.length - 1 &&
    d.createdNodeIds.includes(d.materializedOriginNodeId) &&
    d.createdPlaceIds.includes(d.materializedOriginPlaceId) &&
    d.createdNodeIds.every((id) => !d.reusedNodeIds.includes(id)) &&
    sameArray(
      [...d.afterCorridorNodeIds.slice(0, -1)].sort(),
      [...d.createdNodeIds, ...d.reusedNodeIds].sort(),
    ) &&
    d.createdTransportEdgeIds.length === d.afterCorridorNodeIds.length - 1 &&
    [
      ...d.beforeDayOccurrences.map((day) => day.id),
      ...d.createdDayOccurrenceIds,
    ].includes(d.materializedOriginDayOccurrenceId) &&
    d.archivedTransportEdgeIds[0] === d.sourceTransportEdgeId &&
    d.archivedTransportEdgeIds.length === d.beforeCorridorNodeIds.length - 1 &&
    d.archivableProviderActualTransportEdgeIds.every((id) =>
      d.archivedTransportEdgeIds.includes(id),
    ) &&
    sameArray(
      d.afterGeneratedNodeFacts.map((node) => String(node.id)).sort(),
      [...d.createdNodeIds, ...d.reusedNodeIds].sort(),
    )
  );
}

async function validateV5Corridor(
  tx: Transaction,
  tripId: string,
  current: {
    id: string;
    anchorFromNodeId: string | null;
    anchorToNodeId: string;
    status: string;
    tripId: string;
  },
  previous: {
    id: string;
    anchorFromNodeId: string | null;
    anchorToNodeId: string;
    status: string;
    tripId: string;
  },
  delta: RouteAdoptDeltaV5,
  histories: readonly Prisma.TransportEdgeHistoryGetPayload<{
    include: { temporalValues: true };
  }>[],
) {
  if (
    previous.anchorFromNodeId !== delta.sourceRouteAnchorFromNodeId ||
    previous.anchorToNodeId !== delta.destinationNodeId ||
    current.anchorFromNodeId !== delta.materializedOriginNodeId
  )
    return false;
  const groundEdges = await tx.transportEdge.findMany({
    where: {
      tripId,
      adoptedRouteId: current.id,
      mode: { in: ['RAIL', 'BUS'] },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const groundFacts = await externalGroundTransitExecutionFacts(
    tx,
    tripId,
    current.id,
  );
  if (
    !sameArray(
      groundEdges.map((edge) => edge.id),
      [...delta.createdGroundTransitTransportEdgeIds].sort(),
    ) ||
    groundFacts.some(
      (leg) => leg.tripId !== tripId || leg.adoptedRouteId !== current.id,
    ) ||
    hashExternalRouteAudit(groundFacts) !==
      hashExternalRouteAudit(delta.afterGroundTransitLegFacts)
  )
    return false;
  if (
    hashExternalRouteAudit(
      await externalGeneratedNodeFacts(tx, tripId, [
        ...delta.createdNodeIds,
        ...delta.reusedNodeIds,
      ]),
    ) !== hashExternalRouteAudit(delta.afterGeneratedNodeFacts)
  )
    return false;
  if (
    hashExternalRouteAudit(
      histories.map((history) => ({
        ...history,
        temporalValues: [...history.temporalValues].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      })),
    ) !== delta.archivedSuffixHash
  )
    return false;
  if (
    (await hashPreservedRoutePrefix(
      tx,
      tripId,
      delta.preservedPrefixNodeIds,
      delta.preservedPrefixTransportEdgeIds,
    )) !== delta.preservedPrefixHash
  )
    return false;
  const nodes = await tx.itineraryNode.findMany({
    where: { tripId },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const edges = await tx.transportEdge.findMany({ where: { tripId } });
  const start = nodes.findIndex(
    (node) => node.id === delta.sourceRouteAnchorFromNodeId,
  );
  const end = nodes.findIndex(
    (node) => node.id === delta.sourceDivergenceNodeId,
  );
  if (
    start < 0 ||
    end < start ||
    !sameArray(
      nodes.slice(start, end + 1).map((node) => node.id),
      delta.preservedPrefixNodeIds,
    ) ||
    nodes[end + 1]?.id !== delta.materializedOriginNodeId ||
    edges.some(
      (edge) =>
        edge.fromNodeId === delta.sourceDivergenceNodeId &&
        edge.toNodeId === delta.materializedOriginNodeId,
    )
  )
    return false;
  const originalIds = [
    ...delta.preservedPrefixNodeIds.slice(0, -1),
    ...delta.beforeCorridorNodeIds,
  ];
  const originalNodes = originalIds.map(
    (id) =>
      delta.beforeGeneratedNodes.find((node) => node.id === id) ??
      nodes.find((node) => node.id === id),
  );
  if (originalNodes.some((node) => node === undefined)) return false;
  const restored = resolveCurrentRouteReplacementCorridor(
    tripId,
    originalNodes as NonNullable<(typeof originalNodes)[number]>[],
    [
      ...edges.filter((edge) =>
        delta.preservedPrefixTransportEdgeIds.includes(edge.id),
      ),
      ...histories.map((h) => ({
        id: h.originalTransportEdgeId,
        tripId,
        fromNodeId: h.originalFromNodeId,
        toNodeId: h.originalToNodeId,
        source: h.source,
        adoptedRouteId: h.adoptedRouteId,
      })),
    ],
    [{ ...previous, status: 'ACTIVE' }],
    delta.sourceRouteAnchorFromNodeId,
    delta.destinationNodeId,
  );
  if (!restored || !sameArray(restored.replacementNodeIds, originalIds))
    return false;
  if (
    !sameArray(
      histories.map((h) => h.originalTransportEdgeId).sort(),
      [...delta.archivedTransportEdgeIds].sort(),
    ) ||
    histories.some(
      (h) => h.adoptedRouteId !== previous.id || h.source !== 'ADOPTED_ROUTE',
    )
  )
    return false;
  const providerActualIds = histories
    .filter((h) => h.temporalValues.some((v) => v.layer === 'ACTUAL'))
    .map((h) => h.originalTransportEdgeId)
    .sort();
  return (
    histories.every((h) =>
      h.temporalValues.every(
        (v) => v.layer !== 'ACTUAL' || v.sourceKind === 'PROVIDER_OBSERVATION',
      ),
    ) &&
    sameArray(
      providerActualIds,
      [...delta.archivableProviderActualTransportEdgeIds].sort(),
    )
  );
}
