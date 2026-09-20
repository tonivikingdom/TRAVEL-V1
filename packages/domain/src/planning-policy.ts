import {
  isCanonicalRouteFareAmount,
  type NormalizedRouteCandidate,
} from './route-query.js';

export const ROUTE_QUERY_LOOKBACK_SECONDS = 15 * 60;
export const VALUE_EFFECTIVE_TIME_BASIS_POINTS = 14_000;

export type DwellPlanningStatus =
  | 'NORMAL'
  | 'SOFT_DEVIATION'
  | 'USER_REQUIREMENT_VIOLATION'
  | 'INFEASIBLE'
  | 'UNKNOWN';

export interface DwellPlanningAssessment {
  readonly projectedDwellSeconds: number | null;
  readonly status: DwellPlanningStatus;
  readonly systemSuggestedDurationSeconds: number | null;
  readonly userMinimumDurationSeconds: number | null;
  readonly requiresUserAdjustment: boolean;
  readonly adjustedUserMinimumDurationSeconds: number | null;
}

export function assessDwell(input: {
  readonly arrival: Date | null;
  readonly departure: Date | null;
  readonly systemSuggestedDurationSeconds: number | null;
  readonly userMinimumDurationSeconds: number | null;
}): DwellPlanningAssessment {
  const systemSuggestion = optionalPositiveSeconds(
    input.systemSuggestedDurationSeconds,
  );
  const userMinimum = optionalPositiveSeconds(input.userMinimumDurationSeconds);
  if (input.arrival === null || input.departure === null) {
    return {
      projectedDwellSeconds: null,
      status: 'UNKNOWN',
      systemSuggestedDurationSeconds: systemSuggestion,
      userMinimumDurationSeconds: userMinimum,
      requiresUserAdjustment: false,
      adjustedUserMinimumDurationSeconds: null,
    };
  }
  const milliseconds = input.departure.getTime() - input.arrival.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return {
      projectedDwellSeconds: Math.floor(milliseconds / 1_000),
      status: 'INFEASIBLE',
      systemSuggestedDurationSeconds: systemSuggestion,
      userMinimumDurationSeconds: userMinimum,
      requiresUserAdjustment: false,
      adjustedUserMinimumDurationSeconds: null,
    };
  }
  const projectedDwellSeconds = Math.floor(milliseconds / 1_000);
  if (userMinimum !== null && projectedDwellSeconds < userMinimum) {
    if (projectedDwellSeconds === 0) {
      return {
        projectedDwellSeconds,
        status: 'INFEASIBLE',
        systemSuggestedDurationSeconds: systemSuggestion,
        userMinimumDurationSeconds: userMinimum,
        requiresUserAdjustment: false,
        adjustedUserMinimumDurationSeconds: null,
      };
    }
    return {
      projectedDwellSeconds,
      status: 'USER_REQUIREMENT_VIOLATION',
      systemSuggestedDurationSeconds: systemSuggestion,
      userMinimumDurationSeconds: userMinimum,
      requiresUserAdjustment: true,
      adjustedUserMinimumDurationSeconds: projectedDwellSeconds,
    };
  }
  return {
    projectedDwellSeconds,
    status:
      systemSuggestion !== null && projectedDwellSeconds < systemSuggestion
        ? 'SOFT_DEVIATION'
        : 'NORMAL',
    systemSuggestedDurationSeconds: systemSuggestion,
    userMinimumDurationSeconds: userMinimum,
    requiresUserAdjustment: false,
    adjustedUserMinimumDurationSeconds: null,
  };
}

export function expandRouteQueryStart(input: {
  readonly planningEarliestDeparture: Date | null;
  readonly absoluteEarliestDeparture: Date | null;
  readonly lookbackSeconds?: number;
}): Date | null {
  const lookbackSeconds = input.lookbackSeconds ?? ROUTE_QUERY_LOOKBACK_SECONDS;
  if (!Number.isSafeInteger(lookbackSeconds) || lookbackSeconds < 0) {
    throw new Error('lookbackSeconds must be a non-negative integer');
  }
  if (input.planningEarliestDeparture === null) {
    return input.absoluteEarliestDeparture;
  }
  const expanded = new Date(
    input.planningEarliestDeparture.getTime() - lookbackSeconds * 1_000,
  );
  if (
    input.absoluteEarliestDeparture !== null &&
    expanded < input.absoluteEarliestDeparture
  ) {
    return input.absoluteEarliestDeparture;
  }
  return expanded;
}

export interface RouteRecommendationResult {
  readonly ordered: readonly NormalizedRouteCandidate[];
  /** Primary candidate for the active query mode. */
  readonly primaryCandidateId: string;
  /** @deprecated Retained for internal DEPART_AT compatibility. */
  readonly fastestCandidateId: string;
  readonly valueCandidateId: string | null;
}

