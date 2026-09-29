export type RouteMode =
  | 'WALKING'
  | 'DRIVING'
  | 'TAXI'
  | 'RAIL'
  | 'BUS'
  | 'FERRY'
  | 'FLIGHT'
  | 'OTHER';

export interface RouteLocation {
  readonly name: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly providerPlaceRef: string | null;
  readonly providerHubRef?: string | null;
}

export interface RouteTimePoint {
  readonly instant: Date;
  readonly timeZone: string;
}

export interface RouteCandidateLeg {
  readonly mode: RouteMode;
  readonly from: RouteLocation;
  readonly to: RouteLocation;
  readonly departure: RouteTimePoint | null;
  readonly arrival: RouteTimePoint | null;
  readonly durationSeconds: number | null;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
  readonly providerRef: string | null;
  readonly groundTransit?: {
    readonly serviceClass: 'FIXED_SERVICE' | 'HIGH_FREQUENCY';
    readonly serviceIdentityKey: string | null;
    readonly lineRef: string | null;
    readonly lineName: string | null;
    readonly directionRef: string | null;
    readonly directionLabel: string | null;
    readonly boardingHubRef: string | null;
    readonly alightingHubRef: string | null;
    readonly headwayMinSeconds: number | null;
    readonly headwayMaxSeconds: number | null;
    readonly minimumTransferSeconds: number | null;
    readonly boardingAccessMinimumSeconds?: number | null;
  } | null;
}

export interface RouteFare {
  readonly amount: string;
  readonly currency: string;
}

// Parser-safety limits, not currency precision rules. They bound
// provider-controlled decimal work while retaining high-precision fares.
export const MAX_ROUTE_FARE_INTEGER_DIGITS = 64;
export const MAX_ROUTE_FARE_FRACTION_DIGITS = 32;

export interface NormalizedRouteCandidate {
  readonly candidateId: string;
  readonly provider: string;
  readonly providerCandidateRef: string | null;
  readonly observedAt: Date;
  readonly validUntil: Date | null;
  readonly departure: RouteTimePoint;
  readonly arrival: RouteTimePoint;
  readonly durationSeconds: number;
  readonly legs: readonly RouteCandidateLeg[];
  readonly fare: RouteFare | null;
}

export interface RouteRequirementBounds {
  readonly earliestDeparture: Date | null;
  readonly latestArrival: Date | null;
}

export type RouteCandidateRejectionReason =
  'INVALID_CANDIDATE' | 'DEPARTURE_BEFORE_EARLIEST' | 'ARRIVAL_AFTER_LATEST';

export type RouteCandidateValidation =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: RouteCandidateRejectionReason;
    };

export function validateRouteCandidate(
  candidate: NormalizedRouteCandidate,
  bounds: RouteRequirementBounds,
): RouteCandidateValidation {
  if (!isValidCandidate(candidate)) {
    return { accepted: false, reason: 'INVALID_CANDIDATE' };
  }
  if (
    bounds.earliestDeparture !== null &&
    candidate.departure.instant.getTime() < bounds.earliestDeparture.getTime()
  ) {
    return { accepted: false, reason: 'DEPARTURE_BEFORE_EARLIEST' };
  }
  if (
    bounds.latestArrival !== null &&
    candidate.arrival.instant.getTime() > bounds.latestArrival.getTime()
  ) {
    return { accepted: false, reason: 'ARRIVAL_AFTER_LATEST' };
  }
  return { accepted: true };
}

function isValidCandidate(candidate: NormalizedRouteCandidate): boolean {
  if (
    candidate.candidateId.trim() === '' ||
    candidate.provider.trim() === '' ||
    !validDate(candidate.observedAt) ||
    (candidate.validUntil !== null && !validDate(candidate.validUntil)) ||
    !validTimePoint(candidate.departure) ||
    !validTimePoint(candidate.arrival) ||
    !validDuration(candidate.durationSeconds) ||
    candidate.legs.length === 0 ||
    !validFare(candidate.fare) ||
    candidate.arrival.instant.getTime() < candidate.departure.instant.getTime()
  ) {
    return false;
  }
  if (
    candidate.arrival.instant.getTime() -
      candidate.departure.instant.getTime() !==
    candidate.durationSeconds * 1_000
  ) {
    return false;
  }
  return candidate.legs.every(validLeg);
}

