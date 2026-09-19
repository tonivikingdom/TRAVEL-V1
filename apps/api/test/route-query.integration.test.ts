import { randomUUID } from 'node:crypto';

import {
  AuthService,
  digestOpaqueToken,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  TripService,
  type Actor,
  type RouteProviderQueryInput,
  type RouteProviderResult,
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
      policyVersion: 'route-adoption-preview-v2',
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
    let trip = await createTrip(identity);
    for (const name of names)
      trip = await addVisit(identity, trip, name, '2030-10-01');
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
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${trip.id}/previews/${previewId}/adopt`,
      headers: bearer(identity),
      payload: {
        baseTripVersion: trip.version,
        idempotencyKey,
      },
    });
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
