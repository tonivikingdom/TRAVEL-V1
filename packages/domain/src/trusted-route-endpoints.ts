import type { NormalizedRouteCandidate, RouteLocation } from './route-query.js';

export type TrustedRouteEndpoint = Pick<
  RouteLocation,
  'latitude' | 'longitude' | 'providerPlaceRef' | 'providerHubRef'
>;

/** Structured identity outranks coordinate coincidence; display names are not identity. */
export function matchesTrustedRouteEndpoint(
  candidate: RouteLocation,
  trusted: TrustedRouteEndpoint,
): boolean {
  if (candidate.providerPlaceRef != null && trusted.providerPlaceRef != null)
    return candidate.providerPlaceRef === trusted.providerPlaceRef;
  if (candidate.providerHubRef != null && trusted.providerHubRef != null)
    return candidate.providerHubRef === trusted.providerHubRef;
  return (
    candidate.latitude !== null &&
    candidate.longitude !== null &&
    trusted.latitude !== null &&
    trusted.longitude !== null &&
    Number.isFinite(candidate.latitude) &&
    Number.isFinite(candidate.longitude) &&
    candidate.latitude === trusted.latitude &&
    candidate.longitude === trusted.longitude
  );
}

export function validateExternalRouteCandidateEndpoints(
  candidate: Pick<NormalizedRouteCandidate, 'legs'>,
  origin: TrustedRouteEndpoint,
  destination: TrustedRouteEndpoint,
): boolean {
  const first = candidate.legs[0];
  const last = candidate.legs.at(-1);
  return (
    first !== undefined &&
    last !== undefined &&
    matchesTrustedRouteEndpoint(first.from, origin) &&
    matchesTrustedRouteEndpoint(last.to, destination)
  );
}
