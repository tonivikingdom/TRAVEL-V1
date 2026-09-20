import type {
  RouteQueryHint,
  RouteQueryRequest,
  RouteQueryResponse,
  RouteQueryTimeConditionView,
  RouteTimePointView,
} from '@travel/contracts';
import {
  assessDwell,
  expandRouteQueryStart,
  rankArriveByCandidates,
  rankRouteCandidates,
  ROUTE_QUERY_LOOKBACK_SECONDS,
  VALUE_EFFECTIVE_TIME_BASIS_POINTS,
  validateRouteCandidate,
  type DwellPlanningAssessment,
  type NormalizedRouteCandidate,
  type RouteLocation,
} from '@travel/domain';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  RouteProvider,
  RouteProviderTimePreference,
} from './route-ports.js';
import {
  systemClock,
  type Clock,
  type RouteCandidatePayload,
  type RoutePlanningRepository,
} from './route-planning-ports.js';
import { hashRouteCandidateSnapshot } from './route-snapshot.js';
import {
  evaluateTripScheduleRecord,
  orderedTripNodes,
} from './schedule-evaluation.js';
import { resolveCurrentRouteCorridor } from './route-corridor.js';
import {
  parseAbsoluteInstantInput,
  validateIanaTimeZoneInput,
} from './time-input.js';
import type {
  ItineraryNodeRecord,
  PlaceRecord,
  TripAggregateRecord,
  TripRepository,
} from './trip-ports.js';

interface NormalizedQueryTime {
  readonly hardEarliestDeparture: Date | null;
  readonly hardLatestArrival: Date | null;
  readonly planningEarliestDeparture: Date | null;
  readonly earliestDeparture: Date | null;
  readonly latestArrival: Date | null;
  readonly preference: RouteProviderTimePreference;
  readonly hint: NormalizedHint | null;
  readonly lookbackSeconds: number;
}

type NormalizedHint =
  | {
      readonly type: 'DEPART_AT';
      readonly instant: Date;
      readonly timeZone: string;
    }
  | {
      readonly type: 'ARRIVE_BY';
      readonly instant: Date;
      readonly timeZone: string;
    };

export class RouteQueryService {
  constructor(
    private readonly repository: TripRepository,
    private readonly provider: RouteProvider,
    private readonly planningRepository: RoutePlanningRepository,
    private readonly options: RouteQueryServiceOptions,
  ) {
    requireTtl(options.candidateSnapshotTtlSeconds);
  }

  async queryRoutes(
    actor: Actor,
    tripId: string,
    input: RouteQueryRequest,
  ): Promise<RouteQueryResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(input.fromNodeId, 'fromNodeId');
    requireUuid(input.toNodeId, 'toNodeId');
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const trip = await this.repository.findOwnedById({
      ownerUserId: actor.userId,
      tripId,
    });
    if (trip === null) {
      throw new ApplicationError('NOT_FOUND', '行程不存在。', 404);
    }
    const basisVersion = positiveInteger(input.basisVersion, 'basisVersion');
    if (trip.version !== basisVersion) {
      throw new ApplicationError(
        'VERSION_CONFLICT',
        '行程版本已变化，请刷新后重新查询。',
        409,
      );
    }

    const nodes = orderedTripNodes(trip);
    const fromIndex = nodes.findIndex((node) => node.id === input.fromNodeId);
    const toIndex = nodes.findIndex((node) => node.id === input.toNodeId);
    if (fromIndex < 0 || toIndex < 0) {
      throw new ApplicationError('NOT_FOUND', '行程节点不存在。', 404);
    }
    if (!isQueryableRouteCorridor(trip, nodes, fromIndex, toIndex)) {
      throw new ApplicationError(
        'ROUTE_QUERY_UNSUPPORTED',
        '路线查询只能连接相邻节点或同一当前已采用路线的两个锚点。',
        422,
      );
    }
    const fromNode = nodes[fromIndex];
    const toNode = nodes[toIndex];
    if (fromNode === undefined || toNode === undefined) {
      throw new Error('Trip adjacency projection is incomplete');
    }
    const origin = requirePlaceEndpoint(fromNode);
    const destination = requirePlaceEndpoint(toNode);

