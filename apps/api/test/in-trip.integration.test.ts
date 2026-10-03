import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthService,
  digestOpaqueToken,
  InTripReadService,
  TripService,
} from '@travel/application';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaFlightRepository,
  PrismaInTripReadRepository,
  PrismaTripRepository,
} from '@travel/persistence';
import { SyntheticFlightProvider } from '@travel/providers';
import type { InTripView } from '@travel/contracts';
import { buildApi } from '../src/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('TEST_DATABASE_URL required for P6B SYNTHETIC integration');
const managed = createPrismaClient(databaseUrl);
const userIds: string[] = [];
let owner: Awaited<ReturnType<typeof identity>>;
let stranger: Awaited<ReturnType<typeof identity>>;
let admin: Awaited<ReturnType<typeof identity>>;
const read = new InTripReadService(
  new PrismaInTripReadRepository(managed.client),
);
const tripService = new TripService(new PrismaTripRepository(managed.client));
const app = buildApi({
  readinessProbe: {
    async check() {
      return { name: 'postgresql', status: 'READY' };
    },
  },
  authService: new AuthService(new PrismaAuthRepository(managed.client), {
    magicLinkLandingUrl: 'http://synthetic.example.test/login/magic',
    magicLinkTtlSeconds: 600,
    sessionTtlSeconds: 86400,
    invitationTtlSeconds: 86400,
    rateLimitWindowSeconds: 300,
    rateLimitMaxRequests: 50,
    defaultBaseCurrency: 'JPY',
    defaultUiLanguage: 'zh-CN',
    jobMaxAttempts: 5,
  }),
  tripService,
  inTripReadService: read,
});

async function identity(role: 'USER' | 'ADMIN' = 'USER') {
  const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
  const email = `synthetic-p6b-${randomUUID()}@synthetic.example.test`;
  const user = await managed.client.user.create({
    data: {
      email,
      normalizedEmail: email,
      role,
      preference: { create: { baseCurrency: 'JPY', uiLanguage: 'zh-CN' } },
      sessions: {
        create: {
          tokenDigest: digestOpaqueToken(credential),
          expiresAt: new Date(Date.now() + 3600000),
        },
      },
    },
  });
  userIds.push(user.id);
  return {
    actor: { userId: user.id, email, role, status: 'ACTIVE' as const },
    credential,
  };
}
beforeAll(async () => {
  owner = await identity();
  stranger = await identity();
  admin = await identity('ADMIN');
});
afterAll(async () => {
  await app.close();
  await managed.client.user.deleteMany({ where: { id: { in: userIds } } });
  await managed.close();
});

async function fixture() {
  owner = await identity();
  let t = await tripService.createTrip(owner.actor, {
    name: 'SYNTHETIC P6B Flight',
    planningAnchorDate: '2030-10-01',
    defaultPeopleCount: 1,
  });
  for (const i of [0, 1])
    t = await tripService.executeCommand(owner.actor, t.id, t.version, {
      type: 'ADD_PLACE_VISIT',
      position: i,
      targetDay:
        i === 0
          ? { type: 'NEW', localDate: '2030-10-01', sequence: 0 }
          : { type: 'EXISTING', dayOccurrenceId: t.days[0]!.dayOccurrenceId },
      place: {
        type: 'CUSTOM',
        name: `SYNTHETIC Airport ${i}`,
        latitude: 35,
        longitude: 139,
      },
    });
  const [a, b] = t.days[0]!.nodes;
  t = await tripService.executeCommand(owner.actor, t.id, t.version, {
    type: 'SET_MANUAL_TRANSPORT',
    fromNodeId: a!.id,
    toNodeId: b!.id,
    mode: 'FLIGHT',
    fixedService: true,
    serviceLabel: 'SYNTHETIC flight',
  });
  return { trip: t, a: a!, edge: t.connections[0]!.transport! };
}
async function get(tripId: string, credential = owner.credential) {
  return app.inject({
    method: 'GET',
    url: `/trips/${tripId}/in-trip`,
    headers: { authorization: `Bearer ${credential}` },
  });
}

