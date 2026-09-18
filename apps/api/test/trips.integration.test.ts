import { randomUUID } from 'node:crypto';

import {
  AuthService,
  digestOpaqueToken,
  TripService,
} from '@travel/application';
import type { TripView } from '@travel/contracts';
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
  throw new Error('TEST_DATABASE_URL is required for P2A integration tests');
}

const NOW = new Date('2030-09-01T00:00:00.000Z');

describe('P2A Trip API with PostgreSQL 17', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let userA: SyntheticIdentity;
  let userB: SyntheticIdentity;
  let admin: SyntheticIdentity;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    [userA, userB, admin] = await Promise.all([
      createIdentity(managed, 'synthetic-p2a-a@synthetic.example.test', 'USER'),
      createIdentity(managed, 'synthetic-p2a-b@synthetic.example.test', 'USER'),
      createIdentity(
        managed,
        'synthetic-p2a-admin@synthetic.example.test',
        'ADMIN',
      ),
    ]);
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
      tripService: new TripService(new PrismaTripRepository(managed.client)),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('creates an empty Trip whose anchor owns no date and projects no Day', async () => {
    const trip = await createTrip(userA, '2030-10-01');
    expect(trip).toMatchObject({
      planningAnchorDate: '2030-10-01',
      effectiveStartDate: null,
      effectiveEndDate: null,
      version: 1,
      days: [],
    });
    expect(await managed.client.dateOwnership.count()).toBe(0);
    expect(await managed.client.itineraryNode.count()).toBe(0);
  });

  it('updates metadata with optimistic versioning without claiming the anchor date', async () => {
    const trip = await createTrip(userA, '2030-10-01');
    const updated = await patchTrip(userA, trip.id, {
      baseTripVersion: 1,
      name: 'SYNTHETIC renamed',
      planningAnchorDate: '2030-11-01',
      defaultPeopleCount: 3,
    });
    expect(updated).toMatchObject({
      name: 'SYNTHETIC renamed',
      planningAnchorDate: '2030-11-01',
      defaultPeopleCount: 3,
      version: 2,
      days: [],
    });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/trips/${trip.id}`,
      headers: bearer(userA),
      payload: { baseTripVersion: 1, name: 'SYNTHETIC stale write' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    expect((await getTrip(userA, trip.id)).name).toBe('SYNTHETIC renamed');
    expect(await managed.client.dateOwnership.count()).toBe(0);
  });

  it('creates the first PLACE_VISIT and establishes a one-day effective range', async () => {
    const trip = await createTrip(userA);
    const updated = await addVisit(userA, trip, '2030-10-02', 0, {
      type: 'CUSTOM',
      name: 'SYNTHETIC Place A',
      latitude: 31.2304,
      longitude: 121.4737,
      address: null,
    });
    expect(updated).toMatchObject({
      effectiveStartDate: '2030-10-02',
      effectiveEndDate: '2030-10-02',
      version: 2,
    });
    expect(updated.days).toHaveLength(1);
    expect(updated.days[0]?.nodes[0]).toMatchObject({
      kind: 'PLACE_VISIT',
      position: 0,
      place: { name: 'SYNTHETIC Place A', address: null },
    });
    expect(await managed.client.dateOwnership.count()).toBe(1);
  });

  it('creates the first FREE_ACTION without a Place or coordinates', async () => {
    const trip = await createTrip(userA);
    const updated = await addFreeAction(userA, trip, '2030-10-02', 0);
    expect(updated.days[0]?.nodes[0]).toMatchObject({
      kind: 'FREE_ACTION',
      place: null,
    });
    const node = await managed.client.itineraryNode.findFirstOrThrow();
    expect(node.placeId).toBeNull();
    expect(await managed.client.place.count()).toBe(0);
  });

  it('owns and projects an empty middle day between two content dates', async () => {
    let trip = await createTrip(userA);
    trip = await addFreeAction(userA, trip, '2030-10-01', 0);
    trip = await addFreeAction(userA, trip, '2030-10-03', 0);
    expect(trip.days.map((day) => [day.localDate, day.nodes.length])).toEqual([
      ['2030-10-01', 1],
      ['2030-10-02', 0],
      ['2030-10-03', 1],
    ]);
    expect(await ownedDates(trip.id)).toEqual([
      '2030-10-01',
      '2030-10-02',
      '2030-10-03',
    ]);
  });

  it('keeps a middle blank day owned after deleting its only node', async () => {
    let trip = await createTrip(userA);
    trip = await addFreeAction(userA, trip, '2030-10-01', 0);
    trip = await addFreeAction(userA, trip, '2030-10-02', 0);
    trip = await addFreeAction(userA, trip, '2030-10-03', 0);
    const middleNode = trip.days[1]?.nodes[0];
    expect(middleNode).toBeDefined();
    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'DELETE_NODE',
      nodeId: middleNode!.id,
    });
    expect(trip.effectiveStartDate).toBe('2030-10-01');
    expect(trip.effectiveEndDate).toBe('2030-10-03');
    expect(trip.days[1]).toEqual({ localDate: '2030-10-02', nodes: [] });
    expect(await ownedDates(trip.id)).toHaveLength(3);
  });

  it('shrinks boundary dates and releases all ownership after the final node', async () => {
    let trip = await createTrip(userA, '2030-09-15');
    trip = await addFreeAction(userA, trip, '2030-10-01', 0);
    trip = await addFreeAction(userA, trip, '2030-10-02', 0);
    trip = await addFreeAction(userA, trip, '2030-10-03', 0);
    trip = await deleteOnlyNodeOnDay(userA, trip, '2030-10-03');
    expect(trip.effectiveEndDate).toBe('2030-10-02');
    expect(await ownedDates(trip.id)).toEqual(['2030-10-01', '2030-10-02']);
    trip = await deleteOnlyNodeOnDay(userA, trip, '2030-10-02');
    trip = await deleteOnlyNodeOnDay(userA, trip, '2030-10-01');
    expect(trip).toMatchObject({
      planningAnchorDate: '2030-09-15',
      effectiveStartDate: null,
      effectiveEndDate: null,
      days: [],
    });
    expect(await managed.client.dateOwnership.count()).toBe(0);
  });

  it('keeps multiple Visit occurrences of one Place independent', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(
      userA,
      trip,
      '2030-10-01',
      0,
      customPlace('SYNTHETIC Hotel'),
      'first stay',
    );
    const placeId = trip.days[0]!.nodes[0]!.place!.id;
    trip = await addVisit(
      userA,
      trip,
      '2030-10-01',
      1,
      { type: 'EXISTING', placeId },
      'second stay',
    );
    const [first, second] = trip.days[0]!.nodes;
    expect(first?.id).not.toBe(second?.id);
    expect(first?.place?.id).toBe(placeId);
    expect(second?.place?.id).toBe(placeId);
    expect([first?.note, second?.note]).toEqual(['first stay', 'second stay']);
  });

  it('rejects a conflicting date without leaving a node, ownership, or version change', async () => {
    let tripA = await createTrip(userA);
    const tripB = await createTrip(userA);
    tripA = await addFreeAction(userA, tripA, '2030-10-02', 0);
    const response = await commandResponse(userA, tripB.id, tripB.version, {
      type: 'ADD_FREE_ACTION',
      localDate: '2030-10-02',
      position: 0,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DATE_OWNED');
    expect(
      await managed.client.itineraryNode.count({ where: { tripId: tripB.id } }),
    ).toBe(0);
    expect((await getTrip(userA, tripB.id)).version).toBe(1);
    expect(await ownedDates(tripA.id)).toEqual(['2030-10-02']);
  });

  it('lets at most one concurrent Trip claim the same owner date', async () => {
    const tripA = await createTrip(userA);
    const tripB = await createTrip(userA);
    const responses = await Promise.all([
      commandResponse(userA, tripA.id, 1, freeActionCommand('2030-10-02')),
      commandResponse(userA, tripB.id, 1, freeActionCommand('2030-10-02')),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)?.json().error
        .code,
    ).toBe('DATE_OWNED');
    expect(await managed.client.dateOwnership.count()).toBe(1);
    expect(await managed.client.itineraryNode.count()).toBe(1);
  });

  it('rolls back a range expansion that crosses another Trip ownership', async () => {
    let blocking = await createTrip(userA);
    let expanding = await createTrip(userA);
    blocking = await addFreeAction(userA, blocking, '2030-10-02', 0);
    expanding = await addFreeAction(userA, expanding, '2030-10-01', 0);
    const response = await commandResponse(
      userA,
      expanding.id,
      expanding.version,
      freeActionCommand('2030-10-03'),
    );
    expect(response.statusCode).toBe(409);
    const persisted = await getTrip(userA, expanding.id);
    expect(persisted.version).toBe(expanding.version);
    expect(persisted.effectiveEndDate).toBe('2030-10-01');
    expect(persisted.days).toHaveLength(1);
    expect(await ownedDates(blocking.id)).toEqual(['2030-10-02']);
  });

  it('allows only one mutation from the same baseTripVersion', async () => {
    const trip = await createTrip(userA);
    const responses = await Promise.all([
      commandResponse(userA, trip.id, 1, freeActionCommand('2030-10-01')),
      commandResponse(userA, trip.id, 1, freeActionCommand('2030-10-01')),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)?.json().error
        .code,
    ).toBe('VERSION_CONFLICT');
    expect((await getTrip(userA, trip.id)).version).toBe(2);
    expect(await managed.client.itineraryNode.count()).toBe(1);
  });

  it('returns NOT_FOUND for another owner, ADMIN, and an unknown private Trip ID', async () => {
    const trip = await createTrip(userA);
    for (const identity of [userB, admin]) {
      const response = await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}`,
        headers: bearer(identity),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
    const missing = await app.inject({
      method: 'GET',
      url: `/trips/${randomUUID()}`,
      headers: bearer(userA),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('NOT_FOUND');
    const list = await app.inject({
      method: 'GET',
      url: '/trips',
      headers: bearer(userB),
    });
    expect(list.json().trips).toEqual([]);
  });

  it('keeps same-day positions unique and stable across insert and move', async () => {
    let trip = await createTrip(userA);
    trip = await addFreeAction(userA, trip, '2030-10-01', 0, 'A');
    trip = await addFreeAction(userA, trip, '2030-10-01', 0, 'B');
    trip = await addFreeAction(userA, trip, '2030-10-01', 1, 'C');
    expect(trip.days[0]!.nodes.map((node) => node.note)).toEqual([
      'B',
      'C',
      'A',
    ]);
    const nodeA = trip.days[0]!.nodes[2]!;
    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'MOVE_NODE_WITHIN_DAY',
      nodeId: nodeA.id,
      position: 0,
    });
    expect(trip.days[0]!.nodes.map((node) => node.note)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(trip.days[0]!.nodes.map((node) => node.position)).toEqual([0, 1, 2]);
  });

  it('replaces a Visit Place in place and clears the old location note', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(
      userA,
      trip,
      '2030-10-01',
      0,
      customPlace('SYNTHETIC old'),
      'old location note',
    );
    const before = trip.days[0]!.nodes[0]!;
    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'REPLACE_PLACE',
      nodeId: before.id,
      place: customPlace('SYNTHETIC new'),
    });
    const after = trip.days[0]!.nodes[0]!;
    expect(after).toMatchObject({
      id: before.id,
      localDate: before.localDate,
      position: before.position,
      note: null,
      place: { name: 'SYNTHETIC new' },
    });
    expect(await managed.client.place.count()).toBe(2);
  });

  it('does not delete a Place still referenced by another Visit occurrence', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(
      userA,
      trip,
      '2030-10-01',
      0,
      customPlace('SYNTHETIC shared'),
    );
    const first = trip.days[0]!.nodes[0]!;
    trip = await addVisit(userA, trip, '2030-10-01', 1, {
      type: 'EXISTING',
      placeId: first.place!.id,
    });
    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'DELETE_NODE',
      nodeId: first.id,
    });
    expect(trip.days[0]!.nodes).toHaveLength(1);
    expect(trip.days[0]!.nodes[0]!.place!.id).toBe(first.place!.id);
    expect(await managed.client.place.count()).toBe(1);
  });

  it('hides another owner Place and rolls back the failed Visit command', async () => {
    let otherTrip = await createTrip(userB);
    otherTrip = await addVisit(
      userB,
      otherTrip,
      '2030-10-01',
      0,
      customPlace('SYNTHETIC private place'),
    );
    const privatePlaceId = otherTrip.days[0]!.nodes[0]!.place!.id;
    const trip = await createTrip(userA);
    const response = await commandResponse(userA, trip.id, 1, {
      type: 'ADD_PLACE_VISIT',
      localDate: '2030-10-01',
      position: 0,
      place: { type: 'EXISTING', placeId: privatePlaceId },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect((await getTrip(userA, trip.id)).version).toBe(1);
    expect(
      await managed.client.itineraryNode.count({ where: { tripId: trip.id } }),
    ).toBe(0);
  });

  it('rejects invalid or timezone-bearing values for DATE fields', async () => {
    for (const planningAnchorDate of [
      '2030-02-30',
      '2030-10-01T00:00:00Z',
      '2030/10/01',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/trips',
        headers: bearer(userA),
        payload: {
          name: 'SYNTHETIC invalid date',
          planningAnchorDate,
          defaultPeopleCount: 1,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('exposes the committed P2A tables and database constraints', async () => {
    const tables = await managed.client.$queryRaw<
      Array<{ table_name: string }>
    >`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('Trip', 'DateOwnership', 'Place', 'ItineraryNode')
      ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      'DateOwnership',
      'ItineraryNode',
      'Place',
      'Trip',
    ]);
    const ownershipIndexes = await managed.client.$queryRaw<
      Array<{ indexname: string }>
    >`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'DateOwnership'
      `;
    expect(ownershipIndexes.map((row) => row.indexname)).toContain(
      'DateOwnership_pkey',
    );
  });

  async function createTrip(
    identity: SyntheticIdentity,
    planningAnchorDate = '2030-10-01',
  ): Promise<TripView> {
    const response = await app.inject({
      method: 'POST',
      url: '/trips',
      headers: bearer(identity),
      payload: {
        name: `SYNTHETIC trip ${randomUUID()}`,
        planningAnchorDate,
        defaultPeopleCount: 2,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as TripView;
  }

  async function patchTrip(
    identity: SyntheticIdentity,
    tripId: string,
    payload: Record<string, unknown>,
  ): Promise<TripView> {
    const response = await app.inject({
      method: 'PATCH',
      url: `/trips/${tripId}`,
      headers: bearer(identity),
      payload,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
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

  async function addFreeAction(
    identity: SyntheticIdentity,
    trip: TripView,
    localDate: string,
    position: number,
    note: string | null = null,
  ): Promise<TripView> {
    return executeCommand(identity, trip.id, trip.version, {
      type: 'ADD_FREE_ACTION',
      localDate,
      position,
      note,
    });
  }

  async function addVisit(
    identity: SyntheticIdentity,
    trip: TripView,
    localDate: string,
    position: number,
    place: Record<string, unknown>,
    note: string | null = null,
  ): Promise<TripView> {
    return executeCommand(identity, trip.id, trip.version, {
      type: 'ADD_PLACE_VISIT',
      localDate,
      position,
      place,
      note,
    });
  }

  async function executeCommand(
    identity: SyntheticIdentity,
    tripId: string,
    baseTripVersion: number,
    command: Record<string, unknown>,
  ): Promise<TripView> {
    const response = await commandResponse(
      identity,
      tripId,
      baseTripVersion,
      command,
    );
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
  }

  function commandResponse(
    identity: SyntheticIdentity,
    tripId: string,
    baseTripVersion: number,
    command: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${tripId}/commands`,
      headers: bearer(identity),
      payload: { baseTripVersion, command },
    });
  }

  async function deleteOnlyNodeOnDay(
    identity: SyntheticIdentity,
    trip: TripView,
    localDate: string,
  ): Promise<TripView> {
    const node = trip.days.find((day) => day.localDate === localDate)?.nodes[0];
    expect(node).toBeDefined();
    return executeCommand(identity, trip.id, trip.version, {
      type: 'DELETE_NODE',
      nodeId: node!.id,
    });
  }

  async function ownedDates(tripId: string): Promise<string[]> {
    const records = await managed.client.dateOwnership.findMany({
      where: { tripId },
      orderBy: { localDate: 'asc' },
    });
    return records.map((record) => record.localDate.toISOString().slice(0, 10));
  }
});

interface SyntheticIdentity {
  readonly userId: string;
  readonly credential: string;
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
      preference: {
        create: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' },
      },
      sessions: {
        create: {
          tokenDigest: digestOpaqueToken(credential),
          expiresAt: new Date(NOW.getTime() + 86_400_000),
        },
      },
    },
  });
  return { userId: user.id, credential };
}

function bearer(identity: SyntheticIdentity) {
  return { authorization: `Bearer ${identity.credential}` };
}

function customPlace(name: string) {
  return {
    type: 'CUSTOM',
    name,
    latitude: 31.2304,
    longitude: 121.4737,
    address: null,
  };
}

function freeActionCommand(localDate: string) {
  return {
    type: 'ADD_FREE_ACTION',
    localDate,
    position: 0,
    note: 'SYNTHETIC concurrent action',
  };
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
  await managed.client.transportEdgeHistoryTimeValue.deleteMany();
  await managed.client.transportEdgeHistory.deleteMany();
  await managed.client.temporalValue.deleteMany();
  await managed.client.transportEdge.deleteMany();
  await managed.client.itineraryNode.deleteMany();
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