export function rankRouteCandidates(
  candidates: readonly NormalizedRouteCandidate[],
  availableStart: Date,
  valueBasisPoints = VALUE_EFFECTIVE_TIME_BASIS_POINTS,
): RouteRecommendationResult {
  if (candidates.length === 0) {
    throw new Error('At least one route candidate is required');
  }
  if (!Number.isSafeInteger(valueBasisPoints) || valueBasisPoints < 10_000) {
    throw new Error('valueBasisPoints must be an integer >= 10000');
  }
  for (const candidate of candidates) {
    if (candidate.fare !== null) {
      parseDecimal(candidate.fare.amount);
      if (!/^[A-Z]{3}$/u.test(candidate.fare.currency)) {
        throw new Error('fare currency must be a canonical ISO-style code');
      }
    }
  }
  const fastest = [...candidates].sort(primaryComparator)[0]!;
  const fastestEffective = effectiveMilliseconds(fastest, availableStart);
  const valuePool = candidates.filter(
    (candidate) =>
      candidate.fare !== null &&
      BigInt(effectiveMilliseconds(candidate, availableStart)) * 10_000n <=
        BigInt(fastestEffective) * BigInt(valueBasisPoints),
  );
  const currencies = new Set(
    valuePool.map((candidate) => candidate.fare!.currency.toUpperCase()),
  );
  const cheapest =
    currencies.size === 1
      ? ([...valuePool].sort((left, right) => {
          const fareOrder = compareDecimalAmounts(
            left.fare!.amount,
            right.fare!.amount,
          );
          return fareOrder !== 0 ? fareOrder : primaryComparator(left, right);
        })[0] ?? null)
      : null;
  const value = cheapest?.candidateId === fastest.candidateId ? null : cheapest;
  const selected = new Set([
    fastest.candidateId,
    ...(value === null ? [] : [value.candidateId]),
  ]);
  const references = candidates
    .filter((candidate) => !selected.has(candidate.candidateId))
    .sort(primaryComparator);
  return {
    ordered: [fastest, ...(value === null ? [] : [value]), ...references],
    primaryCandidateId: fastest.candidateId,
    fastestCandidateId: fastest.candidateId,
    valueCandidateId: value?.candidateId ?? null,
  };
}

/**
 * Ranks candidates for an ARRIVE_BY query. This is intentionally independent
 * from the DEPART_AT fastest/value policy: arrival-by has no 140% value pool
 * and never promotes a value candidate.
 */
export function rankArriveByCandidates(
  candidates: readonly NormalizedRouteCandidate[],
): RouteRecommendationResult {
  if (candidates.length === 0) {
    throw new Error('At least one route candidate is required');
  }
  for (const candidate of candidates) {
    if (candidate.fare !== null) {
      parseDecimal(candidate.fare.amount);
      if (!/^[A-Z]{3}$/u.test(candidate.fare.currency)) {
        throw new Error('fare currency must be a canonical ISO-style code');
      }
    }
  }
  const ordered = [...candidates].sort(arriveByComparator);
  const primary = ordered[0]!;
  return {
    ordered,
    primaryCandidateId: primary.candidateId,
    fastestCandidateId: primary.candidateId,
    valueCandidateId: null,
  };
}

export type BufferRiskKind =
  | 'SYSTEM_SUGGESTED_BUFFER'
  | 'USER_PREFERRED_BUFFER'
  | 'SYSTEM_MINIMUM_CONNECTION';

export type BufferRiskDisposition =
  | 'NONE'
  | 'SOFT_DEVIATION'
  | 'ACKNOWLEDGED_SOFT_DEVIATION'
  | 'ONGOING_EXECUTION_RISK';

export interface BufferEvaluation {
  readonly kind: BufferRiskKind;
  readonly requiredSeconds: number | null;
  readonly availableSeconds: number;
  readonly breached: boolean;
  readonly disposition: BufferRiskDisposition;
}

export function evaluateBuffer(input: {
  readonly kind: BufferRiskKind;
  readonly requiredSeconds: number | null;
  readonly availableSeconds: number;
  readonly acknowledged: boolean;
}): BufferEvaluation {
  if (!Number.isSafeInteger(input.availableSeconds)) {
    throw new Error('availableSeconds must be an integer');
  }
  const required = optionalPositiveSeconds(input.requiredSeconds);
  const breached = required !== null && input.availableSeconds < required;
  return {
    kind: input.kind,
    requiredSeconds: required,
    availableSeconds: input.availableSeconds,
    breached,
    disposition: !breached
      ? 'NONE'
      : input.kind === 'SYSTEM_MINIMUM_CONNECTION'
        ? 'ONGOING_EXECUTION_RISK'
        : input.acknowledged
          ? 'ACKNOWLEDGED_SOFT_DEVIATION'
          : 'SOFT_DEVIATION',
  };
}