describe('P6B real PostgreSQL and authenticated read API', () => {
  it('keeps owner isolation, revoked sessions and version/write counts on repeated reads', async () => {
    const { trip } = await fixture();
    const before = await managed.client.trip.findUniqueOrThrow({
      where: { id: trip.id },
    });
    const events = await managed.client.executionEvent.count({
      where: { tripId: trip.id },
    });
    const receipts = await managed.client.operationReceipt.count({
      where: { tripId: trip.id },
    });
    const readSnapshot = () =>
      Promise.all([
        managed.client.tripAuthoringReceipt.findMany({
          where: { tripId: trip.id },
        }),
        managed.client.dateOwnership.findMany({ where: { tripId: trip.id } }),
        managed.client.dayOccurrence.findMany({ where: { tripId: trip.id } }),
        managed.client.itineraryNode.findMany({ where: { tripId: trip.id } }),
        managed.client.temporalValue.findMany({
          where: {
            OR: [
              { node: { tripId: trip.id } },
              { transportEdge: { tripId: trip.id } },
            ],
          },
        }),
      ]);
    const unchanged = await readSnapshot();
    const responses = await Promise.all([
      get(trip.id),
      get(trip.id),
      get(trip.id, stranger.credential),
      get(trip.id, admin.credential),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 404, 404]);
    expect(responses[0]!.json()).toMatchObject({
      tripVersion: trip.version,
      execution: { state: 'NOT_STARTED', recordedAt: null },
      flights: [],
    });
    expect(
      (await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }))
        .version,
    ).toBe(before.version);
    expect(
      await managed.client.executionEvent.count({ where: { tripId: trip.id } }),
    ).toBe(events);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(receipts);
    expect(
      (await app.inject({ method: 'GET', url: `/trips/${trip.id}/in-trip` }))
        .statusCode,
    ).toBe(401);
    expect((await get('bad')).statusCode).toBe(400);
    expect(await readSnapshot()).toEqual(unchanged);
  });
  it('reads saved revised/runway facts without any Provider call or fabricated user execution', async () => {
    const { trip, edge } = await fixture();
    const provider = new SyntheticFlightProvider({
      scheduledUtc: '2030-10-01T05:15:00Z',
      observedAt: '2030-10-01T04:00:00Z',
      refreshMode: 'delayed',
      failFirstRefresh: false,
    });
    const snapshot = (
      await provider.search({ flightNumber: 'SY123', date: '2030-10-01' })
    )[0]!;
    const repository = new PrismaFlightRepository(managed.client);
    const adoption = await repository.adopt({
      ownerUserId: owner.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      transportEdgeId: edge.id,
      flight: snapshot,
    });
    if (adoption.status !== 'SUCCESS')
      throw new Error('SYNTHETIC adoption failed');
    const revised = {
      ...snapshot,
      fetchedAt: '2030-10-01T04:01:00Z',
      departure: {
        ...snapshot.departure,
        revisedUtc: '2030-10-01T05:35:00Z',
        runwayUtc: '2030-10-01T05:08:00Z',
        gate: 'SYNTHETIC G8',
        terminal: 'SYNTHETIC T2',
      },
    };
    const refresh = await repository.refresh({
      ownerUserId: owner.actor.userId,
      tripId: trip.id,
      flightBindingId: adoption.binding.id,
      flight: revised,
    });
    expect(refresh.status).toBe('SUCCESS');
    const response = await get(trip.id);
    const view = response.json<InTripView>();
    expect(view.execution).toMatchObject({
      state: 'NOT_STARTED',
      recordedAt: null,
    });
    expect(view.flights[0]?.latestSnapshot.departure).toMatchObject({
      revisedUtc: '2030-10-01T05:35:00Z',
      runwayUtc: '2030-10-01T05:08:00Z',
      gate: 'SYNTHETIC G8',
    });
    expect(view.flights[0]?.selectedSnapshot).toEqual(snapshot);
    expect(
      await managed.client.executionEvent.count({ where: { tripId: trip.id } }),
    ).toBe(0);
  });
  it('excludes undone events, reports conflicting records, and observes current versions after edits', async () => {
    const { trip, a } = await fixture();
    const event = await managed.client.executionEvent.create({
      data: {
        ownerUserId: owner.actor.userId,
        tripId: trip.id,
        nodeId: a.id,
        source: 'MANUAL',
        type: 'ARRIVAL',
        occurredAt: new Date('2030-10-01T04:00:00Z'),
      },
    });
    expect((await get(trip.id)).json()).toMatchObject({
      execution: { state: 'AT_NODE', currentNodeId: a.id },
    });
    const conflict = await managed.client.executionEvent.create({
      data: {
        ownerUserId: owner.actor.userId,
        tripId: trip.id,
        nodeId: trip.days[0]!.nodes[1]!.id,
        source: 'MANUAL',
        type: 'ARRIVAL',
        occurredAt: new Date('2030-10-01T05:00:00Z'),
      },
    });
    expect((await get(trip.id)).json()).toMatchObject({
      execution: { state: 'INCONSISTENT' },
    });
    await managed.client.executionEvent.update({
      where: { id: conflict.id },
      data: { undoneAt: new Date() },
    });
    const edited = await tripService.executeCommand(
      owner.actor,
      trip.id,
      trip.version,
      {
        type: 'SET_NODE_NOTE',
        nodeId: a.id,
        note: 'SYNTHETIC concurrent edit',
      },
    );
    const reads = await Promise.all([get(trip.id), get(trip.id)]);
    expect(reads.map((r) => r.json().tripVersion)).toEqual([
      edited.version,
      edited.version,
    ]);
    await managed.client.executionEvent.update({
      where: { id: event.id },
      data: { undoneAt: new Date() },
    });
    expect((await get(trip.id)).json()).toMatchObject({
      execution: { state: 'NOT_STARTED', recordedAt: null },
    });
    await managed.client.user.update({
      where: { id: owner.actor.userId },
      data: { status: 'DISABLED' },
    });
    expect((await get(trip.id)).statusCode).toBe(401);
    await managed.client.user.update({
      where: { id: owner.actor.userId },
      data: { status: 'ACTIVE' },
    });
  });

  it('integrates authoring/read owner isolation, version updates and transport adjacency rollback', async () => {
    const { trip, edge } = await fixture();
    const command = {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
      },
      position: 1,
      note: 'SYNTHETIC must not split transport',
    };
    const author = (credential: string, position: number) =>
      app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/authoring`,
        headers: { authorization: `Bearer ${credential}` },
        payload: {
          baseTripVersion: trip.version,
          idempotencyKey: randomUUID(),
          command: { ...command, position },
        },
      });
    for (const actor of [stranger, admin]) {
      expect((await author(actor.credential, 2)).statusCode).toBe(404);
      expect((await get(trip.id, actor.credential)).statusCode).toBe(404);
    }
    const before = (await get(trip.id)).json();
    const conflict = await author(owner.credential, 1);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'CONSTRAINT_CONFLICT' },
    });
    expect((await get(trip.id)).json()).toEqual(before);
    expect(
      await managed.client.transportEdge.findUnique({ where: { id: edge.id } }),
    ).not.toBeNull();
    expect(
      await managed.client.tripAuthoringReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
    const accepted = await author(owner.credential, 2);
    expect(accepted.statusCode).toBe(200);
    const fresh = accepted.json<import('@travel/contracts').TripView>();
    expect(fresh.version).toBe(trip.version + 1);
    expect(
      fresh.connections.find((c) => c.transport?.id === edge.id),
    ).toBeDefined();
    expect(fresh.days[0]!.nodes.at(-1)!.timeValues).toEqual([]);
    expect(fresh.days[0]!.nodes.at(-1)!.timeIntents).toEqual([]);
    const reads = await Promise.all([get(trip.id), get(trip.id)]);
    expect(reads.map((r) => r.json().tripVersion)).toEqual([
      fresh.version,
      fresh.version,
    ]);
    expect(
      await managed.client.tripAuthoringReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.executionEvent.count({ where: { tripId: trip.id } }),
    ).toBe(0);
  });
});
