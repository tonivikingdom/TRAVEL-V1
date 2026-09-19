import { randomUUID } from 'node:crypto';

import {
  AuthService,
  digestOpaqueToken,
  RouteQueryService,
  TripService,
  type Actor,
  type RouteProviderQueryInput,
  type RouteProviderResult,
} from '@travel/application';
import type { RouteQueryResponse, TripView } from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import { SyntheticRouteProvider } from '@travel/providers';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { buildApi } from '../src/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P4A1 integration tests');
}

const NOW = new Date('2030-09-01T00:00:00.000Z');

describe('P4A1 provider-neutral route query with PostgreSQL 17', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let userA: SyntheticIdentity;
  let userB: SyntheticIdentity;
  let admin: SyntheticIdentity;
  let providerInputs: RouteProviderQueryInput[];
  let providerResult: RouteProviderResult;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    [userA, userB, admin] = await Promise.all([
      createIdentity(managed, 'p4a1-a@synthetic.example.test', 'USER'),
      createIdentity(managed, 'p4a1-b@synthetic.example.test', 'USER'),
      createIdentity(managed, 'p4a1-admin@synthetic.example.test', 'ADMIN'),
    ]);
    providerInputs = [];
    providerResult = {
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T10:00:00Z', '2030-10-01T11:00:00Z')],
    };
    const repository = new PrismaTripRepository(managed.client);
    const provider = new SyntheticRouteProvider((input) => {
      providerInputs.push(input);
      return providerResult;
    });
    app = buildApi({
      readinessProbe: {
        async check() {
          return { name: 'postgresql', status: 'READY' };
        },
      },
      authService: new AuthService(
        new PrismaAuthRepository(managed.client),
        authConfig(),
      ),
      tripService: new TripService(repository),
      routeQueryService: new RouteQueryService(repository, provider),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('queries adjacent places and remains transactionally read-only', async () => {
    const trip = await tripWithVisits(userA, ['Tokyo', 'Los Angeles']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const before = await databaseFacts(trip.id);

    const response = await query(userA, trip, from!.id, to!.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T19:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as RouteQueryResponse;
    expect(body).toMatchObject({
      tripId: trip.id,
      basisVersion: trip.version,
      candidates: [
        {
          provider: 'SYNTHETIC',
          queryBasisVersion: trip.version,
          overall: { durationSeconds: 3600 },
        },
      ],
    });
    expect(providerInputs[0]).toMatchObject({
      origin: { name: 'Tokyo' },
      destination: { name: 'Los Angeles' },
      earliestDeparture: new Date('2030-10-01T10:00:00Z'),
    });
    expect(await databaseFacts(trip.id)).toEqual(before);
  });

  it('feeds both P3B2 hard bounds to the provider without copying propagation', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: from!.id,
      pointKind: 'DEPARTURE',
      operator: 'NOT_BEFORE',
      instant: '2030-10-01T18:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: false,
    });
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: to!.id,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T20:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: false,
    });
    providerResult = {
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T10:30:00Z', '2030-10-01T11:30:00Z')],
    };

    const response = await query(userA, trip, from!.id, to!.id, null);
    expect(response.statusCode).toBe(200);
    expect(providerInputs[0]).toMatchObject({
      earliestDeparture: new Date('2030-10-01T10:00:00Z'),
      latestArrival: new Date('2030-10-01T12:00:00Z'),
      preference: { type: 'NONE' },
    });
  });

  it('post-filters provider violations and distinguishes an empty feasible result', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: to!.id,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T20:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    providerResult = {
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T11:30:00Z', '2030-10-01T12:01:00Z')],
    };
    const response = await query(userA, trip, from!.id, to!.id, null);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NO_MATCHING_CANDIDATE' });
  });

  it('rejects missing time, stale version, non-adjacent nodes, and FreeAction endpoints', async () => {
    let trip = await tripWithVisits(userA, ['A', 'B', 'C']);
    const [a, b, c] = trip.days[0]!.nodes;

    let response = await query(userA, trip, a!.id, b!.id, null);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'ROUTE_QUERY_TIME_REQUIRED',
    });

    response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version - 1,
        fromNodeId: a!.id,
        toNodeId: b!.id,
        hint: departHint(),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    response = await query(userA, trip, a!.id, c!.id, departHint());
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'ROUTE_QUERY_UNSUPPORTED' });

    trip = await command(userA, trip, {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
      },
      position: 1,
      note: 'SYNTHETIC',
    });
    response = await query(
      userA,
      trip,
      trip.days[0]!.nodes[0]!.id,
      trip.days[0]!.nodes[1]!.id,
      departHint(),
    );
    expect(response.statusCode).toBe(422);
    expect(providerInputs).toHaveLength(0);
  });

  it('hides owner resources from another user and ADMIN', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    for (const identity of [userB, admin]) {
      const response = await query(
        identity,
        trip,
        from!.id,
        to!.id,
        departHint(),
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(providerInputs).toHaveLength(0);
  });

  it('uses DayOccurrence sequence for a local-date rollback adjacency', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'Tokyo', '2030-01-10');
    trip = await addVisit(userA, trip, 'Los Angeles', '2030-01-09');
    const [tokyo, losAngeles] = trip.days.flatMap((day) => day.nodes);
    const response = await query(
      userA,
      trip,
      tokyo!.id,
      losAngeles!.id,
      departHint(),
    );

    expect(response.statusCode).toBe(200);
    expect(trip.days.map((day) => day.localDate)).toEqual([
      '2030-01-10',
      '2030-01-09',
    ]);
    expect(providerInputs[0]).toMatchObject({
      origin: { name: 'Tokyo' },
      destination: { name: 'Los Angeles' },
    });
  });

  async function createTrip(identity: SyntheticIdentity): Promise<TripView> {
    const response = await app.inject({
      method: 'POST',
      url: '/trips',
      headers: bearer(identity),
      payload: {
        name: `SYNTHETIC P4A1 ${randomUUID()}`,
        planningAnchorDate: '2030-10-01',
        defaultPeopleCount: 1,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as TripView;
  }

  async function tripWithVisits(
    identity: SyntheticIdentity,
    names: readonly string[],
  ): Promise<TripView> {
    let trip = await createTrip(identity);
    for (const name of names)
      trip = await addVisit(identity, trip, name, '2030-10-01');
    return trip;
  }

  async function addVisit(
    identity: SyntheticIdentity,
    trip: TripView,
    name: string,
    localDate: string,
  ): Promise<TripView> {
    return command(identity, trip, {
      type: 'ADD_PLACE_VISIT',
      targetDay:
        trip.days.length === 0
          ? { type: 'NEW', localDate, sequence: 0 }
          : trip.days.some((day) => day.localDate === localDate)
            ? {
                type: 'EXISTING',
                dayOccurrenceId: trip.days.find(
                  (day) => day.localDate === localDate,
                )!.dayOccurrenceId,
              }
            : { type: 'NEW', localDate, sequence: trip.days.length },
      position:
        trip.days.find((day) => day.localDate === localDate)?.nodes.length ?? 0,
      place: {
        type: 'CUSTOM',
        name,
        latitude: 35.6762,
        longitude: 139.6503,
      },
    });
  }

  async function command(
    identity: SyntheticIdentity,
    trip: TripView,
    commandInput: Record<string, unknown>,
  ): Promise<TripView> {
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/commands`,
      headers: bearer(identity),
      payload: { baseTripVersion: trip.version, command: commandInput },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
  }

  function query(
    identity: SyntheticIdentity,
    trip: TripView,
    fromNodeId: string,
    toNodeId: string,
    hint: Record<string, unknown> | null,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(identity),
      payload: { basisVersion: trip.version, fromNodeId, toNodeId, hint },
    });
  }

  async function databaseFacts(tripId: string) {
    const [trip, timeValues, intents, transports] = await Promise.all([
      managed.client.trip.findUniqueOrThrow({ where: { id: tripId } }),
      managed.client.temporalValue.count(),
      managed.client.userTimeIntent.count({ where: { tripId } }),
      managed.client.transportEdge.count({ where: { tripId } }),
    ]);
    return { version: trip.version, timeValues, intents, transports };
  }
});

interface SyntheticIdentity {
  readonly credential: string;
  readonly actor: Actor;
}

function departHint() {
  return {
    type: 'DEPART_AT',
    instant: '2030-10-01T19:00:00+09:00',
    timeZone: 'Asia/Tokyo',
  };
}

function candidate(
  departure: string,
  arrival: string,
): Extract<RouteProviderResult, { status: 'SUCCESS' }>['candidates'][number] {
  const durationSeconds =
    (new Date(arrival).getTime() - new Date(departure).getTime()) / 1_000;
  const origin = {
    name: 'Origin',
    latitude: 35.6762,
    longitude: 139.6503,
    providerPlaceRef: 'origin',
  };
  const destination = {
    name: 'Destination',
    latitude: 34.0522,
    longitude: -118.2437,
    providerPlaceRef: 'destination',
  };
  return {
    candidateId: `candidate-${departure}-${arrival}`,
    provider: 'SYNTHETIC',
    providerCandidateRef: 'SYNTHETIC_REF',
    observedAt: NOW,
    validUntil: null,
    departure: { instant: new Date(departure), timeZone: 'Asia/Tokyo' },
    arrival: { instant: new Date(arrival), timeZone: 'America/Los_Angeles' },
    durationSeconds,
    legs: [
      {
        mode: 'FLIGHT',
        from: origin,
        to: destination,
        departure: { instant: new Date(departure), timeZone: 'Asia/Tokyo' },
        arrival: {
          instant: new Date(arrival),
          timeZone: 'America/Los_Angeles',
        },
        durationSeconds,
        fixedService: true,
        serviceLabel: 'SYNTHETIC-1',
        providerRef: 'SYNTHETIC_LEG',
      },
    ],
    fare: null,
  };
}

async function createIdentity(
  managed: ManagedPrismaClient,
  email: string,
  role: 'ADMIN' | 'USER',
): Promise<SyntheticIdentity> {
  const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
  const user = await managed.client.user.create({
    data: {
      email,
      normalizedEmail: email,
      role,
      preference: { create: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' } },
      sessions: {
        create: {
          tokenDigest: digestOpaqueToken(credential),
          expiresAt: new Date(NOW.getTime() + 86_400_000),
        },
      },
    },
  });
  return {
    credential,
    actor: { userId: user.id, email: user.email, role, status: 'ACTIVE' },
  };
}

function bearer(identity: SyntheticIdentity) {
  return { authorization: `Bearer ${identity.credential}` };
}

function authConfig() {
  return {
    magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
    magicLinkTtlSeconds: 600,
    sessionTtlSeconds: 86_400,
    invitationTtlSeconds: 86_400,
    rateLimitWindowSeconds: 300,
    rateLimitMaxRequests: 50,
    defaultBaseCurrency: 'CNY',
    defaultUiLanguage: 'zh-CN',
    jobMaxAttempts: 5,
  };
}

async function resetSyntheticData(managed: ManagedPrismaClient): Promise<void> {
  await managed.client.userTimeIntent.deleteMany();
  await managed.client.transportEdgeHistoryTimeValue.deleteMany();
  await managed.client.transportEdgeHistory.deleteMany();
  await managed.client.temporalValue.deleteMany();
  await managed.client.transportEdge.deleteMany();
  await managed.client.itineraryNode.deleteMany();
  await managed.client.dayOccurrence.deleteMany();
  await managed.client.dateOwnership.deleteMany();
  await managed.client.trip.deleteMany();
  await managed.client.place.deleteMany();
  await managed.client.notificationEvent.deleteMany();
  await managed.client.storedObject.deleteMany();
  await managed.client.magicLinkRequestBucket.deleteMany();
  await managed.client.job.deleteMany();
  await managed.client.session.deleteMany();
  await managed.client.magicLinkToken.deleteMany();
  await managed.client.magicLinkDeliveryRequest.deleteMany();
  await managed.client.userPreference.deleteMany();
  await managed.client.invitation.deleteMany();
  await managed.client.user.deleteMany();
}
