import { randomUUID } from 'node:crypto';
import {
  AuthService,
  TripService,
  PlaceSearchService,
  digestOpaqueToken,
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
import { SyntheticPlaceSearchProvider } from '@travel/providers';
import { buildApi } from '../src/app.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const date = '2031-10-01';
describe('Place Search explicit selection on real PostgreSQL', () => {
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
      placeSearchService: new PlaceSearchService(
        new SyntheticPlaceSearchProvider(),
        new TripService(new PrismaTripRepository(db.client)),
      ),
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
  async function search(trip: TripView, query = '東京駅', identity = owner) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/place-search`,
      headers: headers(identity),
      payload: { query, language: 'ja' },
    });
  }
  async function counts() {
    return {
      places: await db.client.place.count({ where: { ownerUserId: owner.id } }),
      receipts: await db.client.tripAuthoringReceipt.count({
        where: { ownerUserId: owner.id },
      }),
      execution: await db.client.executionEvent.count({
        where: { trip: { ownerUserId: owner.id } },
      }),
    };
  }
  function selection(trip: TripView, token: string) {
    return {
      selectionToken: token,
      baseTripVersion: trip.version,
      idempotencyKey: randomUUID(),
      targetDay: { type: 'NEW', localDate: date, sequence: 0 },
      position: 0,
      note: 'SYNTHETIC user note',
    };
  }
  async function select(
    trip: TripView,
    body: Record<string, unknown>,
    identity = owner,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/place-selection`,
      headers: headers(identity),
      payload: body,
    });
  }
  it('search and cancel have zero formal writes; ambiguous candidates need explicit selection; add is atomic/idempotent', async () => {
    const trip = await create();
    const before = await counts();
    const response = await search(trip);
    expect(response.statusCode).toBe(200);
    const candidates = response.json().candidates;
    expect(candidates).toHaveLength(3);
    expect(candidates[0].name).toBe(candidates[1].name);
    expect(candidates[0].externalId).not.toBe(candidates[1].externalId);
    expect(await counts()).toEqual(before);
    expect(
      (await db.client.trip.findUniqueOrThrow({ where: { id: trip.id } }))
        .version,
    ).toBe(trip.version);
    const body = selection(trip, candidates[1].selectionToken);
    const added = await select(trip, body);
    expect(added.statusCode, added.body).toBe(200);
    const fresh = added.json() as TripView;
    expect(fresh.version).toBe(trip.version + 1);
    const node = fresh.days[0]!.nodes[0]!;
    expect(node.place?.latitude).toBe(
      Number(candidates[1].coordinates.latitude.toFixed(6)),
    );
    expect(node.note).toContain(candidates[1].externalId);
    expect(node.timeValues).toEqual([]);
    expect((await select(trip, body)).json()).toEqual(fresh);
    const after = await counts();
    expect(after.places).toBe(before.places + 1);
    expect(after.receipts).toBe(before.receipts + 1);
    expect(after.execution).toBe(before.execution);
  });
  it('missing coordinates and forged evidence leave all formal data unchanged', async () => {
    const trip = await create();
    const candidates = (await search(trip)).json().candidates;
    const before = await counts();
    expect(
      (await select(trip, selection(trip, candidates[2].selectionToken)))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await select(
          trip,
          selection(trip, candidates[0].selectionToken + 'tampered'),
        )
      ).statusCode,
    ).toBe(400);
    expect(await counts()).toEqual(before);
  });
  it('provider unavailable leaves Trip and saved-place authoring available', async () => {
    const trip = await create();
    const before = await counts();
    expect((await search(trip, 'unavailable')).statusCode).toBe(503);
    const r = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/authoring`,
      headers: headers(),
      payload: {
        baseTripVersion: trip.version,
        idempotencyKey: randomUUID(),
        command: {
          type: 'ADD_PLACE_VISIT',
          targetDay: { type: 'NEW', localDate: date, sequence: 0 },
          position: 0,
          place: {
            type: 'CUSTOM',
            name: 'SYNTHETIC saved',
            latitude: 35,
            longitude: 139,
          },
        },
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await counts()).places).toBe(before.places + 1);
    const fresh = r.json() as TripView;
    const saved = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/authoring`,
      headers: headers(),
      payload: {
        baseTripVersion: fresh.version,
        idempotencyKey: randomUUID(),
        command: {
          type: 'ADD_PLACE_VISIT',
          targetDay: {
            type: 'EXISTING',
            dayOccurrenceId: fresh.days[0]!.dayOccurrenceId,
          },
          position: 1,
          place: {
            type: 'EXISTING',
            placeId: fresh.days[0]!.nodes[0]!.place!.id,
          },
        },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await counts()).places).toBe(before.places + 1);
  });
  it('foreign owner/admin cannot search/select; valid token is bound to its original owner and Trip', async () => {
    const trip = await create();
    const candidates = (await search(trip)).json().candidates;
    const before = await counts();
    expect((await search(trip, '東京駅', other)).statusCode).toBe(404);
    expect(
      (await select(trip, selection(trip, candidates[0].selectionToken), other))
        .statusCode,
    ).toBe(404);
    const ownOtherTrip = await create('2032-01-01');
    expect(
      (
        await select(
          ownOtherTrip,
          selection(ownOtherTrip, candidates[0].selectionToken),
        )
      ).statusCode,
    ).toBe(400);
    expect((await counts()).places).toBe(before.places);
  });
  it('concurrent authoring produces version conflict with no orphan Place; fresh-version retry succeeds', async () => {
    const trip = await create();
    const candidates = (await search(trip)).json().candidates;
    await app.inject({
      method: 'PATCH',
      url: `/trips/${trip.id}`,
      headers: headers(),
      payload: {
        baseTripVersion: trip.version,
        name: 'SYNTHETIC other device',
      },
    });
    const before = await counts();
    const body = selection(trip, candidates[0].selectionToken);
    expect((await select(trip, body)).statusCode).toBe(409);
    expect(await counts()).toEqual(before);
    const accepted = await select(trip, {
      ...body,
      baseTripVersion: trip.version + 1,
      idempotencyKey: randomUUID(),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });
});
