import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
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
// I59-01: preserved independent audit regressions for integration HEAD
// 9a477ee4998424e45363be998c1e4e807f0490dd. All eight cases and assertions
// reused from /workspace/scratch/v1-integration-audit-59/independent.integration.test.ts.
// Four failures are intentional on this QA baseline; no production fix is included.
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
describe('Independent AUDIT59 — SYNTHETIC + real PostgreSQL', () => {
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

  async function shortLivedAggregate(fixed: boolean) {
    const trip = await confirmStillAtOrigin(await seed());
    const result = transit(trip, depart);
    if (result.status !== 'SUCCESS') throw new Error('SYNTHETIC fixture');
    h.setResult({
      ...result,
      candidates: result.candidates.map((c) => ({
        ...c,
        observedAt: new Date('2026-10-10T09:59:00Z'),
        validUntil: new Date('2026-10-10T09:59:02Z'),
        legs: c.legs.map((l) =>
          fixed
            ? l
            : {
                ...l,
                mode: 'TRANSIT' as const,
                fixedService: false,
                serviceLabel: null,
              },
        ),
      })),
    });
    const q = await query(trip, 'TRANSIT');
    expect(q.statusCode, q.body).toBe(200);
    const candidate = q.json<RouteQueryResponse>().candidates[0]!;
    const p = await h.preview(owner, trip, candidate.candidateSnapshotId);
    expect(p.statusCode, p.body).toBe(201);
    const preview = p.json<RoutePreviewView>();
    expect(preview.expiresAt).toBe('2026-10-10T09:59:02.000Z');
    expect(preview.adoptable).toBe(true);
    return { trip, candidate, preview };
  }
  async function auditEvidence(
    name: string,
    before: Awaited<ReturnType<typeof footprint>>,
    after: typeof before,
    status: number | string,
  ) {
    const counts = (f: typeof before) => ({
      tripVersion: f.trip.version,
      ...Object.fromEntries(
        Object.entries(f)
          .filter(([k]) => k !== 'trip')
          .map(([k, v]) => [k, Array.isArray(v) ? v.length : null]),
      ),
    });
    const outcome = {
      synthetic: true,
      targetHead: '9a477ee4998424e45363be998c1e4e807f0490dd',
      evidenceExpiresAt: '2026-10-10T09:59:02.000Z',
      requestTime: '2026-10-10T09:59:01.000Z',
      lockedTime: '2026-10-10T09:59:03.000Z',
      status,
      footprintUnchanged: JSON.stringify(before) === JSON.stringify(after),
      before: counts(before),
      after: counts(after),
    };
    const evidenceRoot = new URL(
      '../../../docs/status/assets/i59-adoption-ttl-race/rerun/',
      import.meta.url,
    );
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(
      new URL(`${name}.json`, evidenceRoot),
      JSON.stringify(outcome, null, 2) + '\n',
    );
    return outcome;
  }
  for (const fixed of [false, true]) {
    it(`AUDIT59 ${fixed ? 'fixed BUS' : 'aggregate TRANSIT'} TTL already expired before request refuses Adopt with zero writes`, async () => {
      const { trip, preview } = await shortLivedAggregate(fixed);
      h.setNow(new Date('2026-10-10T09:59:03Z'));
      const before = await footprint(h.managed, trip.id);
      const response = await h.adopt(owner, trip, preview);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe('PREVIEW_STALE');
      onlyWrites(before, await footprint(h.managed, trip.id));
    });
    it(`AUDIT59 ${fixed ? 'fixed BUS' : 'aggregate TRANSIT'} completed receipt replay after TTL expiration is zero-write`, async () => {
      const { trip, preview } = await shortLivedAggregate(fixed);
      h.setNow(new Date('2026-10-10T09:59:01Z'));
      const key = randomUUID();
      const first = await h.adopt(owner, trip, preview, key);
      expect(first.statusCode, first.body).toBe(200);
      h.setNow(new Date('2026-10-10T09:59:03Z'));
      const before = await footprint(h.managed, trip.id);
      const response = await h.adopt(owner, trip, preview, key);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().operationReceipt).toEqual(
        first.json().operationReceipt,
      );
      onlyWrites(before, await footprint(h.managed, trip.id));
    });
    it(`AUDIT59 ${fixed ? 'fixed BUS' : 'aggregate TRANSIT'} expired Provider/Preview evidence during owner lock wait cannot authorize new Adopt`, async () => {
      const { trip, preview } = await shortLivedAggregate(fixed);
      h.setNow(new Date('2026-10-10T09:59:01Z'));
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
      const request = h.adopt(owner, trip, preview);
      try {
        await waitForOwnerLock(h.managed, 1);
        h.setNow(new Date('2026-10-10T09:59:03Z'));
        release.release();
        const response = await request;
        const outcome = await auditEvidence(
          `adopt-expired-during-lock-${fixed ? 'fixed' : 'aggregate'}`,
          before,
          await footprint(h.managed, trip.id),
          response.statusCode,
        );
        expect({
          httpStatus: outcome.status,
          footprintUnchanged: outcome.footprintUnchanged,
        }).toEqual({ httpStatus: 409, footprintUnchanged: true });
      } finally {
        release.release();
        await holder;
        await request;
      }
    });
    it(`AUDIT59 ${fixed ? 'fixed BUS' : 'aggregate TRANSIT'} Provider/Preview TTL crossing during tentative writes must roll back new Adopt`, async () => {
      const { trip, preview } = await shortLivedAggregate(fixed);
      const before = await footprint(h.managed, trip.id);
      let samples = 0;
      const repo = new PrismaRoutePlanningRepository(h.client, {
        now: () =>
          new Date(
            ++samples === 1 ? '2026-10-10T09:59:01Z' : '2026-10-10T09:59:03Z',
          ),
      });
      const result = await repo.adoptPreview({
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
        now: new Date('2026-10-10T09:59:01Z'),
        undoExpiresAt: new Date('2026-10-10T10:09:01Z'),
      });
      const outcome = await auditEvidence(
        `adopt-expired-during-writes-${fixed ? 'fixed' : 'aggregate'}`,
        before,
        await footprint(h.managed, trip.id),
        result.status,
      );
      expect(samples).toBe(2);
      expect({
        status: outcome.status,
        footprintUnchanged: outcome.footprintUnchanged,
      }).toEqual({ status: 'PREVIEW_STALE', footprintUnchanged: true });
    });
  }
});
