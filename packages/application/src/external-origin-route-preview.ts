import type { ExternalOriginReplacementView } from '@travel/contracts';
import {
  resolveExternalOriginReplacementCorridor,
  validateRouteCandidate,
  validateExternalRouteCandidateEndpoints,
} from '@travel/domain';
import type { ExternalOriginPlanningContext } from './external-execution-origin-ports.js';
import {
  authorizeExternalOriginPlanning,
  externalRouteOriginSnapshot,
} from './external-origin-route-query.js';
import { hashExternalRouteCandidateSnapshot } from './route-snapshot.js';
import type {
  RouteCandidateSnapshotRecord,
  StoredRoutePreviewPayload,
} from './route-planning-ports.js';
import {
  assertSnapshotFresh,
  validateSnapshot,
  buildChangeSummary,
  formatLocalDate,
  localDateAt,
  normalizeSameHubConfirmations,
  earlierNullable,
  laterNullable,
  stalePreview,
  toCandidateView,
} from './route-preview-plan.js';
import {
  externalRouteDestinationSchedule,
  orderedTripNodes,
} from './schedule-evaluation.js';
import type { TripAggregateRecord } from './trip-ports.js';

export const EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION =
  'route-external-origin-preview-v1';

/** Shared deterministic plan computation. Persistence reruns it after acquiring
 * the owner and Trip locks, using freshly loaded facts rather than the old plan.
 */
