export type RouteReplacementScope = 'FULL_CORRIDOR' | 'SUFFIX';
export interface CorridorNode {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly adoptedRouteId?: string | null;
}
export interface CorridorTransport {
  readonly id: string;
  readonly tripId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly source: string;
  readonly adoptedRouteId?: string | null;
}
export interface CorridorRoute {
  readonly id: string;
  readonly tripId: string;
  readonly status: string;
  readonly anchorFromNodeId: string;
  readonly anchorToNodeId: string;
}
export interface RouteReplacementCorridor {
  readonly replacementScope: RouteReplacementScope;
  readonly sourceAdoptedRouteId: string | null;
  readonly sourceRouteAnchorFromNodeId: string;
  readonly sourceRouteAnchorToNodeId: string;
  readonly replacementAnchorFromNodeId: string;
  readonly replacementAnchorToNodeId: string;
  readonly replacementNodeIds: readonly string[];
  readonly replacementTransportEdgeIds: readonly string[];
  /** Prefix includes the shared replacement origin. */
  readonly preservedPrefixNodeIds: readonly string[];
  readonly preservedPrefixTransportEdgeIds: readonly string[];
}

/** Pure topology policy shared by Query, Preview and locked persistence writes.
 * Facts and live-origin eligibility belong to their existing policies, not here.
 */
export function resolveCurrentRouteReplacementCorridor(
  tripId: string,
  orderedNodes: readonly CorridorNode[],
  transports: readonly CorridorTransport[],
  routes: readonly CorridorRoute[],
  fromNodeId: string,
  toNodeId: string,
): RouteReplacementCorridor | null {
  if (new Set(orderedNodes.map((node) => node.id)).size !== orderedNodes.length)
    return null;
  const fromIndex = orderedNodes.findIndex((node) => node.id === fromNodeId);
  const toIndex = orderedNodes.findIndex((node) => node.id === toNodeId);
  if (
    fromIndex < 0 ||
    toIndex <= fromIndex ||
    orderedNodes[fromIndex]?.kind !== 'PLACE_VISIT' ||
    orderedNodes[toIndex]?.kind !== 'PLACE_VISIT'
  )
    return null;
  const matches = routes.filter((route) => {
    const start = orderedNodes.findIndex(
      (node) => node.id === route.anchorFromNodeId,
    );
    return (
      route.tripId === tripId &&
      route.status === 'ACTIVE' &&
      route.anchorToNodeId === toNodeId &&
      start >= 0 &&
      start <= fromIndex
    );
  });
  const pairEdges = (nodes: readonly CorridorNode[]) =>
    nodes
      .slice(0, -1)
      .map((node, index) =>
        transports.filter(
          (edge) =>
            edge.tripId === tripId &&
            edge.fromNodeId === node.id &&
            edge.toNodeId === nodes[index + 1]!.id,
        ),
      );
  if (matches.length === 0) {
    if (toIndex !== fromIndex + 1) return null;
    const edges = pairEdges(orderedNodes.slice(fromIndex, toIndex + 1))[0]!;
    if (
      edges.length > 1 ||
      edges.some((edge) => edge.source === 'ADOPTED_ROUTE')
    )
      return null;
    return {
      replacementScope: 'FULL_CORRIDOR',
      sourceAdoptedRouteId: null,
      sourceRouteAnchorFromNodeId: fromNodeId,
      sourceRouteAnchorToNodeId: toNodeId,
      replacementAnchorFromNodeId: fromNodeId,
      replacementAnchorToNodeId: toNodeId,
      replacementNodeIds: [fromNodeId, toNodeId],
      replacementTransportEdgeIds: edges.map((edge) => edge.id),
      preservedPrefixNodeIds: [],
      preservedPrefixTransportEdgeIds: [],
    };
  }
  if (matches.length !== 1) return null;
  const route = matches[0]!;
  const start = orderedNodes.findIndex(
    (node) => node.id === route.anchorFromNodeId,
  );
  const sourceNodes = orderedNodes.slice(start, toIndex + 1);
  if (
    sourceNodes[0]?.kind !== 'PLACE_VISIT' ||
    sourceNodes
      .slice(1, -1)
      .some(
        (node) =>
          node.kind !== 'PLACE_VISIT' ||
          node.source !== 'ROUTE_GENERATED' ||
          node.adoptedRouteId !== route.id,
      )
  )
    return null;
  if (
    orderedNodes.some(
      (node) =>
        node.adoptedRouteId === route.id &&
        !sourceNodes.some((member) => member.id === node.id),
    )
  )
    return null;
  const edges = pairEdges(sourceNodes);
  if (
    edges.some(
      (pair) =>
        pair.length !== 1 ||
        pair[0]?.source !== 'ADOPTED_ROUTE' ||
        pair[0]?.adoptedRouteId !== route.id,
    )
  )
    return null;
  if (
    transports.filter(
      (edge) => edge.tripId === tripId && edge.adoptedRouteId === route.id,
    ).length !== edges.length
  )
    return null;
  const offset = fromIndex - start;
  return {
    replacementScope: offset === 0 ? 'FULL_CORRIDOR' : 'SUFFIX',
    sourceAdoptedRouteId: route.id,
    sourceRouteAnchorFromNodeId: route.anchorFromNodeId,
    sourceRouteAnchorToNodeId: route.anchorToNodeId,
    replacementAnchorFromNodeId: fromNodeId,
    replacementAnchorToNodeId: toNodeId,
    replacementNodeIds: sourceNodes.slice(offset).map((node) => node.id),
    replacementTransportEdgeIds: edges.slice(offset).map((pair) => pair[0]!.id),
    preservedPrefixNodeIds:
      offset === 0
        ? []
        : sourceNodes.slice(0, offset + 1).map((node) => node.id),
    preservedPrefixTransportEdgeIds: edges
      .slice(0, offset)
      .map((pair) => pair[0]!.id),
  };
}
