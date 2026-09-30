import { resolveCurrentRouteReplacementCorridor } from '@travel/domain';
import type { ItineraryNodeRecord, TripAggregateRecord } from './trip-ports.js';

/** Record adapter; topology is exclusively resolved by the shared domain policy. */
export function resolveCurrentRouteCorridor(
  trip: TripAggregateRecord,
  orderedNodes: readonly ItineraryNodeRecord[],
  fromIndex: number,
  toIndex: number,
) {
  const from = orderedNodes[fromIndex];
  const to = orderedNodes[toIndex];
  if (from === undefined || to === undefined) return null;
  const corridor = resolveCurrentRouteReplacementCorridor(
    trip.id,
    orderedNodes,
    trip.transportEdges,
    trip.adoptedRoutes ?? [],
    from.id,
    to.id,
  );
  if (corridor === null) return null;
  return {
    ...corridor,
    nodes: orderedNodes.slice(fromIndex, toIndex + 1),
    currentTransports: corridor.replacementTransportEdgeIds.map((id) =>
      trip.transportEdges.find((edge) => edge.id === id)!,
    ),
    currentAdoptedRouteId: corridor.sourceAdoptedRouteId,
  };
}
