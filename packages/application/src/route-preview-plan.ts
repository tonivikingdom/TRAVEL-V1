import type {
  ExternalOriginReplacementView,
  RouteCandidateView,
  RouteLocationView,
  RoutePreviewLocationView,
  RoutePreviewSegmentView,
  RoutePreviewView,
} from '@travel/contracts';
import {
  assessDwell,
  validateRouteCandidate,
  classifyExternalReplacementTransportActual,
  type NormalizedRouteCandidate,
} from '@travel/domain';
import {
  compareCanonicalDwellAdjustments,
  compareCanonicalText,
} from './canonical-order.js';
import { ApplicationError } from './errors.js';
import type { RouteCandidateSnapshotRecord } from './route-planning-ports.js';
import {
  hashRouteCandidateSnapshot,
  hashExternalRouteCandidateSnapshot,
  restoreNormalizedCandidate,
} from './route-snapshot.js';
import {
  evaluateTripScheduleRecord,
  orderedTripNodes,
} from './schedule-evaluation.js';
import { resolveCurrentRouteCorridor } from './route-corridor.js';
import { generatedNodeDeletionProtectionReasons } from './generated-node-deletion-protection.js';
import { validateIanaTimeZoneInput } from './time-input.js';
import type {
  ItineraryNodeRecord,
  TransportEdgeRecord,
  TripAggregateRecord,
} from './trip-ports.js';

export interface PreviewCorridor {
  readonly fromNode: ItineraryNodeRecord;
  readonly toNode: ItineraryNodeRecord;
  readonly nodes: readonly ItineraryNodeRecord[];
  readonly currentTransports: readonly TransportEdgeRecord[];
  readonly replacementScope: 'FULL_CORRIDOR' | 'SUFFIX' | 'EXTERNAL_ORIGIN';
  readonly sourceAdoptedRouteId: string | null;
  readonly sourceRouteAnchorFromNodeId: string;
  readonly sourceRouteAnchorToNodeId: string;
  readonly preservedPrefixNodeIds: readonly string[];
  readonly preservedPrefixTransportEdgeIds: readonly string[];
  readonly currentAdoptedRouteId: string | null;
}

export function validateSnapshot(
  snapshot: RouteCandidateSnapshotRecord,
): NormalizedRouteCandidate {
  const basis = {
    tripId: snapshot.tripId,
    basisVersion: snapshot.basisVersion,
    toNodeId: snapshot.toNodeId,
    provider: snapshot.provider,
    observedAt: snapshot.observedAt.toISOString(),
    candidatePayload: snapshot.candidatePayload,
  };
  const hash =
    snapshot.origin.type === 'ITINERARY_NODE'
      ? hashRouteCandidateSnapshot({
          ...basis,
          fromNodeId: snapshot.origin.nodeId,
        })
      : hashExternalRouteCandidateSnapshot({
          ...basis,
          externalOriginSnapshot: snapshot.origin.snapshot,
        });
  if (hash !== snapshot.candidateHash) throw stalePreview();
  try {
    const candidate = restoreNormalizedCandidate(snapshot.candidatePayload);
    if (
      candidate.provider !== snapshot.provider ||
      candidate.providerCandidateRef !== snapshot.providerCandidateRef ||
      candidate.observedAt.getTime() !== snapshot.observedAt.getTime() ||
      candidate.validUntil?.getTime() !==
        snapshot.providerValidUntil?.getTime() ||
      !candidateUsesSupportedZones(candidate) ||
      !validateRouteCandidate(candidate, {
        earliestDeparture: null,
        latestArrival: null,
      }).accepted
    ) {
      throw stalePreview();
    }
    return candidate;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw stalePreview();
  }
}

export function requireCurrentCorridor(
  trip: TripAggregateRecord,
  snapshot: RouteCandidateSnapshotRecord & { readonly fromNodeId: string },
) {
  const nodes = orderedTripNodes(trip);
  const fromIndex = nodes.findIndex((node) => node.id === snapshot.fromNodeId);
  const toIndex = nodes.findIndex((node) => node.id === snapshot.toNodeId);
  const corridor = resolveCurrentRouteCorridor(trip, nodes, fromIndex, toIndex);
  if (corridor === null) throw stalePreview();
  return {
    fromNode: corridor.nodes[0]!,
    toNode: corridor.nodes.at(-1)!,
    ...corridor,
  };
}

