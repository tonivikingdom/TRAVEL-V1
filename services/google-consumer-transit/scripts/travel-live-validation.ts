import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
  TripView,
  RouteQueryResponse,
  RoutePreviewView,
  AdoptRoutePreviewResponse,
  UndoRouteAdoptionResponse,
} from '@travel/contracts';
import { GoogleConsumerExperimentalRouteProvider } from '@travel/providers';
import { readConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { SearchResult } from '../src/contract.js';
import { observeLiveBrowser } from './live-browser-observer.js';

if (
  process.env.GOOGLE_TRANSIT_LIVE_ACK !== 'personal-development' ||
  process.env.GOOGLE_TRANSIT_LIVE_ADOPT_ACK !== 'isolated-test-adopt-and-undo'
)
  throw new Error(
    'Explicit personal-development and isolated test Adopt/Undo acknowledgement required',
  );
if (
  process.env.GOOGLE_TRANSIT_LIVE_MODES &&
  process.env.GOOGLE_TRANSIT_LIVE_MODES !== 'ARRIVE_BY'
)
  throw new Error('Optional GOOGLE_TRANSIT_LIVE_MODES only accepts ARRIVE_BY');
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('An isolated TEST_DATABASE_URL is required');
const database = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) ||
  !database.pathname.endsWith('_google_live_test')
)
  throw new Error(
    'Use a dedicated loopback database with name ending _google_live_test; no resets are performed',
  );
