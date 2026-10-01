import {
  resolveCurrentRouteReplacementCorridor,
  type CorridorNode,
  type CorridorRoute,
  type CorridorTransport,
} from './route-replacement-corridor.js';

export interface ExternalOriginReplacementCorridor {
  readonly replacementScope: 'EXTERNAL_ORIGIN';
  readonly sourceAdoptedRouteId: string;
  readonly sourceRouteAnchorFromNodeId: string;
  readonly sourceRouteAnchorToNodeId: string;
  readonly sourceTransportEdgeId: string;
  readonly sourceDivergenceNodeId: string;
  readonly destinationNodeId: string;
  readonly preservedPrefixNodeIds: readonly string[];
  readonly preservedPrefixTransportEdgeIds: readonly string[];
  readonly replacementNodeIds: readonly string[];
  readonly replacementTransportEdgeIds: readonly string[];
}

/** External execution diverges on an existing edge, including the first edge.
 * It never creates a planned connection from the divergence node to the hub.
 */
export function resolveExternalOriginReplacementCorridor(input: {
  tripId: string;
  orderedNodes: readonly CorridorNode[];
  transports: readonly CorridorTransport[];
  sourceRoute: CorridorRoute | null;
  sourceTransportEdgeId: string;
  destinationNodeId: string;
}): ExternalOriginReplacementCorridor | null {
  const route = input.sourceRoute;
  if (
    route === null ||
    route.tripId !== input.tripId ||
    route.status !== 'ACTIVE' ||
    input.destinationNodeId !== route.anchorToNodeId
  )
    return null;
  const full = resolveCurrentRouteReplacementCorridor(
    input.tripId,
    input.orderedNodes,
    input.transports,
    [route],
    route.anchorFromNodeId,
    route.anchorToNodeId,
  );
  if (full === null || full.sourceAdoptedRouteId !== route.id) return null;
  const offset = full.replacementTransportEdgeIds.indexOf(
    input.sourceTransportEdgeId,
  );
  if (offset < 0) return null;
  return {
    replacementScope: 'EXTERNAL_ORIGIN',
    sourceAdoptedRouteId: route.id,
    sourceRouteAnchorFromNodeId: route.anchorFromNodeId,
    sourceRouteAnchorToNodeId: route.anchorToNodeId,
    sourceTransportEdgeId: input.sourceTransportEdgeId,
    sourceDivergenceNodeId: full.replacementNodeIds[offset]!,
    destinationNodeId: route.anchorToNodeId,
    preservedPrefixNodeIds: full.replacementNodeIds.slice(0, offset + 1),
    preservedPrefixTransportEdgeIds: full.replacementTransportEdgeIds.slice(
      0,
      offset,
    ),
    replacementNodeIds: full.replacementNodeIds.slice(offset),
    replacementTransportEdgeIds: full.replacementTransportEdgeIds.slice(offset),
  };
}

/** Vehicle ACTUAL is archivable history only in an external replacement plan.
 * Every other ACTUAL provenance continues to protect the transport.
 */
export function classifyExternalReplacementTransportActual(
  edges: readonly {
    readonly id: string;
    readonly timeValues: readonly {
      readonly layer: string;
      readonly sourceKind: string;
    }[];
  }[],
) {
  const protectedBlockingTransportEdgeIds: string[] = [];
  const archivableProviderActualTransportEdgeIds: string[] = [];
  for (const edge of edges) {
    const actual = edge.timeValues.filter((value) => value.layer === 'ACTUAL');
    if (actual.some((value) => value.sourceKind !== 'PROVIDER_OBSERVATION')) {
      protectedBlockingTransportEdgeIds.push(edge.id);
    } else if (actual.length > 0) {
      archivableProviderActualTransportEdgeIds.push(edge.id);
    }
  }
  return {
    protectedBlockingTransportEdgeIds,
    archivableProviderActualTransportEdgeIds,
  };
}
