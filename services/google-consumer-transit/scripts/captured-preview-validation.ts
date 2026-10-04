// CAPTURED_LIVE_REPLAY acceptance, not a fresh sidecar/Google request.
// Synthetic accounts/Trip; original Google observations/clocks are retained.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { buildApi } from '../../../apps/api/src/app.js';
import {
  AuthService,
  digestOpaqueToken,
  TripService,
  RouteQueryService,
  RoutePreviewService,
  RouteAdoptionService,
  RouteUndoService,
} from '@travel/application';
import {
  createPrismaClient,
  createPostgresReadiness,
  PrismaAuthRepository,
  PrismaTripRepository,
  PrismaRoutePlanningRepository,
} from '@travel/persistence';
import type {
  NormalizedRouteCandidate,
  RouteCandidateLeg,
  RouteFare,
} from '@travel/domain';
import type {
  TripView,
  RouteQueryResponse,
  RoutePreviewView,
  AdoptRoutePreviewResponse,
  UndoRouteAdoptionResponse,
} from '@travel/contracts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const path = process.env.GOOGLE_TRANSIT_CAPTURED_EVIDENCE;
if (
  !databaseUrl ||
  !path ||
  process.env.GOOGLE_TRANSIT_CAPTURED_ACK !==
    'isolated-captured-candidate-acceptance'
)
  throw new Error(
    'Explicit captured acceptance acknowledgement and dedicated database/evidence required',
  );
const db = new URL(databaseUrl);
if (db.hostname !== '127.0.0.1' || !db.pathname.endsWith('_google_live_test'))
  throw new Error('Dedicated loopback test database only');
