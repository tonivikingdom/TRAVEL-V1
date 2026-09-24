import {
  AssistanceCapabilityService,
  ApplicationError,
  ExecutionRiskService,
  FlightMonitoringService,
  FlightService,
  type FlightSnapshotProvider,
} from '@travel/application';
import type { FlightSnapshotView } from '@travel/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createPrismaClient,
  PrismaAssistanceCapabilityRepository,
  PrismaExecutionRiskRepository,
  PrismaFlightMonitoringRepository,
  PrismaFlightRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '../src/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P5D3 integration tests');
}

describe('P5D3 flight monitoring with PostgreSQL', () => {
  let managed: ManagedPrismaClient;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await managed.client.user.deleteMany({
      where: { normalizedEmail: { startsWith: 'synthetic-p5d3-' } },
    });
    await managed.client.job.deleteMany({ where: { type: 'FLIGHT_MONITOR' } });
  });

  afterAll(async () => {
    await managed.client.user.deleteMany({
      where: { normalizedEmail: { startsWith: 'synthetic-p5d3-' } },
    });
    await managed.client.job.deleteMany({ where: { type: 'FLIGHT_MONITOR' } });
    await managed.close();
  });

  it('[AUDIT NOTIFICATION PATHS] records separate risk and flight notifications for one refresh', async () => {
    const fixture = await createFixture(managed);
    const initial = snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' });
    const delayed = snapshot({
      status: 'DELAYED',
      fetchedAt: '2030-01-01T12:00:01.000Z',
      revisedDeparture: '2030-01-02T13:00:00.000Z',
      revisedArrival: '2030-01-02T15:00:00.000Z',
    });
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [delayed],
      () => new Date('2030-01-01T12:00:00.000Z'),
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: initial,
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);

    expect(await monitoring.service.ensureEligibleMonitoring()).toBe(1);
    expect(
      await managed.client.job.count({
        where: { type: 'FLIGHT_MONITOR', payloadRef: adopted.binding.id },
      }),
    ).toBe(8);
    const job = await managed.client.job.findFirstOrThrow({
      where: {
        type: 'FLIGHT_MONITOR',
        payloadRef: adopted.binding.id,
        runAt: new Date('2030-01-01T12:00:00.000Z'),
      },
    });
    expect(job.status).toBe('QUEUED');
    await monitoring.service.executeJob(adopted.binding.id, 1);

    expect(
      await managed.client.notificationEvent.findMany({
        where: {
          ownerUserId: fixture.ownerUserId,
          kind: 'FLIGHT_IMPORTANT_CHANGE',
        },
      }),
    ).toEqual([
      expect.objectContaining({
        priority: 'NORMAL',
        changeKinds: ['DELAY'],
        tripId: fixture.tripId,
        flightBindingId: adopted.binding.id,
        flightNumber: 'NH 53',
        hasDownstreamImpact: true,
      }),
    ]);
    expect(
      await managed.client.executionRisk.count({
        where: { tripId: fixture.tripId, status: 'OPEN' },
      }),
    ).toBeGreaterThan(0);
    expect(
      (
        await managed.client.notificationEvent.findMany({
          where: { ownerUserId: fixture.ownerUserId },
          orderBy: { kind: 'asc' },
          select: { kind: true },
        })
      ).map((notification) => notification.kind),
    ).toEqual(['EXECUTION_RISK', 'FLIGHT_IMPORTANT_CHANGE']);
    expect(
      await managed.client.job.count({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: adopted.binding.id,
          status: 'QUEUED',
          runAt: new Date('2030-01-01T13:00:00.000Z'),
        },
      }),
    ).toBe(1);
  });

  it('dedupes concurrent accepted refreshes into one notification generation', async () => {
    const fixture = await createFixture(managed);
    const delayed = snapshot({
      status: 'DELAYED',
      fetchedAt: '2030-01-01T12:01:00.000Z',
      revisedDeparture: '2030-01-02T13:00:00.000Z',
    });
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [delayed, delayed],
      () => new Date('2030-01-01T12:01:00.000Z'),
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await monitoring.service.ensureEligibleMonitoring();

    await Promise.all([
      monitoring.service.executeJob(adopted.binding.id, 1),
      monitoring.service.executeJob(adopted.binding.id, 1),
    ]);
    expect(
      await managed.client.notificationEvent.count({
        where: {
          flightBindingId: adopted.binding.id,
          kind: 'FLIGHT_IMPORTANT_CHANGE',
        },
      }),
    ).toBe(1);
    expect(
      await managed.client.job.count({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: adopted.binding.id,
          status: 'QUEUED',
          uniqueKey: { contains: ':delayed:' },
        },
      }),
    ).toBe(1);
  });

  it('keeps predicted-only schedule data out of monitoring mode selection', async () => {
    const fixture = await createFixture(managed);
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [snapshot({ fetchedAt: '2030-01-01T12:00:01.000Z' })],
      () => new Date('2030-01-01T12:00:00.000Z'),
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({
        fetchedAt: '2030-01-01T11:00:00.000Z',
        predictedDeparture: '2030-01-02T12:45:00.000Z',
      }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');

    await enableMonitoring(managed, fixture, adopted.binding.id);
    await monitoring.service.ensureEligibleMonitoring();

    expect(
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({ mode: 'NORMAL', lastNotifiedDelayMinutes: null });
    expect(
      await managed.client.job.count({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: adopted.binding.id,
          status: 'QUEUED',
          uniqueKey: { contains: ':normal:' },
        },
      }),
    ).toBe(8);
  });

  it('keeps the newest snapshot decision state under different-fetchedAt concurrency', async () => {
    const fixture = await createFixture(managed);
    const older = deferred<readonly FlightSnapshotView[]>();
    const newer = snapshot({
      status: 'DELAYED',
      fetchedAt: '2030-01-01T12:02:00.000Z',
      revisedDeparture: '2030-01-02T14:30:00.000Z',
    });
    let refreshCall = 0;
    const provider: FlightSnapshotProvider = {
      search: async () => [],
      refresh: async () => {
        refreshCall += 1;
        return refreshCall === 1 ? older.promise : [newer];
      },
    };
    const now = () => new Date('2030-01-01T12:00:00.000Z');
    const flightRepository = new PrismaFlightRepository(managed.client);
    const risk = new ExecutionRiskService(
      new PrismaTripRepository(managed.client),
      new PrismaExecutionRiskRepository(managed.client),
      { now },
    );
    const service = new FlightMonitoringService(
      new FlightService(provider, flightRepository, risk),
      new PrismaFlightMonitoringRepository(managed.client),
      { now },
    );
    const adopted = await flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await service.ensureEligibleMonitoring();

    const olderRefresh = service.executeJob(adopted.binding.id, 1);
    await waitFor(() => refreshCall === 1);
    const newerRefresh = service.executeJob(adopted.binding.id, 1);
    await newerRefresh;
    older.resolve([
      snapshot({
        status: 'DELAYED',
        fetchedAt: '2030-01-01T12:01:00.000Z',
        revisedDeparture: '2030-01-02T12:45:00.000Z',
      }),
    ]);
    await olderRefresh;

    expect(
      await managed.client.flightBinding.findUniqueOrThrow({
        where: { id: adopted.binding.id },
      }),
    ).toMatchObject({
      lastRefreshedAt: new Date('2030-01-01T12:02:00.000Z'),
      latestSnapshot: expect.objectContaining({
        departure: expect.objectContaining({
          revisedUtc: '2030-01-02T14:30:00.000Z',
        }),
      }),
    });
    expect(
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({
      mode: 'DELAYED',
      lastNotifiedDelayMinutes: 150,
      lastDecisionFetchedAt: new Date('2030-01-01T12:02:00.000Z'),
      lastDecisionSnapshot: expect.objectContaining({
        departure: expect.objectContaining({
          revisedUtc: '2030-01-02T14:30:00.000Z',
        }),
      }),
    });
    expect(
      await managed.client.notificationEvent.count({
        where: {
          flightBindingId: adopted.binding.id,
          kind: 'FLIGHT_IMPORTANT_CHANGE',
        },
      }),
    ).toBe(1);
    expect(
      await managed.client.job.findMany({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: adopted.binding.id,
          status: 'QUEUED',
          uniqueKey: { contains: ':delayed:' },
        },
        select: { runAt: true },
      }),
    ).toEqual([{ runAt: new Date('2030-01-01T13:00:00.000Z') }]);
  });

  it.each([
    {
      name: 'boarding and gate',
      newer: snapshot({
        status: 'BOARDING',
        fetchedAt: '2030-01-01T12:02:00.000Z',
        gate: 'A7',
      }),
      expectedKinds: ['GATE_AVAILABLE', 'BOARDING'],
      expectedMode: 'NORMAL',
      expectedDelay: null,
      expectedDelayedRunAt: null,
    },
    {
      name: 'delay, boarding and gate',
      newer: snapshot({
        status: 'BOARDING',
        fetchedAt: '2030-01-01T12:02:00.000Z',
        revisedDeparture: '2030-01-02T14:30:00.000Z',
        gate: 'A7',
      }),
      expectedKinds: ['DELAY', 'GATE_AVAILABLE', 'BOARDING'],
      expectedMode: 'DELAYED',
      expectedDelay: 150,
      expectedDelayedRunAt: new Date('2030-01-02T11:00:00.000Z'),
    },
  ])(
    'executes the latest $name observation decision exactly once under concurrency',
    async ({
      newer,
      expectedKinds,
      expectedMode,
      expectedDelay,
      expectedDelayedRunAt,
    }) => {
      const fixture = await createFixture(managed);
      const older = deferred<readonly FlightSnapshotView[]>();
      let refreshCall = 0;
      const provider: FlightSnapshotProvider = {
        search: async () => [],
        refresh: async () => {
          refreshCall += 1;
          return refreshCall === 1 ? older.promise : [newer];
        },
      };
      const now = () => new Date('2030-01-02T10:00:00.000Z');
      const flightRepository = new PrismaFlightRepository(managed.client);
      const service = createMonitoringService(
        managed,
        flightRepository,
        provider,
        now,
      );
      const adopted = await flightRepository.adopt({
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        baseTripVersion: 1,
        transportEdgeId: fixture.flightEdgeId,
        flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
      });
      if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
      await enableMonitoring(managed, fixture, adopted.binding.id);
      await service.ensureEligibleMonitoring();

      const olderRefresh = service.executeJob(adopted.binding.id, 1);
      await waitFor(() => refreshCall === 1);
      const newerRefresh = service.executeJob(adopted.binding.id, 1);
      await newerRefresh;
      older.resolve([
        snapshot({
          status: 'SCHEDULED',
          fetchedAt: '2030-01-01T12:01:00.000Z',
        }),
      ]);
      await olderRefresh;

      expect(
        await managed.client.flightBinding.findUniqueOrThrow({
          where: { id: adopted.binding.id },
        }),
      ).toMatchObject({
        status: 'BOARDING',
        lastRefreshedAt: new Date('2030-01-01T12:02:00.000Z'),
      });
      expect(
        await managed.client.flightMonitorState.findUniqueOrThrow({
          where: { flightBindingId: adopted.binding.id },
        }),
      ).toMatchObject({
        mode: expectedMode,
        lastNotifiedDelayMinutes: expectedDelay,
        lastNotifiedDepartureGate: 'A7',
        lastDecisionFetchedAt: new Date('2030-01-01T12:02:00.000Z'),
        lastDecisionSnapshot: expect.objectContaining({
          status: 'BOARDING',
          fetchedAt: '2030-01-01T12:02:00.000Z',
        }),
      });
      const notifications = await managed.client.notificationEvent.findMany({
        where: {
          flightBindingId: adopted.binding.id,
          kind: 'FLIGHT_IMPORTANT_CHANGE',
        },
      });
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.changeKinds).toEqual(expectedKinds);
      const delayedJobs = await managed.client.job.findMany({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: adopted.binding.id,
          status: 'QUEUED',
          uniqueKey: { contains: ':delayed:' },
        },
        select: { runAt: true },
      });
      expect(delayedJobs).toEqual(
        expectedDelayedRunAt === null ? [] : [{ runAt: expectedDelayedRunAt }],
      );
    },
  );

  it('lets a stale caller finish an uncommitted latest observation decision', async () => {
    const fixture = await createFixture(managed);
    const now = () => new Date('2030-01-02T10:00:00.000Z');
    const flightRepository = new PrismaFlightRepository(managed.client);
    const adopted = await flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    const repository = new PrismaFlightMonitoringRepository(managed.client);
    await repository.ensureEligibleMonitoring(now());

    const latest = snapshot({
      status: 'BOARDING',
      fetchedAt: '2030-01-01T12:02:00.000Z',
      gate: 'A7',
    });
    const written = await flightRepository.refresh({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      flightBindingId: adopted.binding.id,
      flight: latest,
    });
    if (written.status !== 'SUCCESS') throw new Error('refresh failed');
    expect(
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({ lastDecisionFetchedAt: null });

    const staleProvider: FlightSnapshotProvider = {
      search: async () => [],
      refresh: async () => [
        snapshot({ fetchedAt: '2030-01-01T12:01:00.000Z' }),
      ],
    };
    const service = createMonitoringService(
      managed,
      flightRepository,
      staleProvider,
      now,
    );
    await service.executeJob(adopted.binding.id, 1);

    const state = await managed.client.flightMonitorState.findUniqueOrThrow({
      where: { flightBindingId: adopted.binding.id },
    });
    expect(state).toMatchObject({
      mode: 'NORMAL',
      lastNotifiedDepartureGate: 'A7',
      lastDecisionFetchedAt: new Date('2030-01-01T12:02:00.000Z'),
      lastDecisionSnapshot: expect.objectContaining({
        status: 'BOARDING',
        fetchedAt: '2030-01-01T12:02:00.000Z',
      }),
    });
    expect(
      await managed.client.notificationEvent.findMany({
        where: {
          flightBindingId: adopted.binding.id,
          kind: 'FLIGHT_IMPORTANT_CHANGE',
        },
      }),
    ).toEqual([
      expect.objectContaining({
        changeKinds: ['GATE_AVAILABLE', 'BOARDING'],
      }),
    ]);
  });

  it('uses a new schedule generation when the same binding row is rebound', async () => {
    const fixture = await createFixture(managed);
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [snapshot({ fetchedAt: '2030-01-01T12:00:01.000Z' })],
      () => new Date('2030-01-01T12:00:00.000Z'),
    );
    const original = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (original.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, original.binding.id);
    await monitoring.service.ensureEligibleMonitoring();
    const originalState =
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: original.binding.id },
      });

    const replacement = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 2,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({
        candidateId: 'aerodatabox:p5d3-nh53-rebound',
        fetchedAt: '2030-01-01T11:30:00.000Z',
      }),
    });
    if (replacement.status !== 'SUCCESS') throw new Error('replace failed');
    expect(replacement.binding.id).toBe(original.binding.id);
    await monitoring.service.ensureEligibleMonitoring();
    const replacementState =
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: replacement.binding.id },
      });

    expect(replacementState.generation).not.toBe(originalState.generation);
    expect(
      await managed.client.job.count({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: replacement.binding.id,
          status: 'CANCELLED',
        },
      }),
    ).toBe(8);
    expect(
      await managed.client.job.count({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: replacement.binding.id,
          status: 'QUEUED',
        },
      }),
    ).toBe(8);
  });

  it('warns once at T-2 during provider outage and does not create a fake change', async () => {
    const fixture = await createFixture(managed);
    const provider: FlightSnapshotProvider = {
      search: async () => [],
      refresh: async () => {
        throw new ApplicationError(
          'FLIGHT_PROVIDER_UNAVAILABLE',
          'synthetic outage',
          502,
          true,
        );
      },
    };
    const flightRepository = new PrismaFlightRepository(managed.client);
    const risk = new ExecutionRiskService(
      new PrismaTripRepository(managed.client),
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => new Date('2030-01-02T10:00:00.000Z') },
    );
    const service = new FlightMonitoringService(
      new FlightService(provider, flightRepository, risk),
      new PrismaFlightMonitoringRepository(managed.client),
      { now: () => new Date('2030-01-02T10:00:00.000Z') },
    );
    const adopted = await flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await service.ensureEligibleMonitoring();
    await service.executeJob(adopted.binding.id, 1);
    await service.executeJob(adopted.binding.id, 1);
    const notifications = await managed.client.notificationEvent.findMany({
      where: { flightBindingId: adopted.binding.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.changeKinds).toEqual(['PROVIDER_UNAVAILABLE']);
    expect(
      await managed.client.flightBinding.findUniqueOrThrow({
        where: { id: adopted.binding.id },
      }),
    ).toMatchObject({ status: 'SCHEDULED' });
  });

  it('aggregates boarding and a relevant first gate into one persisted notification', async () => {
    const fixture = await createFixture(managed);
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [
        snapshot({
          status: 'BOARDING',
          fetchedAt: '2030-01-02T10:00:01.000Z',
          gate: 'A7',
        }),
      ],
      () => new Date('2030-01-02T10:00:00.000Z'),
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await monitoring.service.ensureEligibleMonitoring();
    await monitoring.service.executeJob(adopted.binding.id, 1);

    expect(
      await managed.client.notificationEvent.findMany({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toEqual([
      expect.objectContaining({
        changeKinds: ['GATE_AVAILABLE', 'BOARDING'],
        priority: 'NORMAL',
      }),
    ]);
  });

  it('refreshes on airport arrival and skips a fixed node within the 30 minute dedupe window', async () => {
    const fixture = await createFixture(managed);
    let now = new Date('2030-01-02T09:45:00.000Z');
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [snapshot({ fetchedAt: '2030-01-02T09:45:01.000Z', gate: 'A7' })],
      () => now,
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await monitoring.service.ensureEligibleMonitoring();
    await monitoring.service.trigger(
      monitoring.actor,
      fixture.tripId,
      adopted.binding.id,
      { type: 'ARRIVED_AT_AIRPORT', airportIata: 'HND' },
    );
    now = new Date('2030-01-02T10:00:00.000Z');
    await monitoring.service.executeJob(adopted.binding.id, 1);

    expect(monitoring.refreshCalls()).toBe(1);
    expect(
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({ arrivedAirportIata: 'HND' });
  });

  it('evaluates the T-2 gate threshold locally when the provider refresh is deduped', async () => {
    const fixture = await createFixture(managed);
    let now = new Date('2030-01-02T09:45:00.000Z');
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [snapshot({ fetchedAt: '2030-01-02T09:45:01.000Z', gate: 'A7' })],
      () => now,
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await monitoring.service.ensureEligibleMonitoring();
    await monitoring.service.trigger(
      monitoring.actor,
      fixture.tripId,
      adopted.binding.id,
      { type: 'FLIGHT_DETAIL_OPENED' },
    );
    expect(
      await managed.client.notificationEvent.count({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toBe(0);

    now = new Date('2030-01-02T10:00:00.000Z');
    await monitoring.service.executeJob(adopted.binding.id, 1);

    expect(monitoring.refreshCalls()).toBe(1);
    expect(
      await managed.client.notificationEvent.findMany({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toEqual([expect.objectContaining({ changeKinds: ['GATE_AVAILABLE'] })]);
    expect(
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({
      lastSuccessfulMonitorRefreshAt: new Date('2030-01-02T09:45:00.000Z'),
    });
  });

  it('handles cancellation recovery and the landing baggage lifecycle without duplicate notifications', async () => {
    const fixture = await createFixture(managed);
    const cancelled = snapshot({
      status: 'CANCELLED',
      fetchedAt: '2030-01-01T12:00:01.000Z',
      gate: 'A1',
      terminal: 'T1',
    });
    const restored = snapshot({
      status: 'DELAYED',
      fetchedAt: '2030-01-01T12:01:00.000Z',
      revisedDeparture: '2030-01-02T14:00:00.000Z',
      gate: 'B2',
      terminal: 'T2',
    });
    const landed = snapshot({
      status: 'ARRIVED',
      fetchedAt: '2030-01-02T14:01:00.000Z',
      runwayArrival: '2030-01-02T14:00:00.000Z',
      baggage: null,
    });
    const baggage = snapshot({
      status: 'ARRIVED',
      fetchedAt: '2030-01-02T14:06:00.000Z',
      runwayArrival: '2030-01-02T14:00:00.000Z',
      baggage: '5',
    });
    let now = new Date('2030-01-01T12:00:00.000Z');
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [cancelled, restored, landed, baggage, baggage],
      () => now,
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await monitoring.service.ensureEligibleMonitoring();
    await monitoring.service.executeJob(adopted.binding.id, 1);
    now = new Date('2030-01-01T12:01:00.000Z');
    await monitoring.service.executeJob(adopted.binding.id, 1);
    expect(
      await managed.client.job.count({
        where: {
          type: 'FLIGHT_MONITOR',
          payloadRef: adopted.binding.id,
          status: 'QUEUED',
          uniqueKey: { contains: ':delayed:' },
        },
      }),
    ).toBe(1);
    now = new Date('2030-01-02T14:01:00.000Z');
    await monitoring.service.trigger(
      monitoring.actor,
      fixture.tripId,
      adopted.binding.id,
      { type: 'POST_FLIGHT_CHECK' },
    );
    now = new Date('2030-01-02T14:06:00.000Z');
    await monitoring.service.executeJob(adopted.binding.id, 1);
    const capabilityService = new AssistanceCapabilityService(
      new PrismaAssistanceCapabilityRepository(managed.client),
      { now: () => now },
    );
    expect(
      await capabilityService.getFlight(
        monitoring.actor,
        fixture.tripId,
        adopted.binding.id,
      ),
    ).toMatchObject({
      state: 'ENABLED',
      effectiveEnabled: true,
      effectiveReason: 'ENABLED',
    });
    now = new Date('2030-01-02T14:11:00.000Z');
    await monitoring.service.executeJob(adopted.binding.id, 1);
    now = new Date('2030-01-02T14:31:00.000Z');
    await monitoring.service.executeJob(adopted.binding.id, 1);

    const notifications = await managed.client.notificationEvent.findMany({
      where: { flightBindingId: adopted.binding.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(notifications.map((item) => item.priority)).toEqual([
      'STRONG',
      'STRONG',
      'NORMAL',
    ]);
    expect(notifications.map((item) => item.changeKinds)).toEqual([
      ['CANCELLED'],
      [
        'RESTORED_AFTER_CANCELLATION',
        'DELAY',
        'GATE_CHANGED',
        'TERMINAL_CHANGED',
      ],
      ['BAGGAGE_AVAILABLE'],
    ]);
    expect(notifications[1]?.summary).toContain('航班已恢复执行');
    expect(notifications[1]?.summary).toContain('延误约 120 分钟');
    expect(notifications[1]?.summary).toContain('登机口现为 B2');
    expect(notifications[1]?.summary).toContain('出发航站楼现为 T2');
    expect(
      await managed.client.flightMonitorState.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({ mode: 'BAGGAGE', lastNotifiedBaggage: '5' });
    expect(
      await managed.client.flightMonitoringCapability.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({
      state: 'STOPPED',
      revision: 2,
      stopReason: 'NATURAL_END',
    });
    expect(
      await capabilityService.getFlight(
        monitoring.actor,
        fixture.tripId,
        adopted.binding.id,
      ),
    ).toMatchObject({
      state: 'STOPPED',
      stopReason: 'NATURAL_END',
      effectiveEnabled: false,
      effectiveReason: 'STOPPED',
    });
  });

  async function createMonitoring(
    managed: ManagedPrismaClient,
    fixture: Fixture,
    snapshots: readonly FlightSnapshotView[],
    now: () => Date,
  ) {
    let call = 0;
    const provider: FlightSnapshotProvider = {
      search: async () => [],
      refresh: async () => [snapshots[Math.min(call++, snapshots.length - 1)]!],
    };
    const flightRepository = new PrismaFlightRepository(managed.client);
    const actor = {
      userId: fixture.ownerUserId,
      email: 'synthetic-p5d3-owner@synthetic.example.test',
      role: 'USER' as const,
      status: 'ACTIVE' as const,
    };
    const risk = new ExecutionRiskService(
      new PrismaTripRepository(managed.client),
      new PrismaExecutionRiskRepository(managed.client),
      { now },
    );
    return {
      actor,
      flightRepository,
      refreshCalls: () => call,
      service: createMonitoringService(
        managed,
        flightRepository,
        provider,
        now,
        risk,
      ),
    };
  }

  async function enableMonitoring(
    managed: ManagedPrismaClient,
    fixture: Fixture,
    flightBindingId: string,
  ): Promise<void> {
    await managed.client.flightMonitoringCapability.upsert({
      where: { flightBindingId },
      create: {
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        flightBindingId,
        state: 'ENABLED',
        revision: 1,
        enabledAt: new Date('2030-01-01T00:00:00.000Z'),
      },
      update: { state: 'ENABLED' },
    });
  }

  it('does not enroll a binding without explicit monitoring opt-in', async () => {
    const fixture = await createFixture(managed);
    const monitoring = await createMonitoring(
      managed,
      fixture,
      [snapshot({ fetchedAt: '2030-01-01T12:00:01.000Z' })],
      () => new Date('2030-01-01T12:00:00.000Z'),
    );
    const adopted = await monitoring.flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' }),
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    expect(await monitoring.service.ensureEligibleMonitoring()).toBe(0);
    expect(
      await managed.client.job.count({
        where: { type: 'FLIGHT_MONITOR', payloadRef: adopted.binding.id },
      }),
    ).toBe(0);
    const manual = await monitoring.service.trigger(
      monitoring.actor,
      fixture.tripId,
      adopted.binding.id,
      { type: 'FLIGHT_DETAIL_OPENED' },
    );
    expect(manual.providerRefreshPerformed).toBe(true);
    expect(monitoring.refreshCalls()).toBe(1);
    expect(
      await managed.client.flightMonitoringCapability.findUnique({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toBeNull();
    await managed.client.flightMonitoringCapability.create({
      data: {
        ownerUserId: fixture.ownerUserId,
        tripId: fixture.tripId,
        flightBindingId: adopted.binding.id,
        state: 'STOPPED',
        revision: 1,
        stoppedAt: new Date('2030-01-01T12:00:00.000Z'),
        stopReason: 'USER',
      },
    });
    expect(await monitoring.service.ensureEligibleMonitoring()).toBe(0);
    const capabilities = new AssistanceCapabilityService(
      new PrismaAssistanceCapabilityRepository(managed.client),
      { now: () => new Date('2030-01-01T12:00:00.000Z') },
    );
    const enabled = await capabilities.mutateFlight(
      monitoring.actor,
      fixture.tripId,
      adopted.binding.id,
      {
        action: 'ENABLE',
        baseCapabilityRevision: 1,
        idempotencyKey: randomUUID(),
      },
    );
    expect(enabled.capability).toMatchObject({ state: 'ENABLED', revision: 2 });
    expect(await monitoring.service.ensureEligibleMonitoring()).toBe(1);
  });

  it('discards an in-flight provider result across pause and resume generations', async () => {
    const fixture = await createFixture(managed);
    let releaseProvider!: () => void;
    let signalProvider!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProvider = resolve;
    });
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const initial = snapshot({ fetchedAt: '2030-01-01T11:00:00.000Z' });
    const next = snapshot({
      status: 'BOARDING',
      fetchedAt: '2030-01-01T12:00:01.000Z',
      gate: 'A7',
    });
    const provider: FlightSnapshotProvider = {
      search: async () => [],
      refresh: async () => {
        signalProvider();
        await providerReleased;
        return [next];
      },
    };
    const flightRepository = new PrismaFlightRepository(managed.client);
    const monitoring = createMonitoringService(
      managed,
      flightRepository,
      provider,
      () => new Date('2030-01-01T12:00:00.000Z'),
    );
    const adopted = await flightRepository.adopt({
      ownerUserId: fixture.ownerUserId,
      tripId: fixture.tripId,
      baseTripVersion: 1,
      transportEdgeId: fixture.flightEdgeId,
      flight: initial,
    });
    if (adopted.status !== 'SUCCESS') throw new Error('adopt failed');
    await enableMonitoring(managed, fixture, adopted.binding.id);
    await monitoring.ensureEligibleMonitoring();
    const running = monitoring.executeJob(adopted.binding.id, 1);
    await providerStarted;
    const actor = {
      userId: fixture.ownerUserId,
      email: 'synthetic-p5d3-owner@synthetic.example.test',
      role: 'USER' as const,
      status: 'ACTIVE' as const,
    };
    const capabilities = new AssistanceCapabilityService(
      new PrismaAssistanceCapabilityRepository(managed.client),
      { now: () => new Date('2030-01-01T12:00:00.000Z') },
    );
    await capabilities.mutateFlight(actor, fixture.tripId, adopted.binding.id, {
      action: 'PAUSE',
      baseCapabilityRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await capabilities.mutateFlight(actor, fixture.tripId, adopted.binding.id, {
      action: 'RESUME',
      baseCapabilityRevision: 2,
      idempotencyKey: randomUUID(),
    });
    releaseProvider();
    await running;
    const binding = await managed.client.flightBinding.findUniqueOrThrow({
      where: { id: adopted.binding.id },
    });
    expect(binding.lastRefreshedAt).toEqual(new Date(initial.fetchedAt));
    expect(binding.status).toBe('SCHEDULED');
    expect(
      await managed.client.notificationEvent.count({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toBe(0);
    expect(
      await managed.client.flightMonitoringCapability.findUniqueOrThrow({
        where: { flightBindingId: adopted.binding.id },
      }),
    ).toMatchObject({ state: 'ENABLED', revision: 3 });
    await monitoring.executeJob(adopted.binding.id, 1);
    expect(binding.lastRefreshedAt).toEqual(new Date(initial.fetchedAt));
  });
});

function createMonitoringService(
  managed: ManagedPrismaClient,
  flightRepository: PrismaFlightRepository,
  provider: FlightSnapshotProvider,
  now: () => Date,
  risk = new ExecutionRiskService(
    new PrismaTripRepository(managed.client),
    new PrismaExecutionRiskRepository(managed.client),
    { now },
  ),
) {
  return new FlightMonitoringService(
    new FlightService(provider, flightRepository, risk),
    new PrismaFlightMonitoringRepository(managed.client),
    { now },
  );
}

interface Fixture {
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly flightEdgeId: string;
}

async function createFixture(managed: ManagedPrismaClient): Promise<Fixture> {
  const ownerUserId = randomUUID();
  const tripId = randomUUID();
  const occurrenceId = randomUUID();
  const nodes = [randomUUID(), randomUUID(), randomUUID()];
  const flightEdgeId = randomUUID();
  await managed.client.$transaction(async (transaction) => {
    await transaction.user.create({
      data: {
        id: ownerUserId,
        email: 'synthetic-p5d3-owner@synthetic.example.test',
        normalizedEmail: 'synthetic-p5d3-owner@synthetic.example.test',
      },
    });
    await transaction.trip.create({
      data: {
        id: tripId,
        ownerUserId,
        name: 'SYNTHETIC P5D3',
        planningAnchorDate: new Date('2030-01-02T00:00:00Z'),
        defaultPeopleCount: 1,
      },
    });
    await transaction.dayOccurrence.create({
      data: {
        id: occurrenceId,
        tripId,
        localDate: new Date('2030-01-02T00:00:00Z'),
        sequence: 0,
      },
    });
    const places = [randomUUID(), randomUUID(), randomUUID()];
    await transaction.place.createMany({
      data: places.map((id, index) => ({
        id,
        ownerUserId,
        name: `SYNTHETIC P5D3 ${index}`,
        latitude: 35 + index,
        longitude: 139 + index,
      })),
    });
    await transaction.itineraryNode.createMany({
      data: nodes.map((id, position) => ({
        id,
        tripId,
        dayOccurrenceId: occurrenceId,
        kind: 'PLACE_VISIT' as const,
        position,
        placeId: places[position]!,
      })),
    });
    await transaction.transportEdge.createMany({
      data: [
        {
          id: flightEdgeId,
          tripId,
          fromNodeId: nodes[0]!,
          toNodeId: nodes[1]!,
          mode: 'FLIGHT',
          fixedService: false,
          source: 'MANUAL',
        },
        {
          id: randomUUID(),
          tripId,
          fromNodeId: nodes[1]!,
          toNodeId: nodes[2]!,
          mode: 'RAIL',
          fixedService: true,
          source: 'MANUAL',
        },
      ],
    });
    const outbound = await transaction.transportEdge.findFirstOrThrow({
      where: { tripId, fromNodeId: nodes[1]! },
    });
    await transaction.temporalValue.create({
      data: {
        transportEdgeId: outbound.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-01-02T14:15:00.000Z'),
        timeZone: 'UTC',
        sourceKind: 'ADOPTED_TRANSPORT_FACT',
      },
    });
  });
  return { ownerUserId, tripId, flightEdgeId };
}

function snapshot(input: {
  readonly candidateId?: string;
  readonly status?: FlightSnapshotView['status'];
  readonly fetchedAt: string;
  readonly revisedDeparture?: string | null;
  readonly predictedDeparture?: string | null;
  readonly revisedArrival?: string | null;
  readonly runwayArrival?: string | null;
  readonly gate?: string | null;
  readonly terminal?: string | null;
  readonly baggage?: string | null;
}): FlightSnapshotView {
  const departure = movement('HND', '2030-01-02T12:00:00.000Z');
  const arrival = movement('CTS', '2030-01-02T14:00:00.000Z');
  return {
    provider: 'aerodatabox',
    candidateId: input.candidateId ?? 'aerodatabox:p5d3-nh53',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2030-01-02',
    status: input.status ?? 'SCHEDULED',
    rawStatus: input.status ?? 'Scheduled',
    airline: { name: 'ANA', iata: 'NH', icao: 'ANA' },
    departure: {
      ...departure,
      revisedUtc: input.revisedDeparture ?? null,
      revisedLocal: input.revisedDeparture ?? null,
      predictedUtc: input.predictedDeparture ?? null,
      predictedLocal: input.predictedDeparture ?? null,
      gate: input.gate ?? null,
      terminal: input.terminal ?? null,
    },
    arrival: {
      ...arrival,
      revisedUtc: input.revisedArrival ?? null,
      revisedLocal: input.revisedArrival ?? null,
      runwayUtc: input.runwayArrival ?? null,
      runwayLocal: input.runwayArrival ?? null,
      baggageBelt: input.baggage ?? null,
    },
    aircraft: null,
    departureDelayMinutes: null,
    arrivalDelayMinutes: null,
    departureDelayBasis: null,
    arrivalDelayBasis: null,
    fetchedAt: input.fetchedAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for refresh');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function movement(iata: string, scheduledUtc: string) {
  return {
    airportName: iata,
    airportIata: iata,
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
  };
}
