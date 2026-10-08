import {
  buildExternalOriginPreviewPayload,
  compareCanonicalDwellAdjustments,
  hashRoutePreviewPayload,
  type AdoptRoutePreviewResult,
  type Clock,
  restoreNormalizedCandidate,
  type StoredRoutePreviewPayload,
} from '@travel/application';
import type {
  ExternalAdoptedRouteAnchorSnapshot,
  RouteAdoptDeltaV5,
} from '@travel/contracts';
import { Prisma } from './generated/prisma/client.js';
import {
  AdoptionAbort,
  archiveRouteEdges,
  assertCurrentAdjacency,
  createAdoptedCandidateEdges,
  reconcileDateOwnership,
  resolveGeneratedNodes,
  sameAdjustments,
  toGeneratedNodeSnapshot,
  toReceiptRecord,
  type AdoptionInput,
  type LockedTripRow,
  type ReceiptDelta,
} from './prisma-route-adoption.js';
import { toSnapshotRecord } from './prisma-route-planning-repository.js';
import { readTripAggregateRecord } from './prisma-trip-repository.js';
import { loadExternalOriginPlanningContext } from './prisma-external-execution-origin-repository.js';
import { hashPreservedRoutePrefix } from './prisma-route-prefix.js';
import {
  externalGeneratedNodeFacts,
  externalGroundTransitExecutionFacts,
  hashExternalRouteAudit,
  lockExternalRouteMutationRows,
} from './prisma-external-route-state.js';

type Transaction = Prisma.TransactionClient;
type Preview = Prisma.RoutePreviewGetPayload<{
  include: { candidateSnapshot: true };
}>;