export function buildChangeSummary(
  candidate: NormalizedRouteCandidate,
  snapshot: RouteCandidateSnapshotRecord,
  trip: TripAggregateRecord,
  corridor: PreviewCorridor,
  userConfirmedSameHub: ReadonlySet<number>,
  schedule: ReturnType<typeof evaluateTripScheduleRecord>,
  external?: ExternalOriginReplacementView,
): RoutePreviewView['changeSummary'] {
  const boundaries: RouteLocationView[] = [];
  for (let index = 0; index + 1 < candidate.legs.length; index += 1) {
    const incoming = candidate.legs[index];
    const outgoing = candidate.legs[index + 1];
    if (
      incoming === undefined ||
      outgoing === undefined ||
      !sameTransferLocation(incoming.to, outgoing.from)
    ) {
      throw previewUnsupported('路线候选的换乘点不连续。');
    }
    if (incoming.to.latitude === null || incoming.to.longitude === null) {
      throw previewUnsupported('路线候选的换乘点缺少可定位坐标。');
    }
    boundaries.push({
      ...incoming.to,
      providerHubRef: incoming.to.providerHubRef ?? null,
    });
  }

  const internalWalking = detectInternalWalking(
    candidate,
    userConfirmedSameHub,
  );
  const groups = groupTransferBoundaries(
    candidate,
    boundaries,
    internalWalking,
  );
  assertEndpointDates(trip, corridor, candidate, external);

  const currentGenerated = corridor.nodes
    .slice(1, -1)
    .filter((node) => node.source === 'ROUTE_GENERATED');
  const usedNodeIds = new Set<string>();
  const nodePlans = groups.map((group) => {
    const reusable = currentGenerated.find(
      (node) =>
        !usedNodeIds.has(node.id) &&
        reliableLocationMatch(node, group.location),
    );
    if (reusable !== undefined) usedNodeIds.add(reusable.id);
    const currentDay =
      reusable === undefined
        ? undefined
        : trip.dayOccurrences.find(
            (occurrence) => occurrence.id === reusable.dayOccurrenceId,
          );
    return {
      ref: group.ref,
      action: reusable === undefined ? ('CREATE' as const) : ('REUSE' as const),
      nodeId: reusable?.id ?? null,
      location: group.location,
      localDate: group.localDate,
      dayOccurrenceId:
        currentDay !== undefined &&
        formatLocalDate(currentDay.localDate) === group.localDate
          ? currentDay.id
          : null,
      provider: snapshot.provider,
      providerPlaceRef: group.location.providerPlaceRef,
      providerHubRef: group.location.providerHubRef ?? null,
      evidence: group.evidence,
    };
  });
  const nodesToRemove = currentGenerated
    .filter((node) => !usedNodeIds.has(node.id))
    .map((node) => {
      const protectionReasons = [
        ...generatedNodeProtectionReasons(node),
        ...generatedNodeDeletionProtectionReasons(node.deletionReferenceFacts),
      ];
      return {
        nodeId: node.id,
        dayOccurrenceId: node.dayOccurrenceId,
        protected: protectionReasons.length > 0,
        protectionReasons,
      };
    });
  const boundaryRef = (boundary: number): string => {
    const group = groups.find(
      (item) => boundary >= item.firstBoundary && boundary <= item.lastBoundary,
    );
    if (group === undefined) throw previewUnsupported('换乘分组不完整。');
    return group.ref;
  };
  const proposedSegments: RoutePreviewSegmentView[] = [];
  for (const [legIndex, leg] of candidate.legs.entries()) {
    if (internalWalking.has(legIndex)) continue;
    proposedSegments.push({
      legIndex,
      fromRef:
        legIndex === 0
          ? external === undefined
            ? 'FROM_NODE'
            : 'EXTERNAL_ORIGIN'
          : boundaryRef(legIndex - 1),
      toRef:
        legIndex === candidate.legs.length - 1
          ? 'TO_NODE'
          : boundaryRef(legIndex),
      mode: leg.mode,
      fixedService: leg.fixedService,
      serviceLabel: leg.serviceLabel,
      providerRef: leg.providerRef,
      ...(leg.groundTransit === undefined
        ? {}
        : { groundTransit: leg.groundTransit }),
      departure: toNullableTimePoint(leg.departure),
      arrival: toNullableTimePoint(leg.arrival),
      durationSeconds: leg.durationSeconds,
    });
  }
  const downstreamImpact = findNearestDownstreamImpact(
    candidate,
    trip,
    corridor,
    schedule,
  );
  const requiredUserAdjustments = uniqueAdjustments([
    ...(external === undefined
      ? (snapshot.candidatePayload.planningAssessment
          ?.requiredUserAdjustments ?? [])
      : []),
    ...(downstreamImpact?.requiredUserAdjustments ?? []),
  ]);
  return {
    transportAction:
      corridor.currentTransports.length === 0 ? 'CREATE' : 'REPLACE',
    willReplaceTransportEdgeId: corridor.currentTransports[0]?.id ?? null,
    willReplaceTransportEdgeIds: corridor.currentTransports.map(
      (edge) => edge.id,
    ),
    requiresGeneratedNodes: external !== undefined || groups.length > 0,
    generatedTransferPoints: groups.map((group) => group.location),
    proposedSegments,
    ...(external === undefined &&
    corridor.replacementScope !== 'EXTERNAL_ORIGIN'
      ? {
          routeCorridor: {
            replacementScope: corridor.replacementScope,
            sourceAdoptedRouteId: corridor.sourceAdoptedRouteId,
            sourceRouteAnchorFromNodeId: corridor.sourceRouteAnchorFromNodeId,
            sourceRouteAnchorToNodeId: corridor.sourceRouteAnchorToNodeId,
            replacementAnchorFromNodeId: corridor.fromNode.id,
            replacementAnchorToNodeId: corridor.toNode.id,
            preservedPrefixNodeIds: corridor.preservedPrefixNodeIds,
            preservedPrefixTransportEdgeIds:
              corridor.preservedPrefixTransportEdgeIds,
            anchorFromNodeId: corridor.fromNode.id,
            anchorToNodeId: corridor.toNode.id,
            currentNodeIds: corridor.nodes.map((node) => node.id),
            currentAdoptedRouteId: corridor.currentAdoptedRouteId,
          },
        }
      : external === undefined
        ? {}
        : { externalOriginReplacement: external }),
    nodesToCreate: nodePlans.filter((plan) => plan.action === 'CREATE'),
    nodesToReuse: nodePlans.filter((plan) => plan.action === 'REUSE'),
    nodesToRemove,
    protectedBlockingNodes:
      corridor.replacementScope === 'SUFFIX' || external !== undefined
        ? currentGenerated.flatMap((node) => {
            const reasons = usedNodeIds.has(node.id)
              ? generatedNodeProtectionReasons(node)
              : nodesToRemove.find((removed) => removed.nodeId === node.id)!
                  .protectionReasons;
            return reasons.length === 0
              ? []
              : [
                  {
                    nodeId: node.id,
                    dayOccurrenceId: node.dayOccurrenceId,
                    protected: true,
                    protectionReasons: reasons,
                  },
                ];
          })
        : nodesToRemove.filter((node) => node.protected),
    ...(external !== undefined
      ? classifyExternalReplacementTransportActual(corridor.currentTransports)
      : {
          protectedBlockingTransportEdgeIds:
            corridor.replacementScope === 'SUFFIX'
              ? corridor.currentTransports
                  .filter((edge) =>
                    edge.timeValues.some((value) => value.layer === 'ACTUAL'),
                  )
                  .map((edge) => edge.id)
              : [],
        }),
    internalTransferDetails: [...internalWalking.entries()].map(
      ([legIndex, evidence]) => {
        const leg = candidate.legs[legIndex]!;
        return {
          legIndex,
          mode: 'WALKING' as const,
          from: {
            ...leg.from,
            providerHubRef: leg.from.providerHubRef ?? null,
          },
          to: { ...leg.to, providerHubRef: leg.to.providerHubRef ?? null },
          durationSeconds: leg.durationSeconds,
          evidence,
        };
      },
    ),
    proposedDayAssignments: [
      ...(external === undefined ? [] : [external.materializedOrigin]),
      ...nodePlans,
    ].map((plan) => ({
      nodeRef: plan.ref,
      localDate: plan.localDate,
      dayOccurrenceId: plan.dayOccurrenceId,
    })),
    proposedTransportDayProjections: proposedSegments.map((segment, index) => ({
      segmentIndex: index,
      fromRef: segment.fromRef,
      toRef: segment.toRef,
      roles: projectionRolesForSegment(
        segment,
        [
          ...(external === undefined ? [] : [external.materializedOrigin]),
          ...nodePlans,
        ],
        trip,
        corridor,
      ),
    })),
    temporalLayer: 'PLANNED',
    temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
    requiredUserAdjustments,
    ...(downstreamImpact === null
      ? {}
      : {
          downstreamImpact: {
            ...downstreamImpact,
            requiredUserAdjustments,
          },
        }),
  };
}

