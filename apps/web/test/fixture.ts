import type {
  ItineraryNodeView,
  RouteCandidateView,
  ScheduleProjectionView,
  TripView,
} from '@travel/contracts';
export const tripId = '10000000-0000-4000-8000-000000000001';
export const fromId = '10000000-0000-4000-8000-000000000002';
export const toId = '10000000-0000-4000-8000-000000000003';
export const dayId = '10000000-0000-4000-8000-000000000004';
export function visit(id: string, name: string): ItineraryNodeView {
  return {
    id,
    kind: 'PLACE_VISIT',
    dayOccurrenceId: dayId,
    position: id === fromId ? 0 : 1,
    place: {
      id,
      name,
      latitude: id === fromId ? 35.6812 : 35.7138,
      longitude: id === fromId ? 139.7671 : 139.7773,
      address:
        id === fromId
          ? '東京都千代田区丸の内（SYNTHETIC 测试地点）'
          : '東京都台東区（SYNTHETIC 测试地点）',
      createdAt: '2030-01-01T00:00:00Z',
    },
    note: null,
    source: 'USER_PLANNED',
    adoptedRouteId: null,
    provider: null,
    providerPlaceRef: null,
    providerHubRef: null,
    sourceOperationId: null,
    autoReplaceable: false,
    userModifiedAt: null,
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    timeIntents: [],
    timeValues: [],
  };
}
export function fixtureTrip(): TripView {
  const a: { -readonly [P in keyof ItineraryNodeView]: ItineraryNodeView[P] } =
    visit(fromId, '丸の内酒店 · SYNTHETIC');
  const b = visit(toId, '上野公园 · SYNTHETIC');
  a.timeValues = [
    {
      id: fromId,
      layer: 'PLANNED',
      pointKind: 'ARRIVAL',
      instant: '2030-10-01T04:00:00Z',
      timeZone: 'Asia/Tokyo',
      sourceKind: 'USER_VALUE',
      sourceRef: null,
      observedAt: null,
      createdAt: '2030-01-01T00:00:00Z',
      updatedAt: '2030-01-01T00:00:00Z',
    },
    {
      id: toId,
      layer: 'PLANNED',
      pointKind: 'DEPARTURE',
      instant: '2030-10-01T05:00:00Z',
      timeZone: 'Asia/Tokyo',
      sourceKind: 'USER_VALUE',
      sourceRef: null,
      observedAt: null,
      createdAt: '2030-01-01T00:00:00Z',
      updatedAt: '2030-01-01T00:00:00Z',
    },
  ];
  a.timeIntents = [
    {
      id: dayId,
      kind: 'MIN_DWELL',
      pointKind: null,
      operator: 'MINIMUM',
      instant: null,
      timeZone: null,
      durationSeconds: 3600,
      locked: true,
      createdAt: '2030-01-01T00:00:00Z',
      updatedAt: '2030-01-01T00:00:00Z',
    },
  ];
  return {
    id: tripId,
    name: '东京慢旅行 · SYNTHETIC',
    planningAnchorDate: '2030-10-01',
    defaultPeopleCount: 1,
    version: 1,
    effectiveStartDate: '2030-10-01',
    effectiveEndDate: '2030-10-02',
    createdAt: '2030-01-01T00:00:00Z',
    updatedAt: '2030-01-01T00:00:00Z',
    days: [
      {
        dayOccurrenceId: dayId,
        localDate: '2030-10-01',
        sequence: 0,
        nodes: [a, b],
        transportProjections: [],
      },
      {
        dayOccurrenceId: '10000000-0000-4000-8000-000000000005',
        localDate: '2030-10-02',
        sequence: 1,
        nodes: [],
        transportProjections: [],
      },
    ],
    connections: [
      { fromNodeId: fromId, toNodeId: toId, state: 'MISSING', transport: null },
    ],
  };
}
export function fixtureSchedule(trip: TripView): ScheduleProjectionView {
  return {
    tripId: trip.id,
    basisVersion: trip.version,
    nodes: [],
    violations: [],
    conflicts: [],
  };
}
export function fixtureCandidate(): RouteCandidateView {
  const t = fixtureTrip();
  const from = t.days[0]!.nodes[0]!.place!;
  const to = t.days[0]!.nodes[1]!.place!;
  return {
    candidateSnapshotId: tripId,
    snapshotExpiresAt: '2030-10-01T12:00:00Z',
    candidateId: 'SYNTHETIC-CANDIDATE',
    provider: 'SYNTHETIC',
    providerCandidateRef: null,
    observedAt: '2030-10-01T03:00:00Z',
    validUntil: null,
    queryBasisVersion: 1,
    queryTimeCondition: {
      hardEarliestDeparture: '2030-10-01T05:00:00Z',
      hardLatestArrival: null,
      earliestDeparture: '2030-10-01T05:00:00Z',
      latestArrival: null,
      preference: { type: 'NONE' },
      hint: null,
    },
    overall: {
      departure: { instant: '2030-10-01T05:00:00Z', timeZone: 'Asia/Tokyo' },
      arrival: { instant: '2030-10-01T05:30:00Z', timeZone: 'Asia/Tokyo' },
      durationSeconds: 1800,
    },
    legs: [
      {
        mode: 'WALKING',
        from: { ...from, providerPlaceRef: null },
        to: { ...to, providerPlaceRef: null },
        departure: { instant: '2030-10-01T05:00:00Z', timeZone: 'Asia/Tokyo' },
        arrival: { instant: '2030-10-01T05:30:00Z', timeZone: 'Asia/Tokyo' },
        durationSeconds: 1800,
        fixedService: false,
        serviceLabel: null,
        providerRef: null,
      },
    ],
    fare: { amount: '0', currency: 'JPY' },
  };
}
