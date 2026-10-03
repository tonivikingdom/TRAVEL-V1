import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AuthService,
  digestOpaqueToken,
  InTripReadService,
  StaticBackupService,
  TripService,
} from '@travel/application';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaFlightRepository,
  PrismaInTripReadRepository,
  PrismaStaticBackupRepository,
  PrismaTripRepository,
} from '@travel/persistence';
import { SyntheticFlightProvider } from '@travel/providers';
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
  staticBackupService: new StaticBackupService(
    new PrismaStaticBackupRepository(managed.client),
  ),
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
const hooks = vi.hoisted(() => ({
  afterRead: undefined as undefined | (() => Promise<void>),
}));
vi.mock(
  '../../../packages/persistence/src/prisma-trip-repository.js',
  async (importOriginal) => {
    const original = await importOriginal<{
      readTripAggregateRecord: (
        client: unknown,
        input: unknown,
      ) => Promise<unknown>;
    }>();
    return {
      ...original,
      readTripAggregateRecord: async (
        ...args: Parameters<typeof original.readTripAggregateRecord>
      ) => {
        const result = await original.readTripAggregateRecord(...args);
        await hooks.afterRead?.();
        return result;
      },
    };
  },
);
async function generate(
  t: import('@travel/contracts').TripView,
  credential = owner.credential,
  key = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/trips/${t.id}/backup`,
    headers: { authorization: `Bearer ${credential}` },
    payload: { baseTripVersion: t.version, idempotencyKey: key },
  });
}
async function latest(id: string, credential = owner.credential) {
  return app.inject({
    method: 'GET',
    url: `/trips/${id}/backup`,
    headers: { authorization: `Bearer ${credential}` },
  });
}
async function facts(id: string) {
  return Promise.all([
    managed.client.trip.findUnique({ where: { id } }),
    managed.client.dayOccurrence.findMany({ where: { tripId: id } }),
    managed.client.dateOwnership.findMany({ where: { tripId: id } }),
    managed.client.itineraryNode.findMany({ where: { tripId: id } }),
    managed.client.executionEvent.findMany({ where: { tripId: id } }),
    managed.client.tripAuthoringReceipt.findMany({ where: { tripId: id } }),
    managed.client.operationReceipt.findMany({ where: { tripId: id } }),
  ]);
}
describe('P6B-2 SYNTHETIC backup on real PostgreSQL/authenticated API', () => {
  it('generates an explicit version, has no Trip writes, replays immutable output, and preserves old backup after editing', async () => {
    const { trip, a } = await fixture();
    expect((await latest(trip.id)).json()).toEqual({ backup: null });
    const before = await facts(trip.id),
      key = randomUUID();
    const response = await generate(trip, owner.credential, key);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const b = response.json<import('@travel/contracts').StaticBackupView>();
    expect(b).toMatchObject({
      schema: 'travel-static-backup-v1',
      tripId: trip.id,
      tripVersion: trip.version,
      name: trip.name,
      peopleCount: 1,
    });
    expect(Number.isFinite(Date.parse(b.generatedAt))).toBe(true);
    expect(b.days[0]!.nodes[0]!.place!.address).toBeNull();
    expect(b.days[0]!.nodes[0]!.note).toBeNull();
    expect(await facts(trip.id)).toEqual(before);
    expect((await generate(trip, owner.credential, key)).json()).toEqual(b);
    const edited = await tripService.executeCommand(
      owner.actor,
      trip.id,
      trip.version,
      { type: 'SET_NODE_NOTE', nodeId: a.id, note: 'SYNTHETIC new note' },
    );
    expect((await latest(trip.id)).json().backup).toEqual(b);
    expect((await generate(trip, owner.credential, key)).json()).toEqual(b);
    expect(
      (await generate(edited, owner.credential, key)).json(),
    ).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const conflict = await generate(trip);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('VERSION_CONFLICT');
    const later = await generate(edited);
    expect(later.json().days[0].nodes[0].note).toBe('SYNTHETIC new note');
    const rows = await managed.client.tripStaticBackup.findMany({
      where: { tripId: trip.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === b.id)!.artifact).toEqual(b);
    const after = await facts(trip.id);
    await latest(trip.id);
    await latest(trip.id);
    expect(await facts(trip.id)).toEqual(after);
  });
  it('preserves saved user time requirements separately from original plan without deriving unknown times', async () => {
    const f = await fixture();
    let trip = await tripService.executeCommand(
      owner.actor,
      f.trip.id,
      f.trip.version,
      {
        type: 'SET_TIME_INTENT',
        nodeId: f.a.id,
        pointKind: 'ARRIVAL',
        operator: 'NOT_AFTER',
        instant: '2030-10-01T04:00:00Z',
        timeZone: 'Asia/Tokyo',
        locked: true,
      },
    );
    trip = await tripService.executeCommand(
      owner.actor,
      trip.id,
      trip.version,
      {
        type: 'SET_MIN_DWELL',
        nodeId: f.a.id,
        durationSeconds: 3600,
        locked: true,
      },
    );
    const before = await facts(trip.id),
      response = await generate(trip);
    expect(response.statusCode).toBe(200);
    const node =
      response.json<import('@travel/contracts').StaticBackupView>().days[0]!
        .nodes[0]!;
    expect(node.plannedTimes).toEqual([]);
    expect(node.requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'POINT_TIME',
          pointKind: 'ARRIVAL',
          operator: 'NOT_AFTER',
          instant: '2030-10-01T04:00:00.000Z',
          timeZone: 'Asia/Tokyo',
          locked: true,
        }),
        expect.objectContaining({
          kind: 'MIN_DWELL',
          durationSeconds: 3600,
          locked: true,
        }),
      ]),
    );
    expect(await facts(trip.id)).toEqual(before);
  });
  it('enforces foreign-owner/admin isolation and authentication on every read/generate, with no overwrite/delete API', async () => {
    const { trip } = await fixture();
    await generate(trip);
    for (const actor of [stranger, admin]) {
      expect((await generate(trip, actor.credential)).statusCode).toBe(404);
      expect((await latest(trip.id, actor.credential)).statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/trips/${trip.id}/backup`,
            headers: { authorization: `Bearer ${actor.credential}` },
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (await app.inject({ method: 'GET', url: `/trips/${trip.id}/backup` }))
        .statusCode,
    ).toBe(401);
    expect((await latest('bad')).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/trips/${trip.id}/backup`,
          headers: { authorization: `Bearer ${owner.credential}` },
          payload: { baseTripVersion: -1, idempotencyKey: 'bad' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      await managed.client.tripStaticBackup.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
  });
  it('allows concurrent same-key generation exactly once', async () => {
    const { trip } = await fixture(),
      key = randomUUID();
    const responses = await Promise.all([
      generate(trip, owner.credential, key),
      generate(trip, owner.credential, key),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(
      await managed.client.tripStaticBackup.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
  });
  it('returns VERSION_CONFLICT with no partial artifact when another device commits N+1 during generation', async () => {
    const { trip, a } = await fixture();
    let entered!: () => void, release!: () => void;
    const readStarted = new Promise<void>((r) => {
        entered = r;
      }),
      resume = new Promise<void>((r) => {
        release = r;
      });
    hooks.afterRead = async () => {
      entered();
      await resume;
    };
    const pending = generate(trip);
    try {
      await readStarted;
      const edited = await tripService.executeCommand(
        owner.actor,
        trip.id,
        trip.version,
        {
          type: 'SET_NODE_NOTE',
          nodeId: a.id,
          note: 'SYNTHETIC other-device N+1',
        },
      );
      expect(edited.version).toBe(trip.version + 1);
      release();
      const response = await pending;
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('VERSION_CONFLICT');
      expect((await latest(trip.id)).json()).toEqual({ backup: null });
      hooks.afterRead = undefined;
      const retried = await generate(edited);
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toMatchObject({
        tripVersion: edited.version,
        days: [{ nodes: [{ note: 'SYNTHETIC other-device N+1' }, {}] }],
      });
    } finally {
      hooks.afterRead = undefined;
      release();
    }
  });
  it('preserves selected and saved Flight snapshots with explicit history and excludes credentials/raw Provider payloads', async () => {
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
    const repo = new PrismaFlightRepository(managed.client);
    const adopted = await repo.adopt({
      ownerUserId: owner.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      transportEdgeId: edge.id,
      flight: snapshot,
    });
    if (adopted.status !== 'SUCCESS')
      throw new Error('SYNTHETIC adoption failed');
    const revised = {
      ...snapshot,
      fetchedAt: '2030-10-01T04:01:00Z',
      departure: {
        ...snapshot.departure,
        revisedUtc: '2030-10-01T05:35:00Z',
        gate: 'SYNTHETIC G8',
      },
    };
    await repo.refresh({
      ownerUserId: owner.actor.userId,
      tripId: trip.id,
      flightBindingId: adopted.binding.id,
      flight: revised,
    });
    // Simulate extraneous persisted provider fields; whitelist must not serialize them.
    await managed.client.flightBinding.update({
      where: { id: adopted.binding.id },
      data: {
        latestSnapshot: JSON.parse(
          JSON.stringify({
            ...revised,
            providerCredential: 'SYNTHETIC_SECRET',
            rawResponse: { token: 'SYNTHETIC_SECRET' },
            departure: { ...revised.departure, session: 'SYNTHETIC_SECRET' },
          }),
        ),
      },
    });
    const fresh = await tripService.getTrip(owner.actor, trip.id),
      before = await facts(trip.id);
    const response = await generate(fresh);
    expect(response.statusCode).toBe(200);
    const b = response.json<import('@travel/contracts').StaticBackupView>();
    expect(b.flights[0]!.selectedSnapshot).toMatchObject({
      flightNumber: snapshot.displayFlightNumber,
      departure: {
        scheduledUtc: snapshot.departure.scheduledUtc,
        revisedUtc: snapshot.departure.revisedUtc,
      },
    });
    expect(b.flights[0]!.savedSnapshot).toMatchObject({
      fetchedAt: revised.fetchedAt,
      departure: {
        revisedUtc: revised.departure.revisedUtc,
        gate: 'SYNTHETIC G8',
      },
    });
    for (const secret of [
      'SYNTHETIC_SECRET',
      owner.credential,
      owner.actor.email,
      'providerCredential',
      'rawResponse',
      'rawStatus',
      'candidateId',
      'tokenDigest',
      'session',
    ])
      expect(response.body).not.toContain(secret);
    expect(await facts(trip.id)).toEqual(before);
  });
});