function uniqueAdjustments(
  values: readonly {
    readonly intentId: string;
    readonly nodeId: string;
    readonly fromDurationSeconds: number;
    readonly toDurationSeconds: number;
  }[],
) {
  return [
    ...new Map(values.map((value) => [value.intentId, value])).values(),
  ].sort(compareCanonicalDwellAdjustments);
}

function findNearestDownstreamImpact(
  candidate: NormalizedRouteCandidate,
  trip: TripAggregateRecord,
  corridor: PreviewCorridor,
  schedule: ReturnType<typeof evaluateTripScheduleRecord>,
): NonNullable<RoutePreviewView['changeSummary']['downstreamImpact']> | null {
  const nodes = orderedTripNodes(trip);
  const startIndex = nodes.findIndex((node) => node.id === corridor.toNode.id);
  if (startIndex < 0) return null;

  for (let index = startIndex; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    const projection = schedule.nodes.find((item) => item.nodeId === node.id);
    if (projection === undefined) continue;
    const arrival =
      index === startIndex
        ? candidate.arrival.instant
        : currentPlanPoint(trip, node.id, 'ARRIVAL', projection.arrival);
    const departure =
      currentPlanPoint(trip, node.id, 'DEPARTURE', projection.departure) ??
      projection.departure.requirementWindow.latest;
    const userMinimum = node.timeIntents.find(
      (intent) => intent.kind === 'MIN_DWELL',
    );
    const planningDuration =
      userMinimum?.durationSeconds ??
      node.systemDwellSuggestion?.durationSeconds ??
      null;
    const hasPointConstraint = node.timeIntents.some(
      (intent) => intent.kind === 'POINT_TIME',
    );
    const timeRelevant =
      departure !== null || planningDuration !== null || hasPointConstraint;
    if (timeRelevant && arrival !== null) {
      const projectedDeparture =
        departure ??
        (planningDuration === null
          ? null
          : new Date(arrival.getTime() + planningDuration * 1_000));
      const dwell = assessDwell({
        arrival,
        departure: projectedDeparture,
        systemSuggestedDurationSeconds:
          node.systemDwellSuggestion?.durationSeconds ?? null,
        userMinimumDurationSeconds: userMinimum?.durationSeconds ?? null,
      });
      const requiredUserAdjustments =
        dwell.requiresUserAdjustment &&
        userMinimum !== undefined &&
        dwell.adjustedUserMinimumDurationSeconds !== null
          ? [
              {
                intentId: userMinimum.id,
                nodeId: node.id,
                fromDurationSeconds: userMinimum.durationSeconds!,
                toDurationSeconds: dwell.adjustedUserMinimumDurationSeconds,
              },
            ]
          : [];
      return {
        nodeId: node.id,
        arrival: arrival.toISOString(),
        departure: projectedDeparture?.toISOString() ?? null,
        projectedDwellSeconds: dwell.projectedDwellSeconds,
        systemSuggestedDwellSeconds: dwell.systemSuggestedDurationSeconds,
        userMinimumDwellSeconds: dwell.userMinimumDurationSeconds,
        status: dwell.status,
        requiredUserAdjustments,
      };
    }
    if (
      hasActualAtNode(trip, node.id, projection) ||
      (index > startIndex && node.source === 'USER_PLANNED')
    ) {
      return null;
    }
  }
  return null;
}

