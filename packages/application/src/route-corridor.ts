import type {
  ItineraryNodeRecord,
  TransportEdgeRecord,
  TripAggregateRecord,
} from './trip-ports.js';

export interface CurrentRouteCorridor {
  readonly nodes: readonly ItineraryNodeRecord[];
  readonly currentTransports: readonly TransportEdgeRecord[];
  readonly currentAdoptedRouteId: string | null;
}

export function resolveCurrentRouteCorridor(
  trip: TripAggregateRecord,
  orderedNodes: readonly ItineraryNodeRecord[],
  fromIndex: number,
  toIndex: number,
): CurrentRouteCorridor | null {
  const fromNode = orderedNodes[fromIndex];
  const toNode = orderedNodes[toIndex];
  if (
    fromIndex < 0 ||
    toIndex <= fromIndex ||
    fromNode?.kind !== 'PLACE_VISIT' ||
    toNode?.kind !== 'PLACE_VISIT'
  ) {
    return null;
  }

  const nodes = orderedNodes.slice(fromIndex, toIndex + 1);
  const currentTransports = adjacentTransports(trip, nodes);
  const activeRoutes = (trip.adoptedRoutes ?? []).filter(
    (route) =>
      route.tripId === trip.id &&
      route.status === 'ACTIVE' &&
      route.anchorFromNodeId === fromNode.id &&
      route.anchorToNodeId === toNode.id,
  );

  if (nodes.length === 2) {
    const edge = currentTransports[0];
    if (edge?.source !== 'ADOPTED_ROUTE') {
      return activeRoutes.length === 0
        ? { nodes, currentTransports, currentAdoptedRouteId: null }
        : null;
    }
    if (
      edge.adoptedRouteId === null ||
      edge.adoptedRouteId === undefined ||
      activeRoutes.length !== 1 ||
      activeRoutes[0]?.id !== edge.adoptedRouteId
    ) {
      return null;
    }
    return {
      nodes,
      currentTransports,
      currentAdoptedRouteId: edge.adoptedRouteId,
    };
  }

  const internalNodes = nodes.slice(1, -1);
  const routeIds = new Set(
    internalNodes.map((node) => node.adoptedRouteId).filter(isString),
  );
  if (
    routeIds.size !== 1 ||
    internalNodes.some(
      (node) =>
        node.kind !== 'PLACE_VISIT' ||
        node.source !== 'ROUTE_GENERATED' ||
        node.adoptedRouteId === null ||
        node.adoptedRouteId === undefined,
    )
  ) {
    return null;
  }
  const routeId = [...routeIds][0]!;
  if (
    activeRoutes.length !== 1 ||
    activeRoutes[0]?.id !== routeId ||
    currentTransports.length !== nodes.length - 1 ||
    currentTransports.some(
      (edge) =>
        edge.source !== 'ADOPTED_ROUTE' || edge.adoptedRouteId !== routeId,
    )
  ) {
    return null;
  }
  return { nodes, currentTransports, currentAdoptedRouteId: routeId };
}

function adjacentTransports(
  trip: TripAggregateRecord,
  nodes: readonly ItineraryNodeRecord[],
): readonly TransportEdgeRecord[] {
  const result: TransportEdgeRecord[] = [];
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    const fromNode = nodes[index];
    const toNode = nodes[index + 1];
    const edge = trip.transportEdges.find(
      (candidate) =>
        candidate.tripId === trip.id &&
        candidate.fromNodeId === fromNode?.id &&
        candidate.toNodeId === toNode?.id,
    );
    if (edge !== undefined) result.push(edge);
  }
  return result;
}

function isString(value: string | null | undefined): value is string {
  return typeof value === 'string';
}
