import {
  AuthService,
  digestOpaqueToken,
  ExecutionRiskService,
} from '@travel/application';
import type {
  ExecutionRiskEvaluationResponse,
  ExecutionRiskListResponse,
  ExecutionRiskView,
} from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaExecutionRiskRepository,
  PrismaTripRepository,
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
  throw new Error('TEST_DATABASE_URL is required for P5D1 integration tests');
}

const INITIAL_NOW = new Date('2030-01-01T10:45:00.000Z');

describe('P5D1 execution-risk API with PostgreSQL', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let userA: SyntheticIdentity;
  let userB: SyntheticIdentity;
  let admin: SyntheticIdentity;
  let fixture: RiskFixture;
  let now: Date;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    now = INITIAL_NOW;
    [userA, userB, admin] = await Promise.all([
      createIdentity(
        managed,
        'synthetic-p5d1-a@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-p5d1-b@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-p5d1-admin@synthetic.example.test',
        'ADMIN',
      ),
    ]);
    fixture = await createRiskFixture(managed, userA.userId);
    const riskService = new ExecutionRiskService(
      new PrismaTripRepository(managed.client),
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => now },
    );
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
      executionRiskService: riskService,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('deduplicates concurrent evaluation and never bumps Trip version', async () => {
    const [first, second] = await Promise.all([
      evaluate(userA),
      evaluate(userA),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await managed.client.executionRisk.count()).toBe(1);
    expect(await managed.client.notificationEvent.count()).toBe(1);
    expect(
      (
        await managed.client.trip.findUniqueOrThrow({
          where: { id: fixture.tripId },
        })
      ).version,
    ).toBe(fixture.version);
  });

  it('evaluates transport-only arrival evidence and tracks fixed departure estimate escalation without duplicate notifications', async () => {
    expect(
      await managed.client.temporalValue.count({
        where: {
          nodeId: fixture.connectionNodeId,
          pointKind: 'ARRIVAL',
        },
      }),
    ).toBe(0);

    const initial = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    expect(initial.risks[0]).toMatchObject({
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
      sourceNodeId: fixture.connectionNodeId,
      sourceTransportEdgeId: fixture.incomingEdgeId,
      protectedTransportEdgeId: fixture.fixedEdgeId,
    });
    expect(initial.risks[0]?.evidenceRefs).toEqual(
      expect.arrayContaining([
        `temporal:${fixture.arrivalValueId}`,
        `transport:${fixture.incomingEdgeId}`,
        `transport:${fixture.fixedEdgeId}`,
      ]),
    );
    expect(await managed.client.notificationEvent.count()).toBe(1);

    const estimatedDepartureId = await setFixedEstimatedDeparture(
      '2030-01-01T10:35:00.000Z',
    );
    const escalated = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    expect(escalated.risks[0]).toMatchObject({
      id: initial.risks[0]?.id,
      kind: 'FIXED_SERVICE_MISSED',
      severity: 'INFEASIBLE',
      sourceTransportEdgeId: fixture.incomingEdgeId,
      requiresRouteReevaluation: true,
    });
    expect(escalated.risks[0]?.evidenceRefs).toContain(
      `temporal:${estimatedDepartureId}`,
    );
    expect(await managed.client.notificationEvent.count()).toBe(2);

    await evaluate(userA);
    expect(await managed.client.notificationEvent.count()).toBe(2);
  });

  it('keeps acknowledged risk quiet, allows severity escalation, and snoozes for 15 minutes', async () => {
    const initial = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    const riskId = initial.risks[0]!.id;
    expect(initial.risks[0]).toMatchObject({
      severity: 'EXECUTABLE_RISK',
      status: 'OPEN',
    });

    const acknowledged = await action(userA, riskId, 'acknowledge');
    expect(acknowledged.json<ExecutionRiskView>().status).toBe('ACKNOWLEDGED');
    await evaluate(userA);
    expect(await managed.client.notificationEvent.count()).toBe(1);

    await setEstimatedArrival('2030-01-01T11:05:00.000Z');
    const escalated = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    expect(escalated.risks[0]).toMatchObject({
      kind: 'FIXED_SERVICE_MISSED',
      severity: 'INFEASIBLE',
      status: 'OPEN',
      requiresRouteReevaluation: true,
    });
    expect(await managed.client.notificationEvent.count()).toBe(2);

    const snoozed = await action(userA, riskId, 'snooze');
    expect(snoozed.json<ExecutionRiskView>()).toMatchObject({
      status: 'SNOOZED',
      snoozedUntil: '2030-01-01T11:00:00.000Z',
    });
    await evaluate(userA);
    expect(await managed.client.notificationEvent.count()).toBe(2);

    now = new Date('2030-01-01T11:01:00.000Z');
    const reminded = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    expect(reminded.risks[0]?.status).toBe('OPEN');
    expect(reminded.notificationsCreated).toHaveLength(1);
    expect(await managed.client.notificationEvent.count()).toBe(3);
  });

  it('resolves a recovered risk and creates a new lifecycle when it reappears', async () => {
    const initial = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    const firstRiskId = initial.risks[0]!.id;

    await setEstimatedArrival('2030-01-01T10:20:00.000Z');
    const resolved = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    expect(resolved.risks).toEqual([]);
    expect(resolved.resolvedRisks).toHaveLength(1);
    expect(resolved.resolvedRisks[0]).toMatchObject({
      id: firstRiskId,
      status: 'RESOLVED',
    });

    await setEstimatedArrival('2030-01-01T10:40:00.000Z');
    const reappeared = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    expect(reappeared.risks).toHaveLength(1);
    expect(reappeared.risks[0]!.id).not.toBe(firstRiskId);
    const generations = await managed.client.executionRisk.findMany({
      where: { tripId: fixture.tripId },
      orderBy: { lifecycleGeneration: 'asc' },
      select: { lifecycleGeneration: true, status: true },
    });
    expect(generations).toEqual([
      { lifecycleGeneration: 1, status: 'RESOLVED' },
      { lifecycleGeneration: 2, status: 'OPEN' },
    ]);
  });

  it('serializes acknowledge/evaluate and snooze/evaluate races without duplicate notification', async () => {
    const initial = (
      await evaluate(userA)
    ).json<ExecutionRiskEvaluationResponse>();
    const riskId = initial.risks[0]!.id;
    await Promise.all([action(userA, riskId, 'acknowledge'), evaluate(userA)]);
    expect(await managed.client.notificationEvent.count()).toBe(1);
    expect((await list(userA)).risks[0]?.status).toBe('ACKNOWLEDGED');

    await Promise.all([action(userA, riskId, 'snooze'), evaluate(userA)]);
    expect(await managed.client.notificationEvent.count()).toBe(1);
    expect((await list(userA)).risks[0]?.status).toBe('SNOOZED');
  });

  it('keeps risks owner-scoped, including for ADMIN', async () => {
    const risk = (await evaluate(userA)).json<ExecutionRiskEvaluationResponse>()
      .risks[0]!;
    for (const identity of [userB, admin]) {
      const read = await app.inject({
        method: 'GET',
        url: `/trips/${fixture.tripId}/execution/risks`,
        headers: bearer(identity.credential),
      });
      expect(read.statusCode).toBe(404);
      const mutate = await action(identity, risk.id, 'acknowledge');
      expect(mutate.statusCode).toBe(404);
    }
  });

  async function setEstimatedArrival(instant: string): Promise<void> {
    await managed.client.$transaction([
      managed.client.temporalValue.update({
        where: { id: fixture.arrivalValueId },
        data: { instant: new Date(instant), observedAt: now },
      }),
      managed.client.trip.update({
        where: { id: fixture.tripId },
        data: { version: { increment: 1 } },
      }),
    ]);
  }

  async function setFixedEstimatedDeparture(instant: string): Promise<string> {
    const existing = await managed.client.temporalValue.findFirst({
      where: {
        transportEdgeId: fixture.fixedEdgeId,
        pointKind: 'DEPARTURE',
        layer: 'ESTIMATED',
      },
      select: { id: true },
    });
    const id = existing?.id ?? randomUUID();
    await managed.client.$transaction([
      existing === null
        ? managed.client.temporalValue.create({
            data: {
              id,
              transportEdgeId: fixture.fixedEdgeId,
              layer: 'ESTIMATED',
              pointKind: 'DEPARTURE',
              instant: new Date(instant),
              timeZone: 'UTC',
              sourceKind: 'PROVIDER_OBSERVATION',
              observedAt: now,
            },
          })
        : managed.client.temporalValue.update({
            where: { id },
            data: { instant: new Date(instant), observedAt: now },
          }),
      managed.client.trip.update({
        where: { id: fixture.tripId },
        data: { version: { increment: 1 } },
      }),
    ]);
    return id;
  }

  function evaluate(identity: SyntheticIdentity) {
    return app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/evaluate`,
      headers: bearer(identity.credential),
    });
  }

  async function list(
    identity: SyntheticIdentity,
  ): Promise<ExecutionRiskListResponse> {
    const response = await app.inject({
      method: 'GET',
      url: `/trips/${fixture.tripId}/execution/risks`,
      headers: bearer(identity.credential),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ExecutionRiskListResponse;
  }

  function action(
    identity: SyntheticIdentity,
    riskId: string,
    operation: 'acknowledge' | 'snooze',
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/risks/${riskId}/${operation}`,
      headers: bearer(identity.credential),
    });
  }
});

