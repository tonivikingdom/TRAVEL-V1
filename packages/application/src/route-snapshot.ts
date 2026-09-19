import { createHash } from 'node:crypto';

import type {
  RouteCandidateLegView,
  RouteLocationView,
  RouteTimePointView,
} from '@travel/contracts';
import type {
  NormalizedRouteCandidate,
  RouteCandidateLeg,
  RouteLocation,
  RouteTimePoint,
} from '@travel/domain';

import type { RouteCandidatePayload } from './route-planning-ports.js';
import { parseAbsoluteInstantInput } from './time-input.js';

export interface CandidateHashBasis {
  readonly tripId: string;
  readonly basisVersion: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly provider: string;
  readonly observedAt: string;
  readonly candidatePayload: RouteCandidatePayload;
}

export function hashRouteCandidateSnapshot(basis: CandidateHashBasis): string {
  return createHash('sha256').update(canonicalJson(basis)).digest('hex');
}

export function restoreNormalizedCandidate(
  payload: RouteCandidatePayload,
): NormalizedRouteCandidate {
  if (
    !isRecord(payload) ||
    typeof payload.candidateId !== 'string' ||
    typeof payload.provider !== 'string' ||
    !nullableString(payload.providerCandidateRef) ||
    typeof payload.observedAt !== 'string' ||
    !nullableString(payload.validUntil) ||
    !isRecord(payload.overall) ||
    !Array.isArray(payload.legs) ||
    !isFare(payload.fare)
  ) {
    throw new Error('Invalid route candidate snapshot payload');
  }
  return {
    candidateId: payload.candidateId,
    provider: payload.provider,
    providerCandidateRef: payload.providerCandidateRef,
    observedAt: parseAbsoluteInstantInput(payload.observedAt, 'observedAt'),
    validUntil:
      payload.validUntil === null
        ? null
        : parseAbsoluteInstantInput(payload.validUntil, 'validUntil'),
    departure: restoreTimePoint(payload.overall.departure),
    arrival: restoreTimePoint(payload.overall.arrival),
    durationSeconds: requireSafeNonNegativeInteger(
      payload.overall.durationSeconds,
    ),
    legs: payload.legs.map(restoreLeg),
    fare: payload.fare,
  };
}

function restoreLeg(value: RouteCandidateLegView): RouteCandidateLeg {
  if (
    !isRecord(value) ||
    !isMode(value.mode) ||
    typeof value.fixedService !== 'boolean' ||
    !nullableString(value.serviceLabel) ||
    !nullableString(value.providerRef) ||
    !nullableNonNegativeInteger(value.durationSeconds)
  ) {
    throw new Error('Invalid route candidate leg payload');
  }
  return {
    mode: value.mode,
    from: restoreLocation(value.from),
    to: restoreLocation(value.to),
    departure:
      value.departure === null ? null : restoreTimePoint(value.departure),
    arrival: value.arrival === null ? null : restoreTimePoint(value.arrival),
    durationSeconds: value.durationSeconds,
    fixedService: value.fixedService,
    serviceLabel: value.serviceLabel,
    providerRef: value.providerRef,
  };
}

function restoreLocation(value: RouteLocationView): RouteLocation {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !nullableFiniteNumber(value.latitude) ||
    !nullableFiniteNumber(value.longitude) ||
    !nullableString(value.providerPlaceRef)
  ) {
    throw new Error('Invalid route location payload');
  }
  return value;
}

function restoreTimePoint(value: RouteTimePointView): RouteTimePoint {
  if (
    !isRecord(value) ||
    typeof value.instant !== 'string' ||
    typeof value.timeZone !== 'string'
  ) {
    throw new Error('Invalid route time point payload');
  }
  return {
    instant: parseAbsoluteInstantInput(value.instant, 'instant'),
    timeZone: value.timeZone,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function nullableFiniteNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function nullableNonNegativeInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function requireSafeNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid route duration');
  }
  return value;
}

function isFare(value: unknown): value is RouteCandidatePayload['fare'] {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.amount === 'string' &&
      typeof value.currency === 'string')
  );
}

function isMode(value: unknown): value is RouteCandidateLeg['mode'] {
  return (
    value === 'WALKING' ||
    value === 'DRIVING' ||
    value === 'TAXI' ||
    value === 'RAIL' ||
    value === 'BUS' ||
    value === 'FERRY' ||
    value === 'FLIGHT' ||
    value === 'OTHER'
  );
}
