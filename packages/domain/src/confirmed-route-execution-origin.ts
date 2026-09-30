import { resolveExecutionFrontier } from './execution-location.js';

export interface RouteExecutionFact {
  readonly instant: Date;
  readonly sourceKind: string;
  readonly sourceRef: string | null;
}

export interface RouteExecutionOriginNode {
  readonly id: string;
  readonly kind: string;
  readonly actualArrival: RouteExecutionFact | null;
  readonly actualDeparture: RouteExecutionFact | null;
  readonly executionStatus: 'POSSIBLY_SKIPPED' | 'SKIPPED' | null;
}

export interface RouteExecutionOriginEvent {
  readonly id: string;
  readonly nodeId: string;
  readonly type: 'ARRIVAL' | 'DEPARTURE' | 'SKIP_CONFIRMED';
  readonly source: 'LOCATION' | 'MANUAL';
  readonly occurredAt: Date;
  readonly undoneAt: Date | null;
  readonly evidenceReliability: 'SUFFICIENT' | 'WEAK' | 'INDETERMINATE' | null;
}

export type ConfirmedRouteExecutionOrigin =
  | { readonly status: 'CONFIRMED_NODE'; readonly nodeId: string }
  | { readonly status: 'NOT_PROGRESSING' | 'UNRESOLVED' | 'CONFLICT' };

/** Topology is supplied by the corridor resolver; execution authorizes its origin. */
export function resolveConfirmedRouteExecutionOrigin(input: {
  readonly nodes: readonly RouteExecutionOriginNode[];
  readonly corridorNodeIds: readonly string[];
  readonly events: readonly RouteExecutionOriginEvent[];
  readonly locationCurrentNodeId?: string | null;
  readonly independentProgress?: boolean;
  readonly externalExecutionFacts?: readonly Date[];
}): ConfirmedRouteExecutionOrigin {
  if (input.corridorNodeIds.length < 2) return { status: 'UNRESOLVED' };
  const frontier = resolveExecutionFrontier(
    input.nodes.map((node, position) => ({
      id: node.id,
      sequence: 0,
      position,
      latitude: null,
      longitude: null,
      targetKind: 'PLACE',
      hasActualArrival: node.actualArrival !== null,
      hasActualDeparture: node.actualDeparture !== null,
      executionStatus: node.executionStatus,
    })),
  );
  if (frontier.state === 'INCONSISTENT') return { status: 'CONFLICT' };
  const activeEvents = input.events.filter((event) => event.undoneAt === null);
  const node = input.nodes.find((item) => item.id === frontier.currentNode?.id);
  const internalIds = input.corridorNodeIds.slice(1, -1);
  if (node !== undefined && internalIds.includes(node.id)) {
    if (node.kind !== 'PLACE_VISIT' || node.executionStatus === 'SKIPPED') {
      return { status: 'CONFLICT' };
    }
    const arrivals = activeEvents.filter(
      (event) => event.nodeId === node.id && event.type === 'ARRIVAL',
    );
    if (arrivals.length > 1) return { status: 'CONFLICT' };
    const arrival = arrivals[0];
    const fact = node.actualArrival;
    if (
      arrival === undefined ||
      fact === null ||
      fact.sourceRef !== `execution-event:${arrival.id}` ||
      fact.instant.getTime() !== arrival.occurredAt.getTime() ||
      fact.sourceKind !==
        (arrival.source === 'MANUAL'
          ? 'USER_VALUE'
          : 'EXECUTION_OBSERVATION') ||
      (arrival.source === 'LOCATION' &&
        arrival.evidenceReliability !== 'SUFFICIENT')
    )
      return { status: 'UNRESOLVED' };
    if (
      input.externalExecutionFacts?.some(
        (instant) => instant >= arrival.occurredAt,
      )
    )
      return { status: 'UNRESOLVED' };
    const originIndex = input.nodes.findIndex((item) => item.id === node.id);
    if (
      activeEvents.some(
        (event) =>
          (event.nodeId === node.id && event.type !== 'ARRIVAL') ||
          input.nodes.findIndex((item) => item.id === event.nodeId) >
            originIndex ||
          event.occurredAt > arrival.occurredAt,
      )
    )
      return { status: 'CONFLICT' };
    return { status: 'CONFIRMED_NODE', nodeId: node.id };
  }
  const fromId = input.corridorNodeIds[0]!;
  const laterIds = input.corridorNodeIds.slice(1);
  const progressing =
    input.independentProgress === true ||
    (input.locationCurrentNodeId != null &&
      laterIds.includes(input.locationCurrentNodeId)) ||
    input.nodes.some(
      (item) =>
        (item.id === fromId && item.actualDeparture !== null) ||
        (laterIds.includes(item.id) &&
          (item.actualArrival !== null ||
            item.actualDeparture !== null ||
            item.executionStatus === 'SKIPPED')),
    ) ||
    activeEvents.some(
      (event) =>
        (event.nodeId === fromId && event.type === 'DEPARTURE') ||
        laterIds.includes(event.nodeId),
    );
  return { status: progressing ? 'UNRESOLVED' : 'NOT_PROGRESSING' };
}
