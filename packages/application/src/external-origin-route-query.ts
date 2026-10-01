import type { ExternalRouteOriginSnapshot } from '@travel/contracts';
import {
  resolveExternalExecutionOriginCurrentness,
  resolveExternalOriginRouteQueryAuthorization,
} from '@travel/domain';
import type {
  ExternalOriginRecord,
  ExternalOriginPlanningContext,
} from './external-execution-origin-ports.js';

export function authorizeExternalOriginPlanning(
  context: ExternalOriginPlanningContext,
  toNodeId: string,
) {
  return resolveExternalOriginRouteQueryAuthorization({
    origin: context.origin,
    currentness:
      context.origin === null
        ? null
        : resolveExternalExecutionOriginCurrentness({
            origin: context.origin,
            origins: context.origins,
            executionEvents: context.executionEvents,
            frontierState: context.frontierState,
          }),
    sourceRoute: context.sourceRoute,
    sourceEdge: context.sourceEdge,
    toNodeId,
  });
}
export function externalRouteOriginSnapshot(
  origin: ExternalOriginRecord,
): ExternalRouteOriginSnapshot {
  return {
    schema: 'external-route-origin-v1',
    externalOriginId: origin.id,
    provider: origin.provider,
    providerHubRef: origin.providerHubRef,
    canonicalHubRef: origin.canonicalHubRef,
    name: origin.name,
    latitude: origin.latitude,
    longitude: origin.longitude,
    timeZone: origin.timeZone,
    arrivedAt: origin.arrivedAt.toISOString(),
    sourceAdoptedRouteId: origin.sourceAdoptedRouteId,
    sourceTransportEdgeId: origin.sourceTransportEdgeId,
    sourceGroundTransitLegExecutionId: origin.sourceGroundTransitLegExecutionId,
    sourceGroundTransitObservationId: origin.sourceGroundTransitObservationId,
    sourceObservationIdentity: origin.sourceObservationIdentity,
    sourceObservationFetchedAt: origin.sourceObservationFetchedAt.toISOString(),
    sourceObservationFactsHash: origin.sourceObservationFactsHash,
  };
}