function currentPlanPoint(
  trip: TripAggregateRecord,
  nodeId: string,
  pointKind: 'ARRIVAL' | 'DEPARTURE',
  projection: ReturnType<
    typeof evaluateTripScheduleRecord
  >['nodes'][number]['arrival'],
): Date | null {
  const selectedTransportValues = trip.transportEdges
    .filter((edge) =>
      pointKind === 'ARRIVAL'
        ? edge.toNodeId === nodeId
        : edge.fromNodeId === nodeId,
    )
    .flatMap((edge) =>
      edge.timeValues
        .filter((value) => value.pointKind === pointKind)
        .map((value) => ({ edgeId: edge.id, value })),
    )
    .sort((left, right) => {
      const layerOrder =
        temporalLayerRank(right.value.layer) -
        temporalLayerRank(left.value.layer);
      return (
        layerOrder ||
        compareCanonicalText(left.edgeId, right.edgeId) ||
        compareCanonicalText(left.value.id, right.value.id)
      );
    });
  const selected = selectedTransportValues[0]?.value ?? null;
  const nodeEffective = projection.effective?.value ?? null;
  if (selected === null) return nodeEffective?.instant ?? null;
  if (nodeEffective === null) return selected.instant;
  const selectedRank = temporalLayerRank(selected.layer);
  const nodeRank = temporalLayerRank(nodeEffective.layer);
  if (selectedRank > nodeRank) return selected.instant;
  if (selectedRank < nodeRank) return nodeEffective.instant;
  return selected.layer === 'ACTUAL' ? nodeEffective.instant : selected.instant;
}

