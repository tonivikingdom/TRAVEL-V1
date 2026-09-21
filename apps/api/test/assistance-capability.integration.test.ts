import {
  AssistanceCapabilityService,
  AuthService,
  digestOpaqueToken,
} from '@travel/application';
import type {
  AssistanceCapabilityView,
  AssistanceMutationResponse,
  TripAssistanceResponse,
} from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAssistanceCapabilityRepository,
  PrismaAuthRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
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
  throw new Error('TEST_DATABASE_URL is required for assistance integration');
}

describe('Assistance capability API with PostgreSQL', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let owner: Identity;
  let other: Identity;
  let admin: Identity;
  let tripId: string;
  let flightBindingId: string;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await managed.client.user.deleteMany({
      where: { normalizedEmail: { startsWith: 'synthetic-assistance-' } },
    });
    owner = await identity(
      managed,
      'synthetic-assistance-owner@synthetic.example.test',
      'USER',
    );
    other = await identity(
      managed,
      'synthetic-assistance-other@synthetic.example.test',
      'USER',
    );
    admin = await identity(
      managed,
      'synthetic-assistance-admin@synthetic.example.test',
      'ADMIN',
    );
    ({ tripId, flightBindingId } = await fixture(managed, owner.userId));
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
      assistanceCapabilityService: new AssistanceCapabilityService(
        new PrismaAssistanceCapabilityRepository(managed.client),
        { now: () => new Date('2030-01-01T10:00:00.000Z') },
      ),
    });
  });

  afterEach(async () => app.close());
  afterAll(async () => {
    await managed.client.user.deleteMany({
      where: { normalizedEmail: { startsWith: 'synthetic-assistance-' } },
    });
    await managed.close();
  });

  it('defaults every scope to NOT_ENABLED without backfilled authorization', async () => {
    const trip = await app.inject({
      method: 'GET',
      url: `/trips/${tripId}/assistance`,
      headers: bearer(owner),
    });
    expect(trip.statusCode).toBe(200);
    expect(trip.json<TripAssistanceResponse>().capabilities).toEqual([
      expect.objectContaining({
        kind: 'LOCATION_ASSISTANCE',
        state: 'NOT_ENABLED',
        revision: 0,
      }),
      expect.objectContaining({
        kind: 'AUTO_RECORD',
        state: 'NOT_ENABLED',
        revision: 0,
      }),
    ]);
    const flight = await app.inject({
      method: 'GET',
      url: `/trips/${tripId}/flights/${flightBindingId}/assistance`,
      headers: bearer(owner),
    });
    expect(flight.json<AssistanceCapabilityView>()).toMatchObject({
      kind: 'FLIGHT_MONITORING',
      state: 'NOT_ENABLED',
      revision: 0,
    });
  });

  it('uses independent revision and durable idempotency without changing Trip.version', async () => {
    const key = randomUUID();
    const first = await mutateTrip(
      owner,
      'LOCATION_ASSISTANCE',
      'ENABLE',
      0,
      key,
    );
    expect(first.statusCode).toBe(200);
    expect(first.json<AssistanceMutationResponse>()).toMatchObject({
      capability: { state: 'ENABLED', revision: 1 },
      idempotentReplay: false,
    });
    const replay = await mutateTrip(
      owner,
      'LOCATION_ASSISTANCE',
      'ENABLE',
      0,
      key,
    );
    expect(replay.json<AssistanceMutationResponse>()).toMatchObject({
      capability: first.json<AssistanceMutationResponse>().capability,
      idempotentReplay: true,
    });
    expect(
      (await managed.client.trip.findUniqueOrThrow({ where: { id: tripId } }))
        .version,
    ).toBe(1);
    const targetNode = await managed.client.itineraryNode.findFirstOrThrow({
      where: { tripId },
      orderBy: { position: 'asc' },
    });
    await managed.client.executionLocationState.create({
      data: {
        tripId,
        targetNodeId: targetNode.id,
        lastObservedAt: new Date('2030-01-01T09:59:00.000Z'),
        outsideTargetConsecutiveCount: 1,
        locationStatus: 'RELIABLE',
      },
    });
    const pause = await mutateTrip(
      owner,
      'LOCATION_ASSISTANCE',
      'PAUSE',
      1,
      randomUUID(),
    );
    expect(pause.json<AssistanceMutationResponse>().capability).toMatchObject({
      state: 'PAUSED',
      revision: 2,
    });
    expect(
      await managed.client.executionLocationState.findUnique({
        where: { tripId },
      }),
    ).toBeNull();
    const resume = await mutateTrip(
      owner,
      'LOCATION_ASSISTANCE',
      'RESUME',
      2,
      randomUUID(),
    );
    expect(resume.json<AssistanceMutationResponse>().capability).toMatchObject({
      state: 'ENABLED',
      revision: 3,
    });
  });

  it('serializes two devices at one base revision and rejects reuse with a different request', async () => {
    const [left, right] = await Promise.all([
      mutateTrip(owner, 'AUTO_RECORD', 'ENABLE', 0, randomUUID()),
      mutateTrip(owner, 'AUTO_RECORD', 'ENABLE', 0, randomUUID()),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);
    const key = randomUUID();
    expect(
      (await mutateTrip(owner, 'LOCATION_ASSISTANCE', 'ENABLE', 0, key))
        .statusCode,
    ).toBe(200);
    const conflict = await mutateTrip(
      owner,
      'LOCATION_ASSISTANCE',
      'PAUSE',
      1,
      key,
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('keeps private scopes owner-only, including ADMIN callers', async () => {
    for (const caller of [other, admin]) {
      const response = await app.inject({
        method: 'GET',
        url: `/trips/${tripId}/assistance`,
        headers: bearer(caller),
      });
      expect(response.statusCode).toBe(404);
      const flight = await app.inject({
        method: 'POST',
        url: `/trips/${tripId}/flights/${flightBindingId}/assistance`,
        headers: bearer(caller),
        payload: {
          action: 'ENABLE',
          baseCapabilityRevision: 0,
          idempotencyKey: randomUUID(),
        },
      });
      expect(flight.statusCode).toBe(404);
    }
  });

  it('cancels queued flight jobs on PAUSE and fences a new generation on RESUME', async () => {
    const enabled = await mutateFlight('ENABLE', 0, randomUUID());
    expect(enabled.json<AssistanceMutationResponse>().capability.revision).toBe(
      1,
    );
    await managed.client.job.create({
      data: {
        type: 'FLIGHT_MONITOR',
        status: 'QUEUED',
        runAt: new Date(),
        attempts: 0,
        maxAttempts: 5,
        uniqueKey: `synthetic-assistance:${randomUUID()}`,
        payloadRef: flightBindingId,
        capabilityRevision: 1,
      },
    });
    const paused = await mutateFlight('PAUSE', 1, randomUUID());
    expect(paused.json<AssistanceMutationResponse>().capability).toMatchObject({
      state: 'PAUSED',
      revision: 2,
    });
    expect(
      await managed.client.job.count({
        where: { payloadRef: flightBindingId, status: 'CANCELLED' },
      }),
    ).toBe(1);
    const resumed = await mutateFlight('RESUME', 2, randomUUID());
    expect(resumed.json<AssistanceMutationResponse>().capability).toMatchObject(
      { state: 'ENABLED', revision: 3 },
    );
  });

  function mutateTrip(
    caller: Identity,
    kind: 'LOCATION_ASSISTANCE' | 'AUTO_RECORD',
    action: string,
    baseCapabilityRevision: number,
    idempotencyKey: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${tripId}/assistance/${kind}`,
      headers: bearer(caller),
      payload: { action, baseCapabilityRevision, idempotencyKey },
    });
  }

  function mutateFlight(
    action: string,
    baseCapabilityRevision: number,
    idempotencyKey: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${tripId}/flights/${flightBindingId}/assistance`,
      headers: bearer(owner),
      payload: { action, baseCapabilityRevision, idempotencyKey },
    });
  }
});

