import { describe, expect, it } from 'vitest';
import {
  candidateConflict,
  departureFloor,
  duration,
  formatTime,
  localToInstant,
  times,
  routeConnections,
  isFoldedTransfer,
  temporalLabel,
  transportTime,
  savedLegTransport,
} from '../src/model.js';
import { coordinates, navigation, placeMap, mapMode } from '../src/maps.js';
import { fixtureCandidate, fixtureTrip } from './fixture.js';
import { TravelApi, WebError, errorText } from '../src/api.js';
describe('formal itinerary time and location adapters', () => {
  it('prioritizes relevant transport facts without presenting vehicle ACTUAL as user arrival', () => {
    const planned = fixtureTrip().days[0]!.nodes[0]!.timeValues[0]!;
    const actual = {
      ...planned,
      layer: 'ACTUAL' as const,
      sourceKind: 'PROVIDER_OBSERVATION' as const,
    };
    expect(
      transportTime([planned, actual], planned.pointKind as 'ARRIVAL'),
    ).toEqual(actual);
    expect(temporalLabel(actual)).toBe('车辆实测');
    expect(
      temporalLabel({ ...actual, sourceKind: 'EXECUTION_OBSERVATION' }),
    ).toBe('实际');
  });
  it('shows arrival, departure and same-layer dwell without replacing a requirement', () => {
    const n = fixtureTrip().days[0]!.nodes[0]!;
    expect(times(n).dwell).toBe(3600);
    expect(formatTime(times(n).arrival, '2030-10-01')).toBe('13:00');
    expect(departureFloor(n)).toBe('2030-10-01T05:00:00.000Z');
  });
  it('departure only leaves arrival/dwell unknown, rather than zero', () => {
    const n = fixtureTrip().days[0]!.nodes[0]!;
    const value = {
      ...n,
      timeValues: n.timeValues.filter((v) => v.pointKind === 'DEPARTURE'),
    };
    expect(times(value).arrival).toBeNull();
    expect(times(value).dwell).toBeNull();
    expect(duration(null)).toBe('待定');
  });
  it('does not subtract different semantic layers or clamp negative dwell', () => {
    const n = fixtureTrip().days[0]!.nodes[0]!;
    expect(
      times({
        ...n,
        timeValues: n.timeValues.map((v) =>
          v.pointKind === 'ARRIVAL' ? { ...v, layer: 'ACTUAL' } : v,
        ),
      }).dwell,
    ).toBeNull();
    expect(duration(-3600)).toBe('时间冲突');
  });
  it('respects prior-date arrival and cross-midnight instants', () => {
    const n = fixtureTrip().days[0]!.nodes[0]!;
    const v = {
      ...n,
      timeValues: n.timeValues.map((x) =>
        x.pointKind === 'ARRIVAL'
          ? { ...x, instant: '2030-09-30T14:00:00Z' }
          : x,
      ),
    };
    expect(formatTime(times(v).arrival, '2030-10-01')).toBe('2030-09-30 23:00');
    expect(times(v).dwell).toBe(54000);
  });
  it('converts explicit event timezone, rejects DST ambiguity and gaps', () => {
    expect(localToInstant('2030-10-01T14:00', 'Asia/Tokyo')).toBe(
      '2030-10-01T05:00:00.000Z',
    );
    expect(() =>
      localToInstant('2030-03-10T02:30', 'America/New_York'),
    ).toThrow();
    expect(() =>
      localToInstant('2030-11-03T01:30', 'America/New_York'),
    ).toThrow();
    expect(() => localToInstant('2030-10-01T14:00', 'Bad/Zone')).toThrow();
  });
  it('blocks the reported 10:45 departure after 13:00 hotel arrival and one-hour dwell', () => {
    const c = fixtureCandidate();
    expect(
      candidateConflict(
        {
          ...c,
          overall: {
            ...c.overall,
            departure: {
              instant: '2030-10-01T01:45:00Z',
              timeZone: 'Asia/Tokyo',
            },
          },
        },
        departureFloor(fixtureTrip().days[0]!.nodes[0]!),
      ),
    ).toContain('早于');
    expect(
      candidateConflict(c, departureFloor(fixtureTrip().days[0]!.nodes[0]!)),
    ).toBeNull();
  });
  it('uses exact trusted coordinates in Maps URLs, never internal IDs, notes or keys', () => {
    const place = fixtureTrip().days[0]!.nodes[0]!.place!;
    const map = new URL(placeMap(place)!);
    expect(map.searchParams.get('query')).toBe('35.6812,139.7671');
    expect(map.searchParams.has('query_place_id')).toBe(false);
    expect(map.searchParams.has('key')).toBe(false);
    const nav = new URL(navigation(place)!);
    expect(nav.searchParams.has('origin')).toBe(false);
    expect(nav.searchParams.get('travelmode')).toBe('walking');
    expect(new URL(placeMap(place, true)!).hostname).toBe('maps.apple.com');
  });
  it('declines navigation without valid coordinates instead of guessing', () => {
    const location = { name: 'SYNTHETIC', latitude: null, longitude: null };
    expect(placeMap(location)).toBeNull();
    expect(navigation(location)).toBeNull();
    expect(coordinates({ ...location, latitude: 91, longitude: 1 })).toBeNull();
  });
  it.each([
    [401, '登录已失效'],
    [403, '没有访问'],
    [404, '已不存在'],
  ])('explains HTTP %s separately', (status, text) =>
    expect(errorText(new WebError(status, 'NOT_FOUND', 'x'))).toContain(text),
  );
  it('uses neutral Undo explanation rather than claiming user execution', () =>
    expect(errorText(new WebError(409, 'UNDO_CONFLICT', 'x'))).toContain(
      '相关状态已更新',
    ));
  it('sends server authorization, parses business errors and distinguishes network failure', async () => {
    const calls: RequestInit[] = [];
    const client = new TravelApi(
      () => 'SYNTHETIC-TEST',
      async (_url, init) => {
        calls.push(init!);
        return new Response(
          JSON.stringify({
            error: { code: 'VERSION_CONFLICT', message: 'stale' },
          }),
          { status: 409 },
        );
      },
    );
    await expect(client.request('/trips', {})).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(calls[0]!.headers).toMatchObject({
      authorization: 'Bearer SYNTHETIC-TEST',
    });
    await expect(
      new TravelApi(
        () => null,
        async () => {
          throw new Error();
        },
      ).request('/trips'),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

it('groups a current adopted corridor for presentation, keeping user-modified stops visible', () => {
  const trip = fixtureTrip();
  const [a, b] = trip.days[0]!.nodes;
  const middle = {
    ...b!,
    id: '10000000-0000-4000-8000-000000000006',
    source: 'ROUTE_GENERATED' as const,
    adoptedRouteId: trip.id,
  };
  const edge = {
    id: trip.id,
    fromNodeId: a!.id,
    toNodeId: middle.id,
    mode: 'RAIL' as const,
    fixedService: true,
    serviceLabel: 'SYNTHETIC',
    note: null,
    source: 'ADOPTED_ROUTE' as const,
    adoptedRouteId: trip.id,
    provider: 'SYNTHETIC',
    providerRef: null,
    createdAt: a!.createdAt,
    updatedAt: a!.updatedAt,
    timeValues: [],
  };
  const value = {
    ...trip,
    connections: [
      {
        fromNodeId: a!.id,
        toNodeId: middle.id,
        state: 'ACTIVE' as const,
        transport: edge,
      },
      {
        fromNodeId: middle.id,
        toNodeId: b!.id,
        state: 'ACTIVE' as const,
        transport: {
          ...edge,
          id: b!.id,
          fromNodeId: middle.id,
          toNodeId: b!.id,
        },
      },
    ],
  };
  expect(routeConnections(value, a!.id).map((c) => c.toNodeId)).toEqual([
    middle.id,
    b!.id,
  ]);
  expect(isFoldedTransfer(value, middle)).toBe(true);
  expect(isFoldedTransfer(value, { ...middle, note: 'important' })).toBe(false);
});

it('an old adopted-route departure result cannot prohibit an earlier replacement', () => {
  const n = fixtureTrip().days[0]!.nodes[0]!;
  const old = {
    ...n,
    timeValues: n.timeValues.map((v) =>
      v.pointKind === 'DEPARTURE'
        ? {
            ...v,
            instant: '2030-10-01T06:00:00Z',
            sourceKind: 'ADOPTED_TRANSPORT_FACT' as const,
          }
        : v,
    ),
  };
  expect(departureFloor(old)).toBe('2030-10-01T05:00:00.000Z');
});

it('explicit original route lookup never silently drops an unknown origin', () => {
  const p = fixtureTrip().days[0]!.nodes[0]!.place!;
  expect(navigation(p, { ...p, latitude: null })).toBeNull();
  expect(mapMode('DRIVING')).toBe('driving');
  expect(mapMode('RAIL')).toBe('transit');
  expect(mapMode('BUS')).toBe('transit');
  expect(mapMode('WALKING')).toBe('walking');
  expect(mapMode('OTHER')).toBeNull();
  expect(new URL(navigation(p, p, null)!).searchParams.has('travelmode')).toBe(
    false,
  );
});

it('saved segment timing uses explicit identity and never current edge array position', () => {
  const trip = fixtureTrip();
  const candidate = fixtureCandidate();
  const edge = {
    id: trip.id,
    fromNodeId: trip.days[0]!.nodes[0]!.id,
    toNodeId: trip.days[0]!.nodes[1]!.id,
    mode: candidate.legs[0]!.mode,
    fixedService: false,
    serviceLabel: null,
    note: null,
    source: 'ADOPTED_ROUTE' as const,
    adoptedRouteId: trip.id,
    provider: 'SYNTHETIC',
    providerRef: null,
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
    timeValues: [],
  };
  const connection = {
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    state: 'ACTIVE' as const,
    transport: edge,
  };
  const route = {
    adoptedRouteId: trip.id,
    transportEdgeIds: [edge.id],
    legs: candidate.legs,
    legTransportEdges: [{ legIndex: 0, transportEdgeId: edge.id }],
  };
  expect(
    savedLegTransport(route, 0, [
      { ...connection, transport: { ...edge, id: 'unrelated' } },
      connection,
    ]),
  ).toEqual(edge);
  expect(
    savedLegTransport({ ...route, legTransportEdges: [] }, 0, [connection]),
  ).toBeNull();
  expect(
    savedLegTransport(
      {
        ...route,
        legTransportEdges: [
          ...route.legTransportEdges,
          ...route.legTransportEdges,
        ],
      },
      0,
      [connection],
    ),
  ).toBeNull();
  expect(
    savedLegTransport(route, 0, [
      { ...connection, transport: { ...edge, adoptedRouteId: 'wrong-route' } },
    ]),
  ).toBeNull();
  expect(
    savedLegTransport(route, 0, [
      { ...connection, transport: { ...edge, mode: 'RAIL' } },
    ]),
  ).toBeNull();
});