function validFare(fare: RouteFare | null): boolean {
  return (
    fare === null ||
    (isCanonicalRouteFareAmount(fare.amount) &&
      /^[A-Z]{3}$/u.test(fare.currency))
  );
}

export function isCanonicalRouteFareAmount(value: string): boolean {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value);
  return (
    match !== null &&
    match[1]!.length <= MAX_ROUTE_FARE_INTEGER_DIGITS &&
    (match[2]?.length ?? 0) <= MAX_ROUTE_FARE_FRACTION_DIGITS
  );
}

function validLeg(leg: RouteCandidateLeg): boolean {
  if (
    !validLocation(leg.from) ||
    !validLocation(leg.to) ||
    (leg.departure !== null && !validTimePoint(leg.departure)) ||
    (leg.arrival !== null && !validTimePoint(leg.arrival)) ||
    (leg.durationSeconds !== null && !validDuration(leg.durationSeconds)) ||
    !validGroundTransitMetadata(leg)
  ) {
    return false;
  }
  if (
    leg.departure !== null &&
    leg.arrival !== null &&
    leg.arrival.instant.getTime() < leg.departure.instant.getTime()
  ) {
    return false;
  }
  if (
    leg.departure !== null &&
    leg.arrival !== null &&
    leg.durationSeconds !== null &&
    leg.arrival.instant.getTime() - leg.departure.instant.getTime() !==
      leg.durationSeconds * 1_000
  ) {
    return false;
  }
  return true;
}

function validGroundTransitMetadata(leg: RouteCandidateLeg): boolean {
  const metadata = leg.groundTransit;
  if (metadata === undefined || metadata === null) return true;
  if (leg.mode !== 'RAIL' && leg.mode !== 'BUS') return false;
  const strings = [
    metadata.serviceIdentityKey,
    metadata.lineRef,
    metadata.lineName,
    metadata.directionRef,
    metadata.directionLabel,
    metadata.boardingHubRef,
    metadata.alightingHubRef,
  ];
  const durations = [
    metadata.headwayMinSeconds,
    metadata.headwayMaxSeconds,
    metadata.minimumTransferSeconds,
    metadata.boardingAccessMinimumSeconds ?? null,
  ];
  return (
    (metadata.serviceClass === 'FIXED_SERVICE' ||
      metadata.serviceClass === 'HIGH_FREQUENCY') &&
    (metadata.serviceClass === 'FIXED_SERVICE') === leg.fixedService &&
    strings.every(
      (value) =>
        value === null ||
        (typeof value === 'string' && value.trim().length > 0),
    ) &&
    durations.every(
      (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
    ) &&
    (metadata.headwayMinSeconds === null ||
      metadata.headwayMaxSeconds === null ||
      metadata.headwayMinSeconds <= metadata.headwayMaxSeconds)
  );
}

function validLocation(location: RouteLocation): boolean {
  if (location.name.trim() === '') return false;
  if (
    location.providerHubRef !== undefined &&
    location.providerHubRef !== null &&
    location.providerHubRef.trim() === ''
  ) {
    return false;
  }
  if (
    (location.latitude === null) !== (location.longitude === null) ||
    (location.latitude !== null &&
      (!Number.isFinite(location.latitude) ||
        location.latitude < -90 ||
        location.latitude > 90)) ||
    (location.longitude !== null &&
      (!Number.isFinite(location.longitude) ||
        location.longitude < -180 ||
        location.longitude > 180))
  ) {
    return false;
  }
  return true;
}

function validTimePoint(point: RouteTimePoint): boolean {
  return validDate(point.instant) && point.timeZone.trim() !== '';
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
