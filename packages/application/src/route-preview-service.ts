import type {
  CreateRoutePreviewRequest,
  RouteCandidateView,
  RouteLocationView,
  RoutePreviewLocationView,
  RoutePreviewSegmentView,
  RoutePreviewView,
} from '@travel/contracts';
import {
  assessDwell,
  validateRouteCandidate,
  type NormalizedRouteCandidate,
} from '@travel/domain';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import {
  systemClock,
  type Clock,
  type RouteCandidateSnapshotRecord,
  type RoutePlanningRepository,
  type StoredRoutePreviewPayload,
} from './route-planning-ports.js';
import {
  hashRouteCandidateSnapshot,
  hashRoutePreviewPayload,
  restoreNormalizedCandidate,
} from './route-snapshot.js';
import {
  evaluateTripScheduleRecord,
  orderedTripNodes,
} from './schedule-evaluation.js';
import { resolveCurrentRouteCorridor } from './route-corridor.js';
import { validateIanaTimeZoneInput } from './time-input.js';
import type { TripAggregateRecord, TripRepository } from './trip-ports.js';

export const ROUTE_PREVIEW_POLICY_VERSION = 'route-adoption-preview-v3';

export interface RoutePreviewServiceOptions {
  readonly previewTtlSeconds: number;
  readonly clock?: Clock;
}

export class RoutePreviewService {
  constructor(
    private readonly tripRepository: TripRepository,
    private readonly planningRepository: RoutePlanningRepository,
    private readonly options: RoutePreviewServiceOptions,
  ) {
    requireTtl(options.previewTtlSeconds);
  }

  async createPreview(
    actor: Actor,
    tripId: string,
    input: CreateRoutePreviewRequest,
  ): Promise<RoutePreviewView> {
    requireUuid(tripId, 'tripId');
    requireUuid(input.candidateSnapshotId, 'candidateSnapshotId');
    const basisVersion = positiveInteger(input.basisVersion, 'basisVersion');
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const trip = await this.requireTrip(actor.userId, tripId);
    if (trip.version !== basisVersion) throw versionConflict();
    const snapshot = await this.planningRepository.findSnapshotOwned({
      ownerUserId: actor.userId,
      tripId,
      snapshotId: input.candidateSnapshotId,
    });
    if (snapshot === null) throw notFound();
    if (snapshot.basisVersion !== basisVersion) throw stalePreview();

    const now = (this.options.clock ?? systemClock).now();
    assertSnapshotFresh(snapshot, now);
    const candidate = validateSnapshot(snapshot);
    const corridor = requireCurrentCorridor(trip, snapshot);
    const { fromNode, toNode } = corridor;
    const schedule = evaluateTripScheduleRecord(trip);
    if (schedule.conflicts.length > 0) throw stalePreview();
    const fromProjection = schedule.nodes.find(
      (node) => node.nodeId === fromNode.id,
    );
    const toProjection = schedule.nodes.find(
      (node) => node.nodeId === toNode.id,
    );
    if (fromProjection === undefined || toProjection === undefined) {
      throw stalePreview();
    }
    const bounds = {
      earliestDeparture: laterNullable(
        snapshot.queryTimeCondition.hardEarliestDeparture === null
          ? null
          : new Date(snapshot.queryTimeCondition.hardEarliestDeparture),
        fromProjection.departure.requirementWindow.earliestBasis.some(
          (basis) => basis.ruleId !== 'MIN_DWELL_FORWARD',
        )
          ? fromProjection.departure.requirementWindow.earliest
          : null,
      ),
      latestArrival: earlierNullable(
        snapshot.queryTimeCondition.hardLatestArrival === null
          ? null
          : new Date(snapshot.queryTimeCondition.hardLatestArrival),
        toProjection.arrival.requirementWindow.latest,
      ),
    };
    if (!validateRouteCandidate(candidate, bounds).accepted) {
      throw stalePreview();
    }

    const candidateView = toCandidateView(snapshot);
    const changeSummary = buildChangeSummary(
      candidate,
      snapshot,
      trip,
      corridor,
      normalizeSameHubConfirmations(
        input.sameHubWalkingLegIndexes,
        candidate.legs.length,
      ),
      toProjection,
    );
    const expiresAt = earlier(
      snapshot.expiresAt,
      new Date(now.getTime() + this.options.previewTtlSeconds * 1_000),
    );
    if (expiresAt <= now) throw stalePreview();
    const previewPayload: StoredRoutePreviewPayload = {
      tripId,
      basisVersion,
      candidateSnapshotId: snapshot.id,
      candidateHash: snapshot.candidateHash,
      policyVersion: ROUTE_PREVIEW_POLICY_VERSION,
      currentConnection: {
        fromNodeId: snapshot.fromNodeId,
        toNodeId: snapshot.toNodeId,
        state: corridor.currentTransports.length === 0 ? 'MISSING' : 'ACTIVE',
        transport:
          corridor.currentTransports[0] === undefined
            ? null
            : {
                id: corridor.currentTransports[0].id,
                mode: corridor.currentTransports[0].mode,
                fixedService: corridor.currentTransports[0].fixedService,
                serviceLabel: corridor.currentTransports[0].serviceLabel,
              },
      },
      candidate: candidateView,
      changeSummary,
    };
    const created = await this.planningRepository.createPreview({
      ownerUserId: actor.userId,
      tripId,
      basisVersion,
      snapshotId: snapshot.id,
      expectedCandidateHash: snapshot.candidateHash,
      fromNodeId: snapshot.fromNodeId,
      toNodeId: snapshot.toNodeId,
      policyVersion: ROUTE_PREVIEW_POLICY_VERSION,
      previewPayload,
      previewHash: hashRoutePreviewPayload(previewPayload),
      now,
      createdAt: now,
      expiresAt,
    });
    switch (created.status) {
      case 'NOT_FOUND':
        throw notFound();
      case 'VERSION_CONFLICT':
        throw versionConflict();
      case 'NOT_ADJACENT':
      case 'PREVIEW_STALE':
        throw stalePreview();
      case 'SUCCESS':
        return toPreviewView(created.preview, now);
    }
  }

