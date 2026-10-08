import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdoptRoutePreviewResponse,
  RoutePreviewView,
  RouteQueryResponse,
  ScheduleProjectionView,
  TripView,
} from '@travel/contracts';
import type { RouteProviderResult } from '@travel/application';
import { BaiduOrdinaryRouteProvider, baiduToWgs84 } from '@travel/providers';
import {
  footprint,
  onlyWrites,
  replanningHarness,
  type SyntheticOwner,
} from './helpers/replanning-acceptance.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'TEST_DATABASE_URL is required for SYNTHETIC travel acceptance',
  );
const frozen = new Date('2026-10-08T04:00:00Z');
const depart = '2026-10-10T10:00:00.000Z';
const raw = [
  { lat: 39.915, lng: 116.404 },
  { lat: 39.925, lng: 116.414 },
];
describe('V1 travel lifecycle — SYNTHETIC Provider + real isolated PostgreSQL', () => {
  let h: ReturnType<typeof replanningHarness>;
  let owner: SyntheticOwner;
  beforeEach(async () => {
    h = replanningHarness(databaseUrl);
    h.setNow(frozen);
    owner = await h.identity();
  });
  afterEach(async () => {
    await h.close();
  });
  async function command(trip: TripView, value: object) {
    const r = await h.post(owner, `/trips/${trip.id}/commands`, {
      baseTripVersion: trip.version,
      command: value,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<TripView>();
  }
  async function seed() {
    const r = await h.post(owner, '/trips', {
      name: 'SYNTHETIC Oct10 打车到高铁站',
      planningAnchorDate: '2026-10-10',
      defaultPeopleCount: 1,
    });
    expect(r.statusCode, r.body).toBe(201);
    let trip = r.json<TripView>();
    for (let i = 0; i < 2; i++) {
      trip = await command(trip, {
        type: 'ADD_PLACE_VISIT',
        position: i,
        targetDay:
          i === 0
            ? { type: 'NEW', localDate: '2026-10-10', sequence: 0 }
            : {
                type: 'EXISTING',
                dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
              },
        place: {
          type: 'CUSTOM',
          name: i === 0 ? 'SYNTHETIC 前一地点' : 'SYNTHETIC 高铁站',
          ...baiduToWgs84(raw[i]!.lat, raw[i]!.lng),
        },
      });
    }
    const [from, to] = trip.days[0]!.nodes;
    for (const [nodeId, pointKind, instant] of [
      [from!.id, 'ARRIVAL', '2026-10-10T09:00:00Z'],
      [from!.id, 'DEPARTURE', depart],
      [to!.id, 'ARRIVAL', '2026-10-10T10:30:00Z'],
      [to!.id, 'DEPARTURE', '2026-10-10T11:30:00Z'],
    ] as const) {
      const response = await h.post(
        owner,
        `/trips/${trip.id}/temporal-values`,
        {
          baseTripVersion: trip.version,
          subject: { type: 'NODE', nodeId },
          value: {
            layer: 'PLANNED',
            pointKind,
            instant,
            timeZone: 'Asia/Shanghai',
          },
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      trip = response.json<TripView>();
    }
    trip = await command(trip, {
      type: 'SET_TIME_INTENT',
      nodeId: from!.id,
      pointKind: 'DEPARTURE',
      operator: 'NOT_BEFORE',
      instant: depart,
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    trip = await command(trip, {
      type: 'SET_TIME_INTENT',
      nodeId: to!.id,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2026-10-10T10:45:00Z',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    return trip;
  }
  function query(
    trip: TripView,
    mode: 'DRIVING' | 'TRANSIT' = 'DRIVING',
    instant = depart,
  ) {
    return h.post(owner, `/trips/${trip.id}/routes/query`, {
      basisVersion: trip.version,
      fromNodeId: trip.days[0]!.nodes[0]!.id,
      toNodeId: trip.days[0]!.nodes[1]!.id,
      travelMode: mode,
      hint: { type: 'DEPART_AT', instant, timeZone: 'Asia/Shanghai' },
    });
  }
  function adapter(mode: 'DRIVING' | 'TRANSIT', approved = true) {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            status: 0,
            result: {
              origin:
                mode === 'DRIVING'
                  ? raw[0]
                  : { city_id: 'SYNTHETIC:city', location: raw[0] },
              destination:
                mode === 'DRIVING'
                  ? raw[1]
                  : { city_id: 'SYNTHETIC:city', location: raw[1] },
              routes: [{ duration: 1800 }],
            },
          }),
        ),
    );
    const provider = new BaiduOrdinaryRouteProvider(
      'SYNTHETIC_NO_REAL_KEY',
      fetcher,
      () => frozen,
      approved,
    );
    h.setProviderHook(async () => {
      h.setResult(await provider.queryRoutes(h.inputs.at(-1)!));
    });
    return fetcher;
  }
  async function schedule(trip: TripView) {
    const r = await h.post(owner, `/trips/${trip.id}/schedule/evaluate`, {
      basisVersion: trip.version,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<ScheduleProjectionView>();
  }
  async function confirmStillAtOrigin(trip: TripView) {
    h.setNow(new Date('2026-10-10T09:59:00Z'));
    const r = await h.post(owner, `/trips/${trip.id}/execution/events`, {
      baseTripVersion: trip.version,
      idempotencyKey: randomUUID(),
      type: 'MANUAL_ARRIVAL',
      nodeId: trip.days[0]!.nodes[0]!.id,
      occurredAt: '2026-10-10T09:00:00Z',
    });
    expect(r.statusCode, r.body).toBe(200);
    const fresh = (await h.get(owner, `/trips/${trip.id}`)).json<TripView>();
    const evidence = await h.get(owner, `/trips/${trip.id}/in-trip`);
    expect(evidence.json().execution).toMatchObject({
      state: 'AT_NODE',
      currentNodeId: trip.days[0]!.nodes[0]!.id,
    });
    return fresh;
  }
  async function dbEvidence(
    name: string,
    before: Awaited<ReturnType<typeof footprint>>,
    after: typeof before,
    extra: object,
  ) {
    const root = '../../docs/status/assets/v1-travel-scenarios/postgres';
    await mkdir(root, { recursive: true });
    const summary = (rows: typeof before) => ({
      tripVersion: rows.trip.version,
      ...Object.fromEntries(
        Object.entries(rows)
          .filter(([key]) => key !== 'trip')
          .map(([key, value]) => [
            key,
            Array.isArray(value) ? value.length : null,
          ]),
      ),
    });
    await writeFile(
      `${root}/${name}.json`,
      JSON.stringify(
        {
          synthetic: true,
          ...extra,
          before: summary(before),
          after: summary(after),
        },
        null,
        2,
      ) + '\n',
    );
  }
  it('future driving Query → Preview → Adopt → read → Undo preserves arrival/departure/stay and authorized writes', async () => {
    const trip = await seed();
    const fetcher = adapter('DRIVING');
    const before = await footprint(h.managed, trip.id);
    const q = await query(trip);
    expect(q.statusCode, q.body).toBe(200);
    expect(h.inputs[0]!.preference).toEqual({
      type: 'DEPART_AT',
      instant: new Date(depart),
      timeZone: 'Asia/Shanghai',
    });
    expect(
      new URL(String(fetcher.mock.calls[0]![0])).searchParams.get(
        'departure_time',
      ),
    ).toBe('1791626400');
    const candidate = q.json<RouteQueryResponse>().candidates[0]!;
    expect(candidate.overall.arrival.instant).toBe('2026-10-10T10:30:00.000Z');
    const queried = await footprint(h.managed, trip.id);
    onlyWrites(before, queried, ['snapshots']);
    const p = await h.preview(owner, trip, candidate.candidateSnapshotId);
    expect(p.statusCode, p.body).toBe(201);
    const view = p.json<RoutePreviewView>();
    expect(view.adoptable).toBe(true);
    const previewed = await footprint(h.managed, trip.id);
    onlyWrites(queried, previewed, ['previews']);
    const key = randomUUID();
    const a = await h.adopt(owner, trip, view, key);
    expect(a.statusCode, a.body).toBe(200);
    const adopted = a.json<AdoptRoutePreviewResponse>();
    expect(adopted.trip.version).toBe(trip.version + 1);
    const after = await footprint(h.managed, trip.id);
    expect(after.edges).toHaveLength(1);
    expect(after.edges[0]!.mode).toBe('DRIVING');
    expect(after.execution).toEqual(before.execution);
    const projection = await schedule(adopted.trip);
    expect(projection.conflicts).toEqual([]);
    for (const n of projection.nodes) {
      expect(n.arrival.effective).not.toBeNull();
      expect(n.departure.effective).not.toBeNull();
      expect(
        Date.parse(n.departure.effective!.value.instant) -
          Date.parse(n.arrival.effective!.value.instant),
      ).toBe(3600000);
    }
    expect((await h.get(owner, `/trips/${trip.id}`)).statusCode).toBe(200);
    expect((await h.get(owner, `/trips/${trip.id}/backup`)).statusCode).toBe(
      200,
    );
    onlyWrites(after, await footprint(h.managed, trip.id));
    const replay = await h.adopt(owner, trip, view, key);
    expect(replay.json()).toEqual(adopted);
    onlyWrites(after, await footprint(h.managed, trip.id));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const u = await h.undo(owner, adopted);
    expect(u.statusCode, u.body).toBe(200);
    const restored = await footprint(h.managed, trip.id);
    await dbEvidence('future-driving-lifecycle', before, restored, {
      frozenClock: frozen.toISOString(),
      requestedDeparture: depart,
      plannedArrival: candidate.overall.arrival.instant,
      providerRequestCount: fetcher.mock.calls.length,
      readAndPreviewFormalWrites: 0,
      adoptVersion: adopted.trip.version,
      undoVersion: restored.trip.version,
    });
    expect(restored.trip.version).toBe(trip.version + 2);
    for (const k of [
      'edges',
      'times',
      'intents',
      'execution',
      'backups',
      'authoring',
    ] as const)
      expect(restored[k], k).toEqual(before[k]);
    // Undo is forward compensation: row bookkeeping may advance, itinerary data must restore.
    function substantive<Row extends { updatedAt: Date }>(rows: Row[]) {
      return rows.map(({ updatedAt, ...data }) => {
        void updatedAt;
        return data;
      });
    }
    expect(substantive(restored.nodes)).toEqual(substantive(before.nodes));
    expect(substantive(restored.days)).toEqual(substantive(before.days));
    const dates = (rows: typeof before.ownership) =>
      rows.map(({ createdAt, ...data }) => {
        void createdAt;
        return data;
      });
    expect(dates(restored.ownership)).toEqual(dates(before.ownership));
    for (const key of ['nodes', 'days'] as const) {
      for (const row of restored[key]) {
        expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(
          before[key].find((old) => old.id === row.id)!.updatedAt.getTime(),
        );
      }
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('advanced driving permission absent is explicit API failure with zero Trip/planning writes', async () => {
    const trip = await seed();
    const fetcher = adapter('DRIVING', false);
    const before = await footprint(h.managed, trip.id);
    const q = await query(trip);
    expect(q.statusCode, q.body).toBe(422);
    expect(q.json().error.code).toBe('ROUTE_QUERY_UNSUPPORTED');
    expect(fetcher).not.toHaveBeenCalled();
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it.each(['DRIVING', 'TRANSIT'] as const)(
    'missing Web travelMode reaches %s adapter as undefined and is explicitly rejected',
    async (mode) => {
      const trip = await seed();
      const fetcher = adapter(mode);
      const before = await footprint(h.managed, trip.id);
      const q = await h.post(owner, `/trips/${trip.id}/routes/query`, {
        basisVersion: trip.version,
        fromNodeId: trip.days[0]!.nodes[0]!.id,
        toNodeId: trip.days[0]!.nodes[1]!.id,
        hint: { type: 'DEPART_AT', instant: depart, timeZone: 'Asia/Shanghai' },
      });
      expect(h.inputs[0]!.travelMode).toBeUndefined();
      expect(q.statusCode, q.body).toBe(422);
      expect(q.json().error.code).toBe('ROUTE_QUERY_UNSUPPORTED');
      expect(fetcher).not.toHaveBeenCalled();
      onlyWrites(before, await footprint(h.managed, trip.id));
    },
  );
  it('aggregate city TRANSIT retains no service/platform facts in snapshot, preview and adoption', async () => {
    const trip = await seed();
    adapter('TRANSIT');
    const q = await query(trip, 'TRANSIT');
    expect(q.statusCode, q.body).toBe(200);
    const c = q.json<RouteQueryResponse>().candidates[0]!;
    expect(c.legs).toHaveLength(1);
    expect(c.legs[0]).toMatchObject({
      mode: 'TRANSIT',
      fixedService: false,
      serviceLabel: null,
    });
    const p = await h.preview(owner, trip, c.candidateSnapshotId);
    expect(p.statusCode, p.body).toBe(201);
    const view = p.json<RoutePreviewView>();
    expect(view.changeSummary.generatedTransferPoints).toEqual([]);
    const a = await h.adopt(owner, trip, view);
    expect(a.statusCode, a.body).toBe(200);
    const rows = await footprint(h.managed, trip.id);
    expect(rows.nodes).toHaveLength(2);
    expect(rows.edges).toHaveLength(1);
    expect(rows.edges[0]).toMatchObject({
      mode: 'TRANSIT',
      fixedService: false,
      serviceLabel: null,
    });
    expect(JSON.stringify(rows.snapshots)).not.toMatch(
      /platform|SYNTHETIC_NO_REAL_KEY/,
    );
  });
  function transit(
    trip: TripView,
    at: string,
    transfer = false,
  ): RouteProviderResult {
    const [a, b] = trip.days[0]!.nodes;
    const point = (n: typeof a) => ({
      name: n!.place!.name,
      latitude: n!.place!.latitude,
      longitude: n!.place!.longitude,
      providerPlaceRef: null,
    });
    const mid = {
      ...point(a),
      name: 'SYNTHETIC 转乘站',
      latitude: (a!.place!.latitude + b!.place!.latitude) / 2,
      longitude: (a!.place!.longitude + b!.place!.longitude) / 2,
      providerHubRef: 'SYNTHETIC:HUB',
    };
    const tp = (offset: number) => ({
      instant: new Date(Date.parse(at) + offset * 1000),
      timeZone: 'Asia/Shanghai',
    });
    const leg = (
      from: ReturnType<typeof point>,
      to: ReturnType<typeof point>,
      start: number,
      end: number,
      mode: 'BUS' | 'RAIL' | 'WALKING',
    ) => ({
      mode,
      from,
      to,
      departure: tp(start),
      arrival: tp(end),
      durationSeconds: end - start,
      fixedService: mode !== 'WALKING',
      serviceLabel: mode === 'WALKING' ? null : `SYNTHETIC ${mode}`,
      providerRef: 'SYNTHETIC:leg',
    });
    return {
      status: 'SUCCESS',
      candidates: [
        {
          candidateId: 'SYNTHETIC_BUS_METRO',
          provider: 'SYNTHETIC',
          providerCandidateRef: null,
          observedAt: frozen,
          validUntil: null,
          departure: tp(0),
          arrival: tp(1800),
          durationSeconds: 1800,
          fare: null,
          legs: transfer
            ? [
                leg(point(a), mid, 0, 900, 'BUS'),
                leg(mid, mid, 900, 1200, 'WALKING'),
                leg(mid, point(b), 1200, 1800, 'RAIL'),
              ]
            : [leg(point(a), point(b), 0, 1800, 'BUS')],
        },
      ],
    };
  }
  it('explicit SYNTHETIC bus → station walk → metro retains transfer without double-counting walking', async () => {
    const trip = await seed();
    h.setResult(transit(trip, depart, true));
    const q = await query(trip, 'TRANSIT');
    expect(q.statusCode, q.body).toBe(200);
    const c = q.json<RouteQueryResponse>().candidates[0]!;
    expect(c.overall.durationSeconds).toBe(1800);
    const p = await h.preview(owner, trip, c.candidateSnapshotId);
    expect(p.statusCode, p.body).toBe(201);
    const view = p.json<RoutePreviewView>();
    expect(view.adoptable, JSON.stringify(view)).toBe(true);
    const a = await h.adopt(owner, trip, view);
    expect(a.statusCode, a.body).toBe(200);
    const result = a.json<AdoptRoutePreviewResponse>();
    expect(result.trip.savedRoutes![0]!.legs.map((l) => l.mode)).toEqual([
      'BUS',
      'WALKING',
      'RAIL',
    ]);
    const projection = await schedule(result.trip);
    expect(projection.conflicts).toEqual([]);
    const edges = await h.client.transportEdge.findMany({
      where: { tripId: trip.id },
    });
    expect(edges.map((e) => e.mode).sort()).toEqual(['BUS', 'RAIL']);
  });
  it('previous place cannot be left before 18:00: 17:55 bus is rejected without a snapshot', async () => {
    const trip = await seed();
    h.setResult(transit(trip, '2026-10-10T09:55:00Z'));
    const before = await footprint(h.managed, trip.id);
    const q = await query(trip, 'TRANSIT', '2026-10-10T09:55:00Z');
    expect(q.statusCode, q.body).toBe(404);
    expect(q.json().error.code).toBe('NO_MATCHING_CANDIDATE');
    expect(h.inputs[0]!.earliestDeparture).toEqual(new Date(depart));
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it('18:05 still at previous place must reject the bus that already departed at 18:00 (acceptance regression)', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    h.setNow(new Date('2026-10-10T10:05:00Z'));
    const result = transit(trip, depart);
    if (result.status !== 'SUCCESS')
      throw new Error('Expected SYNTHETIC service');
    h.setResult({
      ...result,
      candidates: result.candidates.map((c) => ({
        ...c,
        observedAt: new Date('2026-10-10T10:05:00Z'),
      })),
    });
    const before = await footprint(h.managed, trip.id);
    const q = await query(trip, 'TRANSIT');
    await dbEvidence(
      'already-departed-query',
      before,
      await footprint(h.managed, trip.id),
      {
        clock: '2026-10-10T10:05:00Z',
        serviceDeparture: depart,
        execution: 'AT_NODE, confirmed manual arrival; no departure',
        httpStatus: q.statusCode,
        candidateDeparture:
          q.statusCode === 200
            ? q.json<RouteQueryResponse>().candidates[0]!.overall.departure
                .instant
            : null,
      },
    );
    expect(
      q.statusCode,
      `SYNTHETIC now=18:05, departure=18:00, no DEPARTED event; HTTP ${q.statusCode}`,
    ).toBe(404);
    expect(q.json().error.code).toBe('NO_MATCHING_CANDIDATE');
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it('unexpired Preview cannot adopt an 18:00 fixed bus after 18:05 without departure evidence (acceptance regression)', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    h.setNow(new Date('2026-10-10T09:59:00Z'));
    const result = transit(trip, depart);
    if (result.status !== 'SUCCESS')
      throw new Error('Expected SYNTHETIC service');
    h.setResult({
      ...result,
      candidates: result.candidates.map((c) => ({
        ...c,
        observedAt: new Date('2026-10-10T09:59:00Z'),
      })),
    });
    const q = await query(trip, 'TRANSIT');
    expect(q.statusCode, q.body).toBe(200);
    const c = q.json<RouteQueryResponse>().candidates[0]!;
    const p = await h.preview(owner, trip, c.candidateSnapshotId);
    expect(p.statusCode, p.body).toBe(201);
    h.setNow(new Date('2026-10-10T10:05:00Z'));
    const before = await footprint(h.managed, trip.id);
    const a = await h.adopt(owner, trip, p.json<RoutePreviewView>());
    await dbEvidence(
      'already-departed-adopt',
      before,
      await footprint(h.managed, trip.id),
      {
        clock: '2026-10-10T10:05:00Z',
        serviceDeparture: depart,
        previewCreatedAt: p.json<RoutePreviewView>().createdAt,
        previewExpiresAt: p.json<RoutePreviewView>().expiresAt,
        execution: 'AT_NODE, confirmed manual arrival; no departure',
        httpStatus: a.statusCode,
      },
    );
    expect(
      a.statusCode,
      `SYNTHETIC unexpired preview, departed service must fail closed; HTTP ${a.statusCode}`,
    ).toBe(409);
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it('contradictory 18:00 departure / 17:50 latest arrival blocks Query before Provider', async () => {
    let trip = await seed();
    trip = await command(trip, {
      type: 'SET_TIME_INTENT',
      nodeId: trip.days[0]!.nodes[1]!.id,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2026-10-10T09:50:00Z',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    const before = await footprint(h.managed, trip.id);
    const q = await query(trip);
    expect(q.statusCode, q.body).toBe(409);
    expect(q.json().error.code).toBe('CONSTRAINT_CONFLICT');
    expect(h.inputs).toEqual([]);
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it('Trip change after Query blocks Preview; change after Preview blocks Adopt, owner and version fail closed', async () => {
    let trip = await seed();
    adapter('DRIVING');
    const q = await query(trip);
    expect(q.statusCode, q.body).toBe(200);
    const c = q.json<RouteQueryResponse>().candidates[0]!;
    const p = await h.preview(owner, trip, c.candidateSnapshotId);
    expect(p.statusCode, p.body).toBe(201);
    const old = trip;
    trip = await h.note(owner, trip);
    const before = await footprint(h.managed, trip.id);
    expect(
      (await h.preview(owner, old, c.candidateSnapshotId)).json().error.code,
    ).toBe('VERSION_CONFLICT');
    expect(
      (await h.adopt(owner, old, p.json<RoutePreviewView>())).json().error.code,
    ).toBe('VERSION_CONFLICT');
    for (const role of ['USER', 'ADMIN'] as const) {
      const other = await h.identity(role);
      expect((await h.get(other, `/trips/${trip.id}`)).statusCode).toBe(404);
      expect(
        (await h.preview(other, old, c.candidateSnapshotId)).statusCode,
      ).toBe(404);
    }
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
});