    const schedule = evaluateTripScheduleRecord(trip);
    if (schedule.conflicts.length > 0) {
      throw new ApplicationError(
        'CONSTRAINT_CONFLICT',
        '当前行程存在无法同时满足的硬时间约束。',
        409,
      );
    }
    const fromProjection = schedule.nodes.find(
      (node) => node.nodeId === fromNode.id,
    );
    const toProjection = schedule.nodes.find(
      (node) => node.nodeId === toNode.id,
    );
    if (fromProjection === undefined || toProjection === undefined) {
      throw new Error('Schedule projection is missing an itinerary node');
    }
    const userMinimum = fromNode.timeIntents.find(
      (intent) => intent.kind === 'MIN_DWELL',
    );
    const arrival = fromProjection.arrival.effective?.value.instant ?? null;
    const planningDwellSeconds =
      userMinimum?.durationSeconds ??
      fromNode.systemDwellSuggestion?.durationSeconds ??
      null;
    const propagatedEarliest =
      fromProjection.departure.requirementWindow.earliest;
    const planningEarliestDeparture = laterNullable(
      propagatedEarliest,
      arrival === null || planningDwellSeconds === null
        ? null
        : new Date(arrival.getTime() + planningDwellSeconds * 1_000),
    );
    const time = combineQueryTime(
      absoluteDepartureFloor(fromProjection, arrival),
      toProjection.arrival.requirementWindow.latest,
      planningEarliestDeparture,
      input.hint,
      this.options.lookbackSeconds ?? ROUTE_QUERY_LOOKBACK_SECONDS,
    );

    const providerResult = await this.provider.queryRoutes({
      origin: toProviderPlace(origin),
      destination: toProviderPlace(destination),
      earliestDeparture: time.earliestDeparture,
      latestArrival: time.latestArrival,
      preference: time.preference,
    });
    if (providerResult.status === 'NO_MATCHING_CANDIDATE') {
      throw noMatchingCandidate();
    }
    if (providerResult.status === 'UNSUPPORTED_QUERY') {
      throw new ApplicationError(
        'ROUTE_QUERY_UNSUPPORTED',
        '当前路线 Provider 不支持该查询。',
        422,
      );
    }
    if (providerResult.status === 'PROVIDER_UNAVAILABLE') {
      if (providerResult.reason === 'ROUTE_PROVIDER_UNCONFIGURED') {
        throw new ApplicationError(
          'ROUTE_PROVIDER_UNCONFIGURED',
          '尚未配置真实路线 Provider。',
          503,
        );
      }
      throw new ApplicationError(
        'PROVIDER_UNAVAILABLE',
        '路线 Provider 暂时不可用。',
        503,
        true,
      );
    }

    const now = (this.options.clock ?? systemClock).now();
    const candidateIds = new Set<string>();
    const accepted: NormalizedRouteCandidate[] = [];
    for (const candidate of providerResult.candidates) {
      if (candidateIds.has(candidate.candidateId)) {
        throw invalidProviderResponse();
      }
      candidateIds.add(candidate.candidateId);
      const validation = validateRouteCandidate(candidate, {
        earliestDeparture: time.earliestDeparture,
        latestArrival: time.latestArrival,
      });
      if (!validation.accepted) {
        if (validation.reason === 'INVALID_CANDIDATE') {
          throw invalidProviderResponse();
        }
        continue;
      }
      if (!providerCandidateUsesSupportedZones(candidate)) {
        throw invalidProviderResponse();
      }
      if (candidate.validUntil !== null && candidate.validUntil <= now) {
        continue;
      }
      accepted.push(candidate);
    }
    if (accepted.length === 0) {
      throw noMatchingCandidate();
    }

