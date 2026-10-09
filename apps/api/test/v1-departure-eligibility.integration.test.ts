import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdoptRoutePreviewResponse,
  TripView,
  RoutePreviewView,
  RouteQueryResponse,
} from '@travel/contracts';
import {
  hashRouteAdoptionRequest,
  type RouteProviderResult,
} from '@travel/application';
import { PrismaRoutePlanningRepository } from '@travel/persistence';
import { baiduToWgs84 } from '@travel/providers';
import {
  footprint,
  gate,
  waitForOwnerLock,
  onlyWrites,
  replanningHarness,
  type SyntheticOwner,
} from './helpers/replanning-acceptance.js';
// RWS-02 transplanted from qa/v1-travel-scenarios @ 67c7fdc5fc2b5d89f58f7fc8532529af6bbf59cb.
// Original two acceptance assertions and full database footprint checks retained.
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
describe('V1 RWS-02 departure eligibility — SYNTHETIC Provider + real PostgreSQL', () => {
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
    const root = '../../docs/status/assets/v1-departed-route-guard/after';
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
  async function prepared(trip: TripView) {
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
    const candidate = q.json<RouteQueryResponse>().candidates[0]!;
    const p = await h.preview(owner, trip, candidate.candidateSnapshotId);
    expect(p.statusCode, p.body).toBe(201);
    expect(p.json<RoutePreviewView>().adoptable).toBe(true);
    return { candidate, preview: p.json<RoutePreviewView>() };
  }
  it('expired departure rejects both new Preview and readonly Preview retrieval, without writes', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    const { candidate, preview } = await prepared(trip);
    h.setNow(new Date('2026-10-10T10:05:00Z'));
    const before = await footprint(h.managed, trip.id);
    const created = await h.preview(owner, trip, candidate.candidateSnapshotId);
    const retrieved = await h.get(
      owner,
      `/trips/${trip.id}/previews/${preview.previewId}`,
    );
    for (const r of [created, retrieved]) {
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe('PREVIEW_STALE');
    }
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it('Query samples time after slow Provider I/O, not only before the request', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    h.setResult(transit(trip, depart));
    const arrived = gate(),
      release = gate();
    h.setProviderHook(async () => {
      arrived.release();
      await release.pending;
    });
    const before = await footprint(h.managed, trip.id);
    const request = query(trip, 'TRANSIT');
    await arrived.pending;
    h.setNow(new Date('2026-10-10T10:05:00Z'));
    release.release();
    const r = await request;
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error.code).toBe('NO_MATCHING_CANDIDATE');
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it.each(['query', 'preview', 'adopt'] as const)(
    '%s rechecks after waiting for the owner transaction lock',
    async (phase) => {
      const trip = await confirmStillAtOrigin(await seed());
      const { candidate, preview } = await prepared(trip);
      const before = await footprint(h.managed, trip.id);
      const locked = gate(),
        release = gate();
      const holder = h.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${owner.id}, 2))`;
          locked.release();
          await release.pending;
        },
        { timeout: 15000 },
      );
      await locked.pending;
      const request =
        phase === 'query'
          ? query(trip, 'TRANSIT')
          : phase === 'preview'
            ? h.preview(owner, trip, candidate.candidateSnapshotId)
            : h.adopt(owner, trip, preview);
      try {
        await waitForOwnerLock(h.managed, 1);
        h.setNow(new Date('2026-10-10T10:05:00Z'));
        release.release();
        const r = await request;
        expect(r.statusCode, r.body).toBe(phase === 'query' ? 404 : 409);
        expect(r.json().error.code).toBe(
          phase === 'query' ? 'NO_MATCHING_CANDIDATE' : 'PREVIEW_STALE',
        );
        onlyWrites(before, await footprint(h.managed, trip.id));
      } finally {
        release.release();
        await holder;
        await request;
      }
    },
  );
  it('Adopt rechecks after waiting for the Trip row lock', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    const { preview } = await prepared(trip);
    const before = await footprint(h.managed, trip.id);
    const locked = gate(),
      release = gate();
    const holder = h.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Trip" WHERE id=${trip.id}::uuid FOR UPDATE`;
        locked.release();
        await release.pending;
      },
      { timeout: 15000 },
    );
    await locked.pending;
    const request = h.adopt(owner, trip, preview);
    try {
      // Observe the actual row-lock waiter rather than relying on a fixed sleep.
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await h.client.$queryRaw<{ count: number }[]>`
          SELECT count(*)::integer AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND position('FOR UPDATE' in query)>0 AND pid<>pg_backend_pid()`;
        if (rows[0]!.count > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      h.setNow(new Date('2026-10-10T10:05:00Z'));
      release.release();
      const r = await request;
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe('PREVIEW_STALE');
      onlyWrites(before, await footprint(h.managed, trip.id));
    } finally {
      release.release();
      await holder;
      await request;
    }
  });
  it('crossing departure during tentative Adopt writes rolls back every official table', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    const { preview } = await prepared(trip);
    const before = await footprint(h.managed, trip.id);
    const extraFootprint = () =>
      h.client.$transaction(
        async (tx) => ({
          places: await tx.place.findMany({
            where: { ownerUserId: owner.id },
            orderBy: { id: 'asc' },
          }),
          ground: await tx.groundTransitLegExecution.findMany({
            where: { tripId: trip.id },
            include: { observations: true, stateTransitions: true },
            orderBy: { id: 'asc' },
          }),
          projections: await tx.transportDayProjection.findMany({
            where: { tripId: trip.id },
            orderBy: { id: 'asc' },
          }),
          history: await tx.transportEdgeHistory.findMany({
            where: { tripId: trip.id },
            include: { temporalValues: true },
            orderBy: { id: 'asc' },
          }),
        }),
        { isolationLevel: 'RepeatableRead' },
      );
    const extraBefore = await extraFootprint();
    let samples = 0;
    const repo = new PrismaRoutePlanningRepository(h.client, {
      now: () =>
        new Date(
          ++samples === 1 ? '2026-10-10T09:59:00Z' : '2026-10-10T10:05:00Z',
        ),
    });
    const r = await repo.adoptPreview({
      ownerUserId: owner.id,
      tripId: trip.id,
      previewId: preview.previewId,
      baseTripVersion: trip.version,
      idempotencyKey: randomUUID(),
      requestHash: hashRouteAdoptionRequest({
        tripId: trip.id,
        previewId: preview.previewId,
        baseTripVersion: trip.version,
        acceptedUserAdjustments: [],
      }),
      acceptedUserAdjustments: [],
      now: new Date('2026-10-10T09:59:00Z'),
      undoExpiresAt: new Date('2026-10-10T10:09:00Z'),
    });
    expect(await extraFootprint()).toEqual(extraBefore);
    expect(samples).toBe(2);
    expect(r.status).toBe('PREVIEW_STALE');
    onlyWrites(before, await footprint(h.managed, trip.id));
  });
  it('successful pre-departure Adopt can replay after departure and still Undo in its original window', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    const { preview } = await prepared(trip);
    const key = randomUUID();
    const first = await h.adopt(owner, trip, preview, key);
    expect(first.statusCode, first.body).toBe(200);
    const accepted = first.json<AdoptRoutePreviewResponse>();
    h.setNow(new Date('2026-10-10T10:05:00Z'));
    const before = await footprint(h.managed, trip.id);
    const replay = await h.adopt(owner, trip, preview, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json<AdoptRoutePreviewResponse>().operationReceipt).toEqual(
      accepted.operationReceipt,
    );
    onlyWrites(before, await footprint(h.managed, trip.id));
    const undo = await h.undo(owner, accepted);
    expect(undo.statusCode, undo.body).toBe(200);
    const after = await footprint(h.managed, trip.id);
    expect(after.trip.version).toBe(accepted.trip.version + 1);
    expect(after.execution).toEqual(before.execution);
    expect(after.edges).toHaveLength(0);
  });
  it('historical planning after the Trip period can Query, Preview, Adopt and Undo', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    h.setNow(new Date('2026-10-11T10:05:00Z'));
    const { preview } = await prepared(trip);
    const first = await h.adopt(owner, trip, preview);
    expect(first.statusCode, first.body).toBe(200);
    const undo = await h.undo(owner, first.json<AdoptRoutePreviewResponse>());
    expect(undo.statusCode, undo.body).toBe(200);
  });
  it('aggregate non-fixed TRANSIT is not rejected as an already-departed scheduled bus', async () => {
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
        legs: c.legs.map((leg) => ({
          ...leg,
          mode: 'TRANSIT' as const,
          fixedService: false,
          serviceLabel: 'SYNTHETIC aggregate estimate',
        })),
      })),
    });
    const q = await query(trip, 'TRANSIT');
    expect(q.statusCode, q.body).toBe(200);
    const p = await h.preview(
      owner,
      trip,
      q.json<RouteQueryResponse>().candidates[0]!.candidateSnapshotId,
    );
    expect(p.statusCode, p.body).toBe(201);
    const a = await h.adopt(owner, trip, p.json<RoutePreviewView>());
    expect(a.statusCode, a.body).toBe(200);
    const after = await footprint(h.managed, trip.id);
    expect(after.execution).toHaveLength(1);
    expect(after.edges[0]!.fixedService).toBe(false);
  });
  it('owner isolation and version conflict retain priority at a departed Preview', async () => {
    const trip = await confirmStillAtOrigin(await seed());
    const { preview } = await prepared(trip);
    const stranger = await h.identity();
    h.setNow(new Date('2026-10-10T10:05:00Z'));
    const before = await footprint(h.managed, trip.id);
    const read = await h.get(
      stranger,
      `/trips/${trip.id}/previews/${preview.previewId}`,
    );
    const write = await h.adopt(stranger, trip, preview);
    expect(read.statusCode, read.body).toBe(404);
    expect(write.statusCode, write.body).toBe(404);
    onlyWrites(before, await footprint(h.managed, trip.id));
    await h.note(owner, trip);
    const afterNote = await footprint(h.managed, trip.id);
    const staleVersion = await h.adopt(owner, trip, preview);
    expect(staleVersion.statusCode, staleVersion.body).toBe(409);
    expect(staleVersion.json().error.code).toBe('VERSION_CONFLICT');
    onlyWrites(afterNote, await footprint(h.managed, trip.id));
  });
});
