import { randomUUID } from 'node:crypto';
import {
  AuthService,
  TripService,
  digestOpaqueToken,
} from '@travel/application';
import type { TripView, TripAuthoringCommandInput } from '@travel/contracts';
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
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const date = '2031-10-01';
describe('P6A-2 owner/version/idempotent authoring on real PostgreSQL', () => {
  let db: ManagedPrismaClient, app: FastifyInstance;
  let owner: { id: string; credential: string },
    other: { id: string; credential: string };
  beforeAll(() => {
    db = createPrismaClient(databaseUrl);
  });
  beforeEach(async () => {
    async function identity() {
      const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
      const user = await db.client.user.create({
        data: {
          email: `synthetic-authoring-${randomUUID()}@synthetic.example.test`,
          normalizedEmail: `synthetic-authoring-${randomUUID()}@synthetic.example.test`,
          preference: { create: { baseCurrency: 'JPY', uiLanguage: 'zh-CN' } },
          sessions: {
            create: {
              tokenDigest: digestOpaqueToken(credential),
              expiresAt: new Date(Date.now() + 3600000),
            },
          },
        },
      });
      return { id: user.id, credential };
    }
    owner = await identity();
    other = await identity();
    await db.client.user.update({
      where: { id: other.id },
      data: { role: 'ADMIN' },
    });
    app = buildApi({
      readinessProbe: {
        async check() {
          return { name: 'postgresql', status: 'READY' };
        },
      },
      authService: new AuthService(new PrismaAuthRepository(db.client), {
        magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
        magicLinkTtlSeconds: 600,
        sessionTtlSeconds: 3600,
        invitationTtlSeconds: 3600,
        rateLimitWindowSeconds: 300,
        rateLimitMaxRequests: 50,
        defaultBaseCurrency: 'JPY',
        defaultUiLanguage: 'zh-CN',
        jobMaxAttempts: 5,
      }),
      tripService: new TripService(new PrismaTripRepository(db.client)),
    });
  });
  afterEach(async () => {
    await app.close();
    await db.client.user.deleteMany({
      where: { id: { in: [owner.id, other.id] } },
    });
  });
  afterAll(async () => {
    await db.close();
  });
  const headers = (identity = owner) => ({
    authorization: `Bearer ${identity.credential}`,
  });
  async function create(day = date, key = randomUUID()) {
    const r = await app.inject({
      method: 'POST',
      url: '/trips',
      headers: headers(),
      payload: {
        name: 'SYNTHETIC authoring',
        planningAnchorDate: day,
        defaultPeopleCount: 1,
        idempotencyKey: key,
      },
    });
    expect(r.statusCode).toBe(201);
    return r.json() as TripView;
  }
  async function response(
    trip: TripView,
    command: TripAuthoringCommandInput,
    key = randomUUID(),
    identity = owner,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/authoring`,
      headers: headers(identity),
      payload: { baseTripVersion: trip.version, idempotencyKey: key, command },
    });
  }
  async function change(trip: TripView, command: TripAuthoringCommandInput) {
    const r = await response(trip, command);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as TripView;
  }
  const target = (localDate = date, sequence = 0) => ({
    type: 'NEW' as const,
    localDate,
    sequence,
  });
  async function activity(trip: TripView, title = 'SYNTHETIC activity') {
    return change(trip, {
      type: 'ADD_FREE_ACTION',
      targetDay: trip.days.length
        ? { type: 'EXISTING', dayOccurrenceId: trip.days[0]!.dayOccurrenceId }
        : target(),
      position: trip.days[0]?.nodes.length ?? 0,
      note: title,
    });
  }
  it('creates once, owns no date until the first valid activity, and leaves all times unknown', async () => {
    const key = randomUUID();
    let trip = await create(date, key);
    expect(await create(date, key)).toEqual(trip);
    expect(
      await db.client.dateOwnership.count({ where: { tripId: trip.id } }),
    ).toBe(0);
    trip = await activity(trip);
    expect(trip.version).toBe(2);
    expect([trip.effectiveStartDate, trip.effectiveEndDate]).toEqual([
      date,
      date,
    ]);
    expect(trip.days[0]!.nodes[0]).toMatchObject({
      kind: 'FREE_ACTION',
      note: 'SYNTHETIC activity',
      timeValues: [],
      timeIntents: [],
    });
    expect(
      await db.client.dateOwnership.count({ where: { tripId: trip.id } }),
    ).toBe(1);
    const conflict = await app.inject({
      method: 'POST',
      url: '/trips',
      headers: headers(),
      payload: {
        name: 'different',
        planningAnchorDate: date,
        defaultPeopleCount: 1,
        idempotencyKey: key,
      },
    });
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('adds a known owned place without changing its facts, then reorders persisted same-day nodes', async () => {
    let trip = await activity(await create());
    const place = await db.client.place.create({
      data: {
        ownerUserId: owner.id,
        name: 'SYNTHETIC hotel',
        latitude: 35.6,
        longitude: 139.7,
        address: 'SYNTHETIC address',
      },
    });
    trip = await change(trip, {
      type: 'ADD_PLACE_VISIT',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
      },
      position: 1,
      place: { type: 'EXISTING', placeId: place.id },
    });
    trip = await activity(trip, 'SYNTHETIC walk');
    const moved = trip.days[0]!.nodes[2]!;
    trip = await change(trip, {
      type: 'MOVE_NODE',
      nodeId: moved.id,
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
      },
      position: 0,
    });
    const reread = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}`,
      headers: headers(),
    });
    expect(reread.json()).toEqual(trip);
    expect(trip.days[0]!.nodes.map((n) => n.position)).toEqual([0, 1, 2]);
    expect(trip.days[0]!.nodes[0]!.id).toBe(moved.id);
    expect(
      await db.client.place.count({ where: { ownerUserId: owner.id } }),
    ).toBe(1);
  });
  it('moves to a new day atomically and preserves middle blank dates, shrinks empty ends', async () => {
    let trip = await activity(await create());
    trip = await activity(trip, 'SYNTHETIC second');
    const moving = trip.days[0]!.nodes[1]!;
    trip = await change(trip, {
      type: 'MOVE_NODE',
      nodeId: moving.id,
      targetDay: target('2031-10-03', 1),
      position: 0,
    });
    expect(trip.version).toBe(4);
    expect(trip.days.map((d) => d.localDate)).toEqual([
      date,
      '2031-10-02',
      '2031-10-03',
    ]);
    expect(trip.days[1]!.nodes).toEqual([]);
    expect(
      await db.client.dateOwnership.count({ where: { tripId: trip.id } }),
    ).toBe(3);
    trip = await change(trip, {
      type: 'MOVE_NODE',
      nodeId: trip.days[0]!.nodes[0]!.id,
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: trip.days[2]!.dayOccurrenceId,
      },
      position: 1,
    });
    expect(trip.days.map((d) => d.localDate)).toEqual(['2031-10-03']);
    expect(trip.days[0]!.nodes.map((n) => n.position)).toEqual([0, 1]);
    expect(
      await db.client.dateOwnership.count({ where: { tripId: trip.id } }),
    ).toBe(1);
  });
  it('rolls back date extension conflict including new occurrence, positions, version and receipt', async () => {
    const first = await activity(await create());
    const second = await change(await create('2031-10-02'), {
      type: 'ADD_FREE_ACTION',
      targetDay: target('2031-10-02'),
      position: 0,
      note: 'SYNTHETIC occupied',
    });
    const count = await db.client.tripAuthoringReceipt.count({
      where: { ownerUserId: owner.id },
    });
    const r = await response(first, {
      type: 'ADD_FREE_ACTION',
      note: 'SYNTHETIC extend across occupied date',
      targetDay: target('2031-10-03', 1),
      position: 0,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('DATE_OWNED');
    const reread = await app.inject({
      method: 'GET',
      url: `/trips/${first.id}`,
      headers: headers(),
    });
    expect(reread.json()).toEqual(first);
    expect(
      await db.client.tripAuthoringReceipt.count({
        where: { ownerUserId: owner.id },
      }),
    ).toBe(count);
    expect(
      await db.client.dateOwnership.count({ where: { tripId: second.id } }),
    ).toBe(1);
  });
  it('fences two keys at one version and stably replays one key even after later writes', async () => {
    const trip = await create();
    const c: TripAuthoringCommandInput = {
      type: 'ADD_FREE_ACTION',
      targetDay: target(),
      position: 0,
      note: 'SYNTHETIC first',
    };
    const key = randomUUID();
    const replies = await Promise.all([
      response(trip, c, key),
      response(trip, c, key),
    ]);
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(replies[0]!.json()).toEqual(replies[1]!.json());
    const committed = replies[0]!.json() as TripView;
    await activity(committed, 'SYNTHETIC later');
    expect((await response(trip, c, key)).json()).toEqual(committed);
    expect(
      (await response(trip, { ...c, note: 'different' }, key)).json().error
        .code,
    ).toBe('IDEMPOTENCY_CONFLICT');
    const current = (
      await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}`,
        headers: headers(),
      })
    ).json() as TripView;
    const writes = await Promise.all([
      response(current, {
        ...c,
        targetDay: {
          type: 'EXISTING',
          dayOccurrenceId: current.days[0]!.dayOccurrenceId,
        },
        position: 2,
      }),
      response(current, {
        ...c,
        targetDay: {
          type: 'EXISTING',
          dayOccurrenceId: current.days[0]!.dayOccurrenceId,
        },
        position: 2,
      }),
    ]);
    expect(writes.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      await db.client.itineraryNode.count({ where: { tripId: trip.id } }),
    ).toBe(3);
  });
  it.each(['ACTUAL', 'LOCKED', 'EXECUTION'] as const)(
    'preserves %s and blocks same-day as well as cross-day moves',
    async (kind) => {
      let trip = await activity(await create());
      trip = await activity(trip, 'SYNTHETIC second');
      const n = trip.days[0]!.nodes[0]!;
      if (kind === 'ACTUAL')
        await db.client.temporalValue.create({
          data: {
            nodeId: n.id,
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: new Date('2031-10-01T08:00:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
        });
      if (kind === 'LOCKED')
        await db.client.userTimeIntent.create({
          data: {
            tripId: trip.id,
            nodeId: n.id,
            kind: 'MIN_DWELL',
            operator: 'MINIMUM',
            durationSeconds: 600,
            locked: true,
          },
        });
      if (kind === 'EXECUTION')
        await db.client.executionEvent.create({
          data: {
            ownerUserId: owner.id,
            tripId: trip.id,
            nodeId: n.id,
            type: 'ARRIVAL',
            source: 'MANUAL',
            occurredAt: new Date('2031-10-01T08:00:00Z'),
          },
        });
      for (const day of [
        {
          type: 'EXISTING' as const,
          dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
        },
        target('2031-10-02', 1),
      ]) {
        const r = await response(trip, {
          type: 'MOVE_NODE',
          nodeId: n.id,
          targetDay: day,
          position: day.type === 'NEW' ? 0 : 1,
        });
        expect(r.statusCode).toBe(409);
        expect(r.json().error.code).toBe('FACT_PROTECTED');
      }
      expect(
        await db.client.dayOccurrence.count({ where: { tripId: trip.id } }),
      ).toBe(1);
    },
  );
  it('preserves repeated-date occurrence identity and date-line order rather than sorting by local clock', async () => {
    let trip = await activity(await create());
    trip = await change(trip, {
      type: 'ADD_FREE_ACTION',
      targetDay: target(date, 1),
      position: 0,
      note: 'SYNTHETIC repeated date',
    });
    const first = trip.days[0]!.dayOccurrenceId,
      second = trip.days[1]!.dayOccurrenceId;
    expect(first).not.toBe(second);
    trip = await change(trip, {
      type: 'ADD_FREE_ACTION',
      targetDay: target('2031-09-30', 2),
      position: 0,
      note: 'SYNTHETIC date-line crossing',
    });
    expect(trip.days.map((d) => d.localDate)).toEqual([
      date,
      date,
      '2031-09-30',
    ]);
    const id = trip.days[1]!.nodes[0]!.id;
    trip = await change(trip, {
      type: 'MOVE_NODE',
      nodeId: id,
      targetDay: { type: 'EXISTING', dayOccurrenceId: first },
      position: 1,
    });
    expect(trip.days[0]!.nodes[1]!.id).toBe(id);
    expect(trip.days.map((d) => d.dayOccurrenceId)).toEqual([
      first,
      second,
      trip.days[2]!.dayOccurrenceId,
    ]);
    expect(trip.days[1]!.nodes).toHaveLength(0); // internal blank occurrence retained.
  });
  it('rejects foreign owner/admin-like access and foreign saved places with no partial writes', async () => {
    const trip = await activity(await create());
    const c: TripAuthoringCommandInput = {
      type: 'MOVE_NODE',
      nodeId: trip.days[0]!.nodes[0]!.id,
      targetDay: target('2031-10-02', 1),
      position: 0,
    };
    expect((await response(trip, c, randomUUID(), other)).statusCode).toBe(404);
    const place = await db.client.place.create({
      data: {
        ownerUserId: other.id,
        name: 'SYNTHETIC private',
        latitude: 35,
        longitude: 139,
      },
    });
    const r = await response(trip, {
      type: 'ADD_PLACE_VISIT',
      targetDay: target('2031-10-02', 1),
      position: 0,
      place: { type: 'EXISTING', placeId: place.id },
    });
    expect(r.statusCode).toBe(404);
    expect(
      await db.client.itineraryNode.count({ where: { tripId: trip.id } }),
    ).toBe(1);
    expect(
      await db.client.dayOccurrence.count({ where: { tripId: trip.id } }),
    ).toBe(1);
  });
});