    const availableStart =
      effectiveAvailableStart(time) ??
      arrival ??
      time.earliestDeparture ??
      accepted.reduce(
        (minimum, candidate) =>
          candidate.departure.instant < minimum
            ? candidate.departure.instant
            : minimum,
        accepted[0]!.departure.instant,
      );
    const assessments = new Map(
      accepted.map((candidate) => [
        candidate.candidateId,
        assessCandidateDwell(candidate, arrival, fromNode),
      ]),
    );
    const fullyFeasible = accepted.filter(
      (candidate) =>
        !assessments.get(candidate.candidateId)!.requiresUserAdjustment &&
        assessments.get(candidate.candidateId)!.status !== 'INFEASIBLE',
    );
    const adjustmentCandidates = accepted.filter(
      (candidate) =>
        assessments.get(candidate.candidateId)!.requiresUserAdjustment,
    );
    const valueBasisPoints =
      this.options.valueEffectiveTimeBasisPoints ??
      VALUE_EFFECTIVE_TIME_BASIS_POINTS;
    const rank = (items: readonly NormalizedRouteCandidate[]) =>
      time.preference.type === 'ARRIVE_BY'
        ? rankArriveByCandidates(items).ordered
        : rankRouteCandidates(items, availableStart, valueBasisPoints).ordered;
    const ranked =
      fullyFeasible.length === 0
        ? rank(accepted)
        : [
            ...rank(fullyFeasible),
            ...(adjustmentCandidates.length === 0
              ? []
              : rank(adjustmentCandidates)),
          ];
    const timeCondition = toTimeConditionView(time);
    const payloads = ranked.map((candidate) =>
      toCandidatePayload(
        candidate,
        trip.version,
        timeCondition,
        availableStart,
        assessments.get(candidate.candidateId)!,
        fromNode,
      ),
    );
    const saved = await this.planningRepository.saveCandidateSnapshots({
      ownerUserId: actor.userId,
      tripId: trip.id,
      basisVersion: trip.version,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      snapshots: ranked.map((candidate, index) => {
        const candidatePayload = payloads[index];
        if (candidatePayload === undefined) {
          throw new Error('Route candidate snapshot payload is missing');
        }
        const expiresAt = snapshotExpiry(
          now,
          this.options.candidateSnapshotTtlSeconds,
          candidate.validUntil,
        );
        return {
          provider: candidate.provider,
          providerCandidateRef: candidate.providerCandidateRef,
          observedAt: candidate.observedAt,
          providerValidUntil: candidate.validUntil,
          candidatePayload,
          candidateHash: hashRouteCandidateSnapshot({
            tripId: trip.id,
            basisVersion: trip.version,
            fromNodeId: fromNode.id,
            toNodeId: toNode.id,
            provider: candidate.provider,
            observedAt: candidate.observedAt.toISOString(),
            candidatePayload,
          }),
          queryTimeCondition: timeCondition,
          createdAt: now,
          expiresAt,
        };
      }),
    });
    if (saved.status === 'NOT_FOUND') {
      throw new ApplicationError('NOT_FOUND', '行程不存在。', 404);
    }
    if (saved.status !== 'SUCCESS') {
      throw new ApplicationError(
        'VERSION_CONFLICT',
        '行程在路线查询期间发生变化，请刷新后重新查询。',
        409,
      );
    }
    return {
      tripId: trip.id,
      basisVersion: trip.version,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      timeCondition,
      candidates: saved.snapshots.map((snapshot) => ({
        ...snapshot.candidatePayload,
        candidateSnapshotId: snapshot.id,
        snapshotExpiresAt: snapshot.expiresAt.toISOString(),
      })),
    };
  }
}

export interface RouteQueryServiceOptions {
  readonly candidateSnapshotTtlSeconds: number;
  readonly lookbackSeconds?: number;
  readonly valueEffectiveTimeBasisPoints?: number;
  readonly clock?: Clock;
}

function combineQueryTime(
  hardEarliestDeparture: Date | null,
  hardLatestArrival: Date | null,
  planningEarliestDeparture: Date | null,
  hintInput: RouteQueryHint | null | undefined,
  lookbackSeconds: number,
): NormalizedQueryTime {
  const hint = normalizeHint(hintInput);
  let earliestDeparture = expandRouteQueryStart({
    planningEarliestDeparture,
    absoluteEarliestDeparture: hardEarliestDeparture,
    lookbackSeconds,
  });
  let latestArrival = hardLatestArrival;
  if (hint?.type === 'DEPART_AT') {
    earliestDeparture = later(earliestDeparture, hint.instant);
  } else if (hint?.type === 'ARRIVE_BY') {
    latestArrival = earlier(latestArrival, hint.instant);
  }
  if (earliestDeparture === null && latestArrival === null) {
    throw new ApplicationError(
      'ROUTE_QUERY_TIME_REQUIRED',
      '当前行程没有可用时间要求，请提供本次查询时刻。',
      400,
    );
  }
  if (
    earliestDeparture !== null &&
    latestArrival !== null &&
    earliestDeparture.getTime() > latestArrival.getTime()
  ) {
    throw new ApplicationError(
      'CONSTRAINT_CONFLICT',
      '本次查询时刻与行程硬时间窗口不相容。',
      409,
    );
  }
  const preference: RouteProviderTimePreference =
    hint === null
      ? { type: 'NONE' }
      : hint.type === 'DEPART_AT'
        ? {
            type: hint.type,
            instant: earliestDeparture ?? hint.instant,
            timeZone: hint.timeZone,
          }
        : {
            type: hint.type,
            instant: latestArrival ?? hint.instant,
            timeZone: hint.timeZone,
          };
  return {
    hardEarliestDeparture,
    hardLatestArrival,
    planningEarliestDeparture,
    earliestDeparture,
    latestArrival,
    preference,
    hint,
    lookbackSeconds,
  };
}