function hasActualAtNode(
  trip: TripAggregateRecord,
  nodeId: string,
  projection: ReturnType<typeof evaluateTripScheduleRecord>['nodes'][number],
): boolean {
  return (
    projection.arrival.actual !== null ||
    projection.departure.actual !== null ||
    trip.transportEdges.some(
      (edge) =>
        (edge.fromNodeId === nodeId || edge.toNodeId === nodeId) &&
        edge.timeValues.some((value) => value.layer === 'ACTUAL'),
    )
  );
}

function temporalLayerRank(layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL'): number {
  return layer === 'ACTUAL' ? 3 : layer === 'ESTIMATED' ? 2 : 1;
}

function sameTransferLocation(
  left: RouteLocationView,
  right: RouteLocationView,
): boolean {
  if (left.providerPlaceRef !== null && right.providerPlaceRef !== null) {
    return left.providerPlaceRef === right.providerPlaceRef;
  }
  return (
    left.latitude !== null &&
    left.longitude !== null &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude
  );
}

function detectInternalWalking(
  candidate: NormalizedRouteCandidate,
  userConfirmedSameHub: ReadonlySet<number>,
): ReadonlyMap<number, 'SYSTEM_STRUCTURED' | 'USER_CONFIRMED'> {
  const result = new Map<number, 'SYSTEM_STRUCTURED' | 'USER_CONFIRMED'>();
  for (const index of userConfirmedSameHub) {
    if (
      !Number.isSafeInteger(index) ||
      index <= 0 ||
      index >= candidate.legs.length - 1 ||
      candidate.legs[index]?.mode !== 'WALKING'
    ) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '同枢纽确认只能引用明确的中间步行段。',
        400,
      );
    }
  }
  for (let index = 1; index + 1 < candidate.legs.length; index += 1) {
    const leg = candidate.legs[index];
    if (leg?.mode !== 'WALKING') continue;
    const structured = sameStructuredHub(leg.from, leg.to);
    if (structured || userConfirmedSameHub.has(index)) {
      result.set(index, structured ? 'SYSTEM_STRUCTURED' : 'USER_CONFIRMED');
    }
  }
  return result;
}