/** Caller already holds the owner advisory and Trip locks and has checked receipt replay. */
export async function executeExternalRouteAdoption(
  tx: Transaction,
  input: AdoptionInput,
  lockedTrip: LockedTripRow,
  preview: Preview,
  clock: Clock,
): Promise<AdoptRoutePreviewResult> {
  if (lockedTrip.version !== input.baseTripVersion)
    return { status: 'VERSION_CONFLICT' };
  const snapshot = toSnapshotRecord(preview.candidateSnapshot);
  const payload =
    preview.previewPayload as unknown as StoredRoutePreviewPayload;
  if (
    snapshot.origin.type !== 'EXTERNAL_EXECUTION_ORIGIN' ||
    preview.basisVersion !== input.baseTripVersion ||
    preview.expiresAt <= input.now ||
    preview.policyVersion !== 'route-external-origin-preview-v2' ||
    payload.policyVersion !== preview.policyVersion ||
    preview.previewHash === null ||
    hashRoutePreviewPayload(payload) !== preview.previewHash ||
    preview.candidateHash !== snapshot.candidateHash ||
    payload.candidateHash !== snapshot.candidateHash ||
    payload.tripId !== input.tripId ||
    payload.basisVersion !== input.baseTripVersion ||
    payload.candidateSnapshotId !== snapshot.id
  )
    return { status: 'PREVIEW_STALE' };
  const scope = payload.changeSummary.externalOriginReplacement;
  if (!scope) return { status: 'PREVIEW_STALE' };
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "AdoptedRoute" WHERE "id"=${scope.sourceAdoptedRouteId}::uuid AND "tripId"=${input.tripId}::uuid FOR UPDATE`,
  );
  await lockExternalRouteMutationRows(
    tx,
    input.tripId,
    [
      ...new Set([
        ...scope.preservedPrefixNodeIds,
        ...scope.replacementNodeIds,
      ]),
    ],
    [
      ...scope.preservedPrefixTransportEdgeIds,
      ...scope.replacementTransportEdgeIds,
    ],
  );
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "GroundTransitLegExecution" WHERE "id"=${scope.sourceGroundTransitLegExecutionId}::uuid AND "tripId"=${input.tripId}::uuid FOR UPDATE`,
  );
  const trip = await readTripAggregateRecord(tx, input);
  const context = await loadExternalOriginPlanningContext(tx, {
    ...input,
    externalOriginId: snapshot.origin.externalOriginId,
  });
  if (!trip || !context) return { status: 'PREVIEW_STALE' };
  const eligibilityNow = new Date(
    Math.max(input.now.getTime(), clock.now().getTime()),
  );
  let locked: StoredRoutePreviewPayload;
  try {
    locked = buildExternalOriginPreviewPayload({
      trip,
      snapshot,
      context,
      now: eligibilityNow,
      sameHubWalkingLegIndexes: payload.changeSummary.internalTransferDetails
        ?.filter((detail) => detail.evidence === 'USER_CONFIRMED')
        .map((detail) => detail.legIndex),
    });
  } catch {
    return { status: 'PREVIEW_STALE' };
  }
  const summary = locked.changeSummary;
  if (
    (summary.protectedBlockingNodes?.length ?? 0) > 0 ||
    (summary.protectedBlockingTransportEdgeIds?.length ?? 0) > 0 ||
    summary.downstreamImpact?.status === 'INFEASIBLE'
  )
    return { status: 'PREVIEW_BLOCKED' };
  if (hashRoutePreviewPayload(locked) !== preview.previewHash)
    return { status: 'PREVIEW_STALE' };
  const plan = summary.externalOriginReplacement!;
  const adjustments = [...(summary.requiredUserAdjustments ?? [])].sort(
    compareCanonicalDwellAdjustments,
  );
  if (!sameAdjustments(adjustments, input.acceptedUserAdjustments))
    return { status: 'USER_ADJUSTMENT_REQUIRED' };
  const adjustmentRows = await tx.userTimeIntent.findMany({
    where: {
      tripId: input.tripId,
      id: { in: adjustments.map((a) => a.intentId) },
      kind: 'MIN_DWELL',
      operator: 'MINIMUM',
    },
  });
  if (
    adjustmentRows.length !== adjustments.length ||
    adjustmentRows.some(
      (row) =>
        !adjustments.some(
          (a) =>
            a.intentId === row.id &&
            a.nodeId === row.nodeId &&
            a.fromDurationSeconds === row.durationSeconds,
        ),
    )
  )
    return { status: 'PREVIEW_STALE' };
  const beforeOccurrences = await tx.dayOccurrence.findMany({
    where: { tripId: input.tripId },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  });
  const beforeNodes = await tx.itineraryNode.findMany({
    where: { tripId: input.tripId },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const beforeGenerated = beforeNodes
    .filter((node) => plan.replacementNodeIds.slice(1, -1).includes(node.id))
    .map(toGeneratedNodeSnapshot);
  const beforeDates = await tx.dateOwnership.findMany({
    where: { tripId: input.tripId, ownerUserId: input.ownerUserId },
    orderBy: { localDate: 'asc' },
  });
  const oldEdges = await tx.transportEdge.findMany({
    where: {
      tripId: input.tripId,
      id: { in: [...plan.replacementTransportEdgeIds] },
    },
    include: { temporalValues: true, dayProjections: true },
    orderBy: { id: 'asc' },
  });
  if (oldEdges.length !== plan.replacementTransportEdgeIds.length)
    return { status: 'PREVIEW_STALE' };
  if (
    oldEdges.some((edge) =>
      edge.temporalValues.some(
        (v) => v.layer === 'ACTUAL' && v.sourceKind !== 'PROVIDER_OBSERVATION',
      ),
    )
  )
    return { status: 'FACT_PROTECTED' };
  const prefixHash = await hashPreservedRoutePrefix(
    tx,
    input.tripId,
    plan.preservedPrefixNodeIds,
    plan.preservedPrefixTransportEdgeIds,
  );
  const materialization = plan.materializedOrigin;
  let occurrenceId = materialization.dayOccurrenceId;
  let createdOriginOccurrence = false;
  if (occurrenceId === null) {
    const maximum = await tx.dayOccurrence.aggregate({
      where: { tripId: input.tripId },
      _max: { sequence: true },
    });
    const occurrence = await tx.dayOccurrence.create({
      data: {
        tripId: input.tripId,
        localDate: new Date(materialization.localDate + 'T00:00:00Z'),
        sequence: (maximum._max.sequence ?? -1) + 100,
      },
    });
    occurrenceId = occurrence.id;
    createdOriginOccurrence = true;
  } else if (
    !beforeOccurrences.some(
      (day) =>
        day.id === occurrenceId &&
        localDate(day.localDate) === materialization.localDate,
    )
  )
    throw new AdoptionAbort('PREVIEW_STALE');
  const originPlace = await tx.place.create({
    data: {
      ownerUserId: input.ownerUserId,
      name: materialization.location.name,
      latitude: materialization.location.latitude!,
      longitude: materialization.location.longitude!,
      address: null,
    },
  });
  const maximumPosition = await tx.itineraryNode.aggregate({
    where: { dayOccurrenceId: occurrenceId },
    _max: { position: true },
  });
  const originNode = await tx.itineraryNode.create({
    data: {
      tripId: input.tripId,
      dayOccurrenceId: occurrenceId,
      kind: 'PLACE_VISIT',
      position: (maximumPosition._max.position ?? -1) + 100,
      placeId: originPlace.id,
      note: null,
      // The existing CHECK requires generated ownership immediately. This
      // transaction-private stub breaks the live-anchor/route/receipt cycle;
      // it becomes ROUTE_GENERATED before any transaction can observe it.
      source: 'USER_PLANNED',
      adoptedRouteId: null,
      sourceOperationId: null,
      provider: materialization.provider,
      providerHubRef: materialization.providerHubRef,
      providerPlaceRef: null,
      autoReplaceable: true,
    },
  });
  // E is inserted after the divergence, including when its date occurrence is newly created.
  const placement = await placeExternalOrigin(
    tx,
    input.tripId,
    originNode.id,
    plan.sourceDivergenceNodeId,
  );
  const anchorSnapshot: ExternalAdoptedRouteAnchorSnapshot = {
    schemaVersion: 'external-adopted-route-anchor-v1',
    externalOrigin: snapshot.origin.snapshot,
    materializedNodeId: originNode.id,
    materializedPlaceId: originPlace.id,
    materializedDayOccurrenceId: occurrenceId,
    localDate: materialization.localDate,
  };
  const replaced = await tx.adoptedRoute.updateMany({
    where: {
      id: plan.sourceAdoptedRouteId,
      tripId: input.tripId,
      status: 'ACTIVE',
      anchorFromNodeId: plan.sourceRouteAnchorFromNodeId,
      anchorToNodeId: plan.sourceRouteAnchorToNodeId,
    },
    data: { status: 'REPLACED', replacedAt: input.now },
  });
  if (replaced.count !== 1) throw new AdoptionAbort('PREVIEW_STALE');
  await tx.job.updateMany({
    where: {
      type: 'GROUND_TRANSIT_MONITOR',
      payloadRef: plan.sourceAdoptedRouteId,
      status: 'QUEUED',
    },
    data: {
      status: 'CANCELLED',
      cancelRequested: true,
      cancelledAt: input.now,
      completedAt: input.now,
    },
  });
  await tx.job.updateMany({
    where: {
      type: 'GROUND_TRANSIT_MONITOR',
      payloadRef: plan.sourceAdoptedRouteId,
      status: 'RUNNING',
    },
    data: { cancelRequested: true },
  });
  const route = await tx.adoptedRoute.create({
    data: {
      tripId: input.tripId,
      anchorOriginKind: 'EXTERNAL_EXECUTION_ORIGIN',
      anchorFromNodeId: originNode.id,
      anchorFromExternalOriginId: plan.externalOriginId,
      anchorFromSnapshot: anchorSnapshot as unknown as Prisma.InputJsonValue,
      anchorToNodeId: plan.destinationNodeId,
      sourcePreviewId: preview.id,
      candidateSnapshotId: snapshot.id,
      candidateHash: snapshot.candidateHash,
      policyVersion: preview.policyVersion,
      status: 'ACTIVE',
      createdAt: input.now,
    },
  });
  const receipt = await tx.operationReceipt.create({
    data: {
      ownerUserId: input.ownerUserId,
      tripId: input.tripId,
      operationType: 'ROUTE_ADOPT',
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      baseTripVersion: input.baseTripVersion,
      resultingTripVersion: input.baseTripVersion + 1,
      previewId: preview.id,
      adoptedRouteId: route.id,
      undoExpiresAt: input.undoExpiresAt,
      delta: {},
      createdAt: input.now,
    },
  });
  await tx.itineraryNode.update({
    where: { id: originNode.id },
    data: {
      source: 'ROUTE_GENERATED',
      adoptedRouteId: route.id,
      sourceOperationId: receipt.id,
    },
  });
  const delta: ReceiptDelta = {
    schemaVersion: 'route-adopt-delta-v3',
    createdNodeIds: [originNode.id],
    reusedNodeIds: [],
    removedGeneratedNodes: beforeGenerated.filter((node) =>
      summary.nodesToRemove!.some((n) => n.nodeId === node.id),
    ),
    createdTransportEdgeIds: [],
    archivedTransportHistoryIds: [],
    createdDayProjections: [],
    removedDayProjections: oldEdges.flatMap((edge) =>
      edge.dayProjections.map((p) => ({
        transportEdgeId: edge.id,
        dayOccurrenceId: p.dayOccurrenceId,
        role: p.role,
      })),
    ),
    affectedDayOccurrenceIds: [occurrenceId],
    beforeCorridorNodeIds: [...plan.replacementNodeIds],
    afterCorridorNodeIds: [],
    beforeDayOccurrences: beforeOccurrences.map((day) => ({
      id: day.id,
      sequence: day.sequence,
      localDate: localDate(day.localDate),
    })),
    beforeNodePlacements: beforeNodes.map((node) => ({
      nodeId: node.id,
      dayOccurrenceId: node.dayOccurrenceId,
      position: node.position,
    })),
    beforeGeneratedNodes: beforeGenerated,
    beforeOwnedDates: beforeDates.map((d) => localDate(d.localDate)),
    beforeEffectiveStartDate:
      lockedTrip.effectiveStartDate === null
        ? null
        : localDate(lockedTrip.effectiveStartDate),
    beforeEffectiveEndDate:
      lockedTrip.effectiveEndDate === null
        ? null
        : localDate(lockedTrip.effectiveEndDate),
    previousActiveAdoptedRouteId: plan.sourceAdoptedRouteId,
    createdPlaceIds: [originPlace.id],
    createdDayOccurrenceIds: [
      ...(createdOriginOccurrence ? [occurrenceId] : []),
      ...placement.createdOccurrenceIds,
    ],
    userDwellAdjustments: adjustments.map((a) => {
      const row = adjustmentRows.find((r) => r.id === a.intentId)!;
      return {
        intentId: a.intentId,
        nodeId: a.nodeId,
        beforeDurationSeconds: row.durationSeconds!,
        afterDurationSeconds: a.toDurationSeconds,
        beforeLocked: row.locked,
      };
    }),
  };
  for (const a of delta.userDwellAdjustments)
    await tx.userTimeIntent.update({
      where: { id: a.intentId },
      data: { durationSeconds: a.afterDurationSeconds },
    });
  delta.archivedTransportHistoryIds.push(
    ...(await archiveRouteEdges(tx, oldEdges, input.now)),
  );
  await tx.itineraryNode.deleteMany({
    where: {
      tripId: input.tripId,
      id: { in: summary.nodesToRemove!.map((n) => n.nodeId) },
    },
  });
  const nodePlans = [...summary.nodesToCreate!, ...summary.nodesToReuse!]
    .map((node) => ({
      ...node,
      dayOccurrenceId:
        node.dayOccurrenceId === null
          ? null
          : (placement.suffixOccurrenceIds.get(node.dayOccurrenceId) ??
            node.dayOccurrenceId),
    }))
    .sort(
      (a, b) =>
        Number(a.ref.split('_').at(-1)) - Number(b.ref.split('_').at(-1)),
    );
  const resolved = await resolveGeneratedNodes(tx, {
    ...input,
    adoptedRouteId: route.id,
    receiptId: receipt.id,
    provider: snapshot.provider,
    anchorFromNodeId: originNode.id,
    anchorToNodeId: plan.destinationNodeId,
    nodes: nodePlans,
  });
  delta.createdNodeIds.push(...resolved.createdNodeIds);
  delta.reusedNodeIds.push(...resolved.reusedNodeIds);
  delta.createdPlaceIds.push(...resolved.createdPlaceIds);
  delta.createdDayOccurrenceIds.push(...resolved.createdDayOccurrenceIds);
  delta.affectedDayOccurrenceIds.push(...resolved.affectedOccurrenceIds);
  const refs = new Map([
    ['EXTERNAL_ORIGIN', originNode.id],
    ['TO_NODE', plan.destinationNodeId],
    ...resolved.refs.entries(),
  ]);
  await createAdoptedCandidateEdges(
    tx,
    input,
    preview,
    route,
    { segments: summary.proposedSegments },
    locked,
    delta,
    refs,
  );
  await assertCurrentAdjacency(tx, input.tripId);
  const range = await reconcileDateOwnership(
    tx,
    input.ownerUserId,
    input.tripId,
  );
  await tx.trip.update({
    where: { id: input.tripId },
    data: {
      effectiveStartDate: range.minimum,
      effectiveEndDate: range.maximum,
      version: { increment: 1 },
    },
  });
  delta.afterCorridorNodeIds = [
    originNode.id,
    ...nodePlans.map((node) => resolved.refs.get(node.ref)!),
    plan.destinationNodeId,
  ];
  delta.affectedDayOccurrenceIds = [...new Set(delta.affectedDayOccurrenceIds)];
  if (
    (await hashPreservedRoutePrefix(
      tx,
      input.tripId,
      plan.preservedPrefixNodeIds,
      plan.preservedPrefixTransportEdgeIds,
    )) !== prefixHash
  )
    throw new AdoptionAbort('PREVIEW_STALE');
  const histories = await tx.transportEdgeHistory.findMany({
    where: {
      id: { in: delta.archivedTransportHistoryIds },
      tripId: input.tripId,
    },
    include: { temporalValues: { orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  const complete: RouteAdoptDeltaV5 = {
    ...delta,
    schemaVersion: 'route-adopt-delta-v5',
    replacementScope: 'EXTERNAL_ORIGIN',
    externalOriginId: plan.externalOriginId,
    sourceGroundTransitLegExecutionId: plan.sourceGroundTransitLegExecutionId,
    sourceAdoptedRouteId: plan.sourceAdoptedRouteId,
    sourceTransportEdgeId: plan.sourceTransportEdgeId,
    sourceRouteAnchorFromNodeId: plan.sourceRouteAnchorFromNodeId,
    sourceRouteAnchorToNodeId: plan.sourceRouteAnchorToNodeId,
    sourceDivergenceNodeId: plan.sourceDivergenceNodeId,
    destinationNodeId: plan.destinationNodeId,
    materializedOriginNodeId: originNode.id,
    materializedOriginPlaceId: originPlace.id,
    materializedOriginDayOccurrenceId: occurrenceId,
    materializedOriginAnchorSnapshot: anchorSnapshot,
    preservedPrefixNodeIds: plan.preservedPrefixNodeIds,
    preservedPrefixTransportEdgeIds: plan.preservedPrefixTransportEdgeIds,
    preservedPrefixHash: prefixHash,
    replacementNodeIds: plan.replacementNodeIds,
    archivedTransportEdgeIds: plan.replacementTransportEdgeIds,
    archivableProviderActualTransportEdgeIds:
      summary.archivableProviderActualTransportEdgeIds ?? [],
    afterGeneratedNodeFacts: await externalGeneratedNodeFacts(
      tx,
      input.tripId,
      [...delta.createdNodeIds, ...delta.reusedNodeIds],
    ),
    createdGroundTransitTransportEdgeIds: (
      await tx.transportEdge.findMany({
        where: {
          tripId: input.tripId,
          adoptedRouteId: route.id,
          mode: { in: ['RAIL', 'BUS'] },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
    ).map((edge) => edge.id),
    afterGroundTransitLegFacts: await externalGroundTransitExecutionFacts(
      tx,
      input.tripId,
      route.id,
    ),
    archivedSuffixHash: hashExternalRouteAudit(histories),
  };
  const result = await tx.operationReceipt.update({
    where: { id: receipt.id },
    data: { delta: complete as unknown as Prisma.InputJsonValue },
  });
  await tx.outboxEvent.create({
    data: {
      type: 'ROUTE_ADOPTED',
      aggregateType: 'AdoptedRoute',
      aggregateId: route.id,
      tripId: input.tripId,
      operationReceiptId: receipt.id,
      payload: {
        operationReceiptId: receipt.id,
        tripId: input.tripId,
        resultingTripVersion: input.baseTripVersion + 1,
        adoptedRouteId: route.id,
        replacementScope: 'EXTERNAL_ORIGIN',
        externalOriginId: plan.externalOriginId,
      },
      createdAt: input.now,
    },
  });
  // The existing external-origin rule already requires departure >= now.
  // Recheck with a fresh clock before commit, without altering its time policy.
  if (
    restoreNormalizedCandidate(snapshot.candidatePayload).departure.instant <
    new Date(Math.max(eligibilityNow.getTime(), clock.now().getTime()))
  )
    throw new AdoptionAbort('PREVIEW_STALE');
  return {
    status: 'SUCCESS',
    receipt: toReceiptRecord(result),
    idempotentReplay: false,
  };
}
function localDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

/** Split a date occurrence only when inserting E would otherwise place D before E.
 * These are timeline projections, not additional itinerary facts. */
async function placeExternalOrigin(
  tx: Transaction,
  tripId: string,
  originId: string,
  divergenceId: string,
) {
  const nodes = await tx.itineraryNode.findMany({
    where: { tripId },
    select: { id: true, dayOccurrenceId: true },
    orderBy: [
      { dayOccurrence: { sequence: 'asc' } },
      { position: 'asc' },
      { id: 'asc' },
    ],
  });
  const ordered = nodes.filter((node) => node.id !== originId);
  const origin = nodes.find((node) => node.id === originId)!;
  const divergence = ordered.findIndex((node) => node.id === divergenceId);
  if (divergence < 0) throw new AdoptionAbort('PREVIEW_STALE');
  ordered.splice(divergence + 1, 0, origin);
  const occurrences = await tx.dayOccurrence.findMany({
    where: { tripId },
    orderBy: { sequence: 'asc' },
  });
  const runs: { id: string; originalId: string; nodeIds: string[] }[] = [];
  const createdOccurrenceIds: string[] = [];
  const suffixOccurrenceIds = new Map<string, string>();
  let sequence = Math.max(...occurrences.map((day) => day.sequence)) + 100;
  for (const node of ordered) {
    let run = runs.at(-1);
    if (!run || run.originalId !== node.dayOccurrenceId) {
      let id = node.dayOccurrenceId;
      if (runs.some((previous) => previous.originalId === id)) {
        const old = occurrences.find((day) => day.id === id)!;
        const split = await tx.dayOccurrence.create({
          data: { tripId, localDate: old.localDate, sequence: ++sequence },
        });
        createdOccurrenceIds.push(split.id);
        suffixOccurrenceIds.set(id, split.id);
        id = split.id;
      }
      run = { id, originalId: node.dayOccurrenceId, nodeIds: [] };
      runs.push(run);
    }
    run.nodeIds.push(node.id);
    if (node.dayOccurrenceId !== run.id)
      await tx.itineraryNode.update({
        where: { id: node.id },
        data: {
          dayOccurrenceId: run.id,
          position: 2_000_000 + ordered.indexOf(node),
        },
      });
  }
  const order = runs.map((run) => run.id);
  for (const day of occurrences.filter(
    (day) => !runs.some((run) => run.id === day.id),
  )) {
    const next = occurrences.find(
      (candidate) =>
        candidate.sequence > day.sequence && order.includes(candidate.id),
    );
    const index = next ? order.indexOf(next.id) : order.length;
    order.splice(index, 0, day.id);
  }
  await tx.$executeRaw(
    Prisma.sql`UPDATE "DayOccurrence" SET "sequence"="sequence"+${sequence + 100} WHERE "tripId"=${tripId}::uuid`,
  );
  for (const [i, id] of order.entries())
    await tx.dayOccurrence.update({ where: { id }, data: { sequence: i } });
  for (const run of runs) {
    await tx.$executeRaw(
      Prisma.sql`UPDATE "ItineraryNode" SET "position"="position"+3000000 WHERE "dayOccurrenceId"=${run.id}::uuid`,
    );
    for (const [position, id] of run.nodeIds.entries())
      await tx.itineraryNode.update({ where: { id }, data: { position } });
  }
  return { createdOccurrenceIds, suffixOccurrenceIds };
}