function normalizeHint(
  hint: RouteQueryHint | null | undefined,
): NormalizedHint | null {
  if (hint === undefined || hint === null) return null;
  if (hint.type !== 'DEPART_AT' && hint.type !== 'ARRIVE_BY') {
    throw new ApplicationError('VALIDATION_ERROR', '查询时间类型无效。', 400);
  }
  return {
    type: hint.type,
    instant: parseAbsoluteInstantInput(hint.instant, 'hint.instant'),
    timeZone: validateIanaTimeZoneInput(hint.timeZone),
  };
}

function requirePlaceEndpoint(node: ItineraryNodeRecord): PlaceRecord {
  if (node.kind !== 'PLACE_VISIT' || node.place === null) {
    throw new ApplicationError(
      'ROUTE_QUERY_UNSUPPORTED',
      '自由行动节点不能作为静态路线查询端点。',
      422,
    );
  }
  return node.place;
}

function toProviderPlace(place: PlaceRecord) {
  return {
    placeId: place.id,
    name: place.name,
    latitude: place.latitude,
    longitude: place.longitude,
  };
}

function toTimeConditionView(
  time: NormalizedQueryTime,
): RouteQueryTimeConditionView {
  return {
    hardEarliestDeparture: time.hardEarliestDeparture?.toISOString() ?? null,
    hardLatestArrival: time.hardLatestArrival?.toISOString() ?? null,
    planningEarliestDeparture:
      time.planningEarliestDeparture?.toISOString() ?? null,
    lookbackSeconds: time.lookbackSeconds,
    earliestDeparture: time.earliestDeparture?.toISOString() ?? null,
    latestArrival: time.latestArrival?.toISOString() ?? null,
    preference:
      time.preference.type === 'NONE'
        ? time.preference
        : {
            type: time.preference.type,
            instant: time.preference.instant.toISOString(),
            timeZone: time.preference.timeZone,
          },
    hint:
      time.hint === null
        ? null
        : {
            type: time.hint.type,
            instant: time.hint.instant.toISOString(),
            timeZone: time.hint.timeZone,
          },
  };
}

function toCandidatePayload(
  candidate: NormalizedRouteCandidate,
  basisVersion: number,
  timeCondition: RouteQueryTimeConditionView,
  availableStart: Date,
  dwell: DwellPlanningAssessment,
  fromNode: ItineraryNodeRecord,
): RouteCandidatePayload {
  const minimumIntent = fromNode.timeIntents.find(
    (intent) => intent.kind === 'MIN_DWELL',
  );
  return {
    candidateId: candidate.candidateId,
    provider: candidate.provider,
    providerCandidateRef: candidate.providerCandidateRef,
    observedAt: candidate.observedAt.toISOString(),
    validUntil: candidate.validUntil?.toISOString() ?? null,
    queryBasisVersion: basisVersion,
    queryTimeCondition: timeCondition,
    overall: {
      departure: toTimePointView(candidate.departure),
      arrival: toTimePointView(candidate.arrival),
      durationSeconds: candidate.durationSeconds,
    },
    legs: candidate.legs.map((leg) => ({
      ...leg,
      from: toLocationView(leg.from),
      to: toLocationView(leg.to),
      departure: leg.departure === null ? null : toTimePointView(leg.departure),
      arrival: leg.arrival === null ? null : toTimePointView(leg.arrival),
    })),
    fare: candidate.fare,
    planningAssessment: {
      effectiveTotalTimeSeconds: Math.max(
        0,
        Math.floor(
          (candidate.arrival.instant.getTime() - availableStart.getTime()) /
            1_000,
        ),
      ),
      requiresUserAdjustment: dwell.requiresUserAdjustment,
      requiredUserAdjustments:
        dwell.requiresUserAdjustment &&
        minimumIntent !== undefined &&
        dwell.adjustedUserMinimumDurationSeconds !== null
          ? [
              {
                intentId: minimumIntent.id,
                nodeId: fromNode.id,
                fromDurationSeconds: minimumIntent.durationSeconds!,
                toDurationSeconds: dwell.adjustedUserMinimumDurationSeconds,
              },
            ]
          : [],
      softDeviations:
        dwell.status === 'SOFT_DEVIATION'
          ? (['SYSTEM_SUGGESTED_DWELL'] as const)
          : [],
    },
  };
}

