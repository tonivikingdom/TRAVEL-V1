import { randomUUID } from 'node:crypto';

import {
  AuthService,
  digestOpaqueToken,
  ExecutionRiskService,
  GroundTransitService,
  GroundTransitRouteReevaluationService,
  type GroundTransitProvider,
  hashRoutePreviewPayload,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  RouteUndoService,
  TripService,
  type Actor,
  type RouteProvider,
  type RouteProviderQueryInput,
  type RouteProviderResult,
  type StoredRoutePreviewPayload,
} from '@travel/application';
import type {
  GroundTransitExecutionResponse,
  GroundTransitRouteReevaluationHandoffView,
  RoutePreviewView,
  RouteQueryResponse,
  TripView,
} from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaExecutionRiskRepository,
  PrismaGroundTransitRepository,
  PrismaGroundTransitRouteProgressRepository,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import {
  GoogleConsumerExperimentalRouteProvider,
  SyntheticRouteProvider,
  SyntheticGroundTransitProvider,
  createDevelopmentSyntheticGroundTransitRouteProvider,
  UnconfiguredGroundTransitProvider,
} from '@travel/providers';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
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
  let currentNow: Date;
  let providerHook: (() => Promise<void>) | undefined;
  let tripRepository: PrismaTripRepository;

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
    currentNow = NOW;
    providerHook = undefined;
    providerResult = {
      status: 'SUCCESS',
      candidates: [candidate('2030-10-01T10:00:00Z', '2030-10-01T11:00:00Z')],
    };
    const repository = new PrismaTripRepository(managed.client);
    tripRepository = repository;
    const provider = new SyntheticRouteProvider(async (input) => {
      providerInputs.push(input);
      await providerHook?.();
      return providerResult;
    });
    app = buildTestApi(provider);
  });

  function buildTestApi(
    provider: RouteProvider,
    groundProvider: GroundTransitProvider = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    ),
  ): FastifyInstance {
    const routePlanningRepository = new PrismaRoutePlanningRepository(
      managed.client,
    );
    const groundTransitRepository = new PrismaGroundTransitRepository(
      managed.client,
    );
    const executionRiskService = new ExecutionRiskService(
      tripRepository,
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => currentNow, groundTransitRepository },
    );
    return buildApi({
      readinessProbe: {
        async check() {
          return { name: 'postgresql', status: 'READY' };
        },
      },
      authService: new AuthService(
        new PrismaAuthRepository(managed.client),
        authConfig(),
      ),
      tripService: new TripService(tripRepository),
      routeQueryService: new RouteQueryService(
        tripRepository,
        provider,
        routePlanningRepository,
        {
          candidateSnapshotTtlSeconds: 900,
          clock: { now: () => currentNow },
        },
      ),
      routePreviewService: new RoutePreviewService(
        tripRepository,
        routePlanningRepository,
        {
          previewTtlSeconds: 600,
          clock: { now: () => currentNow },
        },
      ),
      routeAdoptionService: new RouteAdoptionService(
        routePlanningRepository,
        new TripService(tripRepository),
        { undoWindowSeconds: 600, clock: { now: () => currentNow } },
      ),
      routeUndoService: new RouteUndoService(
        routePlanningRepository,
        new TripService(tripRepository),
        { now: () => currentNow },
      ),
      groundTransitService: new GroundTransitService(
        groundTransitRepository,
        groundProvider,
        () => currentNow,
        executionRiskService,
      ),
      groundTransitRouteReevaluationService:
        new GroundTransitRouteReevaluationService(
          tripRepository,
          groundTransitRepository,
          new PrismaGroundTransitRouteProgressRepository(managed.client),
          () => currentNow,
        ),
      executionRiskService,
    });
  }

  async function adoptedFixedGroundTrip(
    schedule: {
      readonly now: string;
      readonly departure: string;
      readonly arrival: string;
    } = {
      now: '2030-10-01T09:50:00Z',
      departure: '2030-10-01T10:00:00Z',
      arrival: '2030-10-01T11:00:00Z',
    },
  ) {
    currentNow = new Date(schedule.now);
    const trip = await tripWithVisits(userA, [
      'Ground origin',
      'Ground destination',
    ]);
    const [from, to] = trip.days[0]!.nodes;
    const base = candidate(schedule.departure, schedule.arrival, 'UTC', 'UTC');
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...base,
          observedAt: currentNow,
          candidateId: `ground-operational-${randomUUID()}`,
          legs: [
            {
              ...base.legs[0]!,
              mode: 'RAIL',
              groundTransit: {
                serviceClass: 'FIXED_SERVICE',
                serviceIdentityKey: 'synthetic:operational:1',
                lineRef: 'rail-1',
                lineName: 'Rail 1',
                directionRef: 'east',
                directionLabel: 'East',
                boardingHubRef: 'A',
                alightingHubRef: 'D',
                headwayMinSeconds: null,
                headwayMaxSeconds: null,
                minimumTransferSeconds: 300,
                boardingAccessMinimumSeconds: 0,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `ground-operational-${randomUUID()}`,
    );
    const leg = await managed.client.groundTransitLegExecution.findFirstOrThrow(
      {
        where: { tripId: trip.id },
      },
    );
    return { trip, adopted, leg, from: from! };
  }

  function groundSequence(
    changes: readonly (
      | 'CANCELLED'
      | 'RECOVERY'
      | 'RECOVERY_WITH_SERVICE_DEPARTURE'
      | 'SHORT_TURN'
      | 'ACTUAL_MISS'
      | 'DELAY_16'
      | 'DELAY_17'
      | 'DELAY_31'
    )[],
  ): GroundTransitProvider {
    let index = 0;
    let replay = false;
    return {
      name: 'SYNTHETIC',
      async fetchObservation({ leg }) {
        const selected = replay ? index - 1 : index++;
        const kind = changes[Math.min(selected, changes.length - 1)]!;
        const source = new SyntheticGroundTransitProvider(
          kind === 'SHORT_TURN' ? 'SHORT_TURN' : 'RECOVERY',
          () => currentNow,
        );
        const result = await source.fetchObservation({ leg });
        if (result.status !== 'SUCCESS') return result;
        const plannedArrival = leg.baseline?.plannedArrival ?? null;
        const delayMinutes =
          kind === 'DELAY_16'
            ? 16
            : kind === 'DELAY_17'
              ? 17
              : kind === 'DELAY_31'
                ? 31
                : null;
        return {
          status: 'SUCCESS',
          observation: {
            ...result.observation,
            observationIdentity: `operational:${leg.id}:${selected}`,
            serviceStatus:
              kind === 'CANCELLED'
                ? ('CANCELLED' as const)
                : delayMinutes === null
                  ? ('ON_TIME' as const)
                  : ('DELAYED' as const),
            estimatedArrival:
              delayMinutes === null || plannedArrival === null
                ? null
                : new Date(plannedArrival.getTime() + delayMinutes * 60_000),
            actualDeparture:
              kind === 'ACTUAL_MISS' ||
              kind === 'RECOVERY_WITH_SERVICE_DEPARTURE'
                ? new Date('2030-10-01T10:00:00Z')
                : null,
          },
        };
      },
      // Tests switch this flag only for an exact accepted-observation replay.
      setReplay(value: boolean) {
        replay = value;
      },
    } as GroundTransitProvider & { setReplay(value: boolean): void };
  }

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await resetSyntheticData(managed);
    await managed.close();
  });

  it('persists a candidate snapshot without mutating official Trip facts', async () => {
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
          candidateSnapshotId: expect.any(String),
          snapshotExpiresAt: '2030-09-01T00:15:00.000Z',
        },
      ],
    });
    expect(providerInputs[0]).toMatchObject({
      origin: { name: 'Tokyo' },
      destination: { name: 'Los Angeles' },
      earliestDeparture: new Date('2030-10-01T10:00:00Z'),
    });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(await databaseFacts(trip.id)).toEqual(before);
  });

  it('does not notify for a missing onward transfer when no protected connection exists', async () => {
    currentNow = new Date('2030-10-01T09:50:00Z');
    const trip = await tripWithVisits(userA, ['Bus origin', 'Bus destination']);
    const [from, to] = trip.days[0]!.nodes;
    const base = candidate(
      '2030-10-01T10:00:00Z',
      '2030-10-01T10:30:00Z',
      'UTC',
      'UTC',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...base,
          observedAt: currentNow,
          legs: [
            {
              ...base.legs[0]!,
              mode: 'BUS',
              fixedService: false,
              groundTransit: {
                serviceClass: 'HIGH_FREQUENCY',
                serviceIdentityKey: null,
                lineRef: 'bus-1',
                lineName: 'Bus 1',
                directionRef: 'east',
                directionLabel: 'East',
                boardingHubRef: 'origin',
                alightingHubRef: 'destination',
                headwayMinSeconds: 180,
                headwayMaxSeconds: 300,
                minimumTransferSeconds: null,
                boardingAccessMinimumSeconds: 0,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `no-onward-${randomUUID()}`,
    );
    const ground = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(ground.statusCode).toBe(200);
    const noOnwardSafety =
      ground.json<GroundTransitExecutionResponse>().legs[0]!.safety;
    expect(noOnwardSafety.boarding).toMatchObject({
      headwayWaitReserveSeconds: 300,
      totalSystemMinimumSeconds: 300,
    });
    expect(noOnwardSafety.transferToNext).toBeNull();
    expect(noOnwardSafety).not.toHaveProperty('totalSystemMinimumSeconds');
    expect(noOnwardSafety).not.toHaveProperty('transferMinimumSeconds');
    const recorded = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: adopted.trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: currentNow.toISOString(),
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(recorded.statusCode).toBe(200);
    const evaluated = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/evaluate`,
      headers: bearer(userA),
    });
    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json<{ risks: unknown[] }>().risks).toEqual([]);
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
  });

  it('reopens a baseline headway risk after fresh realtime expires and Provider becomes unavailable', async () => {
    currentNow = new Date('2030-10-01T09:56:00Z');
    await app.close();
    const routeProvider = createDevelopmentSyntheticGroundTransitRouteProvider(
      () => currentNow,
    );
    app = buildTestApi(
      routeProvider,
      new SyntheticGroundTransitProvider('NEXT_DEPARTURE_2', () => currentNow),
    );
    const trip = await tripWithVisits(userA, [
      'Ground origin',
      'Ground destination',
    ]);
    const [from, to] = trip.days[0]!.nodes;
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `ground-fallback-${randomUUID()}`,
    );
    const legs = await managed.client.groundTransitLegExecution.findMany({
      where: { tripId: trip.id },
      orderBy: { legIndex: 'asc' },
    });
    const high = legs.find((leg) => leg.serviceClass === 'HIGH_FREQUENCY')!;
    const initialGround = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(initialGround.statusCode).toBe(200);
    const initialSafety = initialGround
      .json<GroundTransitExecutionResponse>()
      .legs.find((leg) => leg.id === high.id)!.safety;
    expect(initialSafety.boarding).toMatchObject({
      headwayWaitReserveSeconds: 300,
      totalSystemMinimumSeconds: 300,
    });
    expect(initialSafety.transferToNext).toMatchObject({
      transferMinimumSeconds: 300,
      transferBasis: 'ADOPTED',
      totalSystemMinimumSeconds: 300,
    });
    expect(initialSafety).not.toHaveProperty('totalSystemMinimumSeconds');
    const recorded = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: adopted.trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: currentNow.toISOString(),
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(recorded.statusCode).toBe(200);
    const evaluate = () =>
      app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/execution/evaluate`,
        headers: bearer(userA),
      });
    expect(
      (await evaluate()).json<{ risks: { kind: string }[] }>().risks,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'BUFFER_BELOW_SYSTEM_MINIMUM' }),
      ]),
    );
    const refreshed = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${high.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      leg: {
        safety: {
          boarding: {
            headwayWaitReserveSeconds: 120,
            totalSystemMinimumSeconds: 120,
          },
          transferToNext: { totalSystemMinimumSeconds: 300 },
        },
      },
    });
    expect(
      (await evaluate())
        .json<{ risks: { sourceTransportEdgeId: string }[] }>()
        .risks.filter(
          (risk) => risk.sourceTransportEdgeId === high.transportEdgeId,
        ),
    ).toEqual([]);
    const observationCount =
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: high.id },
      });
    await app.close();
    app = buildTestApi(routeProvider, new UnconfiguredGroundTransitProvider());
    currentNow = new Date('2030-10-01T09:59:00Z');
    const unavailable = () =>
      app.inject({
        method: 'POST',
        url: `/trips/${trip.id}/execution/ground-transit/${high.transportEdgeId}/refresh`,
        headers: bearer(userA),
      });
    expect((await unavailable()).statusCode).toBe(503);
    expect(
      (await evaluate())
        .json<{ risks: { sourceTransportEdgeId: string }[] }>()
        .risks.filter(
          (risk) => risk.sourceTransportEdgeId === high.transportEdgeId,
        ),
    ).toEqual([]);
    currentNow = new Date('2030-10-01T10:05:00Z');
    await managed.client.tripAssistanceCapability.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: currentNow,
      },
    });
    const repository = new PrismaGroundTransitRepository(managed.client);
    const riskService = new ExecutionRiskService(
      tripRepository,
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => currentNow, groundTransitRepository: repository },
    );
    const monitor = new GroundTransitService(
      repository,
      new UnconfiguredGroundTransitProvider(),
      () => currentNow,
      riskService,
    );
    await expect(
      monitor.executeJob(high.adoptedRouteId, 1),
    ).rejects.toMatchObject({
      code: 'GROUND_TRANSIT_PROVIDER_UNAVAILABLE',
    });
    const reopened = await managed.client.executionRisk.findMany({
      where: {
        tripId: trip.id,
        sourceTransportEdgeId: high.transportEdgeId,
        status: 'OPEN',
      },
    });
    expect(reopened).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'BUFFER_BELOW_SYSTEM_MINIMUM' }),
      ]),
    );
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: high.id },
      }),
    ).toBe(observationCount);
    expect(
      (
        await managed.client.groundTransitLegExecution.findUniqueOrThrow({
          where: { id: high.id },
        })
      ).nextCheckAt,
    ).toEqual(new Date('2030-10-01T10:01:00Z'));
    await managed.client.groundTransitLegExecution.update({
      where: { id: high.id },
      data: {
        baseline: {
          ...(high.baseline as Record<string, unknown>),
          minimumTransferSeconds: null,
        } as never,
      },
    });
    const missingTransfer = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(missingTransfer.statusCode).toBe(200);
    const missingSafety = missingTransfer
      .json<GroundTransitExecutionResponse>()
      .legs.find((leg) => leg.id === high.id)!.safety;
    expect(missingSafety.boarding.totalSystemMinimumSeconds).toBe(300);
    expect(missingSafety.transferToNext).toMatchObject({
      transferMinimumSeconds: null,
      transferBasis: 'UNKNOWN',
      totalSystemMinimumSeconds: null,
      feasibility: 'UNKNOWN',
      reasonCodes: expect.arrayContaining(['TRANSFER_MINIMUM_UNKNOWN']),
    });
    expect(missingSafety).not.toHaveProperty('reasonCodes');
    currentNow = new Date('2030-10-01T10:06:00Z');
    const staleFailure = await unavailable();
    expect(staleFailure.statusCode).toBe(503);
    expect(staleFailure.json()).toMatchObject({
      error: { code: 'GROUND_TRANSIT_PROVIDER_UNAVAILABLE' },
    });
    const unknown = await managed.client.executionRisk.findFirst({
      where: {
        tripId: trip.id,
        sourceTransportEdgeId: high.transportEdgeId,
        kind: 'UNKNOWN_EXECUTION_MARGIN',
        status: 'OPEN',
      },
    });
    expect(unknown).toMatchObject({ severity: 'UNKNOWN' });
    await managed.client.groundTransitLegExecution.update({
      where: { id: high.id },
      data: {
        baseline: {
          ...(high.baseline as Record<string, unknown>),
          minimumTransferSeconds: 480,
        } as never,
      },
    });
    const knownTransfer = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(knownTransfer.statusCode).toBe(200);
    expect(
      knownTransfer
        .json<GroundTransitExecutionResponse>()
        .legs.find((leg) => leg.id === high.id)!.safety.transferToNext,
    ).toMatchObject({
      transferMinimumSeconds: 480,
      totalSystemMinimumSeconds: 480,
      transferBasis: 'ADOPTED',
    });
    const riskCountBeforePause = await managed.client.executionRisk.count({
      where: { tripId: trip.id },
    });
    const notificationCountBeforePause =
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      });
    await managed.client.tripAssistanceCapability.update({
      where: {
        tripId_kind: { tripId: trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      },
      data: { state: 'PAUSED', revision: 2, pausedAt: currentNow },
    });
    await expect(
      riskService.evaluateTripRisks(userA.actor, trip.id, {
        groupKey: 'stale-ground-monitor',
        sourceTransportEdgeId: high.transportEdgeId,
        expectedGroundTransitCapabilityRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
    expect(
      await managed.client.executionRisk.count({ where: { tripId: trip.id } }),
    ).toBe(riskCountBeforePause);
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(notificationCountBeforePause);
  });

  it('accepts cancellation once, aggregates one strong presentation, and restores the same adopted route', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    const groundProvider = groundSequence([
      'CANCELLED',
      'RECOVERY',
    ]) as GroundTransitProvider & { setReplay(value: boolean): void };
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundProvider,
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    const first = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        state: 'NO_LONGER_FEASIBLE',
        operational: {
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
          requiredAction: 'ROUTE_REEVALUATION_REQUIRED',
          changeKinds: ['SERVICE_CANCELLED'],
        },
      },
    });
    const active = await managed.client.notificationEvent.findMany({
      where: {
        tripId: trip.id,
        presentationGroupKey: {
          startsWith: `ground-transit-observation:${leg.id}:`,
        },
        presentationActive: true,
      },
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ priority: 'STRONG' });
    expect(active[0]!.changeKinds).toContain('SERVICE_CANCELLED');
    expect(
      await managed.client.transportEdge.count({
        where: { id: leg.transportEdgeId, adoptedRoute: { status: 'ACTIVE' } },
      }),
    ).toBe(1);
    const countBeforeReplay = await managed.client.notificationEvent.count({
      where: { tripId: trip.id },
    });
    groundProvider.setReplay(true);
    const replay = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(replay.json()).toMatchObject({ status: 'IDEMPOTENT' });
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(countBeforeReplay);
    expect(
      (
        await managed.client.groundTransitLegExecution.findUniqueOrThrow({
          where: { id: leg.id },
          select: { latestObservation: true },
        })
      ).latestObservation,
    ).toMatchObject({
      __groundTransitRiskDecision: `operational:${leg.id}:0:2030-10-01T09:50:00.000Z`,
    });
    groundProvider.setReplay(false);
    currentNow = new Date('2030-10-01T09:51:00Z');
    const correction = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(correction.statusCode).toBe(200);
    expect(correction.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        state: 'PENDING',
        operational: {
          disposition: 'CONTINUE_CURRENT_PLAN',
          changeKinds: ['SERVICE_RESTORED'],
        },
      },
    });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(2);
    expect(
      (
        await managed.client.groundTransitStateTransition.findMany({
          where: { legExecutionId: leg.id },
          orderBy: { occurredAt: 'asc' },
        })
      ).map((item) => item.toState),
    ).toEqual(['PENDING', 'NO_LONGER_FEASIBLE', 'PENDING']);
    const presentations = await managed.client.notificationEvent.findMany({
      where: {
        tripId: trip.id,
        presentationGroupKey: {
          startsWith: `ground-transit-observation:${leg.id}:`,
        },
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      presentations.filter((item) => item.presentationActive),
    ).toHaveLength(1);
    expect(
      presentations.some(
        (item) =>
          Array.isArray(item.changeKinds) &&
          item.changeKinds.includes('SERVICE_RESTORED'),
      ),
    ).toBe(true);
    expect(
      await managed.client.executionRisk.count({
        where: {
          tripId: trip.id,
          sourceTransportEdgeId: leg.transportEdgeId,
          kind: 'PROTECTED_TIME_INFEASIBLE',
          status: 'OPEN',
        },
      }),
    ).toBe(0);
    const oldDecision = await new PrismaExecutionRiskRepository(
      managed.client,
    ).reconcile({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      basisTripVersion: (
        await managed.client.trip.findUniqueOrThrow({
          where: { id: trip.id },
          select: { version: true },
        })
      ).version,
      now: currentNow,
      desiredRisks: [],
      expectedGroundTransitObservation: {
        transportEdgeId: leg.transportEdgeId,
        identity: `operational:${leg.id}:0`,
        fetchedAt: new Date('2030-10-01T09:50:00Z'),
      },
    });
    expect(oldDecision).toEqual({ status: 'OBSERVATION_OBSOLETE' });
  });

  it('hands off a cancelled active leg to explicit Query, Preview, and Adopt without planning side effects', async () => {
    const { trip, adopted, leg, from } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider((input) => {
        providerInputs.push(input);
        return providerResult;
      }),
      groundSequence(['CANCELLED']),
    );
    const refresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({
      leg: { operational: { requiredAction: 'ROUTE_REEVALUATION_REQUIRED' } },
    });
    const countsBefore = await Promise.all([
      managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
      managed.client.routePreview.count({ where: { tripId: trip.id } }),
      managed.client.operationReceipt.count({ where: { tripId: trip.id } }),
    ]);
    const handoffUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/route-reevaluation`;
    const forbidden = await app.inject({
      method: 'GET',
      url: handoffUrl,
      headers: bearer(userB),
    });
    expect(forbidden.statusCode).toBe(404);
    const handoffResponse = await app.inject({
      method: 'GET',
      url: handoffUrl,
      headers: bearer(userA),
    });
    expect(handoffResponse.statusCode).toBe(200);
    const handoff =
      handoffResponse.json() as GroundTransitRouteReevaluationHandoffView;
    const current = await managed.client.trip.findUniqueOrThrow({
      where: { id: trip.id },
    });
    expect(handoff).toMatchObject({
      adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
      readiness: 'READY',
      query: {
        basisVersion: current.version,
        fromNodeId: from.id,
        toNodeId: adopted.trip.days[0]!.nodes.at(-1)!.id,
        hint: {
          type: 'DEPART_AT',
          instant: currentNow.toISOString(),
          timeZone: 'UTC',
        },
      },
    });
    expect(
      await Promise.all([
        managed.client.routeCandidateSnapshot.count({
          where: { tripId: trip.id },
        }),
        managed.client.routePreview.count({ where: { tripId: trip.id } }),
        managed.client.operationReceipt.count({ where: { tripId: trip.id } }),
      ]),
    ).toEqual(countsBefore);
    expect(providerInputs).toHaveLength(1); // Only the original user query.

    const firstCandidate =
      providerResult.status === 'SUCCESS'
        ? providerResult.candidates[0]!
        : null;
    if (firstCandidate === null) throw new Error('Synthetic candidate missing');
    const originalLeg = firstCandidate.legs[0]!;
    if (
      originalLeg.groundTransit === undefined ||
      originalLeg.groundTransit === null
    )
      throw new Error('Ground transit metadata missing');
    if (handoff.query === null)
      throw new Error('READY handoff must include a query');
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...firstCandidate,
          candidateId: `replacement-${randomUUID()}`,
          providerCandidateRef: `replacement-${randomUUID()}`,
          legs: [
            {
              ...originalLeg,
              providerRef: `replacement-${randomUUID()}`,
              groundTransit: {
                ...originalLeg.groundTransit,
                serviceIdentityKey: 'synthetic:replacement:1',
              },
            },
          ],
        },
      ],
    };
    const queried = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userA),
      payload: handoff.query,
    });
    expect(queried.statusCode).toBe(200);
    const queryResult = queried.json() as RouteQueryResponse;
    expect(queryResult.candidates).toHaveLength(1);
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(countsBefore[0] + 1);
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: handoff.query!.basisVersion,
        candidateSnapshotId: queryResult.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    expect(preview.adoptable).toBe(true);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    const replacement = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: handoff.query!.basisVersion,
        idempotencyKey: randomUUID(),
      },
    });
    expect(replacement.statusCode).toBe(200);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'REPLACED' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ readiness: 'NOT_REQUIRED', query: null });
  });

  it('stops a recovered plan handoff and rejects an independently progressed origin', async () => {
    const { trip, leg, from } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED', 'RECOVERY']),
    );
    const refreshUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    const handoffUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/route-reevaluation`;
    await app.inject({
      method: 'POST',
      url: refreshUrl,
      headers: bearer(userA),
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ readiness: 'READY' });
    const departureFact = await managed.client.temporalValue.create({
      data: {
        nodeId: from.id,
        layer: 'ACTUAL',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T09:50:30Z'),
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({
      readiness: 'ORIGIN_UNRESOLVED',
      query: null,
      reasonCodes: expect.arrayContaining(['EXECUTION_ALREADY_PROGRESSING']),
    });
    await managed.client.temporalValue.delete({
      where: { id: departureFact.id },
    });
    currentNow = new Date('2030-10-01T09:51:00Z');
    await app.inject({
      method: 'POST',
      url: refreshUrl,
      headers: bearer(userA),
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: handoffUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ readiness: 'NOT_REQUIRED', query: null });
  });

  it('uses current Trip.version and leaves stale handoff queries to the existing version fence', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED']),
    );
    await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    const handoff = (
      await app.inject({
        method: 'GET',
        url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/route-reevaluation`,
        headers: bearer(userA),
      })
    ).json() as GroundTransitRouteReevaluationHandoffView;
    expect(handoff.readiness).toBe('READY');
    if (handoff.query === null) throw new Error('READY handoff has no query');
    const owned = await managed.client.trip.findUniqueOrThrow({
      where: { id: trip.id },
    });
    await managed.client.trip.update({
      where: { id: trip.id },
      data: { version: { increment: 1 } },
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/routes/query`,
      headers: bearer(userA),
      payload: handoff.query,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(handoff.query?.basisVersion).toBe(owned.version);
  });

  it('does not rewind independently confirmed destination arrival on a later provider cancellation', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await managed.client.groundTransitLegExecution.update({
      where: { id: leg.id },
      data: { state: 'ARRIVED_PENDING_HANDOFF' },
    });
    await managed.client.groundTransitStateTransition.create({
      data: {
        legExecutionId: leg.id,
        fromState: 'PENDING',
        toState: 'ARRIVED_PENDING_HANDOFF',
        source: 'LOCATION_ASSISTANCE',
        evidenceRef: 'node:destination-arrival',
        occurredAt: currentNow,
      },
    });
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED']),
    );
    const result = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`,
      headers: bearer(userA),
    });
    expect(result.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        state: 'ARRIVED_PENDING_HANDOFF',
        operational: { disposition: 'CONTINUE_CURRENT_PLAN' },
      },
    });
    expect(
      await managed.client.groundTransitStateTransition.count({
        where: { legExecutionId: leg.id, toState: 'NO_LONGER_FEASIBLE' },
      }),
    ).toBe(0);
  });

  it('does not infer user boarding from provider ACTUAL departure during recovery', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED', 'RECOVERY_WITH_SERVICE_DEPARTURE']),
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    expect(
      (
        await app.inject({ method: 'POST', url, headers: bearer(userA) })
      ).json(),
    ).toMatchObject({
      leg: { state: 'NO_LONGER_FEASIBLE' },
    });
    currentNow = new Date('2030-10-01T10:11:00Z');
    const recovered = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(recovered.json()).toMatchObject({
      status: 'APPLIED',
      leg: { state: 'PENDING' },
    });
    expect(
      await managed.client.temporalValue.findFirst({
        where: {
          transportEdgeId: leg.transportEdgeId,
          pointKind: 'DEPARTURE',
          layer: 'ACTUAL',
        },
      }),
    ).toMatchObject({ sourceKind: 'PROVIDER_OBSERVATION' });
  });

  it('restores the independent in-progress execution state after a temporary service failure', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await managed.client.groundTransitLegExecution.update({
      where: { id: leg.id },
      data: { state: 'IN_PROGRESS' },
    });
    await managed.client.groundTransitStateTransition.create({
      data: {
        legExecutionId: leg.id,
        fromState: 'PENDING',
        toState: 'IN_PROGRESS',
        source: 'LOCATION_ASSISTANCE',
        evidenceRef: 'node:boarding-departure',
        occurredAt: currentNow,
      },
    });
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['SHORT_TURN', 'RECOVERY']),
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    expect(
      (
        await app.inject({ method: 'POST', url, headers: bearer(userA) })
      ).json(),
    ).toMatchObject({
      leg: { state: 'NO_LONGER_FEASIBLE' },
    });
    currentNow = new Date('2030-10-01T09:51:00Z');
    expect(
      (
        await app.inject({ method: 'POST', url, headers: bearer(userA) })
      ).json(),
    ).toMatchObject({
      status: 'APPLIED',
      leg: { state: 'IN_PROGRESS' },
    });
    expect(
      (
        await managed.client.groundTransitStateTransition.findFirstOrThrow({
          where: { legExecutionId: leg.id, toState: 'NO_LONGER_FEASIBLE' },
          orderBy: { occurredAt: 'desc' },
        })
      ).fromState,
    ).toBe('IN_PROGRESS');
  });

  it('does not repeat a persistent material-delay presentation or create blank text', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence([
        'DELAY_16',
        'DELAY_16',
        'DELAY_17',
        'DELAY_31',
        'RECOVERY',
      ]),
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    for (const [index, expectedCount] of [1, 1, 1, 2, 2].entries()) {
      currentNow = new Date(Date.UTC(2030, 9, 1, 9, 50 + index));
      const response = await app.inject({
        method: 'POST',
        url,
        headers: bearer(userA),
      });
      expect(response.json()).toMatchObject({ status: 'APPLIED' });
      const presentations = await managed.client.notificationEvent.findMany({
        where: {
          tripId: trip.id,
          presentationGroupKey: {
            startsWith: `ground-transit-observation:${leg.id}:`,
          },
        },
      });
      expect(presentations).toHaveLength(expectedCount);
      expect(
        presentations.filter((item) => item.presentationActive),
      ).toHaveLength(index < 4 ? 1 : 0);
      expect(
        presentations.every(
          (item) =>
            item.body.trim().length > 0 &&
            (item.summary?.trim().length ?? 0) > 0,
        ),
      ).toBe(true);
    }
  });

  it.each([
    {
      name: 'departure platform',
      facts: [
        { departurePlatform: '2' },
        { departurePlatform: '5' },
        { departurePlatform: '5' },
        { departurePlatform: '5' },
      ],
      expectedKind: 'DEPARTURE_PLATFORM_CHANGED',
    },
    {
      name: 'early departure',
      facts: [
        { estimatedDeparture: null },
        { estimatedDeparture: '2030-10-01T11:50:00Z' },
        { estimatedDeparture: '2030-10-01T11:50:00Z' },
        { estimatedDeparture: '2030-10-01T11:50:00Z' },
      ],
      expectedKind: 'EARLY_DEPARTURE',
    },
    {
      name: 'material delay under the near-window policy',
      facts: [
        { estimatedArrival: null },
        { estimatedArrival: '2030-10-01T13:20:00Z' },
        { estimatedArrival: '2030-10-01T13:20:00Z' },
        { estimatedArrival: '2030-10-01T13:20:00Z' },
      ],
      expectedKind: 'MATERIAL_DELAY',
    },
  ])(
    'activates a persistent $name incident once when entering the execution window',
    async ({ facts, expectedKind }) => {
      const { trip, leg } = await adoptedFixedGroundTrip({
        now: '2030-10-01T09:00:00Z',
        departure: '2030-10-01T12:00:00Z',
        arrival: '2030-10-01T13:00:00Z',
      });
      let index = 0;
      const groundProvider: GroundTransitProvider = {
        name: 'SYNTHETIC',
        async fetchObservation({ leg: currentLeg }) {
          const source = await new SyntheticGroundTransitProvider(
            'RECOVERY',
            () => currentNow,
          ).fetchObservation({ leg: currentLeg });
          if (source.status !== 'SUCCESS') return source;
          const fact = facts[Math.min(index, facts.length - 1)]! as {
            departurePlatform?: string;
            estimatedDeparture?: string | null;
            estimatedArrival?: string | null;
          };
          const result = {
            ...source.observation,
            observationIdentity: `attention:${currentLeg.id}:${index++}`,
            departurePlatform: fact.departurePlatform ?? null,
            estimatedDeparture:
              fact.estimatedDeparture === undefined ||
              fact.estimatedDeparture === null
                ? null
                : new Date(fact.estimatedDeparture),
            estimatedArrival:
              fact.estimatedArrival === undefined ||
              fact.estimatedArrival === null
                ? null
                : new Date(fact.estimatedArrival),
            serviceStatus:
              fact.estimatedArrival === undefined ||
              fact.estimatedArrival === null
                ? ('ON_TIME' as const)
                : ('DELAYED' as const),
          };
          return { status: 'SUCCESS', observation: result };
        },
      };
      await app.close();
      app = buildTestApi(
        new SyntheticRouteProvider(() => providerResult),
        groundProvider,
      );
      const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
      const samples = [
        '2030-10-01T09:05:00Z',
        '2030-10-01T09:30:00Z',
        '2030-10-01T11:20:00Z',
        '2030-10-01T11:25:00Z',
      ];
      for (const [sampleIndex, instant] of samples.entries()) {
        currentNow = new Date(instant);
        if (sampleIndex === 3) {
          // A fresh service instance must honor the persisted presentation state.
          await app.close();
          app = buildTestApi(
            new SyntheticRouteProvider(() => providerResult),
            groundProvider,
          );
        }
        const response = await app.inject({
          method: 'POST',
          url,
          headers: bearer(userA),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: 'APPLIED' });
        const presentations = await managed.client.notificationEvent.findMany({
          where: {
            tripId: trip.id,
            presentationGroupKey: {
              startsWith: `ground-transit-observation:${leg.id}:`,
            },
          },
        });
        expect(presentations).toHaveLength(sampleIndex < 2 ? 0 : 1);
        if (sampleIndex >= 2) {
          expect(presentations[0]).toMatchObject({
            presentationActive: true,
          });
          expect(presentations[0]!.changeKinds).toContain(expectedKind);
          expect(presentations[0]!.summary?.trim().length).toBeGreaterThan(0);
          expect(presentations[0]!.body.trim().length).toBeGreaterThan(0);
          if (expectedKind === 'DEPARTURE_PLATFORM_CHANGED') {
            expect(presentations[0]!.summary).toContain('5');
          }
        }
      }
      const stored = await managed.client.groundTransitObservation.findMany({
        where: { legExecutionId: leg.id },
      });
      expect(stored).toHaveLength(4);
      expect(
        stored.every(
          (item) =>
            !Object.hasOwn(
              item.facts as Record<string, unknown>,
              '__groundTransitAttention',
            ),
        ),
      ).toBe(true);
    },
  );

  it('marks a skipped adopted stop infeasible and refuses to revive an actual missed service', async () => {
    const { trip, leg, adopted, from } = await adoptedFixedGroundTrip();
    const groundProvider = groundSequence([
      'SHORT_TURN',
      'RECOVERY',
      'ACTUAL_MISS',
      'RECOVERY',
    ]);
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundProvider,
    );
    const url = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    const shortTurn = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(shortTurn.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: {
          targetServiceability: { alighting: 'NOT_SERVED' },
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
        },
      },
    });
    currentNow = new Date('2030-10-01T09:51:00Z');
    const restored = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(restored.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: { disposition: 'CONTINUE_CURRENT_PLAN' },
      },
    });
    currentNow = new Date('2030-10-01T10:11:00Z');
    const actualArrival = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: adopted.trip.version,
        subject: { type: 'NODE', nodeId: from.id },
        value: {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:10:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(actualArrival.statusCode).toBe(200);
    const missed = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(missed.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: {
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
          irreversibleActualMiss: true,
        },
      },
    });
    currentNow = new Date('2030-10-01T10:12:00Z');
    const impossibleCorrection = await app.inject({
      method: 'POST',
      url,
      headers: bearer(userA),
    });
    expect(impossibleCorrection.json()).toMatchObject({
      status: 'APPLIED',
      leg: {
        operational: {
          disposition: 'CURRENT_PLAN_NO_LONGER_FEASIBLE',
          irreversibleActualMiss: true,
        },
      },
    });
    expect(
      await managed.client.transportEdge.count({
        where: { id: leg.transportEdgeId },
      }),
    ).toBe(1);
  });

  it('fences an old service recovery after the user adopts a replacement', async () => {
    const { trip, leg, from } = await adoptedFixedGroundTrip();
    const previousTo = trip.days[0]!.nodes[1]!;
    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      groundSequence(['CANCELLED', 'RECOVERY']),
    );
    const oldUrl = `/trips/${trip.id}/execution/ground-transit/${leg.transportEdgeId}/refresh`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: oldUrl,
          headers: bearer(userA),
        })
      ).json(),
    ).toMatchObject({ status: 'APPLIED' });
    const changed = providerResult;
    if (changed.status !== 'SUCCESS')
      throw new Error('synthetic candidate missing');
    providerResult = {
      status: 'SUCCESS',
      candidates: changed.candidates.map((item) => ({
        ...item,
        candidateId: `replacement-${randomUUID()}`,
        legs: item.legs.map((segment) => ({
          ...segment,
          groundTransit:
            segment.groundTransit === null ||
            segment.groundTransit === undefined
              ? null
              : {
                  ...segment.groundTransit,
                  serviceIdentityKey: 'synthetic:replacement:2',
                },
        })),
      })),
    };
    const currentTripResponse = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}`,
      headers: bearer(userA),
    });
    expect(currentTripResponse.statusCode).toBe(200);
    const currentTrip = currentTripResponse.json() as TripView;
    const preview = await createPreview(
      userA,
      currentTrip,
      from.id,
      previousTo.id,
    );
    await adoptSuccessfully(
      userA,
      currentTrip,
      preview.previewId,
      `replacement-${randomUUID()}`,
    );
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: leg.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'REPLACED' });
    const oldRefresh = await app.inject({
      method: 'POST',
      url: oldUrl,
      headers: bearer(userA),
    });
    expect(oldRefresh.statusCode).toBe(404);
    const oldGround =
      await managed.client.groundTransitLegExecution.findUniqueOrThrow({
        where: { id: leg.id },
      });
    expect(oldGround).toMatchObject({
      latestObservationId: `operational:${leg.id}:0`,
      state: 'NO_LONGER_FEASIBLE',
    });
  });

  it('fences a delayed cancellation response after monitoring is paused', async () => {
    const { trip, leg } = await adoptedFixedGroundTrip();
    await managed.client.tripAssistanceCapability.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: currentNow,
      },
    });
    const synthetic = new SyntheticGroundTransitProvider(
      'CANCEL_FIXED',
      () => currentNow,
    );
    const repository = new PrismaGroundTransitRepository(managed.client);
    const monitor = new GroundTransitService(
      repository,
      {
        name: 'SYNTHETIC',
        async fetchObservation(input) {
          await managed.client.tripAssistanceCapability.update({
            where: {
              tripId_kind: {
                tripId: trip.id,
                kind: 'GROUND_TRANSIT_MONITORING',
              },
            },
            data: { state: 'PAUSED', revision: 2, pausedAt: currentNow },
          });
          return synthetic.fetchObservation(input);
        },
      },
      () => currentNow,
      new ExecutionRiskService(
        tripRepository,
        new PrismaExecutionRiskRepository(managed.client),
        { now: () => currentNow, groundTransitRepository: repository },
      ),
    );
    await monitor.executeJob(leg.adoptedRouteId, 1);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.notificationEvent.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.executionRisk.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
  });

  it('persists adopted fixed-service ground identity, refreshes owner-only, and retains archived evidence', async () => {
    const trip = await tripWithVisits(userA, ['Ground A', 'Ground B']);
    const [from, to] = trip.days[0]!.nodes;
    const original = candidate(
      '2030-10-01T10:00:00Z',
      '2030-10-01T11:00:00Z',
      'UTC',
      'UTC',
    );
    const firstLeg = original.legs[0]!;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...original,
          candidateId: 'ground-fixed-candidate',
          legs: [
            {
              ...firstLeg,
              mode: 'RAIL',
              groundTransit: {
                serviceClass: 'FIXED_SERVICE',
                serviceIdentityKey: 'synthetic:rail:2030-10-01:1',
                lineRef: 'rail-1',
                lineName: 'Rail 1',
                directionRef: 'east',
                directionLabel: 'East',
                boardingHubRef: 'hub-a',
                alightingHubRef: 'hub-b',
                headwayMinSeconds: null,
                headwayMaxSeconds: null,
                minimumTransferSeconds: 300,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `ground-adopt-${randomUUID()}`,
    );
    const edge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: trip.id, source: 'ADOPTED_ROUTE' },
    });
    const leg =
      await managed.client.groundTransitLegExecution.findUniqueOrThrow({
        where: { transportEdgeId: edge.id },
      });
    expect(leg).toMatchObject({
      serviceClass: 'FIXED_SERVICE',
      serviceIdentityKey: 'synthetic:rail:2030-10-01:1',
    });
    expect((leg.baseline as Record<string, unknown>).schemaVersion).toBe(
      'ground-transit-baseline-v1',
    );
    const otherRead = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userB),
    });
    expect(otherRead.statusCode).toBe(404);
    const otherRefresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userB),
    });
    expect(otherRefresh.statusCode).toBe(404);
    const syntheticGround = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    );
    let cachedResult:
      | Awaited<ReturnType<GroundTransitProvider['fetchObservation']>>
      | undefined;
    await app.close();
    app = buildTestApi(new SyntheticRouteProvider(() => providerResult), {
      name: 'SYNTHETIC',
      async fetchObservation(input) {
        cachedResult ??= await syntheticGround.fetchObservation(input);
        return cachedResult;
      },
    });
    const refresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toMatchObject({
      status: 'APPLIED',
      leg: { serviceClass: 'FIXED_SERVICE', observationCount: 1 },
    });
    const estimated = await managed.client.temporalValue.findFirstOrThrow({
      where: {
        transportEdgeId: edge.id,
        layer: 'ESTIMATED',
        pointKind: 'DEPARTURE',
      },
    });
    expect(estimated).toMatchObject({
      sourceKind: 'PROVIDER_OBSERVATION',
      instant: new Date('2030-10-01T10:10:00Z'),
    });
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: adopted.trip.version + 1 });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);
    const savedObservation =
      await managed.client.groundTransitObservation.findFirstOrThrow({
        where: { legExecutionId: leg.id },
      });
    expect(estimated.sourceRef).toBe(
      `ground-transit-observation:${savedObservation.id}`,
    );
    const replay = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'IDEMPOTENT' });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: adopted.trip.version + 1 });
    expect(
      await managed.client.groundTransitStateTransition.findMany({
        where: { legExecutionId: leg.id },
        orderBy: { occurredAt: 'asc' },
      }),
    ).toMatchObject([
      { fromState: null, toState: 'PENDING', source: 'ROUTE_ADOPT' },
    ]);

    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      new SyntheticGroundTransitProvider('STALE', () => currentNow),
    );
    const stale = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({
      status: 'STALE_IGNORED',
      leg: { observationCount: 1 },
    });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(1);

    currentNow = new Date('2030-10-01T09:30:00Z');
    await managed.client.tripAssistanceCapability.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: currentNow,
      },
    });
    const monitorProvider = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    );
    const monitor = new GroundTransitService(
      new PrismaGroundTransitRepository(managed.client),
      {
        name: 'SYNTHETIC',
        async fetchObservation(input) {
          const result = await monitorProvider.fetchObservation(input);
          return result.status === 'SUCCESS'
            ? {
                status: 'SUCCESS',
                observation: {
                  ...result.observation,
                  observationIdentity: `background:${result.observation.observationIdentity}`,
                },
              }
            : result;
        },
      },
      () => currentNow,
    );
    await monitor.executeJob(leg.adoptedRouteId, 1);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(2);
    await managed.client.tripAssistanceCapability.update({
      where: {
        tripId_kind: { tripId: trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      },
      data: { state: 'PAUSED', revision: 2, pausedAt: currentNow },
    });
    await monitor.executeJob(leg.adoptedRouteId, 1);
    await managed.client.tripAssistanceCapability.update({
      where: {
        tripId_kind: { tripId: trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      },
      data: { state: 'ENABLED', revision: 3, resumedAt: currentNow },
    });
    await monitor.executeJob(leg.adoptedRouteId, 1);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(2);
    currentNow = new Date('2030-10-01T09:36:00Z');
    await monitor.executeJob(leg.adoptedRouteId, 3);
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(3);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: adopted.trip.version + 1 });

    await app.close();
    app = buildTestApi(
      new SyntheticRouteProvider(() => providerResult),
      new SyntheticGroundTransitProvider('IDENTITY_MISMATCH', () => currentNow),
    );
    const mismatch = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.json()).toMatchObject({ status: 'DIFFERENT_SERVICE' });
    expect(
      await managed.client.groundTransitObservation.count({
        where: { legExecutionId: leg.id },
      }),
    ).toBe(3);

    currentNow = new Date('2030-10-01T10:05:00Z');
    await app.close();
    const actualProvider = new SyntheticGroundTransitProvider(
      'ACTUAL_DEPARTURE',
      () => currentNow,
    );
    app = buildTestApi(new SyntheticRouteProvider(() => providerResult), {
      name: 'SYNTHETIC',
      async fetchObservation(input) {
        const result = await actualProvider.fetchObservation(input);
        return result.status === 'SUCCESS'
          ? {
              status: 'SUCCESS',
              observation: {
                ...result.observation,
                observationIdentity: `actual-test:${result.observation.observationIdentity}`,
              },
            }
          : result;
      },
    });
    const actualRefresh = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(actualRefresh.statusCode).toBe(200);
    expect(actualRefresh.json()).toMatchObject({ status: 'APPLIED' });
    const actual = await managed.client.temporalValue.findUniqueOrThrow({
      where: {
        transportEdgeId_pointKind_layer: {
          transportEdgeId: edge.id,
          pointKind: 'DEPARTURE',
          layer: 'ACTUAL',
        },
      },
    });
    expect(actual).toMatchObject({
      instant: new Date('2030-10-01T10:00:00Z'),
      sourceKind: 'PROVIDER_OBSERVATION',
    });
    currentNow = new Date('2030-10-01T10:10:00Z');
    await app.close();
    const lateEstimateProvider = new SyntheticGroundTransitProvider(
      'FIXED_DELAY',
      () => currentNow,
    );
    app = buildTestApi(new SyntheticRouteProvider(() => providerResult), {
      name: 'SYNTHETIC',
      async fetchObservation(input) {
        const result = await lateEstimateProvider.fetchObservation(input);
        return result.status === 'SUCCESS'
          ? {
              status: 'SUCCESS',
              observation: {
                ...result.observation,
                observationIdentity: `late-estimate:${result.observation.observationIdentity}`,
              },
            }
          : result;
      },
    });
    const lateEstimate = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/execution/ground-transit/${edge.id}/refresh`,
      headers: bearer(userA),
    });
    expect(lateEstimate.statusCode).toBe(200);
    expect(lateEstimate.json()).toMatchObject({ status: 'APPLIED' });
    expect(
      await managed.client.temporalValue.findUniqueOrThrow({
        where: {
          transportEdgeId_pointKind_layer: {
            transportEdgeId: edge.id,
            pointKind: 'DEPARTURE',
            layer: 'ACTUAL',
          },
        },
      }),
    ).toMatchObject({ instant: actual.instant, sourceRef: actual.sourceRef });

    await managed.client.groundTransitLegExecution.delete({
      where: { id: leg.id },
    });
    const legacy = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/execution/ground-transit`,
      headers: bearer(userA),
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toMatchObject({
      legs: [
        {
          transportEdgeId: edge.id,
          state: 'UNKNOWN',
          serviceClass: null,
          baseline: null,
          current: true,
        },
      ],
    });
  });

  it('runs the Google Consumer adapter through snapshot, preview, adopt, and undo', async () => {
    currentNow = new Date('2026-09-20T05:00:00.000Z');
    const fetchImplementation = vi.fn(async (_url, init) => {
      const requestedQuery = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify(googleConsumerHokkaidoFixture(requestedQuery)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await app.close();
    app = buildTestApi(
      new GoogleConsumerExperimentalRouteProvider({
        baseUrl: 'http://127.0.0.1:8787',
        token: 'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
        timeoutMs: 1_000,
        fetchImplementation,
      }),
    );

    const trip = await tripWithVisitsOnDate(
      userA,
      ['Hotel Mahoroba', '洞爷湖景乃之风'],
      '2026-09-23',
    );
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    await Promise.all([
      managed.client.place.update({
        where: { id: from!.place!.id },
        data: { latitude: 42.4930624, longitude: 141.1419064 },
      }),
      managed.client.place.update({
        where: { id: to!.place!.id },
        data: { latitude: 42.565637, longitude: 140.8222622 },
      }),
    ]);
    const flightsBefore = await managed.client.flightBinding.count();
    const routeResponse = await query(userA, trip, from!.id, to!.id, {
      type: 'DEPART_AT',
      instant: '2026-09-23T15:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    });

    expect(routeResponse.statusCode).toBe(200);
    const route = routeResponse.json() as RouteQueryResponse;
    expect(route.candidates[0]).toMatchObject({
      provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
      providerCandidateRef: 'sanitized-hokkaido-01',
      fare: { amount: '3910', currency: 'JPY' },
      legs: googleExpectedLegs(),
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const snapshot =
      await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
        where: { id: route.candidates[0]!.candidateSnapshotId },
      });
    expect(snapshot).toMatchObject({
      provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
      providerCandidateRef: 'sanitized-hokkaido-01',
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(snapshot.candidatePayload).toMatchObject({
      fare: { amount: '3910', currency: 'JPY' },
      legs: googleExpectedLegs(),
    });
    expect(JSON.stringify(snapshot.candidatePayload)).not.toContain(
      'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
    );
    expect(JSON.stringify(snapshot.candidatePayload)).not.toContain(
      'requestedQuery',
    );

    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.nodesToCreate).toHaveLength(6);
    expect(preview.changeSummary.proposedSegments).toMatchObject(
      googleExpectedLegs(),
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `google-consumer-adopt-${randomUUID()}`,
    );
    expect(adopted.trip.version).toBe(trip.version + 1);
    expect(
      adopted.trip.days
        .flatMap((day) => day.nodes)
        .filter((node) => node.source === 'ROUTE_GENERATED'),
    ).toHaveLength(6);
    expect(
      adopted.trip.connections.map((connection) => ({
        mode: connection.transport?.mode,
        fixedService: connection.transport?.fixedService,
        provider: connection.transport?.provider,
        providerRef: connection.transport?.providerRef,
      })),
    ).toEqual(
      googleExpectedLegs().map((leg, index) => ({
        ...leg,
        provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
        providerRef: `sanitized-hokkaido-01:leg:${index}`,
      })),
    );
    const adoptedEdges = await managed.client.transportEdge.findMany({
      where: { tripId: trip.id },
    });
    const adoptedTimes = await managed.client.temporalValue.findMany({
      where: { transportEdgeId: { in: adoptedEdges.map((edge) => edge.id) } },
      orderBy: { instant: 'asc' },
    });
    expect(adoptedTimes).toHaveLength(14);
    expect(adoptedTimes[0]).toMatchObject({
      layer: 'PLANNED',
      sourceKind: 'ADOPTED_TRANSPORT_FACT',
      instant: new Date('2026-09-23T06:00:00.000Z'),
    });
    expect(adoptedTimes.at(-1)).toMatchObject({
      layer: 'PLANNED',
      sourceKind: 'ADOPTED_TRANSPORT_FACT',
      instant: new Date('2026-09-23T08:00:00.000Z'),
    });
    expect(adopted.operationReceipt).toMatchObject({
      operationType: 'ROUTE_ADOPT',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      `google-consumer-undo-${randomUUID()}`,
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
    expect(undone.operationReceipt.operationType).toBe('ROUTE_UNDO');
    expect(
      undone.trip.days
        .flatMap((day) => day.nodes)
        .filter((node) => node.source === 'ROUTE_GENERATED'),
    ).toHaveLength(0);
    expect(undone.trip.connections).toMatchObject([{ state: 'MISSING' }]);
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { id: snapshot.id },
      }),
    ).toBe(1);
    expect(await managed.client.flightBinding.count()).toBe(flightsBefore);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('maps the sidecar unsupported ARRIVE_BY envelope to HTTP 422', async () => {
    const fetchImplementation = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'ERROR',
            error: {
              code: 'UNSUPPORTED_MODE',
              message: 'ARRIVE_BY is not enabled',
            },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await app.close();
    app = buildTestApi(
      new GoogleConsumerExperimentalRouteProvider({
        baseUrl: 'http://127.0.0.1:8787',
        token: 'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
        timeoutMs: 1_000,
        fetchImplementation,
      }),
    );
    const trip = await tripWithVisits(userA, ['Tokyo', 'Shinjuku']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);

    const response = await query(userA, trip, from!.id, to!.id, {
      type: 'ARRIVE_BY',
      instant: '2030-10-01T20:00:00+09:00',
      timeZone: 'Asia/Tokyo',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('runs ARRIVE_BY through the Google adapter, snapshot, preview, adopt, and undo', async () => {
    currentNow = new Date('2026-09-20T05:00:00.000Z');
    const fetchImplementation = vi.fn(async (_url, init) => {
      const requestedQuery = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify(googleConsumerHokkaidoFixture(requestedQuery)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    await app.close();
    app = buildTestApi(
      new GoogleConsumerExperimentalRouteProvider({
        baseUrl: 'http://127.0.0.1:8787',
        token: 'SYNTHETIC_INTEGRATION_TOKEN_DO_NOT_LOG',
        timeoutMs: 1_000,
        fetchImplementation,
      }),
    );
    const trip = await tripWithVisitsOnDate(
      userA,
      ['Hotel Mahoroba', '洞爷湖景乃之风'],
      '2026-09-23',
    );
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const response = await query(userA, trip, from!.id, to!.id, {
      type: 'ARRIVE_BY',
      instant: '2026-09-23T17:30:00+09:00',
      timeZone: 'Asia/Tokyo',
    });
    expect(response.statusCode).toBe(200);
    const route = response.json() as RouteQueryResponse;
    expect(route.candidates[0]).toMatchObject({
      provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
      providerCandidateRef: 'sanitized-hokkaido-01',
      fare: { amount: '3910', currency: 'JPY' },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(fetchImplementation.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      timeMode: 'ARRIVE_BY',
      date: '2026-09-23',
      time: '17:30',
      timezone: 'Asia/Tokyo',
    });
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    expect(preview.adoptable).toBe(true);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      `google-consumer-arrive-by-adopt-${randomUUID()}`,
    );
    expect(adopted.trip.version).toBe(trip.version + 1);
    expect(adopted.operationReceipt.operationType).toBe('ROUTE_ADOPT');
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      `google-consumer-arrive-by-undo-${randomUUID()}`,
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
    expect(undone.operationReceipt.operationType).toBe('ROUTE_UNDO');
    expect(undone.trip.connections).toMatchObject([{ state: 'MISSING' }]);
  });

  it('creates and re-reads an immutable Preview without changing official Trip facts', async () => {
    const trip = await tripWithVisits(userA, ['Tokyo', 'Los Angeles']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const before = await databaseFacts(trip.id);
    const routeResponse = await query(
      userA,
      trip,
      from!.id,
      to!.id,
      departHint(),
    );
    const route = routeResponse.json() as RouteQueryResponse;

    const createResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const preview = createResponse.json() as { previewId: string } & Record<
      string,
      unknown
    >;
    expect(preview).toMatchObject({
      basisVersion: trip.version,
      candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      status: 'ACTIVE',
      adoptable: true,
      currentConnection: { state: 'MISSING', transport: null },
      changeSummary: {
        transportAction: 'CREATE',
        requiresGeneratedNodes: false,
        temporalLayer: 'PLANNED',
        temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
      },
    });
    expect(await databaseFacts(trip.id)).toEqual(before);
    expect(
      await managed.client.routePreview.count({ where: { tripId: trip.id } }),
    ).toBe(1);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/previews/${preview.previewId}`,
      headers: bearer(userA),
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toEqual(preview);
    expect(providerInputs).toHaveLength(1);
  });

  it('returns NOT_FOUND across owner boundaries and marks expired Preview non-adoptable', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    const routeResponse = await query(
      userA,
      trip,
      from!.id,
      to!.id,
      departHint(),
    );
    const route = routeResponse.json() as RouteQueryResponse;

    let response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userB),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(response.statusCode).toBe(404);

    response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(response.statusCode).toBe(201);
    const previewId = (response.json() as { previewId: string }).previewId;

    const hiddenPreview = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/previews/${previewId}`,
      headers: bearer(userB),
    });
    expect(hiddenPreview.statusCode).toBe(404);
    currentNow = new Date(NOW.getTime() + 901_000);

    const staleCreate = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(staleCreate.statusCode).toBe(409);
    expect(staleCreate.json()).toMatchObject({
      error: { code: 'PREVIEW_STALE' },
    });

    response = await app.inject({
      method: 'GET',
      url: `/trips/${trip.id}/previews/${previewId}`,
      headers: bearer(userA),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      previewId,
      status: 'EXPIRED',
      adoptable: false,
    });
  });

  it('does not persist a snapshot when the Trip changes during Provider I/O', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    providerHook = async () => {
      const mutation = await app.inject({
        method: 'PATCH',
        url: `/trips/${trip.id}`,
        headers: bearer(userA),
        payload: {
          baseTripVersion: trip.version,
          name: 'SYNTHETIC changed during provider call',
        },
      });
      expect(mutation.statusCode).toBe(200);
    };

    const response = await query(userA, trip, from!.id, to!.id, departHint());
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
    });
    expect(
      await managed.client.routeCandidateSnapshot.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
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
    expect(response.json()).toMatchObject({
      error: { code: 'NO_MATCHING_CANDIDATE' },
    });
  });

  it('rejects missing time, stale version, non-adjacent nodes, and FreeAction endpoints', async () => {
    let trip = await tripWithVisits(userA, ['A', 'B', 'C']);
    const [a, b, c] = trip.days[0]!.nodes;

    let response = await query(userA, trip, a!.id, b!.id, null);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_QUERY_TIME_REQUIRED' },
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
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
    });

    response = await query(userA, trip, a!.id, c!.id, departHint());
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
    });

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
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
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

  it('shows a 15-minute-lookback candidate, adopts one MIN_DWELL adjustment, and restores it on Undo', async () => {
    let trip = await tripWithVisits(userA, ['Current place', 'Next place']);
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    const temporal = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(temporal.statusCode).toBe(200);
    trip = temporal.json() as TripView;
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3_000,
      locked: false,
    });
    const suggested = await tripRepository.setSystemDwellSuggestion({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      nodeId: from!.id,
      durationSeconds: 3_600,
    });
    expect(suggested.status).toBe('SUCCESS');
    if (suggested.status !== 'SUCCESS') throw new Error('suggestion failed');
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);

    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:34:59Z', '2030-10-01T11:34:59Z', 'UTC', 'UTC'),
        candidate('2030-10-01T10:45:00Z', '2030-10-01T11:45:00Z', 'UTC', 'UTC'),
      ],
    };
    const routeResponse = await query(userA, trip, from!.id, to!.id, null);
    expect(routeResponse.statusCode).toBe(200);
    const route = routeResponse.json() as RouteQueryResponse;
    expect(providerInputs[0]?.earliestDeparture?.toISOString()).toBe(
      '2030-10-01T10:35:00.000Z',
    );
    expect(route.candidates[0]?.planningAssessment).toMatchObject({
      effectiveTotalTimeSeconds: 3_300,
      requiresUserAdjustment: true,
      requiredUserAdjustments: [
        {
          nodeId: from!.id,
          fromDurationSeconds: 3_000,
          toDurationSeconds: 2_700,
        },
      ],
    });
    expect(route.candidates).toHaveLength(1);

    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json() as RoutePreviewView;
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toHaveLength(1);

    const unconfirmed = await adopt(
      userA,
      trip,
      preview.previewId,
      `p5c-unconfirmed-${randomUUID()}`,
    );
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({
      error: { code: 'USER_ADJUSTMENT_REQUIRED' },
    });

    const adjustmentAdoptKey = `p5c-adopt-${randomUUID()}`;
    const adoptedResponse = await adopt(
      userA,
      trip,
      preview.previewId,
      adjustmentAdoptKey,
      adjustments,
    );
    expect(adoptedResponse.statusCode).toBe(200);
    const adopted = adoptedResponse.json() as {
      operationReceipt: { id: string; delta: { schemaVersion: string } };
      trip: TripView;
    };
    expect(adopted.operationReceipt.delta.schemaVersion).toBe(
      'route-adopt-delta-v3',
    );
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { tripId: trip.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 2_700 });

    const replay = await adopt(
      userA,
      trip,
      preview.previewId,
      adjustmentAdoptKey,
      adjustments,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: adopted.operationReceipt.id },
      trip: { version: adopted.trip.version },
    });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id, operationType: 'ROUTE_ADOPT' },
      }),
    ).toBe(1);
    const conflictingReplay = await adopt(
      userA,
      trip,
      preview.previewId,
      adjustmentAdoptKey,
      adjustments.map((adjustment) => ({
        ...adjustment,
        toDurationSeconds: adjustment.toDurationSeconds - 1,
      })),
    );
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      `p5c-undo-${randomUUID()}`,
    );
    expect(undone.operationReceipt.delta).toMatchObject({
      schemaVersion: 'route-undo-delta-v2',
    });
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { tripId: trip.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 3_000 });

    const restoredSuggestion = await command(userA, undone.trip, {
      type: 'REMOVE_MIN_DWELL',
      nodeId: from!.id,
    });
    expect(
      restoredSuggestion.days
        .flatMap((day) => day.nodes)
        .find((node) => node.id === from!.id),
    ).toMatchObject({
      systemDwellSuggestion: { durationSeconds: 3_600 },
      timeIntents: [],
    });
  });

  it('keeps one owner-scoped system dwell suggestion independent from user MIN_DWELL and cascades it safely', async () => {
    let trip = await tripWithVisits(userA, ['Suggestion target', 'Next']);
    const node = trip.days[0]!.nodes[0]!;
    const first = await tripRepository.setSystemDwellSuggestion({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      nodeId: node.id,
      durationSeconds: 3_600,
    });
    expect(first.status).toBe('SUCCESS');
    if (first.status !== 'SUCCESS') throw new Error('suggestion failed');
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);
    const second = await tripRepository.setSystemDwellSuggestion({
      ownerUserId: userA.actor.userId,
      tripId: trip.id,
      baseTripVersion: trip.version,
      nodeId: node.id,
      durationSeconds: 4_200,
    });
    expect(second.status).toBe('SUCCESS');
    if (second.status !== 'SUCCESS')
      throw new Error('suggestion update failed');
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);
    expect(
      await managed.client.systemDwellSuggestion.findMany({
        where: { nodeId: node.id },
      }),
    ).toEqual([
      expect.objectContaining({
        tripId: trip.id,
        durationSeconds: 4_200,
        source: 'SYSTEM_SUGGESTION',
      }),
    ]);

    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: node.id,
      durationSeconds: 3_000,
      locked: false,
    });
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: node.id,
      durationSeconds: 2_400,
      locked: true,
    });
    trip = await command(userA, trip, {
      type: 'REMOVE_MIN_DWELL',
      nodeId: node.id,
    });
    expect(
      await managed.client.systemDwellSuggestion.findUnique({
        where: { nodeId: node.id },
      }),
    ).toMatchObject({ durationSeconds: 4_200 });
    const evaluation = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/schedule/evaluate`,
      headers: bearer(userA),
      payload: { basisVersion: trip.version },
    });
    expect(evaluation.statusCode).toBe(200);
    expect(
      (
        evaluation.json() as { nodes: { nodeId: string; departure: unknown }[] }
      ).nodes.find((value) => value.nodeId === node.id),
    ).toMatchObject({
      departure: {
        requirementWindow: { status: 'UNBOUNDED' },
      },
    });
    expect(evaluation.json()).toMatchObject({ conflicts: [] });

    const foreignTrip = await tripWithVisits(userB, ['Foreign', 'Next']);
    const foreignNode = foreignTrip.days[0]!.nodes[0]!;
    expect(
      await tripRepository.setSystemDwellSuggestion({
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        baseTripVersion: trip.version,
        nodeId: foreignNode.id,
        durationSeconds: 1_800,
      }),
    ).toMatchObject({ status: 'NOT_FOUND' });
    expect(
      await managed.client.systemDwellSuggestion.count({
        where: { nodeId: foreignNode.id },
      }),
    ).toBe(0);

    trip = await command(userA, trip, {
      type: 'DELETE_NODE',
      nodeId: node.id,
    });
    expect(
      await managed.client.systemDwellSuggestion.count({
        where: { nodeId: node.id },
      }),
    ).toBe(0);

    const cascadeNode = trip.days[0]!.nodes[0]!;
    expect(
      await tripRepository.setSystemDwellSuggestion({
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        baseTripVersion: trip.version,
        nodeId: cascadeNode.id,
        durationSeconds: 900,
      }),
    ).toMatchObject({ status: 'SUCCESS' });
    await managed.client.trip.delete({ where: { id: trip.id } });
    expect(
      await managed.client.systemDwellSuggestion.count({
        where: { nodeId: cascadeNode.id },
      }),
    ).toBe(0);
  });

  it('rolls back an accepted dwell adjustment when route persistence fails', async () => {
    const scenario = await adjustableAdoption(userA, 'route-write-failure');
    await managed.client.$executeRawUnsafe(`
      CREATE FUNCTION p5c_fail_adopted_edge() RETURNS trigger AS $$
      BEGIN
        IF NEW."source" = 'ADOPTED_ROUTE' THEN
          RAISE EXCEPTION 'SYNTHETIC_P5C_EDGE_FAILURE';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await managed.client.$executeRawUnsafe(`
      CREATE TRIGGER p5c_fail_adopted_edge_trigger
      BEFORE INSERT ON "TransportEdge"
      FOR EACH ROW EXECUTE FUNCTION p5c_fail_adopted_edge()
    `);
    try {
      const response = await adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-route-write-failure-${randomUUID()}`,
        scenario.adjustments,
      );
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
      await expectAdjustmentRollback(scenario.trip, scenario.intentId, 3_000);
    } finally {
      await managed.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS p5c_fail_adopted_edge_trigger ON "TransportEdge"',
      );
      await managed.client.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS p5c_fail_adopted_edge()',
      );
    }
  });

  it('rolls back route and dwell writes when ROUTE_ADOPTED outbox persistence fails', async () => {
    const scenario = await adjustableAdoption(userA, 'outbox-failure');
    await managed.client.$executeRawUnsafe(`
      CREATE FUNCTION p5c_fail_adopt_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW."type" = 'ROUTE_ADOPTED' THEN
          RAISE EXCEPTION 'SYNTHETIC_P5C_OUTBOX_FAILURE';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await managed.client.$executeRawUnsafe(`
      CREATE TRIGGER p5c_fail_adopt_outbox_trigger
      BEFORE INSERT ON "OutboxEvent"
      FOR EACH ROW EXECUTE FUNCTION p5c_fail_adopt_outbox()
    `);
    try {
      const response = await adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-outbox-failure-${randomUUID()}`,
        scenario.adjustments,
      );
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
      await expectAdjustmentRollback(scenario.trip, scenario.intentId, 3_000);
    } finally {
      await managed.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS p5c_fail_adopt_outbox_trigger ON "OutboxEvent"',
      );
      await managed.client.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS p5c_fail_adopt_outbox()',
      );
    }
  });

  it('rejects stale or tampered dwell adjustments without any write', async () => {
    const scenario = await adjustableAdoption(userA, 'tampered-adjustment');
    const expected = scenario.adjustments[0]!;
    for (const adjustment of [
      { ...expected, intentId: randomUUID() },
      { ...expected, nodeId: randomUUID() },
      { ...expected, fromDurationSeconds: 2_999 },
    ]) {
      const response = await adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-invalid-adjustment-${randomUUID()}`,
        [adjustment],
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'USER_ADJUSTMENT_REQUIRED' },
      });
    }
    await expectAdjustmentRollback(scenario.trip, scenario.intentId, 3_000);
  });

  it('does not let Undo overwrite a later user MIN_DWELL change, removal, or lock decision', async () => {
    for (const mutation of ['CHANGE', 'REMOVE', 'LOCK'] as const) {
      const scenario = await adjustableAdoption(userA, `undo-${mutation}`);
      const adopted = await adoptSuccessfully(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-undo-guard-adopt-${mutation}-${randomUUID()}`,
        scenario.adjustments,
      );
      let changed: TripView;
      if (mutation === 'REMOVE') {
        changed = await command(userA, adopted.trip, {
          type: 'REMOVE_MIN_DWELL',
          nodeId: scenario.adjustments[0]!.nodeId,
        });
      } else {
        changed = await command(userA, adopted.trip, {
          type: 'SET_MIN_DWELL',
          nodeId: scenario.adjustments[0]!.nodeId,
          durationSeconds: mutation === 'CHANGE' ? 2_400 : 2_700,
          locked: mutation === 'LOCK',
        });
      }
      const response = await undo(
        userA,
        changed,
        adopted.operationReceipt.id,
        `p5c-undo-guard-${mutation}-${randomUUID()}`,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'UNDO_CONFLICT' },
      });
      const intent = await managed.client.userTimeIntent.findUnique({
        where: { id: scenario.intentId },
      });
      if (mutation === 'REMOVE') {
        expect(intent).toBeNull();
      } else {
        expect(intent).toMatchObject({
          durationSeconds: mutation === 'CHANGE' ? 2_400 : 2_700,
          locked: mutation === 'LOCK',
        });
      }
      expect(
        await managed.client.operationReceipt.count({
          where: { tripId: scenario.trip.id, operationType: 'ROUTE_UNDO' },
        }),
      ).toBe(0);
      await managed.client.trip.delete({ where: { id: scenario.trip.id } });
    }
  });

  it('serializes two adjusted adoptions at one Trip version', async () => {
    const scenario = await adjustableAdoption(userA, 'concurrent-adjustment');
    const [from, to] = scenario.trip.days[0]!.nodes;
    const secondPreview = await createPreview(
      userA,
      scenario.trip,
      from!.id,
      to!.id,
    );
    const responses = await Promise.all([
      adopt(
        userA,
        scenario.trip,
        scenario.preview.previewId,
        `p5c-concurrent-adjustment-a-${randomUUID()}`,
        scenario.adjustments,
      ),
      adopt(
        userA,
        scenario.trip,
        secondPreview.previewId,
        `p5c-concurrent-adjustment-b-${randomUUID()}`,
        secondPreview.changeSummary.requiredUserAdjustments ?? [],
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: scenario.trip.id, operationType: 'ROUTE_ADOPT' },
      }),
    ).toBe(1);
    expect(
      await managed.client.userTimeIntent.findUniqueOrThrow({
        where: { id: scenario.intentId },
      }),
    ).toMatchObject({ durationSeconds: 2_700 });
    expect(
      await managed.client.trip.findUniqueOrThrow({
        where: { id: scenario.trip.id },
      }),
    ).toMatchObject({ version: scenario.trip.version + 1 });
  });

  it('canonically adopts, replays, and undoes two dwell adjustments whose UUID order opposes preview generation', async () => {
    let trip = await tripWithVisits(userA, [
      'Canonical from',
      'Canonical downstream',
      'Canonical final',
    ]);
    const [from, downstream, final] = trip.days[0]!.nodes;
    const arrivalResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(arrivalResponse.statusCode).toBe(200);
    trip = arrivalResponse.json() as TripView;
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3_000,
      locked: false,
    });
    trip = await command(userA, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: downstream!.id,
      durationSeconds: 2_400,
      locked: false,
    });
    const generatedOrder = [
      trip.days[0]!.nodes[0]!.timeIntents.find(
        (intent) => intent.kind === 'MIN_DWELL',
      )!.id,
      trip.days[0]!.nodes[1]!.timeIntents.find(
        (intent) => intent.kind === 'MIN_DWELL',
      )!.id,
    ];
    const highIntentId = 'f0000000-0000-4000-8000-000000000018';
    const lowIntentId = '10000000-0000-4000-8000-000000000019';
    await managed.client.$transaction([
      managed.client.userTimeIntent.update({
        where: { id: generatedOrder[0]! },
        data: { id: highIntentId },
      }),
      managed.client.userTimeIntent.update({
        where: { id: generatedOrder[1]! },
        data: { id: lowIntentId },
      }),
    ]);
    trip = await new TripService(tripRepository).getTrip(userA.actor, trip.id);
    trip = await command(userA, trip, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: downstream!.id,
      toNodeId: final!.id,
      mode: 'TAXI',
      fixedService: false,
      serviceLabel: 'SYNTHETIC selected downstream transport',
    });
    const selectedEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: {
        tripId: trip.id,
        fromNodeId: downstream!.id,
        toNodeId: final!.id,
      },
    });
    const departureResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'TRANSPORT', transportEdgeId: selectedEdge.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'DEPARTURE',
          instant: '2030-10-01T12:30:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(departureResponse.statusCode).toBe(200);
    trip = departureResponse.json() as TripView;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:45:00Z', '2030-10-01T12:00:00Z', 'UTC', 'UTC'),
      ],
    };

    const preview = await createPreview(userA, trip, from!.id, downstream!.id);
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toEqual([
      {
        intentId: lowIntentId,
        nodeId: downstream!.id,
        fromDurationSeconds: 2_400,
        toDurationSeconds: 1_800,
      },
      {
        intentId: highIntentId,
        nodeId: from!.id,
        fromDurationSeconds: 3_000,
        toDurationSeconds: 2_700,
      },
    ]);

    const adoptKey = `p5c-two-adjustments-${randomUUID()}`;
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      adoptKey,
      adjustments,
    );
    const replay = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      adoptKey,
      adjustments,
    );
    expect(replay.operationReceipt.id).toBe(adopted.operationReceipt.id);
    expect(replay.trip.version).toBe(adopted.trip.version);

    const undoKey = `p5c-two-adjustments-undo-${randomUUID()}`;
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      undoKey,
    );
    const undoReplay = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      undoKey,
    );
    expect(undoReplay.operationReceipt.id).toBe(undone.operationReceipt.id);
    expect(undoReplay.trip.version).toBe(undone.trip.version);
    expect(
      await managed.client.userTimeIntent.findMany({
        where: { id: { in: [lowIntentId, highIntentId] } },
        orderBy: { id: 'asc' },
        select: { id: true, durationSeconds: true },
      }),
    ).toEqual([
      { id: lowIntentId, durationSeconds: 2_400 },
      { id: highIntentId, durationSeconds: 3_000 },
    ]);
  });

  it('adopts a single leg atomically, archives the old transport, and replays one receipt', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: from!.id,
      toNodeId: to!.id,
      mode: 'TAXI',
      fixedService: false,
      serviceLabel: 'SYNTHETIC old taxi',
    });
    const oldEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: trip.id },
    });
    await managed.client.temporalValue.create({
      data: {
        transportEdgeId: oldEdge.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T09:30:00Z'),
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    });
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const beforeVersion = trip.version;
    const first = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-key-0001',
    );

    expect(first.statusCode).toBe(200);
    const adopted = first.json() as {
      operationReceipt: {
        id: string;
        resultingTripVersion: number;
        adoptedRouteId: string;
      };
      trip: TripView;
    };
    expect(adopted.operationReceipt.resultingTripVersion).toBe(
      beforeVersion + 1,
    );
    expect(adopted.trip.version).toBe(beforeVersion + 1);
    expect(adopted.trip.connections[0]).toMatchObject({
      state: 'ACTIVE',
      transport: {
        source: 'ADOPTED_ROUTE',
        provider: 'SYNTHETIC',
        adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
      },
    });

    const [
      edges,
      values,
      nodeValues,
      history,
      historyValues,
      receipts,
      outbox,
    ] = await Promise.all([
      managed.client.transportEdge.findMany({ where: { tripId: trip.id } }),
      managed.client.temporalValue.findMany({
        where: { transportEdge: { tripId: trip.id } },
        orderBy: { pointKind: 'asc' },
      }),
      managed.client.temporalValue.count({
        where: { node: { tripId: trip.id } },
      }),
      managed.client.transportEdgeHistory.findMany({
        where: { tripId: trip.id },
      }),
      managed.client.transportEdgeHistoryTimeValue.findMany({
        where: { history: { tripId: trip.id } },
      }),
      managed.client.operationReceipt.findMany({
        where: { tripId: trip.id },
      }),
      managed.client.outboxEvent.findMany({ where: { tripId: trip.id } }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: 'ADOPTED_ROUTE',
      adoptedRouteId: adopted.operationReceipt.adoptedRouteId,
      provider: 'SYNTHETIC',
    });
    expect(values).toHaveLength(2);
    expect(values.every((value) => value.layer === 'PLANNED')).toBe(true);
    expect(
      values.every((value) => value.sourceKind === 'ADOPTED_TRANSPORT_FACT'),
    ).toBe(true);
    expect(values.some((value) => value.layer === 'ACTUAL')).toBe(false);
    expect(nodeValues).toBe(0);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      originalTransportEdgeId: oldEdge.id,
      invalidationReason: 'USER_REPLACED',
      source: 'MANUAL',
    });
    expect(historyValues).toHaveLength(1);
    expect(historyValues[0]).toMatchObject({
      layer: 'PLANNED',
      pointKind: 'DEPARTURE',
      sourceKind: 'USER_VALUE',
    });
    expect(receipts).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'ROUTE_ADOPTED',
      operationReceiptId: adopted.operationReceipt.id,
    });

    const replay = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-key-0001',
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: adopted.operationReceipt.id },
      trip: { version: beforeVersion + 1 },
    });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({ where: { tripId: trip.id } }),
    ).toBe(1);

    const conflict = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: beforeVersion + 1,
        idempotencyKey: 'synthetic-key-0001',
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('replaces a single-leg adopted route and keeps idempotent replay lifecycle-neutral', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-single-route-1',
    );
    const route1Id = first.operationReceipt.adoptedRouteId;

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('single-route-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(
      secondPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(route1Id);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-single-route-2',
    );
    const route2Id = second.operationReceipt.adoptedRouteId;

    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: route1Id },
      }),
    ).toMatchObject({ status: 'REPLACED', replacedAt: currentNow });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: route2Id },
      }),
    ).toMatchObject({ status: 'ACTIVE', replacedAt: null });
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    expect(
      await managed.client.transportEdgeHistory.findMany({
        where: { tripId: initial.id, adoptedRouteId: route1Id },
      }),
    ).toEqual([
      expect.objectContaining({ invalidationReason: 'USER_REPLACED' }),
    ]);

    const replay = await adopt(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-single-route-2',
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: second.operationReceipt.id },
      trip: { version: second.trip.version },
    });
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('replaces a single-leg route with a multi-leg route and re-queries the new corridor', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-single-multi-1',
    );

    providerResult = transferCandidate();
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(
      secondPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(first.operationReceipt.adoptedRouteId);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-single-multi-2',
    );

    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: first.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'REPLACED' });
    expect(
      second.trip.days
        .flatMap((day) => day.nodes)
        .filter((node) => node.source === 'ROUTE_GENERATED'),
    ).toHaveLength(1);
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);

    const requery = await query(
      userA,
      second.trip,
      from!.id,
      to!.id,
      departHint(),
    );
    expect(requery.statusCode).toBe(200);
  });

  it('keeps one ACTIVE route through multi-leg to repeated single-leg replacements', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    providerResult = transferCandidate();
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-multi-single-1',
    );

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('multi-single-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(
      secondPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(first.operationReceipt.adoptedRouteId);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-multi-single-2',
    );

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('multi-single-3')],
    };
    const thirdPreview = await createPreview(
      userA,
      second.trip,
      from!.id,
      to!.id,
    );
    expect(
      thirdPreview.changeSummary.routeCorridor?.currentAdoptedRouteId,
    ).toBe(second.operationReceipt.adoptedRouteId);
    const third = await adoptSuccessfully(
      userA,
      second.trip,
      thirdPreview.previewId,
      'synthetic-multi-single-3',
    );

    const routes = await managed.client.adoptedRoute.findMany({
      where: { tripId: initial.id },
    });
    expect(routes).toHaveLength(3);
    expect(routes.filter((route) => route.status === 'ACTIVE')).toEqual([
      expect.objectContaining({ id: third.operationReceipt.adoptedRouteId }),
    ]);
    expect(
      routes
        .filter((route) => route.status === 'REPLACED')
        .map((route) => route.id)
        .sort(),
    ).toEqual(
      [
        first.operationReceipt.adoptedRouteId,
        second.operationReceipt.adoptedRouteId,
      ].sort(),
    );
    expect(
      await managed.client.transportEdgeHistory.count({
        where: {
          tripId: initial.id,
          invalidationReason: 'USER_REPLACED',
          adoptedRouteId: {
            in: [
              first.operationReceipt.adoptedRouteId,
              second.operationReceipt.adoptedRouteId,
            ],
          },
        },
      }),
    ).toBe(3);
  });

  it('undoes an adoption as a new versioned transaction and replays one receipt', async () => {
    let trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    trip = await command(userA, trip, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: from!.id,
      toNodeId: to!.id,
      mode: 'TAXI',
      fixedService: false,
      serviceLabel: 'SYNTHETIC pre-adoption taxi',
    });
    const oldEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: trip.id },
    });
    await managed.client.temporalValue.create({
      data: {
        transportEdgeId: oldEdge.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T09:30:00Z'),
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    });
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-undo-adopt-01',
    );
    const adoptReceipt =
      await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.id },
      });
    expect(adoptReceipt).toMatchObject({
      operationType: 'ROUTE_ADOPT',
      targetOperationReceiptId: null,
      undoExpiresAt: new Date(NOW.getTime() + 600_000),
      delta: expect.objectContaining({ schemaVersion: 'route-adopt-delta-v3' }),
    });

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adoptReceipt.id,
      'synthetic-undo-request-01',
    );
    expect(undone.trip.version).toBe(adopted.trip.version + 1);
    expect(undone.trip.connections[0]).toMatchObject({
      state: 'ACTIVE',
      transport: {
        id: oldEdge.id,
        source: 'MANUAL',
        serviceLabel: 'SYNTHETIC pre-adoption taxi',
      },
    });
    expect(undone.operationReceipt).toMatchObject({
      operationType: 'ROUTE_UNDO',
      targetOperationReceiptId: adoptReceipt.id,
      baseTripVersion: adopted.trip.version,
      resultingTripVersion: adopted.trip.version + 1,
      delta: expect.objectContaining({ schemaVersion: 'route-undo-delta-v2' }),
    });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: adopted.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'UNDONE', undoneAt: currentNow });
    expect(
      await managed.client.temporalValue.findMany({
        where: { transportEdgeId: oldEdge.id },
      }),
    ).toEqual([
      expect.objectContaining({
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        sourceKind: 'USER_VALUE',
      }),
    ]);
    expect(
      await managed.client.transportEdgeHistory.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.operationReceipt.findMany({
        where: { tripId: trip.id },
        orderBy: { createdAt: 'asc' },
      }),
    ).toHaveLength(2);
    expect(
      await managed.client.outboxEvent.findMany({
        where: { tripId: trip.id },
        orderBy: { type: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({ type: 'ROUTE_ADOPTED' }),
      expect.objectContaining({ type: 'ROUTE_UNDONE' }),
    ]);

    const replay = await undo(
      userA,
      adopted.trip,
      adoptReceipt.id,
      'synthetic-undo-request-01',
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      operationReceipt: { id: undone.operationReceipt.id },
      trip: { version: adopted.trip.version + 1 },
    });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({
        where: { tripId: trip.id, type: 'ROUTE_UNDONE' },
      }),
    ).toBe(1);
  });

  it('restores a missing connection and rejects reuse of an Undo idempotency key', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-empty-adopt',
    );
    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      'synthetic-empty-undo',
    );
    expect(undone.trip.connections[0]).toMatchObject({
      state: 'MISSING',
      transport: null,
    });

    const conflict = await undo(
      userA,
      { ...adopted.trip, version: adopted.trip.version + 1 },
      adopted.operationReceipt.id,
      'synthetic-empty-undo',
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
  });

  it('undoes single-to-single and single-to-multi replacements with one active route', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-undo-lifecycle-1',
    );
    const originalEdgeId = first.trip.connections[0]!.transport!.id;

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('undo-lifecycle-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-undo-lifecycle-2',
    );
    const staleFirstUndo = await undo(
      userA,
      second.trip,
      first.operationReceipt.id,
      'synthetic-undo-stale-first',
    );
    expect(staleFirstUndo.statusCode).toBe(409);
    expect(staleFirstUndo.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    const restoredSingle = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-undo-lifecycle-2-request',
    );
    expect(restoredSingle.trip.connections[0]!.transport!.id).toBe(
      originalEdgeId,
    );
    const adoptedRoutes = await managed.client.adoptedRoute.findMany({
      where: { tripId: initial.id },
    });
    expect(adoptedRoutes).toHaveLength(2);
    expect(adoptedRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.operationReceipt.adoptedRouteId,
          status: 'ACTIVE',
          replacedAt: null,
        }),
        expect.objectContaining({
          id: second.operationReceipt.adoptedRouteId,
          status: 'UNDONE',
        }),
      ]),
    );

    providerResult = transferCandidate();
    const multiPreview = await createPreview(
      userA,
      restoredSingle.trip,
      from!.id,
      to!.id,
    );
    const multi = await adoptSuccessfully(
      userA,
      restoredSingle.trip,
      multiPreview.previewId,
      'synthetic-undo-lifecycle-3',
    );
    const generated = multi.trip.days
      .flatMap((day) => day.nodes)
      .find((node) => node.source === 'ROUTE_GENERATED')!;
    const generatedPlaceId = generated.place!.id;
    const restoredAgain = await undoSuccessfully(
      userA,
      multi.trip,
      multi.operationReceipt.id,
      'synthetic-undo-lifecycle-3-request',
    );
    expect(
      restoredAgain.trip.days
        .flatMap((day) => day.nodes)
        .some((node) => node.id === generated.id),
    ).toBe(false);
    expect(
      await managed.client.place.findUnique({
        where: { id: generatedPlaceId },
      }),
    ).toBeNull();
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: initial.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('restores a multi-leg corridor with original generated identity after single-leg replacement', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    providerResult = transferCandidate();
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-undo-multi-1',
    );
    const generatedBefore = await managed.client.itineraryNode.findFirstOrThrow(
      {
        where: { tripId: initial.id, source: 'ROUTE_GENERATED' },
      },
    );

    providerResult = {
      status: 'SUCCESS',
      candidates: [replacementSingleCandidate('undo-multi-2')],
    };
    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-undo-multi-2',
    );
    expect(
      await managed.client.itineraryNode.findUnique({
        where: { id: generatedBefore.id },
      }),
    ).toBeNull();

    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-undo-multi-2-request',
    );
    const generatedAfter = await managed.client.itineraryNode.findUniqueOrThrow(
      {
        where: { id: generatedBefore.id },
      },
    );
    expect(generatedAfter).toMatchObject({
      id: generatedBefore.id,
      dayOccurrenceId: generatedBefore.dayOccurrenceId,
      position: generatedBefore.position,
      adoptedRouteId: first.operationReceipt.adoptedRouteId,
      sourceOperationId: generatedBefore.sourceOperationId,
      providerPlaceRef: generatedBefore.providerPlaceRef,
    });
    expect(undone.trip.connections).toHaveLength(2);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: first.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE', replacedAt: null });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: second.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'UNDONE' });
  });

  it('restores a reused generated node route identity after another multi-leg adoption', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    providerResult = transferCandidate();
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-undo-reuse-1',
    );
    const generatedBefore = await managed.client.itineraryNode.findFirstOrThrow(
      {
        where: { tripId: initial.id, source: 'ROUTE_GENERATED' },
      },
    );

    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    expect(secondPreview.changeSummary.nodesToReuse).toEqual([
      expect.objectContaining({ nodeId: generatedBefore.id, action: 'REUSE' }),
    ]);
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-undo-reuse-2',
    );
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: generatedBefore.id },
      }),
    ).toMatchObject({
      adoptedRouteId: second.operationReceipt.adoptedRouteId,
      sourceOperationId: second.operationReceipt.id,
    });

    await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-undo-reuse-request',
    );
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: generatedBefore.id },
      }),
    ).toMatchObject({
      id: generatedBefore.id,
      dayOccurrenceId: generatedBefore.dayOccurrenceId,
      position: generatedBefore.position,
      adoptedRouteId: generatedBefore.adoptedRouteId,
      sourceOperationId: generatedBefore.sourceOperationId,
      providerPlaceRef: generatedBefore.providerPlaceRef,
    });
  });

  it('restores repeated-date occurrence sequence, ownership, and effective range exactly', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'First occurrence', '2030-10-01');
    trip = await command(userA, trip, {
      type: 'ADD_PLACE_VISIT',
      targetDay: { type: 'NEW', localDate: '2030-10-01', sequence: 1 },
      position: 0,
      place: {
        type: 'CUSTOM',
        name: 'Repeated occurrence',
        latitude: 34.0522,
        longitude: -118.2437,
      },
    });
    const beforeDays = trip.days.map((day) => ({
      id: day.dayOccurrenceId,
      localDate: day.localDate,
      sequence: day.sequence,
    }));
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    providerResult = dateRollbackTransferCandidate();
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-undo-occurrence-adopt',
    );
    expect(adopted.trip.days.map((day) => day.localDate)).toEqual([
      '2030-10-01',
      '2030-10-02',
      '2030-10-01',
    ]);
    expect(
      await managed.client.dateOwnership.findMany({
        where: { tripId: trip.id },
      }),
    ).toHaveLength(2);

    const undone = await undoSuccessfully(
      userA,
      adopted.trip,
      adopted.operationReceipt.id,
      'synthetic-undo-occurrence-request',
    );
    expect(
      undone.trip.days.map((day) => ({
        id: day.dayOccurrenceId,
        localDate: day.localDate,
        sequence: day.sequence,
      })),
    ).toEqual(beforeDays);
    expect(
      await managed.client.dateOwnership.findMany({
        where: { tripId: trip.id },
      }),
    ).toEqual([
      expect.objectContaining({ localDate: new Date('2030-10-01T00:00:00Z') }),
    ]);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({
      effectiveStartDate: new Date('2030-10-01T00:00:00Z'),
      effectiveEndDate: new Date('2030-10-01T00:00:00Z'),
    });
  });

  it('protects target-created generated nodes with ACTUAL or new user content', async () => {
    const actualTrip = await tripWithVisits(userA, [
      'Actual From',
      'Actual To',
    ]);
    const [actualFrom, actualTo] = actualTrip.days[0]!.nodes;
    providerResult = transferCandidate();
    const actualPreview = await createPreview(
      userA,
      actualTrip,
      actualFrom!.id,
      actualTo!.id,
    );
    const actualAdopt = await adoptSuccessfully(
      userA,
      actualTrip,
      actualPreview.previewId,
      'synthetic-node-actual-adopt',
    );
    const actualNode = await managed.client.itineraryNode.findFirstOrThrow({
      where: { tripId: actualTrip.id, source: 'ROUTE_GENERATED' },
    });
    await managed.client.temporalValue.create({
      data: {
        nodeId: actualNode.id,
        layer: 'ACTUAL',
        pointKind: 'ARRIVAL',
        instant: new Date('2030-10-01T10:30:00Z'),
        timeZone: 'UTC',
        sourceKind: 'PROVIDER_OBSERVATION',
      },
    });
    const actualRejected = await undo(
      userA,
      actualAdopt.trip,
      actualAdopt.operationReceipt.id,
      'synthetic-node-actual-undo',
    );
    expect(actualRejected.statusCode).toBe(409);
    expect(actualRejected.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.itineraryNode.findUnique({
        where: { id: actualNode.id },
      }),
    ).not.toBeNull();

    const noteTrip = await tripWithVisits(userB, ['Note From', 'Note To']);
    const [noteFrom, noteTo] = noteTrip.days[0]!.nodes;
    const notePreview = await createPreview(
      userB,
      noteTrip,
      noteFrom!.id,
      noteTo!.id,
    );
    const noteAdopt = await adoptSuccessfully(
      userB,
      noteTrip,
      notePreview.previewId,
      'synthetic-node-note-adopt',
    );
    const noteNode = await managed.client.itineraryNode.findFirstOrThrow({
      where: { tripId: noteTrip.id, source: 'ROUTE_GENERATED' },
    });
    await managed.client.itineraryNode.update({
      where: { id: noteNode.id },
      data: { note: 'User-kept fact', userModifiedAt: currentNow },
    });
    const noteRejected = await undo(
      userB,
      noteAdopt.trip,
      noteAdopt.operationReceipt.id,
      'synthetic-node-note-undo',
    );
    expect(noteRejected.statusCode).toBe(409);
    expect(noteRejected.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: noteNode.id },
      }),
    ).toMatchObject({ note: 'User-kept fact' });
  });

  it('rejects unsafe, expired, legacy, and post-version Undo attempts without partial changes', async () => {
    const actualTrip = await tripWithVisits(userA, [
      'Actual From',
      'Actual To',
    ]);
    const [actualFrom, actualTo] = actualTrip.days[0]!.nodes;
    const actualPreview = await createPreview(
      userA,
      actualTrip,
      actualFrom!.id,
      actualTo!.id,
    );
    const actualAdopt = await adoptSuccessfully(
      userA,
      actualTrip,
      actualPreview.previewId,
      'synthetic-unsafe-adopt',
    );
    const activeEdge = await managed.client.transportEdge.findFirstOrThrow({
      where: { tripId: actualTrip.id },
    });
    await managed.client.temporalValue.create({
      data: {
        transportEdgeId: activeEdge.id,
        layer: 'ACTUAL',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-10-01T10:01:00Z'),
        timeZone: 'UTC',
        sourceKind: 'PROVIDER_OBSERVATION',
      },
    });
    const actualRejected = await undo(
      userA,
      actualAdopt.trip,
      actualAdopt.operationReceipt.id,
      'synthetic-unsafe-undo',
    );
    expect(actualRejected.statusCode).toBe(409);
    expect(actualRejected.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: actualAdopt.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: actualTrip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(0);

    const expiredTrip = await tripWithVisitsOnDate(
      userA,
      ['Expired From', 'Expired To'],
      '2030-10-02',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-02')],
    };
    const [expiredFrom, expiredTo] = expiredTrip.days[0]!.nodes;
    const expiredPreview = await createPreview(
      userA,
      expiredTrip,
      expiredFrom!.id,
      expiredTo!.id,
    );
    const expiredAdopt = await adoptSuccessfully(
      userA,
      expiredTrip,
      expiredPreview.previewId,
      'synthetic-expired-adopt',
    );
    currentNow = new Date(NOW.getTime() + 600_000);
    const expired = await undo(
      userA,
      expiredAdopt.trip,
      expiredAdopt.operationReceipt.id,
      'synthetic-expired-undo',
    );
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toMatchObject({ error: { code: 'UNDO_EXPIRED' } });

    currentNow = NOW;
    const legacyTrip = await tripWithVisitsOnDate(
      userA,
      ['Legacy From', 'Legacy To'],
      '2030-10-03',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-03')],
    };
    const [legacyFrom, legacyTo] = legacyTrip.days[0]!.nodes;
    const legacyPreview = await createPreview(
      userA,
      legacyTrip,
      legacyFrom!.id,
      legacyTo!.id,
    );
    const legacyAdopt = await adoptSuccessfully(
      userA,
      legacyTrip,
      legacyPreview.previewId,
      'synthetic-legacy-adopt',
    );
    await managed.client.operationReceipt.update({
      where: { id: legacyAdopt.operationReceipt.id },
      data: { undoExpiresAt: null },
    });
    const legacy = await undo(
      userA,
      legacyAdopt.trip,
      legacyAdopt.operationReceipt.id,
      'synthetic-legacy-undo',
    );
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json()).toMatchObject({
      error: { code: 'UNDO_UNAVAILABLE' },
    });

    const changedTrip = await tripWithVisitsOnDate(
      userA,
      ['Changed From', 'Changed To'],
      '2030-10-04',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-04')],
    };
    const [changedFrom, changedTo] = changedTrip.days[0]!.nodes;
    const changedPreview = await createPreview(
      userA,
      changedTrip,
      changedFrom!.id,
      changedTo!.id,
    );
    const changedAdopt = await adoptSuccessfully(
      userA,
      changedTrip,
      changedPreview.previewId,
      'synthetic-changed-adopt',
    );
    await managed.client.trip.update({
      where: { id: changedTrip.id },
      data: { version: { increment: 1 } },
    });
    const changed = await undo(
      userA,
      changedAdopt.trip,
      changedAdopt.operationReceipt.id,
      'synthetic-changed-undo',
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
  });

  it('serializes concurrent Undo and rolls back when a prior owned date is no longer available', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const preview = await createPreview(userA, initial, from!.id, to!.id);
    const adopted = await adoptSuccessfully(
      userA,
      initial,
      preview.previewId,
      'synthetic-concurrent-undo-adopt',
    );
    const concurrent = await Promise.all([
      undo(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        'synthetic-concurrent-undo-a',
      ),
      undo(
        userA,
        adopted.trip,
        adopted.operationReceipt.id,
        'synthetic-concurrent-undo-b',
      ),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: initial.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({
        where: { tripId: initial.id, type: 'ROUTE_UNDONE' },
      }),
    ).toBe(1);

    const conflictTrip = await tripWithVisitsOnDate(
      userA,
      ['Conflict From', 'Conflict To'],
      '2030-10-02',
    );
    providerResult = {
      status: 'SUCCESS',
      candidates: [singleCandidateForLocalDate('2030-10-02')],
    };
    const [conflictFrom, conflictTo] = conflictTrip.days[0]!.nodes;
    const conflictPreview = await createPreview(
      userA,
      conflictTrip,
      conflictFrom!.id,
      conflictTo!.id,
    );
    const conflictAdopt = await adoptSuccessfully(
      userA,
      conflictTrip,
      conflictPreview.previewId,
      'synthetic-date-conflict-adopt',
    );
    const otherTrip = await createTrip(userA);
    await managed.client.dateOwnership.deleteMany({
      where: { tripId: conflictTrip.id },
    });
    await managed.client.dateOwnership.create({
      data: {
        ownerUserId: userA.actor.userId,
        tripId: otherTrip.id,
        localDate: new Date('2030-10-02T00:00:00.000Z'),
      },
    });
    const routeBefore = await managed.client.adoptedRoute.findUniqueOrThrow({
      where: { id: conflictAdopt.operationReceipt.adoptedRouteId },
    });
    const edgeBefore = await managed.client.transportEdge.findMany({
      where: { tripId: conflictTrip.id },
    });
    const conflict = await undo(
      userA,
      conflictAdopt.trip,
      conflictAdopt.operationReceipt.id,
      'synthetic-date-conflict-undo',
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'UNDO_CONFLICT' },
    });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: conflictAdopt.operationReceipt.adoptedRouteId },
      }),
    ).toEqual(routeBefore);
    expect(
      await managed.client.transportEdge.findMany({
        where: { tripId: conflictTrip.id },
      }),
    ).toEqual(edgeBefore);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: conflictTrip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(0);
  });

  it('rolls back prior route lifecycle when a later adoption fails mid-transaction', async () => {
    const initial = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = initial.days[0]!.nodes;
    const firstPreview = await createPreview(userA, initial, from!.id, to!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-adopt-rollback-1',
    );

    const secondPreview = await createPreview(
      userA,
      first.trip,
      from!.id,
      to!.id,
    );
    const stored = await managed.client.routePreview.findUniqueOrThrow({
      where: { id: secondPreview.previewId },
    });
    const originalPayload =
      stored.previewPayload as unknown as StoredRoutePreviewPayload;
    const invalidPayload: StoredRoutePreviewPayload = {
      ...originalPayload,
      changeSummary: {
        ...originalPayload.changeSummary,
        proposedSegments: originalPayload.changeSummary.proposedSegments.map(
          (segment, index) =>
            index === 0 ? { ...segment, fromRef: 'UNKNOWN_REF' } : segment,
        ),
      },
    };
    await managed.client.routePreview.update({
      where: { id: secondPreview.previewId },
      data: {
        previewPayload: invalidPayload as never,
        previewHash: hashRoutePreviewPayload(invalidPayload),
      },
    });
    const rejected = await adopt(
      userA,
      first.trip,
      secondPreview.previewId,
      'synthetic-adopt-rollback-2',
    );
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { code: 'PREVIEW_STALE' },
    });
    expect(
      await managed.client.adoptedRoute.findMany({
        where: { tripId: initial.id },
      }),
    ).toEqual([
      expect.objectContaining({
        id: first.operationReceipt.adoptedRouteId,
        status: 'ACTIVE',
        replacedAt: null,
      }),
    ]);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: initial.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.outboxEvent.count({ where: { tripId: initial.id } }),
    ).toBe(1);
    expect(
      await managed.client.itineraryNode.count({
        where: { tripId: initial.id, source: 'ROUTE_GENERATED' },
      }),
    ).toBe(0);
    expect(
      await managed.client.trip.findUniqueOrThrow({
        where: { id: initial.id },
      }),
    ).toMatchObject({ version: first.trip.version });
  });

  it('allows only one concurrent adoption for two previews at the same Trip version', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    const [left, right] = await Promise.all([
      createPreview(userA, trip, from!.id, to!.id),
      createPreview(userA, trip, from!.id, to!.id),
    ]);

    const responses = await Promise.all([
      adopt(userA, trip, left.previewId, 'synthetic-concurrent-a'),
      adopt(userA, trip, right.previewId, 'synthetic-concurrent-b'),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)!.json(),
    ).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(1);
    expect(
      await managed.client.adoptedRoute.count({ where: { tripId: trip.id } }),
    ).toBe(1);
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: trip.version + 1 });
  });

  it('creates one generated transfer node for a multi-leg route and keeps ordinary walking formal', async () => {
    const trip = await tripWithVisits(userA, ['From', 'To']);
    const [from, to] = trip.days[0]!.nodes;
    providerResult = transferCandidate();
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    expect(preview).toMatchObject({
      policyVersion: 'route-adoption-preview-v3',
      status: 'ACTIVE',
      adoptable: true,
      changeSummary: {
        nodesToCreate: [{ providerPlaceRef: 'transfer-station' }],
        proposedSegments: [{ mode: 'RAIL' }, { mode: 'WALKING' }],
      },
    });

    const response = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-transfer-01',
    );
    expect(response.statusCode).toBe(200);
    const adopted = response.json() as { trip: TripView };
    const generated = adopted.trip.days
      .flatMap((day) => day.nodes)
      .filter((node) => node.source === 'ROUTE_GENERATED');
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      provider: 'SYNTHETIC',
      providerPlaceRef: 'transfer-station',
      autoReplaceable: true,
    });
    expect(adopted.trip.connections).toHaveLength(2);
    expect(
      adopted.trip.connections.map((connection) => connection.transport?.mode),
    ).toEqual(['RAIL', 'WALKING']);
    expect(
      await managed.client.transportEdge.count({ where: { tripId: trip.id } }),
    ).toBe(2);
    const requery = await query(
      userA,
      adopted.trip,
      from!.id,
      to!.id,
      departHint(),
    );
    expect(requery.statusCode).toBe(200);
  });

  it('projects one cross-day edge across START/OCCUPIED/END and rejects ordinary content in the occupied day', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'Day 1', '2030-10-01');
    trip = await addVisit(userA, trip, 'Day 3', '2030-10-03');
    const [from, to] = trip.days.flatMap((day) => day.nodes);
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T20:00:00Z', '2030-10-03T08:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const preview = await createPreview(userA, trip, from!.id, to!.id);
    const response = await adopt(
      userA,
      trip,
      preview.previewId,
      'synthetic-cross-day',
    );
    expect(response.statusCode).toBe(200);
    const adopted = response.json() as { trip: TripView };
    const projections = adopted.trip.days.map((day) => ({
      localDate: day.localDate,
      projections: day.transportProjections,
    }));
    expect(projections.map((item) => item.localDate)).toEqual([
      '2030-10-01',
      '2030-10-02',
      '2030-10-03',
    ]);
    expect(projections.map((item) => item.projections[0]?.role)).toEqual([
      'START',
      'OCCUPIED',
      'END',
    ]);
    expect(
      new Set(
        projections.flatMap((item) =>
          item.projections.map((projection) => projection.transportEdgeId),
        ),
      ).size,
    ).toBe(1);

    let editableTrip = await command(userA, adopted.trip, {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: adopted.trip.days[0]!.dayOccurrenceId,
      },
      position: 0,
      note: 'SYNTHETIC start-day content',
    });
    editableTrip = await command(userA, editableTrip, {
      type: 'ADD_FREE_ACTION',
      targetDay: {
        type: 'EXISTING',
        dayOccurrenceId: editableTrip.days[2]!.dayOccurrenceId,
      },
      position: 1,
      note: 'SYNTHETIC end-day content',
    });
    const occupied = editableTrip.days[1]!;
    const rejected = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/commands`,
      headers: bearer(userA),
      payload: {
        baseTripVersion: editableTrip.version,
        command: {
          type: 'ADD_FREE_ACTION',
          targetDay: {
            type: 'EXISTING',
            dayOccurrenceId: occupied.dayOccurrenceId,
          },
          position: 0,
          note: 'SYNTHETIC overlap attempt',
        },
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({
      error: { code: 'TRANSPORT_OCCUPIED_DAY' },
    });
    expect(
      await managed.client.dateOwnership.count({ where: { tripId: trip.id } }),
    ).toBe(3);
  });

  async function adjustableAdoption(
    identity: SyntheticIdentity,
    label: string,
  ): Promise<{
    trip: TripView;
    preview: RoutePreviewView;
    intentId: string;
    adjustments: NonNullable<
      RoutePreviewView['changeSummary']['requiredUserAdjustments']
    >;
  }> {
    let trip = await tripWithVisits(identity, [
      `SYNTHETIC ${label} from`,
      `SYNTHETIC ${label} to`,
    ]);
    const [from, to] = trip.days[0]!.nodes;
    const temporal = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/temporal-values`,
      headers: bearer(identity),
      payload: {
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: from!.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    });
    expect(temporal.statusCode).toBe(200);
    trip = temporal.json() as TripView;
    trip = await command(identity, trip, {
      type: 'SET_MIN_DWELL',
      nodeId: from!.id,
      durationSeconds: 3_000,
      locked: false,
    });
    const intentId = trip.days[0]!.nodes[0]!.timeIntents.find(
      (intent) => intent.kind === 'MIN_DWELL',
    )!.id;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:45:00Z', '2030-10-01T11:45:00Z', 'UTC', 'UTC'),
      ],
    };
    const preview = await createPreview(identity, trip, from!.id, to!.id);
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toEqual([
      expect.objectContaining({
        intentId,
        nodeId: from!.id,
        fromDurationSeconds: 3_000,
        toDurationSeconds: 2_700,
      }),
    ]);
    return { trip, preview, intentId, adjustments };
  }

  async function expectAdjustmentRollback(
    trip: TripView,
    intentId: string,
    durationSeconds: number,
  ): Promise<void> {
    expect(
      await managed.client.userTimeIntent.findUniqueOrThrow({
        where: { id: intentId },
      }),
    ).toMatchObject({ durationSeconds });
    expect(
      await managed.client.trip.findUniqueOrThrow({ where: { id: trip.id } }),
    ).toMatchObject({ version: trip.version });
    expect(
      await managed.client.adoptedRoute.count({ where: { tripId: trip.id } }),
    ).toBe(0);
    expect(
      await managed.client.transportEdge.count({ where: { tripId: trip.id } }),
    ).toBe(0);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: trip.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.outboxEvent.count({ where: { tripId: trip.id } }),
    ).toBe(0);
  }

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
    return tripWithVisitsOnDate(identity, names, '2030-10-01');
  }

  async function tripWithVisitsOnDate(
    identity: SyntheticIdentity,
    names: readonly string[],
    localDate: string,
  ): Promise<TripView> {
    let trip = await createTrip(identity);
    for (const name of names)
      trip = await addVisit(identity, trip, name, localDate);
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

  async function suffixFixture(actual = true, originDwell = false) {
    const initial = await tripWithVisits(userA, ['SYNTHETIC A', 'SYNTHETIC D']);
    const [a, d] = initial.days[0]!.nodes;
    providerResult = suffixFoundationCandidate(false);
    if (originDwell) {
      const source = providerResult.candidates[0]!;
      // Flexible synthetic source services avoid a contradictory fixed departure
      // while exercising the existing lookback/dwell policy at an ACTUAL origin.
      providerResult = {
        status: 'SUCCESS',
        candidates: [
          {
            ...source,
            legs: source.legs.map((leg) => ({
              ...leg,
              fixedService: false,
              groundTransit: {
                ...leg.groundTransit!,
                serviceClass: 'HIGH_FREQUENCY',
                headwayMinSeconds: 300,
                headwayMaxSeconds: 600,
              },
            })),
          },
        ],
      };
    }
    const preview = await createPreview(userA, initial, a!.id, d!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      preview.previewId,
      'synthetic-suffix-source',
    );
    const [A, B, C, D] = first.trip.days.flatMap((day) => day.nodes);
    const edges = await managed.client.transportEdge.findMany({
      where: { tripId: initial.id },
      orderBy: { createdAt: 'asc' },
    });
    const prefix = edges.find((edge) => edge.fromNodeId === A!.id)!;
    const full = await query(userA, first.trip, A!.id, D!.id, departHint());
    expect(full.statusCode).toBe(200);
    if (actual) {
      await managed.client.temporalValue.createMany({
        data: [
          {
            nodeId: B!.id,
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: new Date('2030-10-01T10:20:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
          {
            transportEdgeId: prefix.id,
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: new Date('2030-10-01T10:20:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
          {
            transportEdgeId: prefix.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
            instant: new Date('2030-10-01T10:00:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
        ],
      });
    }
    providerResult = suffixFoundationCandidate(true);
    return {
      first,
      A: A!,
      B: B!,
      C: C!,
      D: D!,
      prefix,
      suffixEdges: edges.filter((edge) => edge.id !== prefix.id),
    };
  }

  async function repairRestoredFixture(origin: 'B' | 'C' = 'B') {
    const f = await suffixFixture(false);
    if (origin === 'C') {
      providerResult = {
        status: 'SUCCESS',
        candidates: [
          candidate(
            '2030-10-01T10:45:00Z',
            '2030-10-01T11:00:00Z',
            'UTC',
            'UTC',
          ),
        ],
      };
    }
    const suffix = await createPreview(
      userA,
      f.first.trip,
      f[origin].id,
      f.D.id,
      {
        type: 'DEPART_AT',
        instant:
          origin === 'B' ? '2030-10-01T10:30:00Z' : '2030-10-01T10:45:00Z',
        timeZone: 'UTC',
      },
    );
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      suffix.previewId,
      'repair-suffix',
    );
    const restored = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'repair-undo',
    );
    return { ...f, second, restored };
  }

  async function repairDurableState(tripId: string) {
    return managed.client.trip.findUniqueOrThrow({
      where: { id: tripId },
      include: {
        dayOccurrences: {
          orderBy: { id: 'asc' },
          include: {
            nodes: {
              orderBy: { id: 'asc' },
              include: {
                place: true,
                temporalValues: { orderBy: { id: 'asc' } },
                timeIntents: true,
                systemDwellSuggestion: true,
              },
            },
            transportProjections: { orderBy: { transportEdgeId: 'asc' } },
          },
        },
        adoptedRoutes: { orderBy: { id: 'asc' } },
        routeCandidateSnapshots: { orderBy: { id: 'asc' } },
        routePreviews: { orderBy: { id: 'asc' } },
        transportEdges: {
          orderBy: { id: 'asc' },
          include: { temporalValues: { orderBy: { id: 'asc' } } },
        },
        transportHistory: {
          orderBy: { id: 'asc' },
          include: { temporalValues: { orderBy: { id: 'asc' } } },
        },
        operationReceipts: { orderBy: { id: 'asc' } },
        outboxEvents: { orderBy: { id: 'asc' } },
        groundTransitLegs: {
          orderBy: { id: 'asc' },
          include: {
            observations: { orderBy: { id: 'asc' } },
            stateTransitions: { orderBy: { id: 'asc' } },
          },
        },
      },
    });
  }

  it.each(['B', 'C'] as const)(
    'P5E2 repair A/B: suffix Undo at %s protects deletion by full/earlier suffix replacement',
    async (origin) => {
      const f = await repairRestoredFixture(origin);
      providerResult = suffixFoundationCandidate(
        true,
        origin === 'B' ? '2030-10-01T10:00:00Z' : '2030-10-01T10:30:00Z',
        '2030-10-01T11:00:00Z',
      );
      const preview = await createPreview(
        userA,
        f.restored.trip,
        origin === 'B' ? f.A.id : f.B.id,
        f.D.id,
        origin === 'B'
          ? departHint()
          : {
              type: 'DEPART_AT',
              instant: '2030-10-01T10:30:00Z',
              timeZone: 'UTC',
            },
      );
      expect(preview).toMatchObject({
        adoptable: false,
        status: 'BLOCKED',
      });
      expect(preview.changeSummary.routeCorridor?.replacementScope).toBe(
        origin === 'B' ? 'FULL_CORRIDOR' : 'SUFFIX',
      );
      expect(preview.changeSummary.protectedBlockingNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: f[origin].id,
            protectionReasons: expect.arrayContaining([
              'REFERENCED_BY_ADOPTED_ROUTE',
            ]),
          }),
        ]),
      );
      const before = await repairDurableState(f.restored.trip.id);
      const response = await adopt(
        userA,
        f.restored.trip,
        preview.previewId,
        'repair-blocked',
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'PREVIEW_BLOCKED' },
      });
      expect(await repairDurableState(f.restored.trip.id)).toEqual(before);
      expect(before.adoptedRoutes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: f.first.operationReceipt.adoptedRouteId,
            status: 'ACTIVE',
          }),
          expect.objectContaining({
            id: f.second.operationReceipt.adoptedRouteId,
            status: 'UNDONE',
            anchorFromNodeId: f[origin].id,
          }),
        ]),
      );
      expect(before.operationReceipts).toHaveLength(3);
    },
  );

  it('P5E2 repair C: referenced generated anchor can be reused with its original ID', async () => {
    const f = await repairRestoredFixture();
    const source = suffixFoundationCandidate(false).candidates[0]!;
    const first = source.legs[0]!;
    const last = source.legs.at(-1)!;
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        {
          ...source,
          legs: [
            first,
            {
              ...last,
              from: first.to,
              departure: first.arrival,
              durationSeconds: 2400,
              groundTransit: {
                ...last.groundTransit!,
                boardingHubRef:
                  first.to.providerHubRef ?? first.to.providerPlaceRef,
              },
            },
          ],
        },
      ],
    };
    const preview = await createPreview(userA, f.restored.trip, f.A.id, f.D.id);
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.nodesToReuse).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: f.B.id })]),
    );
    expect(
      preview.changeSummary.nodesToRemove?.map((node) => node.nodeId),
    ).toEqual([f.C.id]);
    const adopted = await adoptSuccessfully(
      userA,
      f.restored.trip,
      preview.previewId,
      'repair-reuse',
    );
    expect(
      adopted.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
    ).toEqual([f.A.id, f.B.id, f.D.id]);
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: f.second.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'UNDONE', anchorFromNodeId: f.B.id });
  });

  it('P5E2 repair D: unadopted suffix Query/Preview does not permanently protect nodes', async () => {
    const f = await suffixFixture(false);
    const temporary = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    providerResult = suffixFoundationCandidate(
      true,
      '2030-10-01T10:00:00Z',
      '2030-10-01T11:00:00Z',
    );
    const full = await createPreview(userA, f.first.trip, f.A.id, f.D.id);
    expect(full.adoptable).toBe(true);
    await adoptSuccessfully(
      userA,
      f.first.trip,
      full.previewId,
      'repair-temporary',
    );
    expect(
      await managed.client.itineraryNode.findUnique({ where: { id: f.B.id } }),
    ).toBeNull();
    expect(
      await managed.client.routePreview.findUnique({
        where: { id: temporary.previewId },
      }),
    ).toBeNull();
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: f.first.trip.id },
      }),
    ).toBe(2);
  });

  it.each(['anchorFrom', 'anchorTo', 'snapshot', 'receipt'] as const)(
    'P5E2 repair E: locked Adopt rechecks new persistent %s reference after Preview',
    async (reference) => {
      const f = await suffixFixture(false);
      const temporary = await createPreview(
        userA,
        f.first.trip,
        f.B.id,
        f.D.id,
        { type: 'DEPART_AT', instant: '2030-10-01T10:30:00Z', timeZone: 'UTC' },
      );
      const evidence = await managed.client.routePreview.findUniqueOrThrow({
        where: { id: temporary.previewId },
      });
      providerResult = suffixFoundationCandidate(
        true,
        '2030-10-01T10:00:00Z',
        '2030-10-01T11:00:00Z',
      );
      const full = await createPreview(userA, f.first.trip, f.A.id, f.D.id);
      expect(full.adoptable).toBe(true);
      const sourceRoute = await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: f.first.operationReceipt.adoptedRouteId },
      });
      if (reference === 'receipt') {
        const receipt = await managed.client.operationReceipt.findUniqueOrThrow(
          { where: { id: f.first.operationReceipt.id } },
        );
        await managed.client.operationReceipt.create({
          data: {
            ...receipt,
            id: randomUUID(),
            idempotencyKey: 'repair-retained-evidence',
            delta: { synthetic: true },
            previewId: evidence.id,
          },
        });
      } else {
        // Persistence-only fixture keeps Trip.version unchanged to isolate the
        // locked reference recheck from the ordinary version fence.
        await managed.client.adoptedRoute.create({
          data: {
            ...sourceRoute,
            id: randomUUID(),
            status: reference === 'anchorTo' ? 'REPLACED' : 'UNDONE',
            sourcePreviewId: evidence.id,
            candidateSnapshotId: evidence.candidateSnapshotId,
            anchorFromNodeId: reference === 'anchorFrom' ? f.B.id : f.A.id,
            anchorToNodeId: reference === 'anchorTo' ? f.C.id : f.D.id,
          },
        });
      }
      const before = await repairDurableState(f.first.trip.id);
      const repository = new PrismaRoutePlanningRepository(managed.client);
      expect(
        await repository.adoptPreview({
          ownerUserId: userA.actor.userId,
          tripId: f.first.trip.id,
          previewId: full.previewId,
          baseTripVersion: f.first.trip.version,
          idempotencyKey: 'repair-lock-recheck',
          requestHash: 'a'.repeat(64),
          acceptedUserAdjustments: [],
          now: NOW,
          undoExpiresAt: new Date(NOW.getTime() + 600_000),
        }),
      ).toEqual({ status: 'PREVIEW_BLOCKED' });
      expect(await repairDurableState(f.first.trip.id)).toEqual(before);
      const refreshed = await createPreview(
        userA,
        f.first.trip,
        f.A.id,
        f.D.id,
      );
      expect(refreshed.adoptable).toBe(false);
      expect(refreshed.changeSummary.protectedBlockingNodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: reference === 'anchorTo' ? f.C.id : f.B.id,
            protectionReasons: expect.arrayContaining([
              reference.startsWith('anchor')
                ? 'REFERENCED_BY_ADOPTED_ROUTE'
                : 'REFERENCED_BY_RETAINED_PLANNING_DATA',
            ]),
          }),
        ]),
      );
      await managed.client.trip.update({
        where: { id: f.first.trip.id },
        data: { version: { increment: 1 } },
      });
      expect(
        (
          await adopt(userA, f.first.trip, full.previewId, 'repair-version')
        ).json(),
      ).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    },
  );

  it.each([false, true])(
    'P5E2 4A: suffix Query/Preview/Adopt/Undo preserves prefix identity and facts (ACTUAL=%s)',
    async (actual) => {
      const f = await suffixFixture(actual);
      const route1 = f.first.operationReceipt.adoptedRouteId;
      const beforeNodes = await managed.client.itineraryNode.findMany({
        where: { tripId: f.first.trip.id },
        orderBy: { position: 'asc' },
      });
      const beforePrefix = await managed.client.transportEdge.findUniqueOrThrow(
        {
          where: { id: f.prefix.id },
          include: {
            temporalValues: { orderBy: { id: 'asc' } },
            dayProjections: true,
          },
        },
      );
      const sourceLegs =
        await managed.client.groundTransitLegExecution.findMany({
          where: { adoptedRouteId: route1 },
          orderBy: { legIndex: 'asc' },
        });
      expect(sourceLegs).toHaveLength(3);
      await managed.client.groundTransitObservation.create({
        data: {
          legExecutionId: sourceLegs[1]!.id,
          observationIdentity: 'SYNTHETIC_4A_HISTORY',
          fetchedAt: NOW,
          factsHash: 'a'.repeat(64),
          facts: { synthetic: true },
        },
      });
      await managed.client.groundTransitStateTransition.create({
        data: {
          legExecutionId: sourceLegs[1]!.id,
          fromState: 'PENDING',
          toState: 'UNKNOWN',
          source: 'SYNTHETIC_TEST',
          evidenceRef: 'SYNTHETIC_4A',
          occurredAt: NOW,
        },
      });
      const beforeLegs =
        await managed.client.groundTransitLegExecution.findMany({
          where: { adoptedRouteId: route1 },
          include: { observations: true, stateTransitions: true },
          orderBy: { legIndex: 'asc' },
        });
      const unsupported = await query(
        userA,
        f.first.trip,
        f.B.id,
        f.C.id,
        departHint(),
      );
      expect(unsupported.json()).toMatchObject({
        error: { code: 'ROUTE_QUERY_UNSUPPORTED' },
      });
      const queried = await query(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(queried.statusCode).toBe(200);
      const snapshotId = (queried.json() as RouteQueryResponse).candidates[0]!
        .candidateSnapshotId;
      expect(
        await managed.client.routeCandidateSnapshot.findUniqueOrThrow({
          where: { id: snapshotId },
        }),
      ).toMatchObject({ fromNodeId: f.B.id, toNodeId: f.D.id });
      const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(preview.adoptable).toBe(true);
      expect(preview.changeSummary.routeCorridor).toMatchObject({
        replacementScope: 'SUFFIX',
        sourceAdoptedRouteId: route1,
        sourceRouteAnchorFromNodeId: f.A.id,
        sourceRouteAnchorToNodeId: f.D.id,
        replacementAnchorFromNodeId: f.B.id,
        replacementAnchorToNodeId: f.D.id,
      });
      expect(
        preview.changeSummary.willReplaceTransportEdgeIds?.slice().sort(),
      ).toEqual(f.suffixEdges.map((edge) => edge.id).sort());
      expect(
        preview.changeSummary.nodesToRemove?.map((node) => node.nodeId),
      ).toEqual([f.C.id]);
      const second = await adoptSuccessfully(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-suffix-adopt',
      );
      const route2 = second.operationReceipt.adoptedRouteId;
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route1 },
        }),
      ).toMatchObject({ status: 'REPLACED' });
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route2 },
        }),
      ).toMatchObject({
        status: 'ACTIVE',
        anchorFromNodeId: f.B.id,
        anchorToNodeId: f.D.id,
      });
      expect(
        await managed.client.transportEdge.findUniqueOrThrow({
          where: { id: f.prefix.id },
          include: {
            temporalValues: { orderBy: { id: 'asc' } },
            dayProjections: true,
          },
        }),
      ).toEqual(beforePrefix);
      const receipt = await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: second.operationReceipt.id },
      });
      expect(receipt.delta).toMatchObject({
        schemaVersion: 'route-adopt-delta-v4',
        replacementScope: 'SUFFIX',
        previousActiveAdoptedRouteId: route1,
        preservedPrefixTransportEdgeIds: [f.prefix.id],
      });
      expect(
        await managed.client.transportEdgeHistory.findMany({
          where: { tripId: f.first.trip.id },
        }),
      ).toEqual(
        expect.arrayContaining(
          f.suffixEdges.map((edge) =>
            expect.objectContaining({
              originalTransportEdgeId: edge.id,
              adoptedRouteId: route1,
            }),
          ),
        ),
      );
      expect(
        await managed.client.groundTransitLegExecution.findMany({
          where: { adoptedRouteId: route1 },
          include: { observations: true, stateTransitions: true },
          orderBy: { legIndex: 'asc' },
        }),
      ).toEqual(beforeLegs);
      expect(
        await managed.client.groundTransitLegExecution.count({
          where: { adoptedRouteId: route2 },
        }),
      ).toBe(2);
      expect(
        second.trip.connections.every(
          (connection) => connection.state === 'ACTIVE',
        ),
      ).toBe(true);
      const replay = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-suffix-adopt',
      );
      expect(replay.json()).toMatchObject({
        operationReceipt: { id: receipt.id },
        trip: { version: second.trip.version },
      });
      const undone = await undoSuccessfully(
        userA,
        second.trip,
        receipt.id,
        'synthetic-suffix-undo',
      );
      expect(undone.trip.version).toBe(second.trip.version + 1);
      expect(
        undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
      ).toEqual([f.A.id, f.B.id, f.C.id, f.D.id]);
      expect(
        undone.trip.connections
          .map((connection) => connection.transport!.id)
          .sort(),
      ).toEqual([f.prefix.id, ...f.suffixEdges.map((edge) => edge.id)].sort());
      expect(
        await managed.client.transportEdge.findUniqueOrThrow({
          where: { id: f.prefix.id },
          include: {
            temporalValues: { orderBy: { id: 'asc' } },
            dayProjections: true,
          },
        }),
      ).toEqual(beforePrefix);
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route1 },
        }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(
        await managed.client.adoptedRoute.findUniqueOrThrow({
          where: { id: route2 },
        }),
      ).toMatchObject({ status: 'UNDONE' });
      expect(
        await managed.client.transportEdgeHistory.count({
          where: { tripId: f.first.trip.id },
        }),
      ).toBe(0);
      const restoredNodes = await managed.client.itineraryNode.findMany({
        where: { tripId: f.first.trip.id },
        orderBy: { position: 'asc' },
      });
      expect(
        restoredNodes.map((node) => [
          node.id,
          node.dayOccurrenceId,
          node.position,
          node.adoptedRouteId,
        ]),
      ).toEqual(
        beforeNodes.map((node) => [
          node.id,
          node.dayOccurrenceId,
          node.position,
          node.adoptedRouteId,
        ]),
      );
      const undoReplay = await undoSuccessfully(
        userA,
        second.trip,
        receipt.id,
        'synthetic-suffix-undo',
      );
      expect(undoReplay.operationReceipt.id).toBe(undone.operationReceipt.id);
    },
  );

  it('P5E2 4A: later suffix C→D preserves both prefix edges across Adopt/Undo', async () => {
    const f = await suffixFixture();
    providerResult = {
      status: 'SUCCESS',
      candidates: [
        candidate('2030-10-01T10:45:00Z', '2030-10-01T11:00:00Z', 'UTC', 'UTC'),
      ],
    };
    const preservedIds = [
      f.prefix.id,
      f.suffixEdges.find((edge) => edge.fromNodeId === f.B.id)!.id,
    ];
    const beforePrefix = await managed.client.transportEdge.findMany({
      where: { id: { in: preservedIds } },
      include: { temporalValues: true, dayProjections: true },
      orderBy: { id: 'asc' },
    });
    const preview = await createPreview(userA, f.first.trip, f.C.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:45:00Z',
      timeZone: 'UTC',
    });
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.routeCorridor).toMatchObject({
      replacementScope: 'SUFFIX',
      preservedPrefixNodeIds: [f.A.id, f.B.id, f.C.id],
      preservedPrefixTransportEdgeIds: preservedIds,
    });
    expect(preview.changeSummary.nodesToRemove).toEqual([]);
    expect(preview.changeSummary.willReplaceTransportEdgeIds).toEqual([
      f.suffixEdges.find((edge) => edge.fromNodeId === f.C.id)!.id,
    ]);
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-later-suffix',
    );
    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-later-suffix-undo',
    );
    expect(
      undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
    ).toEqual([f.A.id, f.B.id, f.C.id, f.D.id]);
    expect(
      await managed.client.transportEdge.findMany({
        where: { id: { in: preservedIds } },
        include: { temporalValues: true, dayProjections: true },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(beforePrefix);
  });

  it.each(['node', 'edge', 'prefix'])(
    'P5E2 4A: locked Adopt rechecks ACTUAL after Preview (%s)',
    async (kind) => {
      const f = await suffixFixture();
      const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(preview.adoptable).toBe(true);
      const fact =
        kind === 'prefix'
          ? await managed.client.temporalValue.update({
              where: {
                id: (
                  await managed.client.temporalValue.findFirstOrThrow({
                    where: {
                      transportEdgeId: f.prefix.id,
                      layer: 'ACTUAL',
                      pointKind: 'DEPARTURE',
                    },
                  })
                ).id,
              },
              data: { instant: new Date('2030-10-01T10:01:00Z') },
            })
          : await managed.client.temporalValue.create({
              data: {
                ...(kind === 'node'
                  ? { nodeId: f.C.id }
                  : { transportEdgeId: f.suffixEdges[0]!.id }),
                layer: 'ACTUAL',
                pointKind: 'DEPARTURE',
                instant: new Date('2030-10-01T10:30:00Z'),
                timeZone: 'UTC',
                sourceKind: 'USER_VALUE',
              },
            });
      const response = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-suffix-actual-race',
      );
      expect(response.statusCode).toBe(kind === 'prefix' ? 200 : 409);
      if (kind !== 'prefix')
        expect(response.json()).toMatchObject({
          error: { code: 'FACT_PROTECTED' },
        });
      expect(
        await managed.client.temporalValue.findUniqueOrThrow({
          where: { id: fact.id },
        }),
      ).toEqual(fact);
    },
  );

  it('P5E2 4A: concurrent suffix Adopts admit one transaction and preserve the prefix', async () => {
    const f = await suffixFixture();
    const hint = {
      type: 'DEPART_AT' as const,
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    };
    const [left, right] = await Promise.all([
      createPreview(userA, f.first.trip, f.B.id, f.D.id, hint),
      createPreview(userA, f.first.trip, f.B.id, f.D.id, hint),
    ]);
    const responses = await Promise.all([
      adopt(
        userA,
        f.first.trip,
        left.previewId,
        'synthetic-suffix-concurrent-a',
      ),
      adopt(
        userA,
        f.first.trip,
        right.previewId,
        'synthetic-suffix-concurrent-b',
      ),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    expect(
      responses.find((response) => response.statusCode === 409)!.json(),
    ).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
    expect(
      await managed.client.adoptedRoute.count({
        where: { tripId: f.first.trip.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    expect(
      await managed.client.transportEdge.findUniqueOrThrow({
        where: { id: f.prefix.id },
      }),
    ).toEqual(f.prefix);
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: f.first.trip.id, operationType: 'ROUTE_ADOPT' },
      }),
    ).toBe(2);
  });

  it('P5E2 4A: suffix V4 Undo restores accepted origin dwell adjustment', async () => {
    const f = await suffixFixture(true, true);
    const trip = await command(userA, f.first.trip, {
      type: 'SET_MIN_DWELL',
      nodeId: f.B.id,
      durationSeconds: 1200,
      locked: false,
    });
    const queried = await query(userA, trip, f.B.id, f.D.id, null);
    expect(queried.statusCode, JSON.stringify(queried.json())).toBe(200);
    const route = queried.json() as RouteQueryResponse;
    expect(route.candidates).toHaveLength(1);
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(userA),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(response.statusCode).toBe(201);
    const preview = response.json() as RoutePreviewView;
    const adjustments = preview.changeSummary.requiredUserAdjustments ?? [];
    expect(adjustments).toEqual([
      expect.objectContaining({
        nodeId: f.B.id,
        fromDurationSeconds: 1200,
        toDurationSeconds: 600,
      }),
    ]);
    expect(preview.adoptable).toBe(true);
    const second = await adoptSuccessfully(
      userA,
      trip,
      preview.previewId,
      'synthetic-suffix-dwell',
      adjustments,
    );
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { nodeId: f.B.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 600 });
    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-suffix-dwell-undo',
    );
    expect(undone.trip.version).toBe(second.trip.version + 1);
    expect(
      await managed.client.userTimeIntent.findFirstOrThrow({
        where: { nodeId: f.B.id, kind: 'MIN_DWELL' },
      }),
    ).toMatchObject({ durationSeconds: 1200 });
    expect(
      await managed.client.temporalValue.findMany({
        where: { nodeId: f.B.id, layer: 'ACTUAL' },
      }),
    ).toEqual([
      expect.objectContaining({ instant: new Date('2030-10-01T10:20:00Z') }),
    ]);
  });

  it('P5E2 4A: suffix Undo restores cross-day projections and node placement', async () => {
    let initial = await createTrip(userA);
    initial = await addVisit(userA, initial, 'SYNTHETIC A', '2030-10-01');
    initial = await addVisit(userA, initial, 'SYNTHETIC D', '2030-10-03');
    const [a, d] = initial.days.flatMap((day) => day.nodes);
    providerResult = suffixFoundationCandidate(
      false,
      '2030-10-01T20:00:00Z',
      '2030-10-03T08:00:00Z',
    );
    const firstPreview = await createPreview(userA, initial, a!.id, d!.id);
    const first = await adoptSuccessfully(
      userA,
      initial,
      firstPreview.previewId,
      'synthetic-cross-day-source',
    );
    const b = first.trip.days.flatMap((day) => day.nodes)[1]!;
    const beforeNodes = await managed.client.itineraryNode.findMany({
      where: { tripId: initial.id },
      orderBy: { id: 'asc' },
    });
    const beforeProjections =
      await managed.client.transportDayProjection.findMany({
        where: { tripId: initial.id },
        select: { transportEdgeId: true, dayOccurrenceId: true, role: true },
        orderBy: [
          { transportEdgeId: 'asc' },
          { dayOccurrenceId: 'asc' },
          { role: 'asc' },
        ],
      });
    expect(beforeProjections.map((projection) => projection.role)).toEqual(
      expect.arrayContaining(['START', 'END', 'SAME_DAY']),
    );
    providerResult = suffixFoundationCandidate(
      true,
      '2030-10-02T08:30:00Z',
      '2030-10-03T08:00:00Z',
    );
    const preview = await createPreview(userA, first.trip, b.id, d!.id, {
      type: 'DEPART_AT',
      instant: '2030-10-02T08:30:00Z',
      timeZone: 'UTC',
    });
    expect(preview.adoptable).toBe(true);
    expect(preview.changeSummary.routeCorridor?.replacementScope).toBe(
      'SUFFIX',
    );
    const second = await adoptSuccessfully(
      userA,
      first.trip,
      preview.previewId,
      'synthetic-cross-day-suffix',
    );
    const undone = await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-cross-day-suffix-undo',
    );
    expect(
      undone.trip.days.map((day) => [day.dayOccurrenceId, day.localDate]),
    ).toEqual(
      first.trip.days.map((day) => [day.dayOccurrenceId, day.localDate]),
    );
    const restoredNodes = await managed.client.itineraryNode.findMany({
      where: { tripId: initial.id },
      orderBy: { id: 'asc' },
    });
    expect(
      restoredNodes.map((node) => [
        node.id,
        node.dayOccurrenceId,
        node.position,
      ]),
    ).toEqual(
      beforeNodes.map((node) => [node.id, node.dayOccurrenceId, node.position]),
    );
    expect(
      await managed.client.transportDayProjection.findMany({
        where: { tripId: initial.id },
        select: { transportEdgeId: true, dayOccurrenceId: true, role: true },
        orderBy: [
          { transportEdgeId: 'asc' },
          { dayOccurrenceId: 'asc' },
          { role: 'asc' },
        ],
      }),
    ).toEqual(beforeProjections);
  });

  it.each(['route-adopt-delta-v2', 'route-adopt-delta-v3'])(
    'P5E2 4A: reads legacy full Preview JSON and %s Undo delta',
    async (schemaVersion) => {
      const initial = await tripWithVisits(userA, [
        'SYNTHETIC Legacy A',
        'SYNTHETIC Legacy D',
      ]);
      const [a, d] = initial.days[0]!.nodes;
      const preview = await createPreview(userA, initial, a!.id, d!.id);
      const stored = await managed.client.routePreview.findUniqueOrThrow({
        where: { id: preview.previewId },
      });
      const payload =
        stored.previewPayload as unknown as StoredRoutePreviewPayload;
      const corridor = payload.changeSummary.routeCorridor!;
      const legacyPayload: StoredRoutePreviewPayload = {
        ...payload,
        changeSummary: {
          ...payload.changeSummary,
          routeCorridor: {
            anchorFromNodeId: corridor.anchorFromNodeId,
            anchorToNodeId: corridor.anchorToNodeId,
            currentNodeIds: corridor.currentNodeIds,
            currentAdoptedRouteId: corridor.currentAdoptedRouteId,
          },
        },
      };
      await managed.client.routePreview.update({
        where: { id: preview.previewId },
        data: {
          previewPayload: legacyPayload as never,
          previewHash: hashRoutePreviewPayload(legacyPayload),
        },
      });
      const first = await adoptSuccessfully(
        userA,
        initial,
        preview.previewId,
        `synthetic-legacy-${schemaVersion}`,
      );
      const receipt = await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: first.operationReceipt.id },
      });
      await managed.client.operationReceipt.update({
        where: { id: receipt.id },
        data: {
          delta: {
            ...(receipt.delta as Record<string, unknown>),
            schemaVersion,
          } as never,
        },
      });
      const undone = await undoSuccessfully(
        userA,
        first.trip,
        receipt.id,
        `synthetic-legacy-undo-${schemaVersion}`,
      );
      expect(
        undone.trip.days.flatMap((day) => day.nodes).map((node) => node.id),
      ).toEqual([a!.id, d!.id]);
      expect(undone.trip.version).toBe(first.trip.version + 1);
    },
  );

  it.each(['node', 'edge'])(
    'P5E2 4A: protects ACTUAL inside mutable suffix (%s)',
    async (kind) => {
      const f = await suffixFixture();
      await managed.client.temporalValue.create({
        data: {
          ...(kind === 'node'
            ? { nodeId: f.C.id }
            : { transportEdgeId: f.suffixEdges[0]!.id }),
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: new Date('2030-10-01T10:40:00Z'),
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      });
      const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      expect(preview.adoptable).toBe(false);
      const response = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-protected-suffix',
      );
      expect(['PREVIEW_BLOCKED', 'FACT_PROTECTED']).toContain(
        response.json().error.code,
      );
      expect(
        await managed.client.adoptedRoute.count({
          where: { tripId: f.first.trip.id },
        }),
      ).toBe(1);
      expect(
        await managed.client.transportEdge.count({
          where: { tripId: f.first.trip.id },
        }),
      ).toBe(3);
    },
  );

  it('P5E2 4A: uses existing monitoring cancellation and scheduler across suffix Adopt/Undo', async () => {
    const f = await suffixFixture();
    const r1 = f.first.operationReceipt.adoptedRouteId;
    await managed.client.tripAssistanceCapability.create({
      data: {
        tripId: f.first.trip.id,
        ownerUserId: userA.actor.userId,
        kind: 'GROUND_TRANSIT_MONITORING',
        state: 'ENABLED',
        revision: 1,
        enabledAt: NOW,
      },
    });
    const queued = await managed.client.job.create({
      data: {
        type: 'GROUND_TRANSIT_MONITOR',
        runAt: NOW,
        uniqueKey: 'SYNTHETIC_4A_QUEUED',
        payloadRef: r1,
        capabilityRevision: 1,
        maxAttempts: 3,
      },
    });
    const running = await managed.client.job.create({
      data: {
        type: 'GROUND_TRANSIT_MONITOR',
        runAt: NOW,
        uniqueKey: 'SYNTHETIC_4A_RUNNING',
        payloadRef: r1,
        capabilityRevision: 1,
        maxAttempts: 3,
        status: 'RUNNING',
        leaseOwner: 'SYNTHETIC_WORKER',
        leaseUntil: new Date(NOW.getTime() + 30000),
      },
    });
    const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-suffix-monitor',
    );
    expect(
      await managed.client.job.findUniqueOrThrow({ where: { id: queued.id } }),
    ).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    expect(
      await managed.client.job.findUniqueOrThrow({ where: { id: running.id } }),
    ).toMatchObject({ status: 'RUNNING', cancelRequested: true });
    const repository = new PrismaGroundTransitRepository(managed.client);
    expect(
      await repository.ensureEligibleMonitoring(
        new Date('2030-10-01T10:25:00Z'),
      ),
    ).toBe(1);
    expect(
      await repository.listJobLegs({
        adoptedRouteId: r1,
        capabilityRevision: 1,
        now: new Date('2030-10-01T10:25:00Z'),
      }),
    ).toEqual([]);
    expect(
      await managed.client.job.findFirstOrThrow({
        where: {
          payloadRef: second.operationReceipt.adoptedRouteId,
          type: 'GROUND_TRANSIT_MONITOR',
        },
      }),
    ).toMatchObject({ status: 'QUEUED', cancelRequested: false });
    await undoSuccessfully(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-suffix-monitor-undo',
    );
    expect(
      await managed.client.job.findFirstOrThrow({
        where: {
          payloadRef: second.operationReceipt.adoptedRouteId,
          type: 'GROUND_TRANSIT_MONITOR',
        },
      }),
    ).toMatchObject({ status: 'CANCELLED', cancelRequested: true });
    expect(
      await managed.client.tripAssistanceCapability.findFirstOrThrow({
        where: { tripId: f.first.trip.id, kind: 'GROUND_TRANSIT_MONITORING' },
      }),
    ).toMatchObject({ state: 'ENABLED', revision: 1 });
  });

  it.each([
    'new-actual',
    'prefix-facts',
    'prefix-topology',
    'delta-prefix',
    'delta-histories',
  ])('P5E2 4A: Undo fences %s without overwriting facts', async (mutation) => {
    const f = await suffixFixture();
    const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-suffix-conflict',
    );
    if (mutation === 'new-actual' || mutation === 'prefix-facts') {
      const edge =
        mutation === 'prefix-facts'
          ? f.prefix
          : await managed.client.transportEdge.findFirstOrThrow({
              where: { adoptedRouteId: second.operationReceipt.adoptedRouteId },
            });
      if (mutation === 'prefix-facts') {
        await managed.client.temporalValue.updateMany({
          where: {
            transportEdgeId: edge.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
          },
          data: { instant: new Date('2030-10-01T10:01:00Z') },
        });
      } else {
        await managed.client.temporalValue.create({
          data: {
            transportEdgeId: edge.id,
            layer: 'ACTUAL',
            pointKind: 'DEPARTURE',
            instant: new Date('2030-10-01T10:30:00Z'),
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
        });
      }
    } else if (mutation === 'prefix-topology') {
      await managed.client.transportEdge.update({
        where: { id: f.prefix.id },
        data: { adoptedRouteId: second.operationReceipt.adoptedRouteId },
      });
    } else {
      const receipt = await managed.client.operationReceipt.findUniqueOrThrow({
        where: { id: second.operationReceipt.id },
      });
      const delta = receipt.delta as Record<string, unknown>;
      await managed.client.operationReceipt.update({
        where: { id: receipt.id },
        data: {
          delta: {
            ...delta,
            ...(mutation === 'delta-prefix'
              ? { preservedPrefixTransportEdgeIds: [f.suffixEdges[0]!.id] }
              : { archivedTransportEdgeIds: [f.prefix.id] }),
          } as never,
        },
      });
    }
    const response = await undo(
      userA,
      second.trip,
      second.operationReceipt.id,
      'synthetic-suffix-conflict-undo',
    );
    expect(response.json()).toMatchObject({ error: { code: 'UNDO_CONFLICT' } });
    expect(
      await managed.client.adoptedRoute.findUniqueOrThrow({
        where: { id: second.operationReceipt.adoptedRouteId },
      }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await managed.client.operationReceipt.count({
        where: { tripId: f.first.trip.id, operationType: 'ROUTE_UNDO' },
      }),
    ).toBe(0);
  });

  it.each(['version', 'route', 'origin', 'topology'])(
    'P5E2 4A: Preview/Adopt fence stale %s',
    async (mutation) => {
      const f = await suffixFixture();
      const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
        type: 'DEPART_AT',
        instant: '2030-10-01T10:30:00Z',
        timeZone: 'UTC',
      });
      if (mutation === 'version')
        await managed.client.trip.update({
          where: { id: f.first.trip.id },
          data: { version: { increment: 1 } },
        });
      if (mutation === 'route')
        await managed.client.adoptedRoute.update({
          where: { id: f.first.operationReceipt.adoptedRouteId },
          data: { status: 'REPLACED' },
        });
      if (mutation === 'origin')
        await managed.client.itineraryNode.update({
          where: { id: f.B.id },
          data: { source: 'USER_PLANNED', adoptedRouteId: null },
        });
      if (mutation === 'topology')
        await managed.client.transportEdge.delete({
          where: { id: f.suffixEdges[0]!.id },
        });
      const freshPreview = await app.inject({
        method: 'POST',
        url: `/trips/${f.first.trip.id}/previews`,
        headers: bearer(userA),
        payload: {
          basisVersion: f.first.trip.version,
          candidateSnapshotId: preview.candidateSnapshotId,
        },
      });
      expect(['VERSION_CONFLICT', 'PREVIEW_STALE']).toContain(
        freshPreview.json().error.code,
      );
      const response = await adopt(
        userA,
        f.first.trip,
        preview.previewId,
        'synthetic-stale-suffix',
      );
      expect(['VERSION_CONFLICT', 'PREVIEW_STALE']).toContain(
        response.json().error.code,
      );
    },
  );

  it('P5E2 4A: suffix remains owner scoped across Query/Preview/Adopt/Undo', async () => {
    const f = await suffixFixture();
    const preview = await createPreview(userA, f.first.trip, f.B.id, f.D.id, {
      type: 'DEPART_AT',
      instant: '2030-10-01T10:30:00Z',
      timeZone: 'UTC',
    });
    for (const other of [userB, admin]) {
      expect(
        (
          await query(other, f.first.trip, f.B.id, f.D.id, {
            type: 'DEPART_AT',
            instant: '2030-10-01T10:30:00Z',
            timeZone: 'UTC',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/trips/${f.first.trip.id}/previews/${preview.previewId}`,
            headers: bearer(other),
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/trips/${f.first.trip.id}/previews`,
            headers: bearer(other),
            payload: {
              basisVersion: f.first.trip.version,
              candidateSnapshotId: preview.candidateSnapshotId,
            },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await adopt(
            other,
            f.first.trip,
            preview.previewId,
            'synthetic-private-suffix',
          )
        ).statusCode,
      ).toBe(404);
    }
    const second = await adoptSuccessfully(
      userA,
      f.first.trip,
      preview.previewId,
      'synthetic-private-suffix-owner',
    );
    for (const other of [userB, admin])
      expect(
        (
          await undo(
            other,
            second.trip,
            second.operationReceipt.id,
            'synthetic-private-undo',
          )
        ).statusCode,
      ).toBe(404);
  });

  async function createPreview(
    identity: SyntheticIdentity,
    trip: TripView,
    fromNodeId: string,
    toNodeId: string,
    hint: Record<string, unknown> = departHint(),
  ): Promise<RoutePreviewView> {
    const routeResponse = await query(
      identity,
      trip,
      fromNodeId,
      toNodeId,
      hint,
    );
    expect(routeResponse.statusCode).toBe(200);
    const route = routeResponse.json() as RouteQueryResponse;
    const previewResponse = await app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews`,
      headers: bearer(identity),
      payload: {
        basisVersion: trip.version,
        candidateSnapshotId: route.candidates[0]!.candidateSnapshotId,
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    return previewResponse.json() as RoutePreviewView;
  }

  function adopt(
    identity: SyntheticIdentity,
    trip: TripView,
    previewId: string,
    idempotencyKey: string,
    acceptedUserAdjustments?: readonly {
      readonly intentId: string;
      readonly nodeId: string;
      readonly fromDurationSeconds: number;
      readonly toDurationSeconds: number;
    }[],
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews/${previewId}/adopt`,
      headers: bearer(identity),
      payload: {
        baseTripVersion: trip.version,
        idempotencyKey,
        ...(acceptedUserAdjustments === undefined
          ? {}
          : { acceptedUserAdjustments }),
      },
    });
  }

  async function adoptSuccessfully(
    identity: SyntheticIdentity,
    trip: TripView,
    previewId: string,
    idempotencyKey: string,
    acceptedUserAdjustments?: readonly {
      readonly intentId: string;
      readonly nodeId: string;
      readonly fromDurationSeconds: number;
      readonly toDurationSeconds: number;
    }[],
  ): Promise<{
    operationReceipt: {
      id: string;
      operationType: 'ROUTE_ADOPT';
      adoptedRouteId: string;
      resultingTripVersion: number;
    };
    trip: TripView;
  }> {
    const response = await adopt(
      identity,
      trip,
      previewId,
      idempotencyKey,
      acceptedUserAdjustments,
    );
    expect(response.statusCode).toBe(200);
    return response.json() as {
      operationReceipt: {
        id: string;
        operationType: 'ROUTE_ADOPT';
        adoptedRouteId: string;
        resultingTripVersion: number;
      };
      trip: TripView;
    };
  }

  function undo(
    identity: SyntheticIdentity,
    trip: TripView,
    operationReceiptId: string,
    idempotencyKey: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/operations/${operationReceiptId}/undo`,
      headers: bearer(identity),
      payload: {
        baseTripVersion: trip.version,
        idempotencyKey,
      },
    });
  }

  async function undoSuccessfully(
    identity: SyntheticIdentity,
    trip: TripView,
    operationReceiptId: string,
    idempotencyKey: string,
  ): Promise<{
    operationReceipt: {
      id: string;
      operationType: 'ROUTE_UNDO';
      targetOperationReceiptId: string;
      baseTripVersion: number;
      resultingTripVersion: number;
      delta: Record<string, unknown>;
    };
    trip: TripView;
  }> {
    const response = await undo(
      identity,
      trip,
      operationReceiptId,
      idempotencyKey,
    );
    expect(response.statusCode).toBe(200);
    return response.json() as {
      operationReceipt: {
        id: string;
        operationType: 'ROUTE_UNDO';
        targetOperationReceiptId: string;
        baseTripVersion: number;
        resultingTripVersion: number;
        delta: Record<string, unknown>;
      };
      trip: TripView;
    };
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

function googleExpectedLegs() {
  return [
    { mode: 'WALKING', fixedService: false },
    { mode: 'BUS', fixedService: true },
    { mode: 'WALKING', fixedService: false },
    { mode: 'RAIL', fixedService: true },
    { mode: 'WALKING', fixedService: false },
    { mode: 'BUS', fixedService: true },
    { mode: 'WALKING', fixedService: false },
  ] as const;
}

function googleConsumerHokkaidoFixture(
  requestedQuery: Record<string, unknown>,
) {
  const stops = [
    ['Hotel Mahoroba', 42.4930624, 141.1419064],
    ['登别温泉中央', 42.495, 141.143],
    ['登别站前', 42.45, 141.18],
    ['登别站', 42.452, 141.181],
    ['洞爷站', 42.55, 140.764],
    ['洞爷站前', 42.551, 140.765],
    ['洞爷湖温泉', 42.566, 140.82],
    ['洞爷湖景乃之风', 42.565637, 140.8222622],
  ] as const;
  const legs = [
    googleSidecarLeg('WALK', 0, 1, '15:00', '15:05', null),
    googleSidecarLeg('BUS', 1, 2, '15:05', '15:25', '道南巴士 1'),
    googleSidecarLeg('WALK', 2, 3, '15:25', '15:30', null),
    googleSidecarLeg('TRAIN', 3, 4, '15:30', '16:15', '北斗 16号'),
    googleSidecarLeg('WALK', 4, 5, '16:15', '16:20', null),
    googleSidecarLeg('BUS', 5, 6, '16:20', '16:50', '洞爷湖线'),
    googleSidecarLeg('WALK', 6, 7, '16:50', '17:00', null),
  ].map((leg) => ({
    ...leg,
    from: googleSidecarStop(stops[leg.fromIndex]!),
    to: googleSidecarStop(stops[leg.toIndex]!),
    fromIndex: undefined,
    toIndex: undefined,
  }));
  return {
    status: 'OK',
    requestId: 'sanitized-request-id',
    provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
    requestedQuery,
    queryVerified: true,
    fetchedAt: '2026-09-20T05:01:00.000Z',
    elapsedMs: 7_336,
    candidateCount: 1,
    candidates: [
      {
        id: 'sanitized-hokkaido-01',
        sourceIndex: 0,
        departureTime: googleSidecarTime('15:00'),
        arrivalTime: googleSidecarTime('17:00'),
        durationSeconds: 7_200,
        fare: { currency: 'JPY', amount: 3_910, displayText: 'JPY 3,910' },
        legs,
        warnings: [],
      },
    ],
    warnings: [],
    cacheHit: false,
    timing: {
      browserStartupMs: 0,
      contextCreationMs: 0,
      navigationMs: 100,
      directionsResponseMs: 7_200,
      parseMs: 20,
      sentinelMs: 16,
      totalMs: 7_336,
    },
  };
}

function googleSidecarLeg(
  mode: string,
  fromIndex: number,
  toIndex: number,
  departure: string,
  arrival: string,
  serviceName: string | null,
) {
  const durationSeconds =
    (Date.parse(`2026-09-23T${arrival}:00+09:00`) -
      Date.parse(`2026-09-23T${departure}:00+09:00`)) /
    1_000;
  return {
    mode,
    fromIndex,
    toIndex,
    departureTime: googleSidecarTime(departure),
    arrivalTime: googleSidecarTime(arrival),
    durationSeconds,
    serviceName,
    lineName: serviceName,
  };
}

function googleSidecarTime(time: string) {
  return {
    localDateTime: `2026-09-23T${time}:00`,
    timezone: 'Asia/Tokyo',
    utc: new Date(`2026-09-23T${time}:00+09:00`).toISOString(),
  };
}

function googleSidecarStop(stop: readonly [string, number, number]) {
  return { name: stop[0], latitude: stop[1], longitude: stop[2] };
}

function candidate(
  departure: string,
  arrival: string,
  departureTimeZone = 'Asia/Tokyo',
  arrivalTimeZone = 'America/Los_Angeles',
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
    departure: { instant: new Date(departure), timeZone: departureTimeZone },
    arrival: { instant: new Date(arrival), timeZone: arrivalTimeZone },
    durationSeconds,
    legs: [
      {
        mode: 'FLIGHT',
        from: origin,
        to: destination,
        departure: {
          instant: new Date(departure),
          timeZone: departureTimeZone,
        },
        arrival: {
          instant: new Date(arrival),
          timeZone: arrivalTimeZone,
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

function replacementSingleCandidate(
  suffix: string,
): Extract<RouteProviderResult, { status: 'SUCCESS' }>['candidates'][number] {
  const replacement = candidate('2030-10-01T10:00:00Z', '2030-10-01T11:00:00Z');
  const [leg] = replacement.legs;
  if (leg === undefined) {
    throw new Error('Synthetic replacement candidate must contain one leg.');
  }

  return {
    ...replacement,
    candidateId: `candidate-${suffix}`,
    providerCandidateRef: `SYNTHETIC_REF_${suffix}`,
    legs: [
      {
        ...leg,
        serviceLabel: `SYNTHETIC-${suffix}`,
        providerRef: `SYNTHETIC_LEG_${suffix}`,
      },
    ],
  };
}

function singleCandidateForLocalDate(
  localDate: string,
): Extract<RouteProviderResult, { status: 'SUCCESS' }>['candidates'][number] {
  return candidate(
    `${localDate}T10:00:00Z`,
    `${localDate}T11:00:00Z`,
    'UTC',
    'UTC',
  );
}

function transferCandidate(): Extract<
  RouteProviderResult,
  { status: 'SUCCESS' }
> {
  const origin = {
    name: 'Origin',
    latitude: 35.6762,
    longitude: 139.6503,
    providerPlaceRef: 'origin',
    providerHubRef: null,
  };
  const transfer = {
    name: 'Transfer Station',
    latitude: 35.68,
    longitude: 139.66,
    providerPlaceRef: 'transfer-station',
    providerHubRef: 'hub-transfer',
  };
  const destination = {
    name: 'Destination',
    latitude: 35.69,
    longitude: 139.67,
    providerPlaceRef: 'destination',
    providerHubRef: null,
  };
  const departure = new Date('2030-10-01T10:00:00Z');
  const transferAt = new Date('2030-10-01T10:30:00Z');
  const arrival = new Date('2030-10-01T11:00:00Z');
  return {
    status: 'SUCCESS',
    candidates: [
      {
        candidateId: 'candidate-transfer',
        provider: 'SYNTHETIC',
        providerCandidateRef: 'SYNTHETIC_TRANSFER',
        observedAt: NOW,
        validUntil: null,
        departure: { instant: departure, timeZone: 'UTC' },
        arrival: { instant: arrival, timeZone: 'UTC' },
        durationSeconds: 3600,
        legs: [
          {
            mode: 'RAIL',
            from: origin,
            to: transfer,
            departure: { instant: departure, timeZone: 'UTC' },
            arrival: { instant: transferAt, timeZone: 'UTC' },
            durationSeconds: 1800,
            fixedService: true,
            serviceLabel: 'SYNTHETIC-R1',
            providerRef: 'SYNTHETIC-R1',
          },
          {
            mode: 'WALKING',
            from: transfer,
            to: destination,
            departure: { instant: transferAt, timeZone: 'UTC' },
            arrival: { instant: arrival, timeZone: 'UTC' },
            durationSeconds: 1800,
            fixedService: false,
            serviceLabel: null,
            providerRef: 'SYNTHETIC-W1',
          },
        ],
        fare: null,
      },
    ],
  };
}

function suffixFoundationCandidate(
  suffix: boolean,
  departureInstant?: string,
  arrivalInstant?: string,
): Extract<RouteProviderResult, { status: 'SUCCESS' }> {
  const base = transferCandidate().candidates[0]!;
  const b = base.legs[0]!.to;
  const c = {
    ...b,
    name: suffix ? 'SYNTHETIC X' : 'SYNTHETIC C',
    providerPlaceRef: suffix ? 'synthetic-x' : 'synthetic-c',
    providerHubRef: suffix ? 'hub-x' : 'hub-c',
    latitude: 35.685,
    longitude: 139.665,
  };
  const locations = suffix
    ? [b, c, base.legs[1]!.to]
    : [base.legs[0]!.from, b, c, base.legs[1]!.to];
  const start = new Date(
    departureInstant ??
      (suffix ? '2030-10-01T10:30:00Z' : '2030-10-01T10:00:00Z'),
  );
  const duration =
    arrivalInstant === undefined
      ? suffix
        ? 900
        : 1200
      : (new Date(arrivalInstant).getTime() - start.getTime()) /
        1000 /
        (locations.length - 1);
  const legs = locations.slice(0, -1).map((from, index) => ({
    ...base.legs[0]!,
    from,
    to: locations[index + 1]!,
    departure: {
      instant: new Date(start.getTime() + index * duration * 1000),
      timeZone: 'UTC',
    },
    arrival: {
      instant: new Date(start.getTime() + (index + 1) * duration * 1000),
      timeZone: 'UTC',
    },
    durationSeconds: duration,
    serviceLabel: `SYNTHETIC_4A_${index}`,
    providerRef: `SYNTHETIC_4A_${index}`,
    groundTransit: {
      serviceClass: 'FIXED_SERVICE' as const,
      serviceIdentityKey: `synthetic:4a:${suffix}:${index}`,
      lineRef: 'synthetic-rail',
      lineName: 'SYNTHETIC Rail',
      directionRef: 'east',
      directionLabel: 'SYNTHETIC East',
      boardingHubRef: from.providerHubRef ?? from.providerPlaceRef,
      alightingHubRef:
        locations[index + 1]!.providerHubRef ??
        locations[index + 1]!.providerPlaceRef,
      headwayMinSeconds: null,
      headwayMaxSeconds: null,
      minimumTransferSeconds: 0,
      boardingAccessMinimumSeconds: 0,
    },
  }));
  return {
    status: 'SUCCESS',
    candidates: [
      {
        ...base,
        candidateId: suffix ? 'synthetic-suffix' : 'synthetic-source',
        legs,
        departure: legs[0]!.departure,
        arrival: legs.at(-1)!.arrival,
        durationSeconds: duration * legs.length,
      },
    ],
  };
}

function dateRollbackTransferCandidate(): Extract<
  RouteProviderResult,
  { status: 'SUCCESS' }
> {
  const result = transferCandidate();
  const candidate = result.candidates[0]!;
  const first = candidate.legs[0]!;
  const second = candidate.legs[1]!;
  const departure = new Date('2030-10-01T10:00:00Z');
  const transferAt = new Date('2030-10-01T16:00:00Z');
  const arrival = new Date('2030-10-01T18:00:00Z');
  return {
    status: 'SUCCESS',
    candidates: [
      {
        ...candidate,
        candidateId: 'candidate-date-rollback-transfer',
        departure: { instant: departure, timeZone: 'Asia/Tokyo' },
        arrival: { instant: arrival, timeZone: 'America/Los_Angeles' },
        durationSeconds: 28_800,
        legs: [
          {
            ...first,
            departure: { instant: departure, timeZone: 'Asia/Tokyo' },
            arrival: {
              instant: transferAt,
              timeZone: 'Pacific/Kiritimati',
            },
            durationSeconds: 21_600,
          },
          {
            ...second,
            departure: {
              instant: transferAt,
              timeZone: 'Pacific/Kiritimati',
            },
            arrival: {
              instant: arrival,
              timeZone: 'America/Los_Angeles',
            },
            durationSeconds: 7_200,
          },
        ],
      },
    ],
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
  await managed.client.outboxEvent.deleteMany();
  await managed.client.operationReceipt.deleteMany();
  await managed.client.userTimeIntent.deleteMany();
  await managed.client.transportEdgeHistoryTimeValue.deleteMany();
  await managed.client.transportEdgeHistory.deleteMany();
  await managed.client.temporalValue.deleteMany();
  await managed.client.transportDayProjection.deleteMany();
  await managed.client.transportEdge.deleteMany();
  // Synthetic-only cleanup: suffix anchors can be route-generated, forming
  // a route/node FK cycle. Detach metadata atomically before deleting routes.
  await managed.client.itineraryNode.updateMany({
    where: { source: 'ROUTE_GENERATED' },
    data: { source: 'USER_PLANNED', adoptedRouteId: null },
  });
  await managed.client.adoptedRoute.deleteMany();
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
