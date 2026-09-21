import {
  AuthService,
  digestOpaqueToken,
  ExecutionLocationService,
  ExecutionRiskService,
  type FlightMonitoringService,
} from '@travel/application';
import type {
  ExecutionContextResponse,
  ExecutionLocationResponse,
  ExecutionMutationResponse,
  ExecutionUndoResponse,
} from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaExecutionLocationRepository,
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
  vi,
} from 'vitest';

import { buildApi } from '../src/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P5E1 integration tests');
}

const NOW = new Date('2030-01-01T10:05:00.000Z');

describe('P5E1 execution-location API with PostgreSQL', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let owner: SyntheticIdentity;
  let other: SyntheticIdentity;
  let admin: SyntheticIdentity;
  let fixture: Fixture;
  let flightTrigger: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    [owner, other, admin] = await Promise.all([
      createIdentity(
        managed,
        'synthetic-p5e1-owner@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-p5e1-other@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-p5e1-admin@synthetic.example.test',
        'ADMIN',
      ),
    ]);
    fixture = await createFixture(managed, owner.userId);
    const tripRepository = new PrismaTripRepository(managed.client);
    const riskService = new ExecutionRiskService(
      tripRepository,
      new PrismaExecutionRiskRepository(managed.client),
      { now: () => NOW },
    );
    flightTrigger = vi.fn(async () => ({
      flightBinding: {},
      providerRefreshPerformed: false,
      notificationId: null,
    }));
    const executionService = new ExecutionLocationService(
      new PrismaExecutionLocationRepository(managed.client),
      riskService,
      {
        trigger: flightTrigger,
      } as unknown as FlightMonitoringService,
      { now: () => NOW },
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
      executionLocationService: executionService,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('writes one ACTUAL arrival from a reliable sample and keeps raw coordinates out of persistence', async () => {
    const response = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      resultingTripVersion: 2,
      event: { nodeId: fixture.nodeAId, source: 'LOCATION' },
    });
    const value = await managed.client.temporalValue.findFirstOrThrow({
      where: {
        nodeId: fixture.nodeAId,
        pointKind: 'ARRIVAL',
        layer: 'ACTUAL',
      },
    });
    expect(value).toMatchObject({
      instant: new Date('2030-01-01T10:00:00.000Z'),
      sourceKind: 'EXECUTION_OBSERVATION',
    });
    expect(value.sourceRef).toMatch(/^execution-event:/u);
    const columns = await managed.client.$queryRaw<
      Array<{ column_name: string }>
    >`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('ExecutionEvent', 'ExecutionLocationState')
        AND column_name IN ('latitude', 'longitude', 'accuracyMeters', 'speed', 'heading')
    `;
    expect(columns).toEqual([]);
  });

  it('does not bump Trip version for low-accuracy or duplicate observations', async () => {
    const poor = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 150,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    expect(poor.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'INDETERMINATE_LOCATION',
      resultingTripVersion: 1,
    });
    const duplicate = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    expect(duplicate.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'NO_CHANGE',
      resultingTripVersion: 1,
    });
    expect(await tripVersion()).toBe(1);
    expect(await managed.client.executionEvent.count()).toBe(0);
  });

  it('rejects stale, future, and invalid coordinate observations', async () => {
    for (const payload of [
      {
        latitude: 35,
        longitude: 139,
        accuracyMeters: 10,
        observedAt: '2030-01-01T09:50:00.000Z',
      },
      {
        latitude: 35,
        longitude: 139,
        accuracyMeters: 10,
        observedAt: '2030-01-01T10:08:00.000Z',
      },
      {
        latitude: 95,
        longitude: 139,
        accuracyMeters: 10,
        observedAt: '2030-01-01T10:00:00.000Z',
      },
    ]) {
      const response = await observe(owner, payload);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(await tripVersion()).toBe(1);
  });

  it('serializes concurrent duplicate arrival decisions into exactly one fact', async () => {
    const payload = {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    };
    const [first, second] = await Promise.all([
      observe(owner, payload),
      observe(owner, payload),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(await managed.client.executionEvent.count()).toBe(1);
    expect(
      await managed.client.temporalValue.count({ where: { layer: 'ACTUAL' } }),
    ).toBe(1);
    expect(await tripVersion()).toBe(2);
  });

  it('serializes automatic and manual arrival into one authoritative fact', async () => {
    const [automatic, manualResult] = await Promise.all([
      observe(owner, {
        latitude: 35,
        longitude: 139,
        accuracyMeters: 10,
        observedAt: '2030-01-01T10:00:00.000Z',
      }),
      manual(owner, {
        baseTripVersion: 1,
        idempotencyKey: randomUUID(),
        type: 'MANUAL_ARRIVAL',
        nodeId: fixture.nodeAId,
        occurredAt: '2030-01-01T10:00:00.000Z',
      }),
    ]);
    expect(automatic.statusCode).toBe(200);
    expect([200, 409]).toContain(manualResult.statusCode);
    expect(await managed.client.executionEvent.count()).toBe(1);
    expect(
      await managed.client.temporalValue.count({
        where: { nodeId: fixture.nodeAId, pointKind: 'ARRIVAL' },
      }),
    ).toBe(1);
    expect(await tripVersion()).toBe(2);
  });

  it('reuses P5D1 risk evaluation after committing an arrival fact', async () => {
    const edge = await managed.client.transportEdge.create({
      data: {
        tripId: fixture.tripId,
        fromNodeId: fixture.nodeAId,
        toNodeId: fixture.nodeBId,
        mode: 'RAIL',
        fixedService: true,
        source: 'MANUAL',
      },
    });
    await managed.client.temporalValue.create({
      data: {
        transportEdgeId: edge.id,
        layer: 'PLANNED',
        pointKind: 'DEPARTURE',
        instant: new Date('2030-01-01T10:10:00.000Z'),
        timeZone: 'UTC',
        sourceKind: 'USER_VALUE',
      },
    });
    await managed.client.userTimeIntent.create({
      data: {
        tripId: fixture.tripId,
        nodeId: fixture.nodeAId,
        kind: 'MIN_DWELL',
        operator: 'MINIMUM',
        durationSeconds: 1_200,
        locked: true,
      },
    });
    await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    expect(
      await managed.client.executionRisk.count({
        where: { tripId: fixture.tripId, status: 'OPEN' },
      }),
    ).toBe(1);
  });

  it('derives an airport trigger from FlightBinding and executes it once after the arrival commit', async () => {
    const edge = await managed.client.transportEdge.create({
      data: {
        tripId: fixture.tripId,
        fromNodeId: fixture.nodeAId,
        toNodeId: fixture.nodeBId,
        mode: 'FLIGHT',
        fixedService: true,
        source: 'MANUAL',
      },
    });
    const snapshot = flightSnapshot('HND', 'CTS');
    const binding = await managed.client.flightBinding.create({
      data: {
        ownerUserId: owner.userId,
        tripId: fixture.tripId,
        transportEdgeId: edge.id,
        provider: 'aerodatabox',
        providerFlightRef: 'aerodatabox:p5e1',
        canonicalFlightNumber: 'NH53',
        displayFlightNumber: 'NH 53',
        serviceDate: new Date('2030-01-01T00:00:00.000Z'),
        selectedSnapshot: snapshot,
        latestSnapshot: snapshot,
        status: 'SCHEDULED',
        lastRefreshedAt: NOW,
      },
    });
    const payload = {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    };
    const first = await observe(owner, payload);
    expect(first.statusCode).toBe(200);
    expect(flightTrigger).toHaveBeenCalledTimes(1);
    expect(flightTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.userId }),
      fixture.tripId,
      binding.id,
      { type: 'ARRIVED_AT_AIRPORT', airportIata: 'HND' },
    );
    const event = await managed.client.executionEvent.findFirstOrThrow({
      where: { tripId: fixture.tripId, type: 'ARRIVAL' },
    });
    expect(event.airportTriggerCompletedAt).not.toBeNull();
    expect((await observe(owner, payload)).statusCode).toBe(200);
    expect(flightTrigger).toHaveBeenCalledTimes(1);
  });

  it('reconciles an airport trigger that failed after the arrival transaction committed', async () => {
    const edge = await managed.client.transportEdge.create({
      data: {
        tripId: fixture.tripId,
        fromNodeId: fixture.nodeAId,
        toNodeId: fixture.nodeBId,
        mode: 'FLIGHT',
        fixedService: true,
        source: 'MANUAL',
      },
    });
    const snapshot = flightSnapshot('HND', 'CTS');
    await managed.client.flightBinding.create({
      data: {
        ownerUserId: owner.userId,
        tripId: fixture.tripId,
        transportEdgeId: edge.id,
        provider: 'aerodatabox',
        providerFlightRef: 'aerodatabox:p5e1-recovery',
        canonicalFlightNumber: 'NH53',
        displayFlightNumber: 'NH 53',
        serviceDate: new Date('2030-01-01T00:00:00.000Z'),
        selectedSnapshot: snapshot,
        latestSnapshot: snapshot,
        status: 'SCHEDULED',
        lastRefreshedAt: NOW,
      },
    });
    flightTrigger.mockRejectedValueOnce(
      new Error('synthetic provider failure'),
    );
    const payload = {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    };
    expect((await observe(owner, payload)).statusCode).toBe(503);
    expect(await managed.client.executionEvent.count()).toBe(1);
    expect(await tripVersion()).toBe(2);
    const recovered = await observe(owner, payload);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'NO_CHANGE',
      airportTriggerAttempted: true,
      resultingTripVersion: 2,
    });
    expect(flightTrigger).toHaveBeenCalledTimes(2);
    expect(
      (
        await managed.client.executionEvent.findFirstOrThrow({
          where: { tripId: fixture.tripId, type: 'ARRIVAL' },
        })
      ).airportTriggerCompletedAt,
    ).not.toBeNull();
  });

  it('claims one airport trigger across concurrent reconciliation callers', async () => {
    await createAirportBinding('aerodatabox:p5e1-concurrent');
    const gate = deferred();
    flightTrigger.mockImplementationOnce(async () => {
      await gate.promise;
      return flightTriggerResult();
    });
    const payload = airportObservation();
    const firstPromise = observe(owner, payload);
    await vi.waitFor(() => expect(flightTrigger).toHaveBeenCalledTimes(1));

    const second = await observe(owner, payload);
    expect(second.statusCode).toBe(200);
    expect(second.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'NO_CHANGE',
      airportTriggerAttempted: false,
      resultingTripVersion: 2,
    });
    expect(flightTrigger).toHaveBeenCalledTimes(1);

    gate.resolve();
    expect((await firstPromise).statusCode).toBe(200);
    const event = await managed.client.executionEvent.findFirstOrThrow({
      where: { tripId: fixture.tripId, type: 'ARRIVAL' },
    });
    expect(event).toMatchObject({
      airportTriggerClaimedAt: null,
      airportTriggerClaimToken: null,
    });
    expect(event.airportTriggerCompletedAt).not.toBeNull();
    expect(await managed.client.executionEvent.count()).toBe(1);
    expect(
      await managed.client.temporalValue.count({
        where: { nodeId: fixture.nodeAId, layer: 'ACTUAL' },
      }),
    ).toBe(1);
    expect(await tripVersion()).toBe(2);
  });

  it('keeps a concurrent loser idle and releases a failed claim for later retry', async () => {
    await createAirportBinding('aerodatabox:p5e1-concurrent-retry');
    const gate = deferred();
    flightTrigger.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error('synthetic provider failure');
    });
    const payload = airportObservation();
    const firstPromise = observe(owner, payload);
    await vi.waitFor(() => expect(flightTrigger).toHaveBeenCalledTimes(1));

    const concurrentLoser = await observe(owner, payload);
    expect(concurrentLoser.statusCode).toBe(200);
    expect(
      concurrentLoser.json<ExecutionLocationResponse>().airportTriggerAttempted,
    ).toBe(false);
    expect(flightTrigger).toHaveBeenCalledTimes(1);

    gate.resolve();
    expect((await firstPromise).statusCode).toBe(503);
    const pending = await managed.client.executionEvent.findFirstOrThrow({
      where: { tripId: fixture.tripId, type: 'ARRIVAL' },
    });
    expect(pending).toMatchObject({
      airportTriggerClaimedAt: null,
      airportTriggerClaimToken: null,
      airportTriggerCompletedAt: null,
    });

    const retry = await observe(owner, payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'NO_CHANGE',
      airportTriggerAttempted: true,
      resultingTripVersion: 2,
    });
    expect(flightTrigger).toHaveBeenCalledTimes(2);
    expect(
      (
        await managed.client.executionEvent.findFirstOrThrow({
          where: { id: pending.id },
        })
      ).airportTriggerCompletedAt,
    ).not.toBeNull();
    expect(await tripVersion()).toBe(2);
  });

  it('never reclaims an undone airport arrival event', async () => {
    await createAirportBinding('aerodatabox:p5e1-undone');
    flightTrigger.mockRejectedValueOnce(
      new Error('synthetic provider failure'),
    );
    const idempotencyKey = randomUUID();
    const payload = {
      baseTripVersion: 1,
      idempotencyKey,
      type: 'MANUAL_ARRIVAL',
      nodeId: fixture.nodeAId,
      occurredAt: '2030-01-01T10:00:00.000Z',
    };
    expect((await manual(owner, payload)).statusCode).toBe(503);
    const event = await managed.client.executionEvent.findFirstOrThrow({
      where: { tripId: fixture.tripId, type: 'ARRIVAL' },
    });
    const undo = await app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${event.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 2, idempotencyKey: randomUUID() },
    });
    expect(undo.statusCode).toBe(200);

    const replay = await manual(owner, payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<ExecutionMutationResponse>()).toMatchObject({
      idempotentReplay: true,
      airportTriggerAttempted: false,
      resultingTripVersion: 3,
    });
    expect(flightTrigger).toHaveBeenCalledTimes(1);
    expect(
      await managed.client.temporalValue.count({
        where: { nodeId: fixture.nodeAId, layer: 'ACTUAL' },
      }),
    ).toBe(0);
    expect(await tripVersion()).toBe(3);
    expect(
      await managed.client.executionEvent.findUniqueOrThrow({
        where: { id: event.id },
      }),
    ).toMatchObject({
      airportTriggerClaimedAt: null,
      airportTriggerClaimToken: null,
      airportTriggerCompletedAt: null,
    });
  });

  it('[AUDIT F-03] reproduces an undone location arrival from the identical observation', async () => {
    await createAirportBinding('aerodatabox:audit-f03-identical');
    const sample = {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    };
    const first = await observe(owner, sample);
    const firstBody = first.json<ExecutionLocationResponse>();
    expect(firstBody).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      resultingTripVersion: 2,
    });
    const undo = await app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${firstBody.event!.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 2, idempotencyKey: randomUUID() },
    });
    expect(undo.json<ExecutionUndoResponse>().resultingTripVersion).toBe(3);

    const replay = await observe(owner, sample);
    expect(replay.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      resultingTripVersion: 4,
    });
    const events = await managed.client.executionEvent.findMany({
      where: { tripId: fixture.tripId, type: 'ARRIVAL' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.undoneAt).not.toBeNull();
    expect(events[1]!.undoneAt).toBeNull();
    expect(events.map((event) => event.occurredAt.toISOString())).toEqual([
      sample.observedAt,
      sample.observedAt,
    ]);
    expect(
      await managed.client.temporalValue.count({
        where: {
          nodeId: fixture.nodeAId,
          pointKind: 'ARRIVAL',
          layer: 'ACTUAL',
        },
      }),
    ).toBe(1);
    expect(await tripVersion()).toBe(4);
    expect(flightTrigger).toHaveBeenCalledTimes(2);
  });

  it('[AUDIT F-03] reproduces an undone arrival from an older still-fresh observation', async () => {
    const first = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:02:00.000Z',
    });
    const firstBody = first.json<ExecutionLocationResponse>();
    await app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${firstBody.event!.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 2, idempotencyKey: randomUUID() },
    });

    const older = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:01:00.000Z',
    });
    expect(older.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      resultingTripVersion: 4,
      event: { occurredAt: '2030-01-01T10:01:00.000Z' },
    });
    expect(await managed.client.executionEvent.count()).toBe(2);
    expect(await tripVersion()).toBe(4);
  });

  it('[AUDIT F-03] records current handling of a newer observation after user Undo', async () => {
    const first = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    const firstBody = first.json<ExecutionLocationResponse>();
    await app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${firstBody.event!.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 2, idempotencyKey: randomUUID() },
    });

    const newer = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:04:00.000Z',
    });
    expect(newer.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      resultingTripVersion: 4,
    });
    expect(await managed.client.executionEvent.count()).toBe(2);
    expect(await tripVersion()).toBe(4);
  });

  it('[AUDIT F-03] serializes concurrent Undo before a queued newer observation and reproduces once', async () => {
    const first = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    const firstBody = first.json<ExecutionLocationResponse>();
    const lockReady = deferred();
    const releaseLock = deferred();
    const ownerLock = managed.client.$transaction(async (transaction) => {
      await transaction.$queryRawUnsafe(
        'SELECT TRUE AS locked FROM pg_advisory_xact_lock(hashtextextended($1, 2))',
        owner.userId,
      );
      lockReady.resolve();
      await releaseLock.promise;
    });
    await lockReady.promise;

    const undoPromise = app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${firstBody.event!.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 2, idempotencyKey: randomUUID() },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const observePromise = observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:04:00.000Z',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLock.resolve();
    await ownerLock;

    const [undo, observation] = await Promise.all([
      undoPromise,
      observePromise,
    ]);
    expect(undo.statusCode).toBe(200);
    expect(observation.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      resultingTripVersion: 4,
    });
    expect(await managed.client.executionEvent.count()).toBe(2);
    expect(
      await managed.client.temporalValue.count({
        where: {
          nodeId: fixture.nodeAId,
          pointKind: 'ARRIVAL',
          layer: 'ACTUAL',
        },
      }),
    ).toBe(1);
    expect(await tripVersion()).toBe(4);
  });

  it('supports idempotent manual departure and exact-source undo with monotonic versions', async () => {
    await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    const key = randomUUID();
    const departure = await manual(owner, {
      baseTripVersion: 2,
      idempotencyKey: key,
      type: 'MANUAL_DEPARTURE',
      nodeId: fixture.nodeAId,
      occurredAt: '2030-01-01T10:01:00.000Z',
    });
    expect(departure.statusCode).toBe(200);
    const body = departure.json<ExecutionMutationResponse>();
    expect(body).toMatchObject({
      resultingTripVersion: 3,
      idempotentReplay: false,
    });
    const replay = await manual(owner, {
      baseTripVersion: 2,
      idempotencyKey: key,
      type: 'MANUAL_DEPARTURE',
      nodeId: fixture.nodeAId,
      occurredAt: '2030-01-01T10:01:00.000Z',
    });
    expect(replay.json<ExecutionMutationResponse>()).toMatchObject({
      event: { id: body.event.id },
      resultingTripVersion: 3,
      idempotentReplay: true,
    });
    const undoKey = randomUUID();
    const undo = await app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${body.event.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 3, idempotencyKey: undoKey },
    });
    expect(undo.json<ExecutionUndoResponse>()).toMatchObject({
      resultingTripVersion: 4,
      idempotentReplay: false,
      event: { id: body.event.id },
    });
    expect(await tripVersion()).toBe(4);
    expect(
      await managed.client.temporalValue.count({
        where: { nodeId: fixture.nodeAId, pointKind: 'DEPARTURE' },
      }),
    ).toBe(0);
  });

  it('[AUDIT EXECUTION ORDER] permits arrival Undo while the same node departure fact remains', async () => {
    const arrival = await observe(owner, {
      latitude: 35,
      longitude: 139,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    const arrivalBody = arrival.json<ExecutionLocationResponse>();
    const departure = await manual(owner, {
      baseTripVersion: 2,
      idempotencyKey: randomUUID(),
      type: 'MANUAL_DEPARTURE',
      nodeId: fixture.nodeAId,
      occurredAt: '2030-01-01T10:01:00.000Z',
    });
    expect(departure.statusCode).toBe(200);

    const undo = await app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${arrivalBody.event!.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 3, idempotencyKey: randomUUID() },
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json<ExecutionUndoResponse>().resultingTripVersion).toBe(4);
    expect(
      await managed.client.temporalValue.count({
        where: {
          nodeId: fixture.nodeAId,
          pointKind: 'ARRIVAL',
          layer: 'ACTUAL',
        },
      }),
    ).toBe(0);
    expect(
      await managed.client.temporalValue.count({
        where: {
          nodeId: fixture.nodeAId,
          pointKind: 'DEPARTURE',
          layer: 'ACTUAL',
        },
      }),
    ).toBe(1);
    expect(await tripVersion()).toBe(4);
  });

  it('marks intervening nodes possibly skipped and confirms or undoes skip without deleting itinerary nodes', async () => {
    const arrival = await observe(owner, {
      latitude: 35.02,
      longitude: 139.02,
      accuracyMeters: 10,
      observedAt: '2030-01-01T10:00:00.000Z',
    });
    expect(arrival.json<ExecutionLocationResponse>()).toMatchObject({
      status: 'CONFIRMED_ARRIVAL',
      event: { nodeId: fixture.nodeCId },
    });
    const context = await getExecution(owner);
    expect(
      context.json<ExecutionContextResponse>().possibleSkippedNodeIds,
    ).toEqual([fixture.nodeAId, fixture.nodeBId]);
    const skip = await manual(owner, {
      baseTripVersion: 2,
      idempotencyKey: randomUUID(),
      type: 'CONFIRM_SKIP',
      nodeId: fixture.nodeAId,
      occurredAt: '2030-01-01T10:01:00.000Z',
    });
    const skipBody = skip.json<ExecutionMutationResponse>();
    expect(skipBody.resultingTripVersion).toBe(3);
    expect(
      (await getExecution(owner)).json<ExecutionContextResponse>(),
    ).toMatchObject({
      possibleSkippedNodeIds: [fixture.nodeBId],
      confirmedSkippedNodeIds: [fixture.nodeAId],
    });
    await app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events/${skipBody.event.id}/undo`,
      headers: bearer(owner.credential),
      payload: { baseTripVersion: 3, idempotencyKey: randomUUID() },
    });
    expect(
      (await getExecution(owner)).json<ExecutionContextResponse>(),
    ).toMatchObject({
      possibleSkippedNodeIds: [fixture.nodeAId, fixture.nodeBId],
      confirmedSkippedNodeIds: [],
    });
    expect(await managed.client.itineraryNode.count()).toBe(3);
  });

  it('hides execution context and mutations from other owners and administrators', async () => {
    for (const identity of [other, admin]) {
      expect((await getExecution(identity)).statusCode).toBe(404);
      expect(
        (
          await manual(identity, {
            baseTripVersion: 1,
            idempotencyKey: randomUUID(),
            type: 'MANUAL_ARRIVAL',
            nodeId: fixture.nodeAId,
            occurredAt: '2030-01-01T10:00:00.000Z',
          })
        ).statusCode,
      ).toBe(404);
    }
    expect(await tripVersion()).toBe(1);
  });

  function observe(
    identity: SyntheticIdentity,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/location`,
      headers: bearer(identity.credential),
      payload,
    });
  }

  function manual(
    identity: SyntheticIdentity,
    payload: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${fixture.tripId}/execution/events`,
      headers: bearer(identity.credential),
      payload,
    });
  }

  function getExecution(identity: SyntheticIdentity) {
    return app.inject({
      method: 'GET',
      url: `/trips/${fixture.tripId}/execution`,
      headers: bearer(identity.credential),
    });
  }

  async function tripVersion() {
    return (
      await managed.client.trip.findUniqueOrThrow({
        where: { id: fixture.tripId },
      })
    ).version;
  }

  async function createAirportBinding(providerFlightRef: string) {
    const edge = await managed.client.transportEdge.create({
      data: {
        tripId: fixture.tripId,
        fromNodeId: fixture.nodeAId,
        toNodeId: fixture.nodeBId,
        mode: 'FLIGHT',
        fixedService: true,
        source: 'MANUAL',
      },
    });
    const snapshot = flightSnapshot('HND', 'CTS');
    return managed.client.flightBinding.create({
      data: {
        ownerUserId: owner.userId,
        tripId: fixture.tripId,
        transportEdgeId: edge.id,
        provider: 'aerodatabox',
        providerFlightRef,
        canonicalFlightNumber: 'NH53',
        displayFlightNumber: 'NH 53',
        serviceDate: new Date('2030-01-01T00:00:00.000Z'),
        selectedSnapshot: snapshot,
        latestSnapshot: snapshot,
        status: 'SCHEDULED',
        lastRefreshedAt: NOW,
      },
    });
  }
});

function airportObservation() {
  return {
    latitude: 35,
    longitude: 139,
    accuracyMeters: 10,
    observedAt: '2030-01-01T10:00:00.000Z',
  };
}

function flightTriggerResult() {
  return {
    flightBinding: {},
    providerRefreshPerformed: false,
    notificationId: null,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface SyntheticIdentity {
  readonly userId: string;
  readonly credential: string;
}

interface Fixture {
  readonly tripId: string;
  readonly nodeAId: string;
  readonly nodeBId: string;
  readonly nodeCId: string;
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

async function createFixture(
  managed: ManagedPrismaClient,
  ownerUserId: string,
): Promise<Fixture> {
  const tripId = randomUUID();
  const occurrenceId = randomUUID();
  const places = [randomUUID(), randomUUID(), randomUUID()];
  const nodes = [randomUUID(), randomUUID(), randomUUID()];
  await managed.client.$transaction(async (transaction) => {
    await transaction.trip.create({
      data: {
        id: tripId,
        ownerUserId,
        name: 'SYNTHETIC P5E1 Trip',
        planningAnchorDate: new Date('2030-01-01T00:00:00.000Z'),
        defaultPeopleCount: 1,
        version: 1,
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
          id: places[0]!,
          ownerUserId,
          name: 'A',
          latitude: 35,
          longitude: 139,
        },
        {
          id: places[1]!,
          ownerUserId,
          name: 'B',
          latitude: 35.01,
          longitude: 139.01,
        },
        {
          id: places[2]!,
          ownerUserId,
          name: 'C',
          latitude: 35.02,
          longitude: 139.02,
        },
      ],
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
  });
  return { tripId, nodeAId: nodes[0]!, nodeBId: nodes[1]!, nodeCId: nodes[2]! };
}

async function resetSyntheticData(managed: ManagedPrismaClient): Promise<void> {
  await managed.client.user.deleteMany({
    where: { normalizedEmail: { startsWith: 'synthetic-p5e1-' } },
  });
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

function flightSnapshot(departureIata: string, arrivalIata: string) {
  return {
    provider: 'aerodatabox',
    candidateId: 'synthetic:p5e1',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2030-01-01',
    status: 'SCHEDULED',
    fetchedAt: NOW.toISOString(),
    departure: {
      airportName: departureIata,
      airportIata: departureIata,
      airportIcao: null,
      timeZone: 'Asia/Tokyo',
      scheduledLocal: '2030-01-01T12:00:00+09:00',
      scheduledUtc: '2030-01-01T03:00:00.000Z',
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
    },
    arrival: {
      airportName: arrivalIata,
      airportIata: arrivalIata,
      airportIcao: null,
      timeZone: 'Asia/Tokyo',
      scheduledLocal: '2030-01-01T14:00:00+09:00',
      scheduledUtc: '2030-01-01T05:00:00.000Z',
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
    },
  };
}