function assessCandidateDwell(
  candidate: NormalizedRouteCandidate,
  arrival: Date | null,
  fromNode: ItineraryNodeRecord,
): DwellPlanningAssessment {
  const minimumIntent = fromNode.timeIntents.find(
    (intent) => intent.kind === 'MIN_DWELL',
  );
  return assessDwell({
    arrival,
    departure: candidate.departure.instant,
    systemSuggestedDurationSeconds:
      fromNode.systemDwellSuggestion?.durationSeconds ?? null,
    userMinimumDurationSeconds: minimumIntent?.durationSeconds ?? null,
  });
}

function absoluteDepartureFloor(
  projection: ReturnType<typeof evaluateTripScheduleRecord>['nodes'][number],
  arrival: Date | null,
): Date | null {
  const window = projection.departure.requirementWindow;
  const direct = window.earliestBasis.some(
    (basis) => basis.ruleId !== 'MIN_DWELL_FORWARD',
  )
    ? window.earliest
    : null;
  const actualArrival = projection.arrival.actual?.instant ?? null;
  return laterNullable(
    direct,
    actualArrival ?? arrivalIfActual(projection, arrival),
  );
}

function arrivalIfActual(
  projection: ReturnType<typeof evaluateTripScheduleRecord>['nodes'][number],
  arrival: Date | null,
): Date | null {
  return projection.arrival.effective?.value.layer === 'ACTUAL'
    ? arrival
    : null;
}

function laterNullable(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

function effectiveAvailableStart(time: NormalizedQueryTime): Date | null {
  const explicitDepartAt =
    time.hint?.type === 'DEPART_AT' ? time.hint.instant : null;
  return laterNullable(time.planningEarliestDeparture, explicitDepartAt);
}

function snapshotExpiry(
  now: Date,
  ttlSeconds: number,
  providerValidUntil: Date | null,
): Date {
  const internalExpiry = new Date(now.getTime() + ttlSeconds * 1_000);
  return providerValidUntil !== null && providerValidUntil < internalExpiry
    ? providerValidUntil
    : internalExpiry;
}

function requireTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 604_800) {
    throw new Error('candidateSnapshotTtlSeconds must be 1..604800');
  }
}

function toTimePointView(point: {
  readonly instant: Date;
  readonly timeZone: string;
}): RouteTimePointView {
  return { instant: point.instant.toISOString(), timeZone: point.timeZone };
}

function toLocationView(location: RouteLocation) {
  return { ...location, providerHubRef: location.providerHubRef ?? null };
}

function isQueryableRouteCorridor(
  trip: TripAggregateRecord,
  nodes: readonly ItineraryNodeRecord[],
  fromIndex: number,
  toIndex: number,
): boolean {
  return resolveCurrentRouteCorridor(trip, nodes, fromIndex, toIndex) !== null;
}

function providerCandidateUsesSupportedZones(
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

function later(left: Date | null, right: Date): Date {
  return left === null || right.getTime() > left.getTime() ? right : left;
}

function earlier(left: Date | null, right: Date): Date {
  return left === null || right.getTime() < left.getTime() ? right : left;
}

function noMatchingCandidate(): ApplicationError {
  return new ApplicationError(
    'NO_MATCHING_CANDIDATE',
    '没有符合当前硬时间窗口的路线候选。',
    404,
  );
}

function invalidProviderResponse(): ApplicationError {
  return new ApplicationError(
    'PROVIDER_UNAVAILABLE',
    '路线 Provider 返回了无法安全使用的候选。',
    503,
    true,
  );
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