  async getPreview(
    actor: Actor,
    tripId: string,
    previewId: string,
  ): Promise<RoutePreviewView> {
    requireUuid(tripId, 'tripId');
    requireUuid(previewId, 'previewId');
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const preview = await this.planningRepository.findPreviewOwned({
      ownerUserId: actor.userId,
      tripId,
      previewId,
    });
    if (preview === null) throw notFound();
    return toPreviewView(preview, (this.options.clock ?? systemClock).now());
  }

  private async requireTrip(
    ownerUserId: string,
    tripId: string,
  ): Promise<TripAggregateRecord> {
    const trip = await this.tripRepository.findOwnedById({
      ownerUserId,
      tripId,
    });
    if (trip === null) throw notFound();
    return trip;
  }
}

function validateSnapshot(
  snapshot: RouteCandidateSnapshotRecord,
): NormalizedRouteCandidate {
  const hash = hashRouteCandidateSnapshot({
    tripId: snapshot.tripId,
    basisVersion: snapshot.basisVersion,
    fromNodeId: snapshot.fromNodeId,
    toNodeId: snapshot.toNodeId,
    provider: snapshot.provider,
    observedAt: snapshot.observedAt.toISOString(),
    candidatePayload: snapshot.candidatePayload,
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

function requireCurrentCorridor(
  trip: TripAggregateRecord,
  snapshot: RouteCandidateSnapshotRecord,
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

function buildChangeSummary(
  candidate: NormalizedRouteCandidate,
  snapshot: RouteCandidateSnapshotRecord,
  trip: TripAggregateRecord,
  corridor: ReturnType<typeof requireCurrentCorridor>,
  userConfirmedSameHub: ReadonlySet<number>,
  toProjection: ReturnType<typeof evaluateTripScheduleRecord>['nodes'][number],
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
  assertEndpointDates(trip, corridor, candidate);

  const currentGenerated = corridor.nodes.filter(
    (node) => node.source === 'ROUTE_GENERATED',
  );
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
      const protectionReasons = generatedNodeProtectionReasons(node);
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
      fromRef: legIndex === 0 ? 'FROM_NODE' : boundaryRef(legIndex - 1),
      toRef:
        legIndex === candidate.legs.length - 1
          ? 'TO_NODE'
          : boundaryRef(legIndex),
      mode: leg.mode,
      fixedService: leg.fixedService,
      serviceLabel: leg.serviceLabel,
      providerRef: leg.providerRef,
      departure: toNullableTimePoint(leg.departure),
      arrival: toNullableTimePoint(leg.arrival),
      durationSeconds: leg.durationSeconds,
    });
  }
  const downstreamNode = corridor.toNode;
  const userMinimum = downstreamNode.timeIntents.find(
    (intent) => intent.kind === 'MIN_DWELL',
  );
  const downstreamDeparture =
    toProjection.departure.effective?.value.instant ?? null;
  const planningDuration =
    userMinimum?.durationSeconds ??
    downstreamNode.systemDwellSuggestion?.durationSeconds ??
    null;
  const projectedDeparture =
    downstreamDeparture ??
    (planningDuration === null
      ? null
      : new Date(
          candidate.arrival.instant.getTime() + planningDuration * 1_000,
        ));
  const dwell = assessDwell({
    arrival: candidate.arrival.instant,
    departure: projectedDeparture,
    systemSuggestedDurationSeconds:
      downstreamNode.systemDwellSuggestion?.durationSeconds ?? null,
    userMinimumDurationSeconds: userMinimum?.durationSeconds ?? null,
  });
  const downstreamAdjustments =
    dwell.requiresUserAdjustment &&
    userMinimum !== undefined &&
    dwell.adjustedUserMinimumDurationSeconds !== null
      ? [
          {
            intentId: userMinimum.id,
            nodeId: downstreamNode.id,
            fromDurationSeconds: userMinimum.durationSeconds!,
            toDurationSeconds: dwell.adjustedUserMinimumDurationSeconds,
          },
        ]
      : [];
  const requiredUserAdjustments = uniqueAdjustments([
    ...(snapshot.candidatePayload.planningAssessment?.requiredUserAdjustments ??
      []),
    ...downstreamAdjustments,
  ]);
  return {
    transportAction:
      corridor.currentTransports.length === 0 ? 'CREATE' : 'REPLACE',
    willReplaceTransportEdgeId: corridor.currentTransports[0]?.id ?? null,
    willReplaceTransportEdgeIds: corridor.currentTransports.map(
      (edge) => edge.id,
    ),
    requiresGeneratedNodes: groups.length > 0,
    generatedTransferPoints: groups.map((group) => group.location),
    proposedSegments,
    routeCorridor: {
      anchorFromNodeId: corridor.fromNode.id,
      anchorToNodeId: corridor.toNode.id,
      currentNodeIds: corridor.nodes.map((node) => node.id),
      currentAdoptedRouteId: corridor.currentAdoptedRouteId,
    },
    nodesToCreate: nodePlans.filter((plan) => plan.action === 'CREATE'),
    nodesToReuse: nodePlans.filter((plan) => plan.action === 'REUSE'),
    nodesToRemove,
    protectedBlockingNodes: nodesToRemove.filter((node) => node.protected),
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
    proposedDayAssignments: nodePlans.map((plan) => ({
      nodeRef: plan.ref,
      localDate: plan.localDate,
      dayOccurrenceId: plan.dayOccurrenceId,
    })),
    proposedTransportDayProjections: proposedSegments.map((segment, index) => ({
      segmentIndex: index,
      fromRef: segment.fromRef,
      toRef: segment.toRef,
      roles: projectionRolesForSegment(segment, nodePlans, trip, corridor),
    })),
    temporalLayer: 'PLANNED',
    temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
    requiredUserAdjustments,
    downstreamImpact: {
      nodeId: downstreamNode.id,
      arrival: candidate.arrival.instant.toISOString(),
      departure: projectedDeparture?.toISOString() ?? null,
      projectedDwellSeconds: dwell.projectedDwellSeconds,
      systemSuggestedDwellSeconds: dwell.systemSuggestedDurationSeconds,
      userMinimumDwellSeconds: dwell.userMinimumDurationSeconds,
      status: dwell.status,
      requiredUserAdjustments,
    },
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
  return [...new Map(values.map((value) => [value.intentId, value])).values()];
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

function localDateAt(point: {
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
  corridor: ReturnType<typeof requireCurrentCorridor>,
  candidate: NormalizedRouteCandidate,
): void {
  const fromDay = trip.dayOccurrences.find(
    (day) => day.id === corridor.fromNode.dayOccurrenceId,
  );
  const toDay = trip.dayOccurrences.find(
    (day) => day.id === corridor.toNode.dayOccurrenceId,
  );
  if (
    fromDay === undefined ||
    toDay === undefined ||
    localDateAt(candidate.departure) !== formatLocalDate(fromDay.localDate) ||
    localDateAt(candidate.arrival) !== formatLocalDate(toDay.localDate)
  ) {
    throw previewUnsupported('ENDPOINT_DAY_MISMATCH');
  }
}

function formatLocalDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeSameHubConfirmations(
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
  corridor: ReturnType<typeof requireCurrentCorridor>,
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

function toCandidateView(
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

function assertSnapshotFresh(
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

function toPreviewView(
  preview: {
    readonly id: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly previewPayload: StoredRoutePreviewPayload;
  },
  now: Date,
): RoutePreviewView {
  const superseded =
    preview.previewPayload.policyVersion !== ROUTE_PREVIEW_POLICY_VERSION;
  const expired = preview.expiresAt <= now;
  const blocked =
    (preview.previewPayload.changeSummary.protectedBlockingNodes?.length ?? 0) >
      0 ||
    preview.previewPayload.changeSummary.downstreamImpact?.status ===
      'INFEASIBLE';
  const status = superseded
    ? ('SUPERSEDED_POLICY' as const)
    : expired
      ? ('EXPIRED' as const)
      : blocked
        ? ('BLOCKED' as const)
        : ('ACTIVE' as const);
  return {
    ...preview.previewPayload,
    previewId: preview.id,
    createdAt: preview.createdAt.toISOString(),
    expiresAt: preview.expiresAt.toISOString(),
    adoptable: status === 'ACTIVE',
    status,
  };
}

function earlier(left: Date, right: Date): Date {
  return left < right ? left : right;
}

function laterNullable(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function earlierNullable(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function notFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', '路线预览资源不存在。', 404);
}

function versionConflict(): ApplicationError {
  return new ApplicationError(
    'VERSION_CONFLICT',
    '行程版本已变化，请重新查询路线。',
    409,
  );
}

function stalePreview(): ApplicationError {
  return new ApplicationError(
    'PREVIEW_STALE',
    '路线候选已过期或不再满足当前安全条件。',
    409,
  );
}

function previewUnsupported(message: string): ApplicationError {
  return new ApplicationError('PREVIEW_UNSUPPORTED', message, 422);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}

function requireUuid(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
}

function requireTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 604_800) {
    throw new Error('previewTtlSeconds must be 1..604800');
  }
}
