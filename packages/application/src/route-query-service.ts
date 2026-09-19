import type {
  RouteCandidateView,
  RouteQueryHint,
  RouteQueryRequest,
  RouteQueryResponse,
  RouteQueryTimeConditionView,
  RouteTimePointView,
} from '@travel/contracts';
import {
  validateRouteCandidate,
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
  evaluateTripScheduleRecord,
  orderedTripNodes,
} from './schedule-evaluation.js';
import {
  parseAbsoluteInstantInput,
  validateIanaTimeZoneInput,
} from './time-input.js';
import type {
  ItineraryNodeRecord,
  PlaceRecord,
  TripRepository,
} from './trip-ports.js';

interface NormalizedQueryTime {
  readonly hardEarliestDeparture: Date | null;
  readonly hardLatestArrival: Date | null;
  readonly earliestDeparture: Date | null;
  readonly latestArrival: Date | null;
  readonly preference: RouteProviderTimePreference;
  readonly hint: NormalizedHint | null;
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
  ) {}

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
    if (toIndex !== fromIndex + 1) {
      throw new ApplicationError(
        'ROUTE_QUERY_UNSUPPORTED',
        '路线查询只支持当前 timeline 中相邻的两个节点。',
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
    const time = combineQueryTime(
      fromProjection.departure.requirementWindow.earliest,
      toProjection.arrival.requirementWindow.latest,
      input.hint,
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
      accepted.push(candidate);
    }
    if (accepted.length === 0) {
      throw noMatchingCandidate();
    }

    const timeCondition = toTimeConditionView(time);
    return {
      tripId: trip.id,
      basisVersion: trip.version,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      timeCondition,
      candidates: accepted.map((candidate) =>
        toCandidateView(candidate, trip.version, timeCondition),
      ),
    };
  }
}

function combineQueryTime(
  hardEarliestDeparture: Date | null,
  hardLatestArrival: Date | null,
  hintInput: RouteQueryHint | null | undefined,
): NormalizedQueryTime {
  const hint = normalizeHint(hintInput);
  let earliestDeparture = hardEarliestDeparture;
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
    earliestDeparture,
    latestArrival,
    preference,
    hint,
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

function toCandidateView(
  candidate: NormalizedRouteCandidate,
  basisVersion: number,
  timeCondition: RouteQueryTimeConditionView,
): RouteCandidateView {
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
  };
}

function toTimePointView(point: {
  readonly instant: Date;
  readonly timeZone: string;
}): RouteTimePointView {
  return { instant: point.instant.toISOString(), timeZone: point.timeZone };
}

function toLocationView(location: RouteLocation) {
  return location;
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