const date = process.env.GOOGLE_TRANSIT_LIVE_DATE;
if (!date) throw new Error('Explicit GOOGLE_TRANSIT_LIVE_DATE required');
const runStartedAt = new Date().toISOString();
const browserObservation = observeLiveBrowser();
const managed = createPrismaClient(databaseUrl);
const readiness = createPostgresReadiness(databaseUrl);
const token = randomBytes(32).toString('hex');
const sidecar = buildServer(
  readConfig({
    ...process.env,
    APP_ENV: process.env.APP_ENV ?? 'test',
    ENABLE_GOOGLE_CONSUMER_TRANSIT: 'true',
    LOCAL_TRANSIT_API_TOKEN: token,
  }),
);
const sidecarAddress = await sidecar.listen({ host: '127.0.0.1', port: 0 });
let providerHttpCalls = 0;
let lastSidecarError: string | undefined;
let lastSidecarResponse: SearchResult | undefined;
const provider = new GoogleConsumerExperimentalRouteProvider({
  baseUrl: sidecarAddress,
  token,
  timeoutMs: 60000,
  fetchImplementation: async (url, init) => {
    providerHttpCalls++;
    const response = await fetch(url, init);
    const body = (await response.clone().json()) as SearchResult & {
      error?: { code: string; stage?: string };
    };
    lastSidecarError = body.error
      ? `${body.error.code}:${body.error.stage ?? 'unknown-stage'}`
      : undefined;
    lastSidecarResponse = body.status === 'OK' ? body : undefined;
    return response;
  },
});
const trips = new PrismaTripRepository(managed.client);
const planning = new PrismaRoutePlanningRepository(managed.client);
const tripService = new TripService(trips);
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
  routeQueryService: new RouteQueryService(trips, provider, planning, {
    candidateSnapshotTtlSeconds: 900,
  }),
  routePreviewService: new RoutePreviewService(trips, planning, {
    previewTtlSeconds: 600,
  }),
  routeAdoptionService: new RouteAdoptionService(planning, tripService, {
    undoWindowSeconds: 600,
  }),
  routeUndoService: new RouteUndoService(planning, tripService),
});
const apiAddress = await api.listen({ host: '127.0.0.1', port: 0 });
let credential = '';
async function post<T>(
  path: string,
  body: unknown,
  status: number,
): Promise<T> {
  const response = await fetch(new URL(path, apiAddress), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T;
  if (response.status !== status) {
    const error = (data as { error?: { code: string; stage?: string } }).error;
    throw new Error(
      `Travel HTTP ${response.status} ${path.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g, ':id')} ${error?.code ?? 'UNKNOWN'} ${lastSidecarError ?? ''}`,
    );
  }
  return data;
}
const summaries: unknown[] = [];
// Ignore version and audit update timestamps. Plan facts and original
// identities, including nodes/connections/saved routes, must be restored.
function planState(trip: TripView): unknown {
  return JSON.parse(
    JSON.stringify(trip, (key, value) =>
      key === 'version' || key === 'updatedAt' ? undefined : value,
    ),
  ) as unknown;
}
async function readTrip(tripId: string): Promise<TripView> {
  const response = await fetch(new URL(`/trips/${tripId}`, apiAddress), {
    headers: { authorization: `Bearer ${credential}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as TripView;
}
try {
  assert.equal((await fetch(new URL('/health/ready', apiAddress))).status, 200);
  const modes =
    process.env.GOOGLE_TRANSIT_LIVE_MODES === 'ARRIVE_BY'
      ? (['ARRIVE_BY'] as const)
      : (['DEPART_AT', 'ARRIVE_BY'] as const);
  for (const timeMode of modes) {
    credential = randomBytes(32).toString('hex');
    const email = `synthetic-google-live-${randomUUID()}@synthetic.example.test`;
    await managed.client.user.create({
      data: {
        email,
        normalizedEmail: email,
        role: 'USER',
        preference: { create: { baseCurrency: 'JPY', uiLanguage: 'zh-CN' } },
        sessions: {
          create: {
            tokenDigest: digestOpaqueToken(credential),
            expiresAt: new Date(Date.now() + 3600000),
          },
        },
      },
    });

    let trip: TripView = await post<TripView>(
      '/trips',
      {
        name: `SYNTHETIC Google cloud live ${timeMode}`,
        planningAnchorDate: date,
        defaultPeopleCount: 1,
      },
      201,
    );
    const locations = [
      { name: 'Hotel Mahoroba', latitude: 42.4930624, longitude: 141.1419064 },
      {
        name: 'The Lake View Toya Nonokaze Resort',
        latitude: 42.565637,
        longitude: 140.8222622,
      },
    ];
    for (const [position, place] of locations.entries()) {
      trip = await post<TripView>(
        `/trips/${trip.id}/commands`,
        {
          baseTripVersion: trip.version,
          command: {
            type: 'ADD_PLACE_VISIT',
            targetDay:
              position === 0
                ? { type: 'NEW', localDate: date, sequence: 0 }
                : {
                    type: 'EXISTING',
                    dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
                  },
            position,
            place: { type: 'CUSTOM', ...place },
          },
        },
        200,
      );
    }
    const [from, to] = trip.days[0]!.nodes;
    const callsBefore = providerHttpCalls;
    const queried: RouteQueryResponse = await post<RouteQueryResponse>(
      `/trips/${trip.id}/routes/query`,
      {
        basisVersion: trip.version,
        fromNodeId: from!.id,
        toNodeId: to!.id,
        hint: {
          type: timeMode,
          instant: `${date}T15:00:00+09:00`,
          timeZone: 'Asia/Tokyo',
        },
      },
      200,
    );
    assert(queried.candidates.length > 0);
    assert.equal(providerHttpCalls, callsBefore + 1);
    const live = lastSidecarResponse;
    assert(live, 'This query must return a fresh sidecar success');
    assert.equal(live.queryVerified, true);
    assert.equal(live.cacheHit, false);
    assert.deepEqual(live.requestedQuery, {
      origin: {
        label: from!.place!.name,
        latitude: from!.place!.latitude,
        longitude: from!.place!.longitude,
      },
      destination: {
        label: to!.place!.name,
        latitude: to!.place!.latitude,
        longitude: to!.place!.longitude,
      },
      date,
      time: '15:00',
      timezone: 'Asia/Tokyo',
      timeMode,
    });
    assert(Date.parse(live.fetchedAt) >= Date.parse(runStartedAt));
    const requestedInstant = Date.parse(`${date}T15:00:00+09:00`);
    for (const c of live.candidates) {
      assert.equal(c.arrivalTime.timezone, 'Asia/Tokyo');
      if (timeMode === 'ARRIVE_BY')
        assert(Date.parse(c.arrivalTime.utc) <= requestedInstant);
      else assert(Date.parse(c.departureTime.utc) >= requestedInstant);
      for (const l of c.legs.filter((l) => l.mode === 'WALK')) {
        assert.equal(l.departureTime, null);
        assert.equal(l.arrivalTime, null);
      }
    }
    for (const c of queried.candidates) {
      assert.equal(c.provider, 'GOOGLE_CONSUMER_EXPERIMENTAL');
      assert.equal(c.observedAt, live.fetchedAt);
      assert(live.candidates.some((raw) => raw.id === c.providerCandidateRef));
      if (timeMode === 'ARRIVE_BY')
        assert(Date.parse(c.overall.arrival.instant) <= requestedInstant);
      const { candidateSnapshotId, snapshotExpiresAt, ...payload } = c;
      const stored =
        await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
          where: { id: candidateSnapshotId },
        });
      assert.equal(stored.provider, c.provider);
      assert.equal(stored.observedAt.toISOString(), live.fetchedAt);
      assert.equal(stored.expiresAt.toISOString(), snapshotExpiresAt);
      assert.deepEqual(stored.candidatePayload, payload);
      assert.deepEqual(stored.queryTimeCondition, queried.timeCondition);
      for (const l of c.legs.filter((l) => l.mode === 'WALKING')) {
        assert.equal(l.departure, null);
        assert.equal(l.arrival, null);
      }
    }
    const afterQuery = await readTrip(trip.id);
    assert.equal(afterQuery.version, trip.version);
    assert.deepEqual(planState(afterQuery), planState(trip));
    const candidate =
      queried.candidates.find(
        (c) =>
          c.legs.some((l) => l.mode === 'BUS') &&
          c.legs.some((l) => l.mode === 'RAIL'),
      ) ?? queried.candidates[0]!;
    const snapshot =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: { id: candidate.candidateSnapshotId },
      });
    assert.equal(snapshot.provider, 'GOOGLE_CONSUMER_EXPERIMENTAL');
    assert.equal(
      (await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }))
        .version,
      trip.version,
    );
    const preview: RoutePreviewView = await post<RoutePreviewView>(
      `/trips/${trip.id}/previews`,
      {
        basisVersion: trip.version,
        candidateSnapshotId: candidate.candidateSnapshotId,
      },
      201,
    );
    assert.equal(preview.adoptable, true);
    assert.equal(providerHttpCalls, callsBefore + 1);
    const afterPreview = await readTrip(trip.id);
    assert.equal(afterPreview.version, trip.version);
    assert.deepEqual(planState(afterPreview), planState(trip));
    const adopted = await post<AdoptRoutePreviewResponse>(
      `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
      {
        baseTripVersion: trip.version,
        idempotencyKey: `synthetic-live-adopt-${randomUUID()}`,
      },
      200,
    );
    assert.equal(adopted.trip.version, trip.version + 1);
    assert.equal(adopted.operationReceipt.operationType, 'ROUTE_ADOPT');
    assert.equal(adopted.trip.connections.length, candidate.legs.length);
    const adoptedModes = adopted.trip.connections.map((c) => c.transport?.mode);
    assert.deepEqual(
      adoptedModes,
      candidate.legs.map((l) => l.mode),
    );
    for (const connection of adopted.trip.connections) {
      assert.equal(
        connection.transport?.provider,
        'GOOGLE_CONSUMER_EXPERIMENTAL',
      );
    }
    const temporalValues = await managed.client.temporalValue.findMany({
      where: { transportEdge: { tripId: trip.id } },
    });
    const temporalFacts = temporalValues.length;
    const verifiedTimePointCount = candidate.legs.reduce(
      (sum, leg) =>
        sum + Number(leg.departure !== null) + Number(leg.arrival !== null),
      0,
    );
    assert.equal(temporalFacts, verifiedTimePointCount);
    for (const fact of temporalValues) {
      assert.equal(fact.layer, 'PLANNED');
      assert.equal(fact.sourceKind, 'ADOPTED_TRANSPORT_FACT');
      assert.equal(fact.observedAt?.toISOString(), live.fetchedAt);
    }
    const undone = await post<UndoRouteAdoptionResponse>(
      `/trips/${trip.id}/operations/${adopted.operationReceipt.id}/undo`,
      {
        baseTripVersion: adopted.trip.version,
        idempotencyKey: `synthetic-live-undo-${randomUUID()}`,
      },
      200,
    );
    assert.equal(undone.trip.version, adopted.trip.version + 1);
    assert.equal(undone.operationReceipt.operationType, 'ROUTE_UNDO');
    assert.equal(undone.trip.days[0]!.nodes.length, 2);
    assert.equal(undone.trip.connections[0]!.state, 'MISSING');
    assert.deepEqual(planState(undone.trip), planState(trip));
    assert.equal(providerHttpCalls, callsBefore + 1);
    const preserved =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: { id: snapshot.id },
      });
    assert.equal(preserved.candidateHash, snapshot.candidateHash);
    const summary = {
      timeMode,
      date,
      localTime: '15:00',
      timezone: 'Asia/Tokyo',
      status: 'PASS',
      candidateCount: queried.candidates.length,
      providerHttpCalls: providerHttpCalls - callsBefore,
      requestedQuery: live.requestedQuery,
      fetchedAt: live.fetchedAt,
      pageEvidence: live.evidence,
      allSidecarArrivals: live.candidates.map((c) => c.arrivalTime.utc),
      allTravelArrivals: queried.candidates.map(
        (c) => c.overall.arrival.instant,
      ),
      allSnapshotsMatchThisLiveQuery: true,
      queryAndPreviewPlanUnchanged: true,
      queryPreviewVersions: [afterQuery.version, afterPreview.version],
      undoRestoresOriginalPlan: true,
      unknownWalkingTimesRemainNull: true,
      liveDataProvider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
      snapshotHashUnchanged: true,
      previewAdoptable: preview.adoptable,
      adoptedModes,
      plannedTemporalFacts: temporalFacts,
      versions: [trip.version, adopted.trip.version, undone.trip.version],
      restoredNodes: undone.trip.days[0]!.nodes.length,
      selectedCandidate: {
        provider: candidate.provider,
        departure: candidate.overall.departure,
        arrival: candidate.overall.arrival,
        durationSeconds: candidate.overall.durationSeconds,
        fare: candidate.fare,
        legs: candidate.legs,
      },
    };
    summaries.push(summary);
    process.stdout.write(
      JSON.stringify({
        timeMode,
        status: 'PASS',
        providerHttpCalls: 1,
        legCount: candidate.legs.length,
      }) + '\n',
    );
    if (timeMode === 'DEPART_AT')
      await new Promise((resolve) => setTimeout(resolve, 15000));
  }
} catch (error) {
  summaries.push({
    status: 'FAIL',
    reason: error instanceof Error ? error.message : 'UNKNOWN',
  });
  process.exitCode = 1;
} finally {
  await api.close();
  await sidecar.close();
  browserObservation.restore();
  await readiness.close();
  await managed.close();
  const directory = new URL(
    '../../../artifacts/google-consumer-transit/',
    import.meta.url,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL(
      `travel-live-${runStartedAt.replace(/[:.]/g, '-')}.json`,
      directory,
    ),
    JSON.stringify(
      {
        implementation: 'REBUILT_COMPATIBLE_IMPLEMENTATION',
        recordedAt: new Date().toISOString(),
        runStartedAt,
        providerHttpCalls,
        lastSidecarError: lastSidecarError ?? null,
        browserDiagnostics: browserObservation.diagnostics,
        transport: 'actual loopback HTTP on both hops',
        database:
          'dedicated PostgreSQL 17 with isolated test accounts and trips',
        summaries,
      },
      null,
      2,
    ),
  );
}