export function buildExternalOriginPreviewPayload(input: {
  trip: TripAggregateRecord;
  snapshot: RouteCandidateSnapshotRecord;
  context: ExternalOriginPlanningContext;
  now: Date;
  sameHubWalkingLegIndexes?: readonly number[] | undefined;
}): StoredRoutePreviewPayload {
  const { trip, snapshot, context, now } = input;
  if (
    snapshot.origin.type !== 'EXTERNAL_EXECUTION_ORIGIN' ||
    snapshot.tripId !== trip.id ||
    snapshot.basisVersion !== trip.version ||
    context.tripId !== trip.id ||
    context.tripVersion !== trip.version ||
    context.origin?.id !== snapshot.origin.externalOriginId ||
    authorizeExternalOriginPlanning(context, snapshot.toNodeId) !== 'AUTHORIZED'
  )
    throw stalePreview();
  const evidence = snapshot.origin.snapshot;
  // Compare canonical hashes; JSON object key order is not evidence.
  const originHash = (externalOriginSnapshot: typeof evidence) =>
    hashExternalRouteCandidateSnapshot({
      tripId: trip.id,
      basisVersion: trip.version,
      toNodeId: snapshot.toNodeId,
      provider: snapshot.provider,
      observedAt: snapshot.observedAt.toISOString(),
      candidatePayload: snapshot.candidatePayload,
      externalOriginSnapshot,
    });
  if (
    originHash(externalRouteOriginSnapshot(context.origin)) !==
    originHash(evidence)
  )
    throw stalePreview();
  const leg = context.leg;
  if (
    leg === null ||
    leg.id !== evidence.sourceGroundTransitLegExecutionId ||
    leg.tripId !== trip.id ||
    leg.transportEdgeId !== evidence.sourceTransportEdgeId ||
    leg.adoptedRouteId !== evidence.sourceAdoptedRouteId
  )
    throw stalePreview();
  const nodes = orderedTripNodes(trip);
  const topology = resolveExternalOriginReplacementCorridor({
    tripId: trip.id,
    orderedNodes: nodes,
    transports: trip.transportEdges,
    sourceRoute:
      trip.adoptedRoutes?.find(
        (route) => route.id === evidence.sourceAdoptedRouteId,
      ) ?? null,
    sourceTransportEdgeId: evidence.sourceTransportEdgeId,
    destinationNodeId: snapshot.toNodeId,
  });
  if (topology === null) throw stalePreview();
  assertSnapshotFresh(snapshot, now);
  let candidate: ReturnType<typeof validateSnapshot>;
  try {
    candidate = validateSnapshot(snapshot);
  } catch {
    throw stalePreview();
  }
  const trustedDestination = nodes.find(
    (node) => node.id === snapshot.toNodeId,
  );
  if (
    !trustedDestination?.place ||
    !validateExternalRouteCandidateEndpoints(
      candidate,
      { ...evidence, providerPlaceRef: null },
      {
        latitude: trustedDestination.place.latitude,
        longitude: trustedDestination.place.longitude,
        providerPlaceRef: trustedDestination.providerPlaceRef ?? null,
        providerHubRef: trustedDestination.providerHubRef ?? null,
      },
    )
  )
    throw stalePreview();
  const downstream = externalRouteDestinationSchedule(trip, snapshot.toNodeId);
  const destinationProjection = downstream.schedule.nodes.find(
    (node) => node.nodeId === snapshot.toNodeId,
  );
  if (
    downstream.schedule.conflicts.length > 0 ||
    destinationProjection === undefined
  )
    throw stalePreview();
  const time = snapshot.queryTimeCondition;
  if (
    !validateRouteCandidate(candidate, {
      earliestDeparture: laterNullable(
        now,
        laterNullable(
          time.hardEarliestDeparture === null
            ? null
            : new Date(time.hardEarliestDeparture),
          time.earliestDeparture === null
            ? null
            : new Date(time.earliestDeparture),
        ),
      ),
      latestArrival: earlierNullable(
        destinationProjection.arrival.requirementWindow.latest,
        earlierNullable(
          time.hardLatestArrival === null
            ? null
            : new Date(time.hardLatestArrival),
          time.latestArrival === null ? null : new Date(time.latestArrival),
        ),
      ),
    }).accepted
  )
    throw stalePreview();
  const localDate = localDateAt({
    instant: candidate.departure.instant,
    timeZone: evidence.timeZone,
  });
  const divergence = nodes.find(
    (node) => node.id === topology.sourceDivergenceNodeId,
  )!;
  const destination = nodes.find(
    (node) => node.id === topology.destinationNodeId,
  )!;
  const startSequence = trip.dayOccurrences.find(
    (day) => day.id === divergence.dayOccurrenceId,
  )!.sequence;
  const endSequence = trip.dayOccurrences.find(
    (day) => day.id === destination.dayOccurrenceId,
  )!.sequence;
  const matchingDays = trip.dayOccurrences.filter(
    (day) =>
      day.sequence >= startSequence &&
      day.sequence <= endSequence &&
      formatLocalDate(day.localDate) === localDate,
  );
  const external: ExternalOriginReplacementView = {
    ...topology,
    externalOriginId: evidence.externalOriginId,
    sourceGroundTransitLegExecutionId:
      evidence.sourceGroundTransitLegExecutionId,
    materializedOrigin: {
      ref: 'EXTERNAL_ORIGIN',
      action: 'CREATE',
      nodeId: null,
      kind: 'PLACE_VISIT',
      source: 'ROUTE_GENERATED',
      autoReplaceable: true,
      userModifiedAt: null,
      evidence: 'USER_CONFIRMED',
      provider: evidence.provider,
      providerHubRef: evidence.providerHubRef,
      providerPlaceRef: null,
      location: {
        ref: 'EXTERNAL_ORIGIN',
        name: evidence.name,
        latitude: evidence.latitude,
        longitude: evidence.longitude,
        providerPlaceRef: null,
        providerHubRef: evidence.providerHubRef,
      },
      localDate,
      // Repeated calendar dates do not identify an occurrence. Leave creation
      // explicit when no unique occurrence in the replaced corridor is usable.
      dayOccurrenceId: matchingDays.length === 1 ? matchingDays[0]!.id : null,
      temporalValues: [],
      executionEvents: [],
    },
  };
  const replacementNodes = topology.replacementNodeIds.map((id) =>
    nodes.find((node) => node.id === id)!,
  );
  const replacementEdges = topology.replacementTransportEdgeIds.map((id) =>
    trip.transportEdges.find((edge) => edge.id === id)!,
  );
  const sourceEdge = replacementEdges[0]!;
  return {
    tripId: trip.id,
    basisVersion: trip.version,
    candidateSnapshotId: snapshot.id,
    candidateHash: snapshot.candidateHash,
    policyVersion: EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION,
    currentConnection: {
      fromNodeId: sourceEdge.fromNodeId,
      toNodeId: sourceEdge.toNodeId,
      state: 'ACTIVE',
      transport: {
        id: sourceEdge.id,
        mode: sourceEdge.mode,
        fixedService: sourceEdge.fixedService,
        serviceLabel: sourceEdge.serviceLabel,
      },
    },
    candidate: toCandidateView(snapshot),
    changeSummary: buildChangeSummary(
      candidate,
      snapshot,
      downstream.trip,
      {
        ...topology,
        fromNode: replacementNodes[0]!,
        toNode: replacementNodes.at(-1)!,
        nodes: replacementNodes,
        currentTransports: replacementEdges,
        currentAdoptedRouteId: topology.sourceAdoptedRouteId,
      },
      normalizeSameHubConfirmations(
        input.sameHubWalkingLegIndexes,
        candidate.legs.length,
      ),
      downstream.schedule,
      external,
    ),
  };
}
