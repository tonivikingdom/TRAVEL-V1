import { randomUUID } from 'node:crypto';

import {
  AuthService,
  digestOpaqueToken,
  hashRoutePreviewPayload,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  RouteUndoService,
  TripService,
  type Actor,
  type RouteProviderQueryInput,
  type RouteProviderResult,
  type StoredRoutePreviewPayload,
} from '@travel/application';
import type {
  RoutePreviewView,
  RouteQueryResponse,
  TripView,
} from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import { SyntheticRouteProvider } from '@travel/providers';
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
    const routePlanningRepository = new PrismaRoutePlanningRepository(
      managed.client,
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
      tripService: new TripService(repository),
      routeQueryService: new RouteQueryService(
        repository,
        provider,
        routePlanningRepository,
        {
          candidateSnapshotTtlSeconds: 900,
          clock: { now: () => currentNow },
        },
      ),
      routePreviewService: new RoutePreviewService(
        repository,
        routePlanningRepository,
        {
          previewTtlSeconds: 600,
          clock: { now: () => currentNow },
        },
      ),
      routeAdoptionService: new RouteAdoptionService(
        routePlanningRepository,
        new TripService(repository),
        { undoWindowSeconds: 600, clock: { now: () => currentNow } },
      ),
      routeUndoService: new RouteUndoService(
        routePlanningRepository,
        new TripService(repository),
        { now: () => currentNow },
      ),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
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
      requiresUserAdjustment: true,
      requiredUserAdjustments: [
        {
          nodeId: from!.id,
          fromDurationSeconds: 3_000,
          toDurationSeconds: 2_700,
        },
      ],
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
    expect(
      await managed.client.adoptedRoute.findMany({
        where: { tripId: initial.id },
        orderBy: { createdAt: 'asc' },
      }),
    ).toEqual([
      expect.objectContaining({
        id: first.operationReceipt.adoptedRouteId,
        status: 'ACTIVE',
        replacedAt: null,
      }),
      expect.objectContaining({
        id: second.operationReceipt.adoptedRouteId,
        status: 'UNDONE',
      }),
    ]);

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

  async function createPreview(
    identity: SyntheticIdentity,
    trip: TripView,
    fromNodeId: string,
    toNodeId: string,
  ): Promise<RoutePreviewView> {
    const routeResponse = await query(
      identity,
      trip,
      fromNodeId,
      toNodeId,
      departHint(),
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
  ): Promise<{
    operationReceipt: {
      id: string;
      adoptedRouteId: string;
      resultingTripVersion: number;
    };
    trip: TripView;
  }> {
    const response = await adopt(identity, trip, previewId, idempotencyKey);
    expect(response.statusCode).toBe(200);
    return response.json() as {
      operationReceipt: {
        id: string;
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
  await managed.client.itineraryNode.deleteMany({
    where: { source: 'ROUTE_GENERATED' },
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
