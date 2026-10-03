import type {
  ConnectionView,
  InTripView,
  ItineraryNodeView,
  ScheduleProjectionView,
  TemporalValueView,
  TripView,
} from '@travel/contracts';
import {
  isFoldedTransfer,
  orderedNodes,
  routeConnections,
  savedLegTransport,
  times,
  transportTime,
} from './model.js';

export type InTripStep =
  | {
      kind: 'node';
      node: ItineraryNodeView;
      start: TemporalValueView | null;
      end: TemporalValueView | null;
    }
  | {
      kind: 'transport';
      connection: ConnectionView;
      routeFrom: string;
      routeTo: string;
      legIndex: number | null;
      start: TemporalValueView | null;
      end: TemporalValueView | null;
    };

/** Device zone is supplied explicitly by the browser; never a server fallback. */
export function todayContext(now: Date, deviceZone: string | null) {
  if (!deviceZone || !Number.isFinite(now.getTime())) return null;
  try {
    return {
      localDate: new Intl.DateTimeFormat('sv-SE', {
        timeZone: deviceZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now),
      clock: new Intl.DateTimeFormat('sv-SE', {
        timeZone: deviceZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(now),
      timeZone: deviceZone,
    };
  } catch {
    return null;
  }
}

export function inTripProjection(
  trip: TripView,
  schedule: ScheduleProjectionView | null,
  evidence: InTripView | null,
  now: Date,
  deviceZone: string | null,
) {
  const context = todayContext(now, deviceZone);
  const matching = trip.days.filter((d) => d.localDate === context?.localDate);
  const coherent =
    evidence?.tripId === trip.id &&
    evidence.tripVersion === trip.version &&
    schedule?.tripId === trip.id &&
    schedule.basisVersion === trip.version;
  const execution =
    coherent &&
    evidence.execution.recordedAt &&
    Date.parse(evidence.execution.recordedAt) <= now.getTime()
      ? evidence.execution
      : null;
  const executionNode = orderedNodes(trip).find(
    (n) => n.id === (execution?.currentNodeId ?? execution?.targetNodeId),
  );
  const day =
    matching.length === 1
      ? matching[0]
      : matching.find(
          (d) => d.dayOccurrenceId === executionNode?.dayOccurrenceId,
        );
  const steps: InTripStep[] = [];
  const seen = new Set<string>();
  for (const n of orderedNodes(trip)) {
    const projection =
      schedule?.basisVersion === trip.version
        ? schedule.nodes.find((p) => p.nodeId === n.id)
        : undefined;
    const t = times(n, projection);
    if (
      n.dayOccurrenceId === day?.dayOccurrenceId &&
      !isFoldedTransfer(trip, n)
    )
      steps.push({ kind: 'node', node: n, start: t.arrival, end: t.departure });
    const chain = routeConnections(trip, n.id);
    for (const c of chain) {
      const edge = c.transport;
      if (!edge || c.state !== 'ACTIVE' || seen.has(edge.id)) continue;
      seen.add(edge.id);
      const involved =
        day &&
        (day.nodes.some(
          (node) => node.id === c.fromNodeId || node.id === c.toNodeId,
        ) ||
          day.transportProjections.some((p) => p.transportEdgeId === edge.id));
      if (!involved) continue;
      const saved = trip.savedRoutes?.find(
        (r) => r.adoptedRouteId === edge.adoptedRouteId,
      );
      const index =
        saved?.legs.findIndex(
          (_, i) =>
            savedLegTransport(saved, i, trip.connections)?.id === edge.id,
        ) ?? -1;
      const leg = index >= 0 ? saved?.legs[index] : null;
      const local = (value: TemporalValueView | null, zone?: string) =>
        value && zone ? { ...value, timeZone: zone } : value;
      steps.push({
        kind: 'transport',
        connection: c,
        routeFrom: chain[0]!.fromNodeId,
        routeTo: chain.at(-1)!.toNodeId,
        legIndex: index >= 0 ? index : null,
        start: local(
          transportTime(edge.timeValues, 'DEPARTURE'),
          leg?.departure?.timeZone,
        ),
        end: local(
          transportTime(edge.timeValues, 'ARRIVAL'),
          leg?.arrival?.timeZone,
        ),
      });
    }
  }
  let index = steps.findIndex((s) => {
    const until = s.end ?? s.start;
    return (
      !until ||
      !Number.isFinite(Date.parse(until.instant)) ||
      Date.parse(until.instant) >= now.getTime()
    );
  });
  let progress = '当前进度未知';
  if (execution?.state === 'AT_NODE' && execution.currentNodeId) {
    const current = steps.findIndex(
      (s) => s.kind === 'node' && s.node.id === execution.currentNodeId,
    );
    if (current >= 0) {
      index = current;
      progress = '已有用户到达记录';
    }
  } else if (execution?.state === 'EN_ROUTE' && execution.targetNodeId) {
    const current = steps.findIndex(
      (s) =>
        s.kind === 'transport' &&
        s.connection.toNodeId === execution.targetNodeId,
    );
    const target = steps.findIndex(
      (s) => s.kind === 'node' && s.node.id === execution.targetNodeId,
    );
    if (current >= 0 || target >= 0) {
      index = current >= 0 ? current : target;
      progress = '已有用户出发记录';
    }
  } else if (execution?.state === 'COMPLETED')
    progress = '已有用户执行记录；日程已结束';
  const past = index < 0 && steps.length > 0;
  if (past) index = steps.length - 1;
  return {
    context,
    day,
    ambiguous: matching.length > 1 && !day,
    progress,
    past,
    step: steps[index] ?? null,
    following: steps.slice(index + 1, index + 3),
    steps,
  };
}