function groupTransferBoundaries(
  candidate: NormalizedRouteCandidate,
  boundaries: readonly RouteLocationView[],
  internalWalking: ReadonlyMap<number, 'SYSTEM_STRUCTURED' | 'USER_CONFIRMED'>,
) {
  const groups: Array<{
    readonly firstBoundary: number;
    readonly lastBoundary: number;
    readonly ref: string;
    readonly location: RoutePreviewLocationView;
    readonly localDate: string;
    readonly evidence: 'SYSTEM_STRUCTURED' | 'USER_CONFIRMED';
  }> = [];
  for (let boundary = 0; boundary < boundaries.length; boundary += 1) {
    const start = boundary;
    let end = boundary;
    let evidence: 'SYSTEM_STRUCTURED' | 'USER_CONFIRMED' = 'SYSTEM_STRUCTURED';
    while (internalWalking.has(end + 1)) {
      evidence = internalWalking.get(end + 1) ?? evidence;
      end += 1;
    }
    const incoming = candidate.legs[start];
    const outgoing = candidate.legs[end + 1];
    const location = boundaries[start];
    if (
      incoming === undefined ||
      outgoing === undefined ||
      location === undefined
    ) {
      throw previewUnsupported('路线候选的换乘结构不完整。');
    }
    const ref = `TRANSFER_${groups.length}`;
    groups.push({
      firstBoundary: start,
      lastBoundary: end,
      ref,
      location: { ...location, ref },
      localDate: transferLocalDate(incoming.arrival, outgoing.departure),
      evidence,
    });
    boundary = end;
  }
  return groups;
}

function sameStructuredHub(
  left: RouteLocationView,
  right: RouteLocationView,
): boolean {
  return (
    left.providerHubRef !== undefined &&
    left.providerHubRef !== null &&
    right.providerHubRef !== undefined &&
    right.providerHubRef !== null &&
    left.providerHubRef === right.providerHubRef
  );
}

function reliableLocationMatch(
  node: ReturnType<typeof orderedTripNodes>[number],
  location: RouteLocationView,
): boolean {
  return (
    (node.providerPlaceRef !== undefined &&
      node.providerPlaceRef !== null &&
      location.providerPlaceRef !== null &&
      node.providerPlaceRef === location.providerPlaceRef) ||
    (node.providerHubRef !== undefined &&
      node.providerHubRef !== null &&
      location.providerHubRef !== undefined &&
      location.providerHubRef !== null &&
      node.providerHubRef === location.providerHubRef)
  );
}

function generatedNodeProtectionReasons(
  node: ReturnType<typeof orderedTripNodes>[number],
): readonly string[] {
  const reasons: string[] = [];
  if (node.timeValues.some((value) => value.layer === 'ACTUAL')) {
    reasons.push('ACTUAL');
  }
  if (node.timeIntents.length > 0) reasons.push('USER_TIME_INTENT');
  if (node.note !== null && node.note.trim() !== '') reasons.push('NOTE');
  if (node.autoReplaceable !== true || node.userModifiedAt != null) {
    reasons.push('USER_MODIFIED');
  }
  return reasons;
}

function transferLocalDate(
  incomingArrival: { readonly instant: Date; readonly timeZone: string } | null,
  outgoingDeparture: {
    readonly instant: Date;
    readonly timeZone: string;
  } | null,
): string {
  if (incomingArrival === null && outgoingDeparture === null) {
    throw previewUnsupported('换乘点缺少可确定日期的到达或出发时刻。');
  }
  const arrivalDate =
    incomingArrival === null ? null : localDateAt(incomingArrival);
  const departureDate =
    outgoingDeparture === null ? null : localDateAt(outgoingDeparture);
  if (
    arrivalDate !== null &&
    departureDate !== null &&
    arrivalDate !== departureDate
  ) {
    throw previewUnsupported('CROSS_DAY_TRANSFER_LOCATION');
  }
  return arrivalDate ?? departureDate!;
}

