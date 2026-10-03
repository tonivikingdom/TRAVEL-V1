import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthService,
  digestOpaqueToken,
  GroundTransitService,
  GroundTransitRouteReevaluationService,
  InTripReadService,
  TripImpactService,
  TripService,
} from '@travel/application';
import type { TripImpactView } from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaGroundTransitRepository,
  PrismaGroundTransitRouteProgressRepository,
  PrismaInTripReadRepository,
  PrismaTripRepository,
} from '@travel/persistence';
import { UnconfiguredGroundTransitProvider } from '@travel/providers';
import { buildApi } from '../src/app.js';
const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error('TEST_DATABASE_URL required: SYNTHETIC impact integration');
const db = createPrismaClient(url),
  trips = new PrismaTripRepository(db.client),
  service = new TripService(trips),
  ground = new PrismaGroundTransitRepository(db.client);
const inTrip = new InTripReadService(new PrismaInTripReadRepository(db.client));
const impact = new TripImpactService(
  trips,
  ground,
  new GroundTransitService(ground, new UnconfiguredGroundTransitProvider()),
  new GroundTransitRouteReevaluationService(
    trips,
    ground,
    new PrismaGroundTransitRouteProgressRepository(db.client),
  ),
  inTrip,
);
const app = buildApi({
  readinessProbe: {
    async check() {
      return { name: 'postgresql', status: 'READY' };
    },
  },
  tripService: service,
  tripImpactService: impact,
  inTripReadService: inTrip,
  authService: new AuthService(new PrismaAuthRepository(db.client), {
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
});
const ids: string[] = [];
async function identity(role: 'USER' | 'ADMIN' = 'USER') {
  const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`,
    email = `synthetic-p6c-${randomUUID()}@synthetic.example.test`;
  const u = await db.client.user.create({
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
  ids.push(u.id);
  return {
    credential,
    actor: { userId: u.id, email, role, status: 'ACTIVE' as const },
  };
}
let owner: Awaited<ReturnType<typeof identity>>,
  stranger: typeof owner,
  admin: typeof owner;
beforeAll(async () => {
  owner = await identity();
  stranger = await identity();
  admin = await identity('ADMIN');
});
afterAll(async () => {
  await app.close();
  await db.client.user.deleteMany({ where: { id: { in: ids } } });
  await db.close();
});
async function fixture() {
  const who = await identity();
  let t = await service.createTrip(who.actor, {
    name: 'SYNTHETIC 后续影响',
    planningAnchorDate: '2030-10-01',
    defaultPeopleCount: 1,
  });
  for (const i of [0, 1])
    t = await service.executeCommand(who.actor, t.id, t.version, {
      type: 'ADD_PLACE_VISIT',
      position: i,
      targetDay:
        i === 0
          ? { type: 'NEW', localDate: '2030-10-01', sequence: 0 }
          : { type: 'EXISTING', dayOccurrenceId: t.days[0]!.dayOccurrenceId },
      place: {
        type: 'CUSTOM',
        name: `SYNTHETIC ${i === 0 ? '酒店' : '车站'}`,
        latitude: 35,
        longitude: 139,
      },
    });
  const a = t.days[0]!.nodes[0]!,
    b = t.days[0]!.nodes[1]!;
  t = await service.executeCommand(who.actor, t.id, t.version, {
    type: 'SET_MANUAL_TRANSPORT',
    fromNodeId: a.id,
    toNodeId: b.id,
    mode: 'RAIL',
    fixedService: true,
    serviceLabel: 'SYNTHETIC 15:00 交通',
  });
  const edge = t.connections[0]!.transport!;
  for (const [nodeId, transportEdgeId, layer, pointKind, hour] of [
    [a.id, null, 'PLANNED', 'ARRIVAL', '04'],
    [null, edge.id, 'PLANNED', 'DEPARTURE', '06'],
    [null, edge.id, 'PLANNED', 'ARRIVAL', '07'],
    [b.id, null, 'PLANNED', 'DEPARTURE', '08'],
  ] as const)
    await db.client.temporalValue.create({
      data: {
        nodeId,
        transportEdgeId,
        layer,
        pointKind,
        instant: new Date(`2030-10-01T${hour}:00:00Z`),
        timeZone: 'Asia/Tokyo',
        sourceKind: transportEdgeId ? 'ADOPTED_TRANSPORT_FACT' : 'USER_VALUE',
      },
    });
  await db.client.userTimeIntent.create({
    data: {
      tripId: t.id,
      nodeId: a.id,
      kind: 'MIN_DWELL',
      operator: 'MINIMUM',
      durationSeconds: 3600,
      locked: true,
    },
  });
  return { who, t, a, b, edge };
}
async function get(id: string, credential: string) {
  return app.inject({
    method: 'GET',
    url: `/trips/${id}/impact`,
    headers: { authorization: `Bearer ${credential}` },
  });
}
async function footprint(id: string) {
  return Promise.all([
    db.client.trip.findUnique({ where: { id } }),
    db.client.itineraryNode.findMany({ where: { tripId: id } }),
    db.client.transportEdge.findMany({ where: { tripId: id } }),
    db.client.executionEvent.findMany({ where: { tripId: id } }),
    db.client.operationReceipt.findMany({ where: { tripId: id } }),
    db.client.executionRisk.findMany({ where: { tripId: id } }),
    db.client.notificationEvent.findMany({ where: { tripId: id } }),
    db.client.routePreview.findMany({ where: { tripId: id } }),
    db.client.routeCandidateSnapshot.findMany({ where: { tripId: id } }),
    db.client.tripAuthoringReceipt.findMany({ where: { tripId: id } }),
    db.client.tripStaticBackup.findMany({ where: { tripId: id } }),
  ]);
}
describe('P6C authoritative HTTP/PostgreSQL read projection', () => {
  it('35-minute arrival change remains attention; minimum dwell satisfied, no writes', async () => {
    const f = await fixture();
    await db.client.temporalValue.create({
      data: {
        nodeId: f.a.id,
        layer: 'ESTIMATED',
        pointKind: 'ARRIVAL',
        instant: new Date('2030-10-01T04:35:00Z'),
        timeZone: 'Asia/Tokyo',
        sourceKind: 'USER_VALUE',
      },
    });
    const before = await footprint(f.t.id),
      response = await get(f.t.id, f.who.credential);
    expect(response.statusCode).toBe(200);
    const body = response.json<TripImpactView>();
    expect(
      body.items.some((i) => i.changed && i.explanation.includes('35 分钟')),
    ).toBe(true);
    expect(
      body.items.some((i) => ['VIOLATED', 'CONFLICT'].includes(i.status)),
    ).toBe(false);
    expect(await footprint(f.t.id)).toEqual(before);
  });
  it.each([
    ['05:35', '停留'],
    ['06:20', '到达'],
  ])(
    'reports %s arrival conflict through existing evaluators',
    async (clock, reason) => {
      const f = await fixture();
      await db.client.temporalValue.create({
        data: {
          nodeId: f.a.id,
          layer: 'ESTIMATED',
          pointKind: 'ARRIVAL',
          instant: new Date(`2030-10-01T${clock}:00Z`),
          timeZone: 'Asia/Tokyo',
          sourceKind: 'USER_VALUE',
        },
      });
      const response = await get(f.t.id, f.who.credential);
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json<TripImpactView>()
          .items.some(
            (i) => i.status === 'VIOLATED' && i.explanation.includes(reason),
          ),
      ).toBe(true);
    },
  );
  it('vehicle ACTUAL influences timing but never creates user progress', async () => {
    const f = await fixture();
    await db.client.temporalValue.create({
      data: {
        transportEdgeId: f.edge.id,
        layer: 'ACTUAL',
        pointKind: 'ARRIVAL',
        instant: new Date('2030-10-01T07:15:00Z'),
        timeZone: 'Asia/Tokyo',
        sourceKind: 'PROVIDER_OBSERVATION',
        sourceRef: 'SYNTHETIC vehicle',
      },
    });
    const before = await footprint(f.t.id);
    expect((await get(f.t.id, f.who.credential)).statusCode).toBe(200);
    expect((await inTrip.read(f.who.actor, f.t.id)).execution).toMatchObject({
      state: 'NOT_STARTED',
      recordedAt: null,
    });
    expect(await footprint(f.t.id)).toEqual(before);
  });
  it('unknown timing remains unknown; private owner/admin isolation', async () => {
    const f = await fixture();
    await db.client.temporalValue.deleteMany({ where: { nodeId: f.a.id } });
    const response = await get(f.t.id, f.who.credential);
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json<TripImpactView>()
        .items.some((i) => i.nodeId === f.a.id && i.status === 'UNKNOWN'),
    ).toBe(true);
    for (const who of [owner, stranger, admin])
      expect((await get(f.t.id, who.credential)).statusCode).toBe(404);
  });
  it('version changes during handoff projection return controlled conflict', async () => {
    const f = await fixture();
    const original = trips.findOwnedById.bind(trips);
    let reads = 0;
    const wrapper = new Proxy(trips, {
      get(target, key) {
        if (key === 'findOwnedById')
          return async (input: Parameters<typeof original>[0]) => {
            reads++;
            if (reads === 2)
              await db.client.trip.update({
                where: { id: f.t.id },
                data: { version: { increment: 1 } },
              });
            return original(input);
          };
        return Reflect.get(target, key);
      },
    });
    const read = new TripImpactService(
      wrapper,
      ground,
      new GroundTransitService(ground, new UnconfiguredGroundTransitProvider()),
      new GroundTransitRouteReevaluationService(
        trips,
        ground,
        new PrismaGroundTransitRouteProgressRepository(db.client),
      ),
      inTrip,
    );
    await expect(read.read(f.who.actor, f.t.id)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(
      await db.client.routePreview.count({ where: { tripId: f.t.id } }),
    ).toBe(0);
  });
});
