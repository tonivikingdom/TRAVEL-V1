import type {
  GroundTransitExecutionResponse,
  InTripView,
  TemporalValueView,
  TripView,
} from '@travel/contracts';
import { fixtureCandidate, fixtureTrip, visit } from './fixture.js';

/** SYNTHETIC contract fixture, not a real timetable or a Provider call. */
export function inTripFixture(
  layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL' = 'PLANNED',
) {
  const base = fixtureTrip();
  const candidate = fixtureCandidate();
  const a = base.days[0]!.nodes[0]!;
  const z = base.days[0]!.nodes[1]!;
  const stamp = '2030-10-01T05:10:00Z';
  const clock = (minute: number) =>
    `2030-10-01T05:${String(minute).padStart(2, '0')}:00Z`;
  const modes = ['WALKING', 'BUS', 'RAIL', 'WALKING'] as const;
  const nodes = [
    a,
    ...[1, 2, 3].map((i) => ({
      ...visit(`transfer-${i}`, `SYNTHETIC 换乘站 ${i}`),
      position: i,
      source: 'ROUTE_GENERATED' as const,
      adoptedRouteId: base.id,
    })),
    { ...z, position: 4 },
  ];
  const legs = modes.map((mode, i) => ({
    ...candidate.legs[0]!,
    mode,
    fixedService: mode === 'RAIL',
    serviceLabel: `SYNTHETIC ${mode} 线路`,
    from: {
      ...nodes[i]!.place!,
      name: `SYNTHETIC 上车站 ${i} · 长站名用于移动端验收`,
      providerPlaceRef: null,
    },
    to: {
      ...nodes[i + 1]!.place!,
      name: `SYNTHETIC 下车站 ${i}`,
      providerPlaceRef: null,
    },
    departure: { instant: clock([0, 15, 35, 50][i]!), timeZone: 'Asia/Tokyo' },
    arrival: {
      instant: i === 3 ? '2030-10-01T06:00:00Z' : clock([10, 30, 50][i]!),
      timeZone: 'Asia/Tokyo',
    },
  }));
  const temporal = (
    i: number,
    pointKind: 'DEPARTURE' | 'ARRIVAL',
    requested: typeof layer,
  ): TemporalValueView => {
    const instant =
      pointKind === 'DEPARTURE'
        ? legs[i]!.departure.instant
        : legs[i]!.arrival.instant;
    return {
      id: `SYNTHETIC-${i}-${pointKind}-${requested}`,
      pointKind,
      layer: requested,
      instant:
        requested === 'PLANNED' || i !== 1
          ? instant
          : new Date(Date.parse(instant) + 5 * 60000).toISOString(),
      timeZone: 'Asia/Tokyo',
      sourceKind:
        requested === 'PLANNED'
          ? 'ADOPTED_TRANSPORT_FACT'
          : 'PROVIDER_OBSERVATION',
      sourceRef: 'SYNTHETIC provenance',
      observedAt: requested === 'PLANNED' ? null : stamp,
      createdAt: stamp,
      updatedAt: stamp,
    };
  };
  const connections = legs.map((l, i) => ({
    fromNodeId: nodes[i]!.id,
    toNodeId: nodes[i + 1]!.id,
    state: 'ACTIVE' as const,
    transport: {
      id: `edge-${i}`,
      fromNodeId: nodes[i]!.id,
      toNodeId: nodes[i + 1]!.id,
      mode: l.mode,
      fixedService: l.fixedService,
      serviceLabel: l.serviceLabel,
      note: null,
      source: 'ADOPTED_ROUTE' as const,
      adoptedRouteId: base.id,
      provider: 'SYNTHETIC',
      providerRef: null,
      createdAt: stamp,
      updatedAt: stamp,
      timeValues: (['DEPARTURE', 'ARRIVAL'] as const).flatMap((p) => [
        temporal(i, p, 'PLANNED'),
        ...(layer === 'PLANNED' || i !== 1 ? [] : [temporal(i, p, layer)]),
      ]),
    },
  }));
  const trip: TripView = {
    ...base,
    days: [{ ...base.days[0]!, nodes }],
    connections,
    savedRoutes: [
      {
        adoptedRouteId: base.id,
        transportEdgeIds: connections.map((c) => c.transport.id),
        legs,
        legTransportEdges: connections.map((c, i) => ({
          legIndex: i,
          transportEdgeId: c.transport.id,
        })),
      },
    ],
  };
  const evidence: InTripView = {
    tripId: trip.id,
    tripVersion: trip.version,
    execution: {
      state: 'NOT_STARTED',
      currentNodeId: null,
      targetNodeId: a.id,
      recordedAt: null,
    },
    flights: [],
  };
  const safety = {
    policyVersion: 'SYNTHETIC',
    realtimeFreshness: 'FRESH' as const,
    headwayWaitReserveSeconds: null,
    boardingAccessMinimumSeconds: null,
    headwayBasis: 'unknown',
    boardingAccessBasis: 'unknown',
    executionWindow: { plannedDeparture: null, plannedArrival: null },
    totalSystemMinimumSeconds: null,
    etaRangeSeconds: null,
    feasibility: 'UNKNOWN' as const,
    reasonCodes: [],
    requiresRouteReevaluation: false,
  };
  const ground: GroundTransitExecutionResponse = {
    tripId: trip.id,
    tripVersion: trip.version,
    legs: connections
      .filter((c) => c.transport.mode === 'BUS' || c.transport.mode === 'RAIL')
      .map((c) => ({
        id: `SYNTHETIC-${c.transport.id}`,
        transportEdgeId: c.transport.id,
        adoptedRouteId: trip.id,
        legIndex: Number(c.transport.id.split('-')[1]),
        mode: c.transport.mode as 'BUS' | 'RAIL',
        provider: 'SYNTHETIC',
        serviceClass: 'FIXED_SERVICE',
        serviceIdentityKey: null,
        state: 'PENDING',
        baseline: null,
        latestObservation: null,
        latestFetchedAt: stamp,
        observationCount: 0,
        deviationConsecutiveObservations: 0,
        deviationStartedAt: null,
        current: true,
        operational: {
          policyVersion: 'SYNTHETIC',
          disposition: 'CONTINUE_CURRENT_PLAN',
          requiredAction: 'NONE',
          changeKinds: [],
          reasonCodes: [],
          targetServiceability: { boarding: 'UNKNOWN', alighting: 'UNKNOWN' },
          requiresUserAttention: false,
          notificationPriority: null,
          observationEvidenceRef: null,
          irreversibleActualMiss: false,
        },
        safety: { boarding: safety, transferToNext: null },
      })),
  };
  return { trip, evidence, ground };
}
