import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  RoutePreviewView,
  RouteQueryResponse,
  TripView,
} from '@travel/contracts';
import { adoptionFootprint } from './helpers/adoption-evidence-ttl.js';
import {
  replanningHarness,
  type SyntheticOwner,
} from './helpers/replanning-acceptance.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('SYNTHETIC calendar regression requires isolated PostgreSQL');
const scenarios = [
  {
    name: 'Tokyo date differs from UTC',
    zone: 'Asia/Tokyo',
    departure: '2030-09-30T15:59:00Z',
    now: '2030-09-30T16:01:00Z',
  },
  {
    name: 'Tokyo midnight carry-over',
    zone: 'Asia/Tokyo',
    departure: '2030-09-30T14:59:00Z',
    now: '2030-09-30T15:01:00Z',
  },
  {
    name: 'UTC midnight carry-over',
    zone: 'UTC',
    departure: '2030-09-30T23:59:00Z',
    now: '2030-10-01T00:01:00Z',
  },
  {
    name: 'after UTC midnight in Tokyo',
    zone: 'Asia/Tokyo',
    departure: '2030-10-01T00:00:00Z',
    now: '2030-10-01T00:01:00Z',
  },
] as const;
type Scenario = (typeof scenarios)[number];
const localDate = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

describe('P5E2 departure calendar — SYNTHETIC + real PostgreSQL', () => {
  let h: ReturnType<typeof replanningHarness>;
  let owner: SyntheticOwner;
  beforeEach(async () => {
    h = replanningHarness(databaseUrl);
    owner = await h.identity();
  });
  afterEach(async () => {
    await h.close();
  });
  async function fixture(s: Scenario, fixed = true, execution = true) {
    const departure = new Date(s.departure);
    const arrival = new Date(departure.getTime() + 30 * 60_000);
    const confirmed = new Date(departure.getTime() - 60_000);
    h.setNow(confirmed);
    const create = await h.post(owner, '/trips', {
      name: 'SYNTHETIC UTC/Tokyo calendar',
      planningAnchorDate: localDate(departure, s.zone),
      defaultPeopleCount: 1,
    });
    expect(create.statusCode, create.body).toBe(201);
    let trip = create.json<TripView>();
    for (let i = 0; i < 2; i++) {
      const date = localDate(i === 0 ? departure : arrival, s.zone);
      const existing = trip.days.find((d) => d.localDate === date);
      const result = await h.post(owner, `/trips/${trip.id}/commands`, {
        baseTripVersion: trip.version,
        command: {
          type: 'ADD_PLACE_VISIT',
          position: existing ? 1 : 0,
          targetDay: existing
            ? { type: 'EXISTING', dayOccurrenceId: existing.dayOccurrenceId }
            : { type: 'NEW', localDate: date, sequence: i },
          place: {
            type: 'CUSTOM',
            name: `SYNTHETIC ${i}`,
            latitude: 35.6762 + i * 0.01,
            longitude: 139.6503 + i * 0.01,
          },
        },
      });
      expect(result.statusCode, result.body).toBe(200);
      trip = result.json<TripView>();
    }
    const nodes = trip.days.flatMap((d) => d.nodes);
    if (execution) {
      const result = await h.post(owner, `/trips/${trip.id}/execution/events`, {
        baseTripVersion: trip.version,
        idempotencyKey: randomUUID(),
        type: 'MANUAL_ARRIVAL',
        nodeId: nodes[0]!.id,
        occurredAt: confirmed.toISOString(),
      });
      expect(result.statusCode, result.body).toBe(200);
      trip = (await h.get(owner, `/trips/${trip.id}`)).json<TripView>();
      const value = await h.client.temporalValue.findFirstOrThrow({
        where: {
          nodeId: nodes[0]!.id,
          sourceRef: `execution-event:${result.json().event.id}`,
        },
      });
      expect(value.timeZone).toBe('UTC'); // Event serialization stays unchanged.
      const state = (await h.get(owner, `/trips/${trip.id}/in-trip`)).json()
        .execution;
      expect(state).toMatchObject({
        state: 'AT_NODE',
        currentNodeId: nodes[0]!.id,
      });
    }
    const point = (i: number) => ({
      name: nodes[i]!.place!.name,
      latitude: nodes[i]!.place!.latitude,
      longitude: nodes[i]!.place!.longitude,
      providerPlaceRef: null,
    });
    const time = (instant: Date) => ({ instant, timeZone: s.zone });
    h.setResult({
      status: 'SUCCESS',
      candidates: [
        {
          candidateId: 'SYNTHETIC calendar',
          provider: 'SYNTHETIC',
          providerCandidateRef: null,
          observedAt: confirmed,
          validUntil: null,
          departure: time(departure),
          arrival: time(arrival),
          durationSeconds: 1800,
          fare: null,
          legs: [
            {
              mode: fixed
                ? s.name.includes('carry-over')
                  ? 'RAIL'
                  : 'BUS'
                : 'TRANSIT',
              from: point(0),
              to: point(1),
              departure: time(departure),
              arrival: time(arrival),
              durationSeconds: 1800,
              fixedService: fixed,
              serviceLabel: 'SYNTHETIC',
              providerRef: null,
            },
          ],
        },
      ],
    });
    const query = () =>
      h.post(owner, `/trips/${trip.id}/routes/query`, {
        basisVersion: trip.version,
        fromNodeId: nodes[0]!.id,
        toNodeId: nodes[1]!.id,
        travelMode: 'TRANSIT',
        hint: { type: 'DEPART_AT', instant: s.departure, timeZone: s.zone },
      });
    return { trip, query };
  }
  for (const s of scenarios) {
    for (const phase of ['Query', 'Preview', 'Adopt'] as const) {
      it(`${s.name}: ${phase} rejects elapsed fixed service with zero writes`, async () => {
        const { trip, query } = await fixture(s);
        let snapshot: string | undefined;
        let preview: RoutePreviewView | undefined;
        if (phase !== 'Query') {
          const q = await query();
          expect(q.statusCode, q.body).toBe(200);
          snapshot =
            q.json<RouteQueryResponse>().candidates[0]!.candidateSnapshotId;
          if (phase === 'Adopt') {
            const p = await h.preview(owner, trip, snapshot);
            expect(p.statusCode, p.body).toBe(201);
            preview = p.json<RoutePreviewView>();
            expect(preview.adoptable).toBe(true);
            expect(Date.parse(preview.expiresAt)).toBeGreaterThan(
              Date.parse(s.now),
            );
          }
        }
        h.setNow(new Date(s.now));
        const before = await adoptionFootprint(h.managed, trip.id, owner.id);
        const result =
          phase === 'Query'
            ? await query()
            : phase === 'Preview'
              ? await h.preview(owner, trip, snapshot!)
              : await h.adopt(owner, trip, preview!);
        const after = await adoptionFootprint(h.managed, trip.id, owner.id);
        const evidencePhase = process.env.P5E2_EVIDENCE_PHASE ?? 'after';
        if (!['before', 'after'].includes(evidencePhase))
          throw new Error('Invalid evidence phase');
        const root = new URL(
          `../../../docs/status/assets/p5e2-departure-calendar/${evidencePhase}/`,
          import.meta.url,
        );
        await mkdir(root, { recursive: true });
        await writeFile(
          new URL(`${s.name.replaceAll(' ', '-')}-${phase}.json`, root),
          JSON.stringify(
            {
              synthetic: true,
              ...s,
              phase,
              expectedStatus: phase === 'Query' ? 404 : 409,
              actualStatus: result.statusCode,
              error: result.json().error?.code ?? null,
              beforeVersion: before.trip.version,
              afterVersion: after.trip.version,
              completeDatabaseFootprintUnchanged:
                JSON.stringify(before) === JSON.stringify(after),
              serializedExecutionTimeZone: 'UTC',
            },
            null,
            2,
          ) + '\n',
        );
        expect(result.statusCode, result.body).toBe(
          phase === 'Query' ? 404 : 409,
        );
        expect(result.json().error.code).toBe(
          phase === 'Query' ? 'NO_MATCHING_CANDIDATE' : 'PREVIEW_STALE',
        );
        expect(after).toEqual(before);
      });
    }
  }
  it.each([
    'aggregate TRANSIT',
    'historical planning',
    'history with old manual facts',
  ] as const)(
    '%s still supports Query → Preview → Adopt → Undo',
    async (kind) => {
      const s = scenarios[0];
      const { trip, query } = await fixture(
        s,
        kind !== 'aggregate TRANSIT',
        kind !== 'historical planning',
      );
      h.setNow(
        new Date(
          kind === 'history with old manual facts'
            ? '2030-10-02T01:00:00Z'
            : s.now,
        ),
      );
      const q = await query();
      expect(q.statusCode, q.body).toBe(200);
      const p = await h.preview(
        owner,
        trip,
        q.json<RouteQueryResponse>().candidates[0]!.candidateSnapshotId,
      );
      expect(p.statusCode, p.body).toBe(201);
      const a = await h.adopt(owner, trip, p.json<RoutePreviewView>());
      expect(a.statusCode, a.body).toBe(200);
      const u = await h.undo(owner, a.json());
      expect(u.statusCode, u.body).toBe(200);
    },
  );
});
