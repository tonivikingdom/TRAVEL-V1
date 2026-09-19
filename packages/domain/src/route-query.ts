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
}

export interface RouteFare {
  readonly amount: string;
  readonly currency: string;
}

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

function validLeg(leg: RouteCandidateLeg): boolean {
  if (
    !validLocation(leg.from) ||
    !validLocation(leg.to) ||
    (leg.departure !== null && !validTimePoint(leg.departure)) ||
    (leg.arrival !== null && !validTimePoint(leg.arrival)) ||
    (leg.durationSeconds !== null && !validDuration(leg.durationSeconds))
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