type CapturedCandidate = {
  id: string;
  departure: string;
  arrival: string;
  durationSeconds: number;
  fare: RouteFare | null;
  legs: (Omit<RouteCandidateLeg, 'departure' | 'arrival' | 'providerRef'> & {
    departure: string | null;
    arrival: string | null;
  })[];
};
const evidence = JSON.parse(await readFile(path, 'utf8')) as {
  summaries: {
    scenario: string;
    status: string;
    query: import('../src/contract.js').Query;
    fetchedAt: string;
    candidates: CapturedCandidate[];
  }[];
};
const captured = evidence.summaries.filter(
  (s: { scenario: string; status: string }) =>
    s.scenario === 'tokyo' && s.status === 'SUCCESS',
);
assert.equal(captured.length, 2);
const managed = createPrismaClient(databaseUrl);
const readiness = createPostgresReadiness(databaseUrl);
const trips = new PrismaTripRepository(managed.client);
const planning = new PrismaRoutePlanningRepository(managed.client);
const tripService = new TripService(trips);
let replayReads = 0;
const timePoint = (iso: string) => ({
  instant: new Date(iso),
  timeZone: 'Asia/Tokyo',
});
const api = buildApi({
  readinessProbe: readiness.probe,
  authService: new AuthService(new PrismaAuthRepository(managed.client), {
    magicLinkLandingUrl: 'http://127.0.0.1/login/magic',
    magicLinkTtlSeconds: 600,
    sessionTtlSeconds: 3600,
    invitationTtlSeconds: 3600,
    rateLimitWindowSeconds: 300,
    rateLimitMaxRequests: 5,
    defaultBaseCurrency: 'JPY',
    defaultUiLanguage: 'zh-CN',
    jobMaxAttempts: 3,
  }),
  tripService,
  routeQueryService: new RouteQueryService(
    trips,
    {
      queryRoutes: async (input) => {
        replayReads++;
        if (input.preference.type === 'NONE')
          throw new Error('Explicit captured mode required');
        const source = captured.find(
          (s: { query: { timeMode: string } }) =>
            s.query.timeMode === input.preference.type,
        );
        assert(source);
        assert.equal(
          input.preference.instant.toISOString(),
          new Date(
            `${source.query.date}T${source.query.time}:00+09:00`,
          ).toISOString(),
        );
        const candidates: NormalizedRouteCandidate[] = source.candidates.map(
          (c: CapturedCandidate) => ({
            candidateId: c.id,
            provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
            providerCandidateRef: c.id.replace(
              'GOOGLE_CONSUMER_EXPERIMENTAL:',
              '',
            ),
            observedAt: new Date(source.fetchedAt),
            validUntil: null,
            departure: timePoint(c.departure),
            arrival: timePoint(c.arrival),
            durationSeconds: c.durationSeconds,
            fare: c.fare,
            legs: c.legs.map((l, legIndex) => ({
              ...l,
              providerRef: `${c.id.replace('GOOGLE_CONSUMER_EXPERIMENTAL:', '')}:leg:${legIndex}`,
              departure: l.departure ? timePoint(l.departure) : null,
              arrival: l.arrival ? timePoint(l.arrival) : null,
            })),
          }),
        );
        return { status: 'SUCCESS', candidates };
      },
    },
    planning,
    { candidateSnapshotTtlSeconds: 900 },
  ),
  routePreviewService: new RoutePreviewService(trips, planning, {
    previewTtlSeconds: 600,
  }),
  routeAdoptionService: new RouteAdoptionService(planning, tripService, {
    undoWindowSeconds: 600,
  }),
  routeUndoService: new RouteUndoService(planning, tripService),
});
const address = await api.listen({ host: '127.0.0.1', port: 0 });
const summaries = [];
try {
  for (const source of captured) {
    const token = randomBytes(32).toString('hex');
    const email = `synthetic-captured-${randomUUID()}@synthetic.example.test`;
    await managed.client.user.create({
      data: {
        email,
        normalizedEmail: email,
        role: 'USER',
        preference: { create: { baseCurrency: 'JPY', uiLanguage: 'zh-CN' } },
        sessions: {
          create: {
            tokenDigest: digestOpaqueToken(token),
            expiresAt: new Date(Date.now() + 3600000),
          },
        },
      },
    });
    const request = async <T>(
      route: string,
      body: unknown,
      status: number,
    ): Promise<T> => {
      const response = await fetch(new URL(route, address), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value));
      return value as T;
    };
    let trip = await request<TripView>(
      '/trips',
      {
        name: `SYNTHETIC CAPTURED_LIVE_REPLAY ${source.query.timeMode}`,
        planningAnchorDate: source.query.date,
        defaultPeopleCount: 1,
      },
      201,
    );
    for (const [position, location] of [
      source.query.origin,
      source.query.destination,
    ].entries())
      trip = await request<TripView>(
        `/trips/${trip.id}/commands`,
        {
          baseTripVersion: trip.version,
          command: {
            type: 'ADD_PLACE_VISIT',
            targetDay:
              position === 0
                ? { type: 'NEW', localDate: source.query.date, sequence: 0 }
                : {
                    type: 'EXISTING',
                    dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
                  },
            position,
            place: {
              type: 'CUSTOM',
              name: location.label,
              latitude: location.latitude,
              longitude: location.longitude,
            },
          },
        },
        200,
      );
    const beforeReads = replayReads;
    const queried = await request<RouteQueryResponse>(
      `/trips/${trip.id}/routes/query`,
      {
        basisVersion: trip.version,
        fromNodeId: trip.days[0]!.nodes[0]!.id,
        toNodeId: trip.days[0]!.nodes[1]!.id,
        hint: {
          type: source.query.timeMode,
          instant: `${source.query.date}T${source.query.time}:00+09:00`,
          timeZone: 'Asia/Tokyo',
        },
      },
      200,
    );
    assert.equal(queried.candidates.length, source.candidates.length);
    const candidate = queried.candidates[0]!;
    const snapshot =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: { id: candidate.candidateSnapshotId },
      });
    assert.equal(snapshot.observedAt.toISOString(), source.fetchedAt);
    const preview = await request<RoutePreviewView>(
      `/trips/${trip.id}/previews`,
      {
        basisVersion: trip.version,
        candidateSnapshotId: candidate.candidateSnapshotId,
      },
      201,
    );
    assert.equal(preview.adoptable, true);
    const afterPreview = await request<TripView>(
      `/trips/${trip.id}`,
      undefined,
      200,
    );
    assert.deepEqual(afterPreview, trip);
    const adopted = await request<AdoptRoutePreviewResponse>(
      `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
      {
        baseTripVersion: trip.version,
        idempotencyKey: `synthetic-captured-adopt-${randomUUID()}`,
      },
      200,
    );
    assert.equal(adopted.trip.version, trip.version + 1);
    const undone = await request<UndoRouteAdoptionResponse>(
      `/trips/${trip.id}/operations/${adopted.operationReceipt.id}/undo`,
      {
        baseTripVersion: adopted.trip.version,
        idempotencyKey: `synthetic-captured-undo-${randomUUID()}`,
      },
      200,
    );
    assert.equal(undone.trip.version, trip.version + 2);
    assert.equal(undone.trip.days[0]!.nodes.length, 2);
    assert.equal(replayReads, beforeReads + 1);
    assert.equal(
      await managed.client.executionEvent.count({ where: { tripId: trip.id } }),
      0,
    );
    summaries.push({
      mode: source.query.timeMode,
      status: 'PASS',
      kind: 'CAPTURED_LIVE_REPLAY',
      originalFetchedAt: source.fetchedAt,
      candidates: queried.candidates.length,
      previewAdoptable: true,
      adoptVersion: adopted.trip.version,
      undoVersion: undone.trip.version,
      googleCalls: 0,
      replayReads: 1,
    });
  }
  console.log(JSON.stringify({ kind: 'CAPTURED_LIVE_REPLAY', summaries }));
  await writeFile(
    '/tmp/google-captured-preview-evidence.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        kind: 'CAPTURED_LIVE_REPLAY',
        summaries,
      },
      null,
      2,
    ),
  );
} finally {
  await api.close();
  await managed.close();
  await readiness.close();
}
