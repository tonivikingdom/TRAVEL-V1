import { resolveConfirmedRouteExecutionOrigin } from '@travel/domain';
import { orderedTripNodes } from './schedule-evaluation.js';
import type { TripAggregateRecord } from './trip-ports.js';

export function resolveConfirmedRouteExecutionOriginForTrip(
  trip: TripAggregateRecord,
  anchorFromNodeId: string,
  anchorToNodeId: string,
  independentProgress = false,
) {
  const nodes = orderedTripNodes(trip);
  const from = nodes.findIndex((node) => node.id === anchorFromNodeId);
  const to = nodes.findIndex((node) => node.id === anchorToNodeId);
  return resolveConfirmedRouteExecutionOrigin({
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      actualArrival:
        node.timeValues.find(
          (value) => value.layer === 'ACTUAL' && value.pointKind === 'ARRIVAL',
        ) ?? null,
      actualDeparture:
        node.timeValues.find(
          (value) =>
            value.layer === 'ACTUAL' && value.pointKind === 'DEPARTURE',
        ) ?? null,
      executionStatus: node.executionStatus ?? null,
    })),
    corridorNodeIds:
      from < 0 || to <= from
        ? []
        : nodes.slice(from, to + 1).map((node) => node.id),
    events: trip.routeExecutionEvents ?? [],
    locationCurrentNodeId: trip.executionLocationCurrentNodeId ?? null,
    independentProgress,
  });
}
