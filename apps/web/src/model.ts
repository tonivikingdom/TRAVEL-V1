import type {
  ItineraryNodeView,
  RouteCandidateView,
  ScheduleNodeProjectionView,
  TemporalValueView,
  TripView,
} from '@travel/contracts';
export const layerLabel = {
  PLANNED: '计划',
  ESTIMATED: '预计',
  ACTUAL: '实际',
};
export function temporalLabel(
  value: Pick<TemporalValueView, 'layer' | 'sourceKind'>,
): string {
  return value.layer === 'ACTUAL' && value.sourceKind === 'PROVIDER_OBSERVATION'
    ? '车辆实测'
    : layerLabel[value.layer];
}
export function transportTime(
  values: readonly TemporalValueView[],
  point: 'ARRIVAL' | 'DEPARTURE',
) {
  return (
    ['ACTUAL', 'ESTIMATED', 'PLANNED']
      .map((layer) =>
        values.find((v) => v.pointKind === point && v.layer === layer),
      )
      .find(Boolean) ?? null
  );
}
export const modeLabel: Record<string, string> = {
  WALKING: '步行',
  RAIL: '铁路',
  BUS: '公交',
  TAXI: '出租车',
  DRIVING: '驾车',
  FERRY: '轮渡',
  FLIGHT: '航班',
  OTHER: '交通',
};
export function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/gu,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
export function formatTime(
  value: Pick<TemporalValueView, 'instant' | 'timeZone'> | null,
  localDate?: string,
): string {
  if (!value) return '待定';
  try {
    const formatted = new Intl.DateTimeFormat('sv-SE', {
      timeZone: value.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value.instant));
    return localDate === formatted.slice(0, 10)
      ? formatted.slice(11)
      : formatted;
  } catch {
    return '时间不可用';
  }
}
export function duration(seconds: number | null): string {
  if (seconds === null) return '待定';
  if (seconds < 0) return '时间冲突';
  return `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)} 小时 ` : ''}${seconds % 3600 ? `${Math.floor((seconds % 3600) / 60)} 分钟` : seconds === 0 ? '0 分钟' : ''}`.trim();
}
export function times(
  node: ItineraryNodeView,
  projection?: ScheduleNodeProjectionView,
) {
  const pick = (kind: 'ARRIVAL' | 'DEPARTURE') =>
    ['ACTUAL', 'ESTIMATED', 'PLANNED']
      .map((layer) =>
        node.timeValues.find((v) => v.layer === layer && v.pointKind === kind),
      )
      .find(Boolean) ?? null;
  const arrival = projection?.arrival.effective?.value ?? pick('ARRIVAL');
  const departure = projection?.departure.effective?.value ?? pick('DEPARTURE');
  const dwell =
    arrival && departure && arrival.layer === departure.layer
      ? (Date.parse(departure.instant) - Date.parse(arrival.instant)) / 1000
      : null;
  return { arrival, departure, dwell };
}
export function departureFloor(
  node: ItineraryNodeView,
  projection?: ScheduleNodeProjectionView,
): string | null {
  const { arrival, departure } = times(node, projection);
  const minimum =
    node.timeIntents.find((i) => i.kind === 'MIN_DWELL')?.durationSeconds ??
    null;
  const points = [
    arrival?.instant,
    departure?.instant,
    projection?.departure.requirementWindow.earliest,
  ];
  if (arrival && minimum !== null)
    points.push(
      new Date(Date.parse(arrival.instant) + minimum * 1000).toISOString(),
    );
  const valid = points.filter((p): p is string => !!p);
  return valid.length
    ? new Date(Math.max(...valid.map(Date.parse))).toISOString()
    : null;
}
export function candidateConflict(
  candidate: RouteCandidateView,
  floor: string | null,
): string | null {
  return floor &&
    Date.parse(candidate.overall.departure.instant) < Date.parse(floor)
    ? '出发早于当前可出发时间，无法衔接。'
    : null;
}
export function nodeZone(
  node: ItineraryNodeView,
  projection?: ScheduleNodeProjectionView,
): string | null {
  return (
    times(node, projection).departure?.timeZone ??
    times(node, projection).arrival?.timeZone ??
    node.timeIntents.find((i) => i.timeZone)?.timeZone ??
    null
  );
}
export function localInput(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date(instant))
    .replace(' ', 'T');
}
// Input conversion only. Ambiguous/nonexistent local times require a new explicit choice.
export function localToInstant(input: string, timeZone: string): string {
  const base = Date.parse(`${input}:00Z`);
  if (!Number.isFinite(base)) throw new Error('请填写完整日期和时间。');
  const matches: string[] = [];
  try {
    for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
      const iso = new Date(base + offset * 60000).toISOString();
      if (localInput(iso, timeZone) === input) matches.push(iso);
    }
  } catch {
    throw new Error('请填写有效的 IANA 时区。');
  }
  if (matches.length !== 1)
    throw new Error('该当地时间不存在或有夏令时歧义，请选择另一个明确时间。');
  return matches[0]!;
}
export function orderedNodes(trip: TripView) {
  return [...trip.days]
    .sort((a, b) => a.sequence - b.sequence)
    .flatMap((d) => [...d.nodes].sort((a, b) => a.position - b.position));
}

/** Presentation only: traverse the current connected edges of one selected route. */
export function routeConnections(trip: TripView, fromNodeId: string) {
  const first = trip.connections.find((c) => c.fromNodeId === fromNodeId);
  if (!first) return [];
  const route =
    first.transport?.source === 'ADOPTED_ROUTE'
      ? first.transport.adoptedRouteId
      : null;
  const result = [first];
  if (!route) return result;
  const seen = new Set([first.fromNodeId, first.toNodeId]);
  while (result.length < trip.connections.length) {
    const next = trip.connections.find(
      (c) =>
        c.fromNodeId === result.at(-1)!.toNodeId &&
        c.transport?.source === 'ADOPTED_ROUTE' &&
        c.transport.adoptedRouteId === route,
    );
    if (!next || seen.has(next.toNodeId)) break;
    result.push(next);
    seen.add(next.toNodeId);
  }
  return result;
}
export function isFoldedTransfer(
  trip: TripView,
  node: ItineraryNodeView,
): boolean {
  if (node.source !== 'ROUTE_GENERATED' || node.userModifiedAt || node.note)
    return false;
  const incoming = trip.connections.find(
    (c) => c.toNodeId === node.id,
  )?.transport;
  const outgoing = trip.connections.find(
    (c) => c.fromNodeId === node.id,
  )?.transport;
  return (
    !!incoming?.adoptedRouteId &&
    incoming.adoptedRouteId === outgoing?.adoptedRouteId
  );
}