interface Identity {
  readonly userId: string;
  readonly credential: string;
}

async function identity(
  managed: ManagedPrismaClient,
  email: string,
  role: 'USER' | 'ADMIN',
): Promise<Identity> {
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
          expiresAt: new Date('2031-01-01T00:00:00Z'),
        },
      },
    },
  });
  return { userId: user.id, credential };
}

async function fixture(managed: ManagedPrismaClient, ownerUserId: string) {
  const tripId = randomUUID();
  const dayOccurrenceId = randomUUID();
  const nodes = [randomUUID(), randomUUID()];
  const places = [randomUUID(), randomUUID()];
  await managed.client.trip.create({
    data: {
      id: tripId,
      ownerUserId,
      name: 'SYNTHETIC assistance',
      planningAnchorDate: new Date('2030-01-01T00:00:00Z'),
      defaultPeopleCount: 1,
    },
  });
  await managed.client.dayOccurrence.create({
    data: {
      id: dayOccurrenceId,
      tripId,
      localDate: new Date('2030-01-01T00:00:00Z'),
      sequence: 0,
    },
  });
  await managed.client.place.createMany({
    data: places.map((id, index) => ({
      id,
      ownerUserId,
      name: `P${index}`,
      latitude: 35 + index,
      longitude: 139 + index,
    })),
  });
  await managed.client.itineraryNode.createMany({
    data: nodes.map((id, position) => ({
      id,
      tripId,
      dayOccurrenceId,
      kind: 'PLACE_VISIT' as const,
      position,
      placeId: places[position]!,
    })),
  });
  const edge = await managed.client.transportEdge.create({
    data: {
      tripId,
      fromNodeId: nodes[0]!,
      toNodeId: nodes[1]!,
      mode: 'FLIGHT',
      fixedService: true,
      source: 'MANUAL',
    },
  });
  const snapshot = flightSnapshot();
  const binding = await managed.client.flightBinding.create({
    data: {
      ownerUserId,
      tripId,
      transportEdgeId: edge.id,
      provider: 'aerodatabox',
      providerFlightRef: 'synthetic:cap',
      canonicalFlightNumber: 'NH53',
      displayFlightNumber: 'NH 53',
      serviceDate: new Date('2030-01-01T00:00:00Z'),
      selectedSnapshot: snapshot,
      latestSnapshot: snapshot,
      status: 'SCHEDULED',
      lastRefreshedAt: new Date('2030-01-01T09:00:00Z'),
    },
  });
  return { tripId, flightBindingId: binding.id };
}

function flightSnapshot() {
  const movement = (scheduledUtc: string) => ({
    airportName: null,
    airportIata: null,
    airportIcao: null,
    timeZone: 'UTC',
    scheduledLocal: scheduledUtc,
    scheduledUtc,
    revisedLocal: null,
    revisedUtc: null,
    predictedLocal: null,
    predictedUtc: null,
    runwayLocal: null,
    runwayUtc: null,
    terminal: null,
    gate: null,
    checkInDesk: null,
    baggageBelt: null,
  });
  return {
    provider: 'aerodatabox',
    candidateId: 'synthetic:cap',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2030-01-01',
    status: 'SCHEDULED',
    rawStatus: null,
    airline: { name: null, iata: null, icao: null },
    departure: movement('2030-01-01T12:00:00.000Z'),
    arrival: movement('2030-01-01T14:00:00.000Z'),
    aircraft: null,
    departureDelayMinutes: null,
    arrivalDelayMinutes: null,
    departureDelayBasis: null,
    arrivalDelayBasis: null,
    fetchedAt: '2030-01-01T09:00:00.000Z',
  };
}

function bearer(identity: Identity) {
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