interface SyntheticIdentity {
  readonly userId: string;
  readonly credential: string;
}

interface RiskFixture {
  readonly tripId: string;
  readonly connectionNodeId: string;
  readonly incomingEdgeId: string;
  readonly fixedEdgeId: string;
  readonly arrivalValueId: string;
  readonly version: number;
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
          expiresAt: new Date('2031-01-01T00:00:00.000Z'),
        },
      },
    },
  });
  return { userId: user.id, credential };
}

async function createRiskFixture(
  managed: ManagedPrismaClient,
  ownerUserId: string,
): Promise<RiskFixture> {
  const tripId = randomUUID();
  const occurrenceId = randomUUID();
  const placeOriginId = randomUUID();
  const placeAId = randomUUID();
  const placeBId = randomUUID();
  const nodeOriginId = randomUUID();
  const nodeAId = randomUUID();
  const nodeBId = randomUUID();
  const incomingEdgeId = randomUUID();
  const fixedEdgeId = randomUUID();
  const arrivalValueId = randomUUID();
  await managed.client.$transaction(async (transaction) => {
    await transaction.trip.create({
      data: {
        id: tripId,
        ownerUserId,
        name: 'SYNTHETIC P5D1 Trip',
        planningAnchorDate: new Date('2030-01-01T00:00:00.000Z'),
        defaultPeopleCount: 1,
        effectiveStartDate: new Date('2030-01-01T00:00:00.000Z'),
        effectiveEndDate: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    await transaction.dayOccurrence.create({
      data: {
        id: occurrenceId,
        tripId,
        localDate: new Date('2030-01-01T00:00:00.000Z'),
        sequence: 0,
      },
    });
    await transaction.place.createMany({
      data: [
        {
          id: placeOriginId,
          ownerUserId,
          name: 'SYNTHETIC Origin',
          latitude: 34,
          longitude: 138,
        },
        {
          id: placeAId,
          ownerUserId,
          name: 'SYNTHETIC Connection',
          latitude: 35,
          longitude: 139,
        },
        {
          id: placeBId,
          ownerUserId,
          name: 'SYNTHETIC Destination',
          latitude: 36,
          longitude: 140,
        },
      ],
    });
    await transaction.itineraryNode.createMany({
      data: [
        {
          id: nodeOriginId,
          tripId,
          dayOccurrenceId: occurrenceId,
          kind: 'PLACE_VISIT',
          position: 0,
          placeId: placeOriginId,
        },
        {
          id: nodeAId,
          tripId,
          dayOccurrenceId: occurrenceId,
          kind: 'PLACE_VISIT',
          position: 1,
          placeId: placeAId,
        },
        {
          id: nodeBId,
          tripId,
          dayOccurrenceId: occurrenceId,
          kind: 'PLACE_VISIT',
          position: 2,
          placeId: placeBId,
        },
      ],
    });
    await transaction.userTimeIntent.create({
      data: {
        tripId,
        nodeId: nodeAId,
        kind: 'MIN_DWELL',
        operator: 'MINIMUM',
        durationSeconds: 1_800,
        locked: false,
      },
    });
    await transaction.transportEdge.createMany({
      data: [
        {
          id: incomingEdgeId,
          tripId,
          fromNodeId: nodeOriginId,
          toNodeId: nodeAId,
          mode: 'RAIL',
          fixedService: false,
          source: 'MANUAL',
        },
        {
          id: fixedEdgeId,
          tripId,
          fromNodeId: nodeAId,
          toNodeId: nodeBId,
          mode: 'RAIL',
          fixedService: true,
          source: 'MANUAL',
        },
      ],
    });
    await transaction.temporalValue.createMany({
      data: [
        {
          id: arrivalValueId,
          transportEdgeId: incomingEdgeId,
          layer: 'ESTIMATED',
          pointKind: 'ARRIVAL',
          instant: new Date('2030-01-01T10:40:00.000Z'),
          timeZone: 'UTC',
          sourceKind: 'PROVIDER_OBSERVATION',
          observedAt: INITIAL_NOW,
        },
        {
          transportEdgeId: fixedEdgeId,
          layer: 'PLANNED',
          pointKind: 'DEPARTURE',
          instant: new Date('2030-01-01T11:00:00.000Z'),
          timeZone: 'UTC',
          sourceKind: 'ADOPTED_TRANSPORT_FACT',
        },
      ],
    });
  });
  return {
    tripId,
    connectionNodeId: nodeAId,
    incomingEdgeId,
    fixedEdgeId,
    arrivalValueId,
    version: 1,
  };
}

function bearer(credential: string) {
  return { authorization: `Bearer ${credential}` };
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
  await managed.client.executionRisk.deleteMany();
  await managed.client.notificationEvent.deleteMany();
  await managed.client.temporalValue.deleteMany();
  await managed.client.transportEdge.deleteMany();
  await managed.client.userTimeIntent.deleteMany();
  await managed.client.itineraryNode.deleteMany();
  await managed.client.dayOccurrence.deleteMany();
  await managed.client.dateOwnership.deleteMany();
  await managed.client.trip.deleteMany();
  await managed.client.place.deleteMany();
  await managed.client.session.deleteMany();
  await managed.client.userPreference.deleteMany();
  await managed.client.invitation.deleteMany();
  await managed.client.user.deleteMany();
}