export type ExternalBoardingScenario =
  | 'AIRPORT_DOMESTIC'
  | 'AIRPORT_INTERNATIONAL'
  | 'RAIL_MAINLAND_CHINA'
  | 'RAIL_JAPAN_SHINKANSEN_OR_LIMITED_EXPRESS'
  | 'RAIL_FRANCE_INTERCITY'
  | 'RAIL_US_INTERCITY'
  | 'EUROSTAR_LONDON'
  | 'URBAN_RAIL'
  | 'CITY_BUS'
  | 'LONG_DISTANCE_BUS'
  | 'LONG_DISTANCE_FERRY_FOOT'
  | 'CRUISE_FIRST_BOARDING';

const MINUTE = 60;

export function suggestedExternalBoardingBufferSeconds(input: {
  readonly countryCode: string | null;
  readonly scenario: ExternalBoardingScenario;
}): number | null {
  const country = input.countryCode?.trim().toUpperCase() ?? null;
  switch (input.scenario) {
    case 'AIRPORT_DOMESTIC':
      return ['IN', 'CL'].includes(country ?? '') ? 180 * MINUTE : 120 * MINUTE;
    case 'AIRPORT_INTERNATIONAL':
      return ['IN', 'CL'].includes(country ?? '') ? 240 * MINUTE : 180 * MINUTE;
    case 'RAIL_MAINLAND_CHINA':
      return 60 * MINUTE;
    case 'RAIL_JAPAN_SHINKANSEN_OR_LIMITED_EXPRESS':
    case 'RAIL_FRANCE_INTERCITY':
      return 30 * MINUTE;
    case 'RAIL_US_INTERCITY':
      return 60 * MINUTE;
    case 'EUROSTAR_LONDON':
      return 90 * MINUTE;
    case 'URBAN_RAIL':
      return 15 * MINUTE;
    case 'CITY_BUS':
      return 10 * MINUTE;
    case 'LONG_DISTANCE_BUS':
      return 30 * MINUTE;
    case 'LONG_DISTANCE_FERRY_FOOT':
      return 120 * MINUTE;
    case 'CRUISE_FIRST_BOARDING':
      return null;
  }
}

function optionalPositiveSeconds(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('duration seconds must be a positive integer');
  }
  return value;
}

function effectiveMilliseconds(
  candidate: NormalizedRouteCandidate,
  availableStart: Date,
): number {
  return Math.max(
    0,
    candidate.arrival.instant.getTime() - availableStart.getTime(),
  );
}

function primaryComparator(
  left: NormalizedRouteCandidate,
  right: NormalizedRouteCandidate,
): number {
  return (
    left.arrival.instant.getTime() - right.arrival.instant.getTime() ||
    compareComparableFare(left, right) ||
    transferCount(left) - transferCount(right) ||
    walkingSeconds(left) - walkingSeconds(right) ||
    compareCodePoints(left.candidateId, right.candidateId)
  );
}

function arriveByComparator(
  left: NormalizedRouteCandidate,
  right: NormalizedRouteCandidate,
): number {
  // For ARRIVE_BY, leaving later is preferable when the arrival requirement
  // is already satisfied. All comparisons use absolute instants.
  return (
    right.departure.instant.getTime() - left.departure.instant.getTime() ||
    left.durationSeconds - right.durationSeconds ||
    compareComparableFare(left, right) ||
    transferCount(left) - transferCount(right) ||
    walkingSeconds(left) - walkingSeconds(right) ||
    compareCodePoints(left.candidateId, right.candidateId)
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareComparableFare(
  left: NormalizedRouteCandidate,
  right: NormalizedRouteCandidate,
): number {
  if (
    left.fare === null ||
    right.fare === null ||
    left.fare.currency.toUpperCase() !== right.fare.currency.toUpperCase()
  ) {
    return 0;
  }
  return compareDecimalAmounts(left.fare.amount, right.fare.amount);
}

function compareDecimalAmounts(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const leftValue = a.value * 10n ** BigInt(scale - a.scale);
  const rightValue = b.value * 10n ** BigInt(scale - b.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function parseDecimal(value: string): {
  readonly value: bigint;
  readonly scale: number;
} {
  if (!isCanonicalRouteFareAmount(value)) {
    throw new Error('fare amount must be a bounded canonical decimal');
  }
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value)!;
  const fraction = match[2] ?? '';
  return { value: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function transferCount(candidate: NormalizedRouteCandidate): number {
  return Math.max(0, candidate.legs.length - 1);
}

function walkingSeconds(candidate: NormalizedRouteCandidate): number {
  return candidate.legs.reduce(
    (total, leg) =>
      total + (leg.mode === 'WALKING' ? (leg.durationSeconds ?? 0) : 0),
    0,
  );
}