export function localDateAt(point: {
  readonly instant: Date;
  readonly timeZone: string;
}): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: point.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(point.instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function assertEndpointDates(
  trip: TripAggregateRecord,
  corridor: PreviewCorridor,
  candidate: NormalizedRouteCandidate,
  external?: ExternalOriginReplacementView,
): void {
  const fromDay = trip.dayOccurrences.find(
    (day) => day.id === corridor.fromNode.dayOccurrenceId,
  );
  const toDay = trip.dayOccurrences.find(
    (day) => day.id === corridor.toNode.dayOccurrenceId,
  );
  if (
    (external === undefined &&
      (fromDay === undefined ||
        localDateAt(candidate.departure) !==
          formatLocalDate(fromDay.localDate))) ||
    toDay === undefined ||
    localDateAt(candidate.arrival) !== formatLocalDate(toDay.localDate)
  ) {
    throw previewUnsupported('ENDPOINT_DAY_MISMATCH');
  }
}

export function formatLocalDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function normalizeSameHubConfirmations(
  indexes: readonly number[] | undefined,
  legCount: number,
): ReadonlySet<number> {
  const result = new Set<number>();
  for (const index of indexes ?? []) {
    if (!Number.isSafeInteger(index) || index <= 0 || index >= legCount - 1) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '同枢纽确认必须引用明确的中间步行段。',
        400,
      );
    }
    result.add(index);
  }
  return result;
}

function projectionRolesForSegment(
  segment: RoutePreviewSegmentView,
  plans: readonly NonNullable<
    RoutePreviewView['changeSummary']['nodesToCreate']
  >[number][],
  trip: TripAggregateRecord,
  corridor: PreviewCorridor,
): readonly ('SAME_DAY' | 'START' | 'OCCUPIED' | 'END')[] {
  const occurrenceFor = (ref: string): string | null => {
    if (ref === 'FROM_NODE') return corridor.fromNode.dayOccurrenceId;
    if (ref === 'TO_NODE') return corridor.toNode.dayOccurrenceId;
    return plans.find((plan) => plan.ref === ref)?.dayOccurrenceId ?? null;
  };
  const fromId = occurrenceFor(segment.fromRef);
  const toId = occurrenceFor(segment.toRef);
  if (fromId === null || toId === null) return ['START', 'END'];
  const fromSequence = trip.dayOccurrences.find(
    (day) => day.id === fromId,
  )?.sequence;
  const toSequence = trip.dayOccurrences.find(
    (day) => day.id === toId,
  )?.sequence;
  if (fromSequence === undefined || toSequence === undefined) {
    return ['START', 'END'];
  }
  const distance = toSequence - fromSequence;
  if (distance === 0) return ['SAME_DAY'];
  if (distance === 1) return ['START', 'END'];
  return [
    'START',
    ...Array.from({ length: distance - 1 }, () => 'OCCUPIED' as const),
    'END',
  ];
}

export function toCandidateView(
  snapshot: RouteCandidateSnapshotRecord,
): RouteCandidateView {
  return {
    ...snapshot.candidatePayload,
    candidateSnapshotId: snapshot.id,
    snapshotExpiresAt: snapshot.expiresAt.toISOString(),
  };
}

function toNullableTimePoint(
  point: { readonly instant: Date; readonly timeZone: string } | null,
) {
  return point === null
    ? null
    : { instant: point.instant.toISOString(), timeZone: point.timeZone };
}

function candidateUsesSupportedZones(
  candidate: NormalizedRouteCandidate,
): boolean {
  try {
    validateIanaTimeZoneInput(candidate.departure.timeZone);
    validateIanaTimeZoneInput(candidate.arrival.timeZone);
    for (const leg of candidate.legs) {
      if (leg.departure !== null) {
        validateIanaTimeZoneInput(leg.departure.timeZone);
      }
      if (leg.arrival !== null) {
        validateIanaTimeZoneInput(leg.arrival.timeZone);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function assertSnapshotFresh(
  snapshot: RouteCandidateSnapshotRecord,
  now: Date,
): void {
  if (
    snapshot.expiresAt <= now ||
    (snapshot.providerValidUntil !== null && snapshot.providerValidUntil <= now)
  ) {
    throw stalePreview();
  }
}

export function earlier(left: Date, right: Date): Date {
  return left < right ? left : right;
}

export function laterNullable(
  left: Date | null,
  right: Date | null,
): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

export function earlierNullable(
  left: Date | null,
  right: Date | null,
): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

export function stalePreview(): ApplicationError {
  return new ApplicationError(
    'PREVIEW_STALE',
    '路线候选已过期或不再满足当前安全条件。',
    409,
  );
}

function previewUnsupported(message: string): ApplicationError {
  return new ApplicationError('PREVIEW_UNSUPPORTED', message, 422);
}
