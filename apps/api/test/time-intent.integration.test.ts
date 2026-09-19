import { randomUUID } from 'node:crypto';

import {
  AuthService,
  digestOpaqueToken,
  TripService,
  type Actor,
} from '@travel/application';
import type { ScheduleProjectionView, TripView } from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
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
  throw new Error('TEST_DATABASE_URL is required for P3B1 integration tests');
}

const NOW = new Date('2030-09-01T00:00:00.000Z');

describe('P3B1 time intents and deterministic evaluation with PostgreSQL 17', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let tripService: TripService;
  let userA: SyntheticIdentity;
  let userB: SyntheticIdentity;
  let admin: SyntheticIdentity;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    [userA, userB, admin] = await Promise.all([
      createIdentity(
        managed,
        'synthetic-p3b1-a@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-p3b1-b@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-p3b1-admin@synthetic.example.test',
        'ADMIN',
      ),
    ]);
    tripService = new TripService(new PrismaTripRepository(managed.client));
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
      tripService,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('creates, updates, locks, unlocks, and removes one current point intent slot', async () => {
    let trip = await tripWithVisit(userA);
    const nodeId = firstNode(trip).id;
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId,
      pointKind: 'ARRIVAL',
      operator: 'EXACT',
      instant: '2030-10-01T19:30:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    let intent = firstNode(trip).timeIntents[0]!;
    expect(intent).toMatchObject({
      kind: 'POINT_TIME',
      operator: 'EXACT',
      instant: '2030-10-01T11:30:00.000Z',
      locked: true,
    });

    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId,
      pointKind: 'ARRIVAL',
      operator: 'EXACT',
      instant: '2030-10-01T19:45:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    expect(firstNode(trip).timeIntents).toHaveLength(1);
    expect(firstNode(trip).timeIntents[0]?.id).toBe(intent.id);

    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT_LOCK',
      intentId: intent.id,
      locked: false,
    });
    intent = firstNode(trip).timeIntents[0]!;
    expect(intent).toMatchObject({
      instant: '2030-10-01T11:45:00.000Z',
      locked: false,
    });

    trip = await command(userA, trip, {
      type: 'REMOVE_TIME_INTENT',
      nodeId,
      pointKind: 'ARRIVAL',
      operator: 'EXACT',
    });
    expect(firstNode(trip).timeIntents).toEqual([]);
  });

  it('stores one minimum dwell intent without inventing arrival or departure facts', async () => {
    let trip = await tripWithVisit(userA);
    const nodeId = firstNode(trip).id;
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId,
      durationSeconds: 2_400,
      locked: true,
    });
    expect(firstNode(trip).timeIntents[0]).toMatchObject({
      kind: 'MIN_DWELL',
      pointKind: null,
      operator: 'MINIMUM',
      instant: null,
      durationSeconds: 2_400,
    });
    expect(firstNode(trip).timeValues).toEqual([]);
  });

  it('serializes concurrent writes with one version winner and no duplicate slot', async () => {
    const trip = await tripWithVisit(userA);
    const nodeId = firstNode(trip).id;
    const writes = await Promise.all([
      commandResponse(userA, trip, {
        type: 'SET_TIME_INTENT',
        nodeId,
        pointKind: 'ARRIVAL',
        operator: 'NOT_AFTER',
        instant: '2030-10-01T20:00:00+08:00',
        timeZone: 'Asia/Shanghai',
        locked: false,
      }),
      commandResponse(userA, trip, {
        type: 'SET_TIME_INTENT',
        nodeId,
        pointKind: 'ARRIVAL',
        operator: 'NOT_AFTER',
        instant: '2030-10-01T20:15:00+08:00',
        timeZone: 'Asia/Shanghai',
        locked: false,
      }),
    ]);
    expect(writes.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await managed.client.userTimeIntent.count({ where: { nodeId } }),
    ).toBe(1);
  });

  it.each(['USER', 'ADMIN'] as const)(
    'hides another owner private intent from %s',
    async (role) => {
      let trip = await tripWithVisit(userB);
      trip = await command(userB, trip, {
        type: 'SET_MIN_DWELL',
        nodeId: firstNode(trip).id,
        durationSeconds: 900,
        locked: false,
      });
      const caller = role === 'ADMIN' ? admin : userA;
      const response = await app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/schedule/evaluate`,
        headers: bearer(caller),
        payload: { basisVersion: trip.version },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    },
  );

  it('rejects unresolved instants and offset-only time zones without changing version', async () => {
    const trip = await tripWithVisit(userA);
    for (const commandInput of [
      {
        type: 'SET_TIME_INTENT',
        nodeId: firstNode(trip).id,
        pointKind: 'ARRIVAL',
        operator: 'EXACT',
        instant: '2030-10-01T19:30:00',
        timeZone: 'Asia/Shanghai',
        locked: false,
      },
      {
        type: 'SET_TIME_INTENT',
        nodeId: firstNode(trip).id,
        pointKind: 'ARRIVAL',
        operator: 'EXACT',
        instant: '2030-10-01T19:30:00+08:00',
        timeZone: '+08:00',
        locked: false,
      },
    ]) {
      const response = await commandResponse(userA, trip, commandInput);
      expect(response.statusCode).toBe(400);
    }
    expect((await getTrip(userA, trip.id)).version).toBe(trip.version);
  });

  it('evaluates exact and bounds read-only against ESTIMATED before PLANNED', async () => {
    let trip = await tripWithVisit(userA);
    const nodeId = firstNode(trip).id;
    trip = await setTime(trip, userA, nodeId, 'PLANNED', 'ARRIVAL', '19:15');
    trip = await setTime(trip, userA, nodeId, 'ESTIMATED', 'ARRIVAL', '19:45');
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T19:30:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: false,
    });
    const version = trip.version;
    const before = await managed.client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "TemporalValue"
    `;
    const projection = await evaluate(userA, trip);
    expect(projection.nodes[0]).toMatchObject({
      status: 'VIOLATED',
      arrival: {
        planned: { layer: 'PLANNED' },
        estimated: { layer: 'ESTIMATED' },
        effective: { value: { layer: 'ESTIMATED' } },
      },
    });
    expect(projection.violations[0]?.currentLayer).toBe('ESTIMATED');
    expect((await getTrip(userA, trip.id)).version).toBe(version);
    const after = await managed.client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM "TemporalValue"
    `;
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  it('uses ACTUAL as immutable evaluation evidence and evaluates dwell states', async () => {
    let trip = await tripWithVisit(userA);
    const nodeId = firstNode(trip).id;
    trip = await setTime(trip, userA, nodeId, 'ACTUAL', 'ARRIVAL', '19:42');
    trip = await setTime(trip, userA, nodeId, 'PLANNED', 'DEPARTURE', '20:30');
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T19:30:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId,
      durationSeconds: 3_000,
      locked: false,
    });
    const projection = await evaluate(userA, trip);
    expect(projection.nodes[0]?.arrival.effective?.value.layer).toBe('ACTUAL');
    expect(projection.nodes[0]?.dwellSeconds).toBe(2_880);
    expect(projection.nodes[0]?.evaluations.map((item) => item.status)).toEqual(
      expect.arrayContaining(['VIOLATED']),
    );
    const actual = await managed.client.temporalValue.findFirstOrThrow({
      where: { nodeId, layer: 'ACTUAL', pointKind: 'ARRIVAL' },
    });
    expect(actual.instant.toISOString()).toBe('2030-10-01T11:42:00.000Z');
  });

  it('reports UNKNOWN for incomplete dwell and CONFLICT for impossible user bounds', async () => {
    let trip = await tripWithVisit(userA);
    const nodeId = firstNode(trip).id;
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId,
      durationSeconds: 2_400,
      locked: false,
    });
    expect((await evaluate(userA, trip)).nodes[0]?.status).toBe('UNKNOWN');
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId,
      pointKind: 'ARRIVAL',
      operator: 'NOT_BEFORE',
      instant: '2030-10-01T20:30:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId,
      pointKind: 'ARRIVAL',
      operator: 'NOT_AFTER',
      instant: '2030-10-01T20:00:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    const projection = await evaluate(userA, trip);
    expect(projection.nodes[0]?.status).toBe('CONFLICT');
    expect(projection.conflicts[0]?.intentIds).toHaveLength(2);
  });

  it('projects fixed transport planned anchors without copying them to Node values', async () => {
    let trip = await tripWithVisit(userA, ['Tokyo', 'Los Angeles']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    trip = await command(userA, trip, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: from!.id,
      toNodeId: to!.id,
      mode: 'FLIGHT',
      fixedService: true,
      serviceLabel: 'SYNTHETIC fixed flight',
    });
    const edge = trip.connections[0]!.transport!;
    trip = await tripService.setResolvedTemporalValue(
      userA.actor,
      trip.id,
      trip.version,
      { type: 'TRANSPORT', transportEdgeId: edge.id },
      {
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: '2030-10-01T20:21:00+08:00',
        timeZone: 'Asia/Shanghai',
        sourceKind: 'ADOPTED_TRANSPORT_FACT',
        sourceRef: 'SYNTHETIC_FIXED_SERVICE',
      },
    );
    trip = await command(userA, trip, {
      type: 'SET_TIME_INTENT',
      nodeId: from!.id,
      pointKind: 'DEPARTURE',
      operator: 'EXACT',
      instant: '2030-10-01T20:21:00+08:00',
      timeZone: 'Asia/Shanghai',
      locked: true,
    });
    const projection = await evaluate(userA, trip);
    expect(projection.nodes[0]?.departure.planned).toBeNull();
    expect(projection.nodes[0]?.departure.effective).toMatchObject({
      subjectType: 'FIXED_TRANSPORT',
      subjectId: edge.id,
      anchor: 'FIXED_TRANSPORT',
    });
    expect(projection.nodes[0]?.anchors[0]?.type).toBe('FIXED_TRANSPORT');
  });

  it('keeps occurrence sequence during evaluation when local dates go backward', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'Tokyo', '2030-01-10');
    trip = await addVisit(userA, trip, 'Los Angeles', '2030-01-09');
    const projection = await evaluate(userA, trip);
    expect(projection.nodes.map((node) => node.nodeId)).toEqual(
      trip.days.flatMap((day) => day.nodes.map((node) => node.id)),
    );
    expect(trip.days.map((day) => day.localDate)).toEqual([
      '2030-01-10',
      '2030-01-09',
    ]);
  });

  async function createTrip(identity: SyntheticIdentity): Promise<TripView> {
    const response = await app.inject({
      method: 'POST',
      url: '/trips',
      headers: bearer(identity),
      payload: {
        name: `SYNTHETIC P3B1 ${randomUUID()}`,
        planningAnchorDate: '2030-10-01',
        defaultPeopleCount: 1,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as TripView;
  }

  async function tripWithVisit(
    identity: SyntheticIdentity,
    names: readonly string[] = ['Visit'],
  ): Promise<TripView> {
    let trip = await createTrip(identity);
    for (const name of names) {
      trip = await addVisit(identity, trip, name, '2030-10-01');
    }
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
        latitude: 31.2304,
        longitude: 121.4737,
      },
    });
  }

  async function command(
    identity: SyntheticIdentity,
    trip: TripView,
    commandInput: Record<string, unknown>,
  ): Promise<TripView> {
    const response = await commandResponse(identity, trip, commandInput);
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
  }

  function commandResponse(
    identity: SyntheticIdentity,
    trip: TripView,
    commandInput: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/commands`,
      headers: bearer(identity),
      payload: { baseTripVersion: trip.version, command: commandInput },
    });
  }

  async function setTime(
    trip: TripView,
    identity: SyntheticIdentity,
    nodeId: string,
    layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL',
    pointKind: 'ARRIVAL' | 'DEPARTURE',
    clock: string,
  ): Promise<TripView> {
    return tripService.setResolvedTemporalValue(
      identity.actor,
      trip.id,
      trip.version,
      { type: 'NODE', nodeId },
      {
        layer,
        pointKind,
        instant: `2030-10-01T${clock}:00+08:00`,
        timeZone: 'Asia/Shanghai',
        sourceKind: layer === 'ACTUAL' ? 'PROVIDER_OBSERVATION' : 'USER_VALUE',
        sourceRef: 'SYNTHETIC_P3B1',
        ...(layer === 'ACTUAL'
          ? { observedAt: `2030-10-01T${clock}:00+08:00` }
          : {}),
      },
    );
  }

  async function evaluate(
    identity: SyntheticIdentity,
    trip: TripView,
  ): Promise<ScheduleProjectionView> {
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/schedule/evaluate`,
      headers: bearer(identity),
      payload: { basisVersion: trip.version },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ScheduleProjectionView;
  }

  async function getTrip(
    identity: SyntheticIdentity,
    tripId: string,
  ): Promise<TripView> {
    const response = await app.inject({
      method: 'GET',
      url: `/trips/${tripId}`,
      headers: bearer(identity),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
  }
});

interface SyntheticIdentity {
  readonly credential: string;
  readonly actor: Actor;
}

function firstNode(trip: TripView) {
  return trip.days[0]!.nodes[0]!;
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
