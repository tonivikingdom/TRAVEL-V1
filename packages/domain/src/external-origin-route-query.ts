import {
  isValidResolvedTransitHub,
  type ExternalOriginFact,
  type ExternalExecutionOriginCurrentness,
  type GroundTransitHubMetadata,
} from './external-execution-origin.js';

/** Planning trusts user execution currentness, never later vehicle recovery. */
export function resolveExternalOriginRouteQueryAuthorization(input: {
  origin:
    | (ExternalOriginFact &
        GroundTransitHubMetadata & {
          sourceAdoptedRouteId: string;
          sourceTransportEdgeId: string;
        })
    | null;
  currentness: ExternalExecutionOriginCurrentness | null;
  sourceRoute: { id: string; status: string; anchorToNodeId: string } | null;
  sourceEdge: {
    id: string;
    source: string;
    adoptedRouteId?: string | null;
  } | null;
  toNodeId: string;
}):
  | 'AUTHORIZED'
  | 'NOT_CURRENT'
  | 'SOURCE_ROUTE_NOT_CURRENT'
  | 'DESTINATION_MISMATCH'
  | 'CONFLICT' {
  const { origin, sourceRoute, sourceEdge } = input;
  if (input.currentness === 'CONFLICT') return 'CONFLICT';
  if (
    origin === null ||
    origin.status !== 'ARRIVED' ||
    input.currentness !== 'CURRENT'
  )
    return 'NOT_CURRENT';
  if (
    !isValidResolvedTransitHub(origin, origin.provider, origin.providerHubRef)
  )
    return 'CONFLICT';
  if (
    sourceRoute?.id !== origin.sourceAdoptedRouteId ||
    sourceRoute.status !== 'ACTIVE' ||
    sourceEdge?.id !== origin.sourceTransportEdgeId ||
    sourceEdge.source !== 'ADOPTED_ROUTE' ||
    sourceEdge.adoptedRouteId !== sourceRoute.id
  )
    return 'SOURCE_ROUTE_NOT_CURRENT';
  if (input.toNodeId !== sourceRoute.anchorToNodeId)
    return 'DESTINATION_MISMATCH';
  return 'AUTHORIZED';
}
