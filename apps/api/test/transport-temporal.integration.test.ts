import { randomUUID } from 'node:crypto';

import {
  AuthService,
  digestOpaqueToken,
  TripService,
  type Actor,
} from '@travel/application';
import type {
  ConnectionView,
  TransportHistoryView,
  TripView,
} from '@travel/contracts';
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
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P2B integration tests');
}

const NOW = new Date('2030-09-01T00:00:00.000Z');

describe('P2B transport adjacency and temporal values with PostgreSQL 17', () => {
  let managed: ManagedPrismaClient;
  let app: FastifyInstance;
  let tripRepository: PrismaTripRepository;
  let tripService: TripService;
  let userA: SyntheticIdentity;
  let userB: SyntheticIdentity;
  let admin: SyntheticIdentity;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    [userA, userB, admin] = await Promise.all([
      createIdentity(managed, 'synthetic-p2b-a@synthetic.example.test', 'USER'),
      createIdentity(managed, 'synthetic-p2b-b@synthetic.example.test', 'USER'),
      createIdentity(
        managed,
        'synthetic-p2b-admin@synthetic.example.test',
        'ADMIN',
      ),
    ]);
    tripRepository = new PrismaTripRepository(managed.client);
    tripService = new TripService(tripRepository);
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
      tripService,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('archives A→B when C is inserted and projects two missing connections', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await setTransport(userA, trip, 0, 1, {
      mode: 'RAIL',
      fixedService: true,
    });
    const original = activeConnections(trip)[0]!.transport!;
    const versionBeforeInsert = trip.version;

    trip = await addVisit(userA, trip, 'C', 1);

    expect(trip.version).toBe(versionBeforeInsert + 1);
    expect(
      trip.connections.map(
        (connection) =>
          `${connectionLabel(trip, connection)}:${connection.state}`,
      ),
    ).toEqual(['A→C:MISSING', 'C→B:MISSING']);
    const records = await history(userA, trip.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      originalTransportEdgeId: original.id,
      invalidationReason: 'ADJACENCY_CHANGED',
    });
    expect(await managed.client.transportEdge.count()).toBe(0);
  });

  it('uses occurrence sequence for adjacency when local dates move backward', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'Tokyo', 0, '2030-01-10');
    trip = await addVisit(userA, trip, 'Los Angeles', 0, '2030-01-09');
    expect(trip.days.map((day) => day.localDate)).toEqual([
      '2030-01-10',
      '2030-01-09',
    ]);

    trip = await setTransport(userA, trip, 0, 1, {
      mode: 'FLIGHT',
      fixedService: true,
    });
    expect(trip.connections).toHaveLength(1);
    expect(connectionLabel(trip, trip.connections[0]!)).toBe(
      'Tokyo→Los Angeles',
    );
    expect(trip.connections[0]!.state).toBe('ACTIVE');
  });

  it('moves D locally and invalidates only the three changed adjacencies', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B', 'C', 'D', 'E', 'F']);
    for (let index = 0; index < 5; index += 1) {
      trip = await setTransport(userA, trip, index, index + 1, {
        mode: 'DRIVING',
        fixedService: false,
      });
    }
    const before = new Map(
      trip.connections.map((connection) => [
        connectionLabel(trip, connection),
        connection.transport?.id,
      ]),
    );
    const nodeD = nodeNamed(trip, 'D');

    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'MOVE_NODE',
      nodeId: nodeD.id,
      dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
      position: 2,
    });

    expect(trip.days[0]!.nodes.map((node) => node.place?.name)).toEqual([
      'A',
      'B',
      'D',
      'C',
      'E',
      'F',
    ]);
    expect(
      activeConnections(trip).map((edge) => connectionLabel(trip, edge)),
    ).toEqual(['A→B', 'E→F']);
    expect(activeConnections(trip).map((edge) => edge.transport?.id)).toEqual([
      before.get('A→B'),
      before.get('E→F'),
    ]);
    expect(
      (await history(userA, trip.id))
        .map((record) => historyLabel(trip, record))
        .sort(),
    ).toEqual(['B→C', 'C→D', 'D→E']);
  });

  it('archives both incident edges before deleting B and leaves A→C missing', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B', 'C']);
    trip = await setTransport(userA, trip, 0, 1);
    trip = await setTransport(userA, trip, 1, 2);
    const nodeB = nodeNamed(trip, 'B');

    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'DELETE_NODE',
      nodeId: nodeB.id,
    });

    expect(
      trip.connections.map(
        (connection) =>
          `${connectionLabel(trip, connection)}:${connection.state}`,
      ),
    ).toEqual(['A→C:MISSING']);
    expect(
      await managed.client.itineraryNode.findUnique({
        where: { id: nodeB.id },
      }),
    ).toBeNull();
    const records = await history(userA, trip.id);
    expect(records).toHaveLength(2);
    expect(
      records.every((record) => record.invalidationReason === 'NODE_DELETED'),
    ).toBe(true);
  });

  it('replaces a Place and invalidates only incoming/outgoing endpoint edges', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B', 'C', 'D']);
    for (let index = 0; index < 3; index += 1) {
      trip = await setTransport(userA, trip, index, index + 1);
    }
    const nodeB = nodeNamed(trip, 'B');
    const keptEdgeId = activeConnections(trip)[2]!.transport!.id;

    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'REPLACE_PLACE',
      nodeId: nodeB.id,
      place: customPlace('X'),
    });

    expect(nodeNamed(trip, 'X').id).toBe(nodeB.id);
    expect(activeConnections(trip)).toHaveLength(1);
    expect(activeConnections(trip)[0]!.transport!.id).toBe(keptEdgeId);
    expect(
      (await history(userA, trip.id)).map(
        (record) => record.invalidationReason,
      ),
    ).toEqual(['ENDPOINT_REPLACED', 'ENDPOINT_REPLACED']);
  });

  it('allows only adjacent Place visits and keeps fixedService independent from mode', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B', 'C']);
    const [a, , c] = trip.days[0]!.nodes;
    const nonAdjacent = await commandResponse(userA, trip.id, trip.version, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: a!.id,
      toNodeId: c!.id,
      mode: 'RAIL',
      fixedService: true,
    });
    expect(nonAdjacent.statusCode).toBe(400);
    expect((await getTrip(userA, trip.id)).version).toBe(trip.version);

    trip = await setTransport(userA, trip, 0, 1, {
      mode: 'RAIL',
      fixedService: false,
    });
    expect(trip.connections[0]!.transport).toMatchObject({
      mode: 'RAIL',
      fixedService: false,
    });
    trip = await setTransport(userA, trip, 1, 2, {
      mode: 'TAXI',
      fixedService: true,
    });
    expect(trip.connections[1]!.transport).toMatchObject({
      mode: 'TAXI',
      fixedService: true,
    });
  });

  it('rejects Transport on FreeAction and projects its directional states', async () => {
    let trip = await createTrip(userA);
    trip = await addVisit(userA, trip, 'A', 0);
    trip = await addFreeAction(userA, trip, 1);
    trip = await addVisit(userA, trip, 'B', 2);
    trip = await addFreeAction(userA, trip, 3);

    expect(trip.connections.map((connection) => connection.state)).toEqual([
      'NOT_APPLICABLE',
      'RUNTIME_ORIGIN_REQUIRED',
      'NOT_APPLICABLE',
    ]);
    const response = await commandResponse(userA, trip.id, trip.version, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: trip.days[0]!.nodes[0]!.id,
      toNodeId: trip.days[0]!.nodes[1]!.id,
      mode: 'WALKING',
      fixedService: false,
    });
    expect(response.statusCode).toBe(400);
    expect(await managed.client.transportEdge.count()).toBe(0);
  });

  it('archives replaced and cleared manual transports with explicit reasons', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await setTransport(userA, trip, 0, 1, {
      mode: 'BUS',
      fixedService: true,
    });
    const versionBeforeReplace = trip.version;
    trip = await setTransport(userA, trip, 0, 1, {
      mode: 'TAXI',
      fixedService: false,
    });
    expect(trip.version).toBe(versionBeforeReplace + 1);
    expect((await history(userA, trip.id))[0]!.invalidationReason).toBe(
      'USER_REPLACED',
    );

    const currentId = trip.connections[0]!.transport!.id;
    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'CLEAR_TRANSPORT',
      transportEdgeId: currentId,
    });
    expect(trip.connections[0]!.state).toBe('MISSING');
    expect((await history(userA, trip.id))[0]!.invalidationReason).toBe(
      'USER_CLEARED',
    );
    const repeat = await commandResponse(userA, trip.id, trip.version, {
      type: 'CLEAR_TRANSPORT',
      transportEdgeId: currentId,
    });
    expect(repeat.statusCode).toBe(404);
    expect((await getTrip(userA, trip.id)).version).toBe(trip.version);
  });

  it('rejects stale transport writes without changing edge or version', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    const staleVersion = trip.version;
    trip = await setTransport(userA, trip, 0, 1);
    const response = await commandResponse(userA, trip.id, staleVersion, {
      type: 'CLEAR_TRANSPORT',
      transportEdgeId: trip.connections[0]!.transport!.id,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('VERSION_CONFLICT');
    const persisted = await getTrip(userA, trip.id);
    expect(persisted.version).toBe(trip.version);
    expect(persisted.connections[0]!.state).toBe('ACTIVE');
  });

  it('rolls back endpoint invalidation when the structural command fails', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await setTransport(userA, trip, 0, 1);
    const privateTrip = await tripWithPlaces(userB, ['PRIVATE']);
    const privatePlaceId = nodeNamed(privateTrip, 'PRIVATE').place!.id;
    const nodeB = nodeNamed(trip, 'B');
    const before = trip;

    const response = await commandResponse(userA, trip.id, trip.version, {
      type: 'REPLACE_PLACE',
      nodeId: nodeB.id,
      place: { type: 'EXISTING', placeId: privatePlaceId },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');

    trip = await getTrip(userA, trip.id);
    expect(trip.version).toBe(before.version);
    expect(trip.connections[0]!.transport!.id).toBe(
      before.connections[0]!.transport!.id,
    );
    expect(await history(userA, trip.id)).toEqual([]);
    expect(nodeNames(trip)).toEqual(['A', 'B']);
  });

  it('hides transport and history from another owner and ADMIN', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await setTransport(userA, trip, 0, 1);
    const edgeId = trip.connections[0]!.transport!.id;
    for (const identity of [userB, admin]) {
      const response = await commandResponse(identity, trip.id, trip.version, {
        type: 'CLEAR_TRANSPORT',
        transportEdgeId: edgeId,
      });
      expect(response.statusCode).toBe(404);
      await expect(
        tripService.listTransportHistory(identity.actor, trip.id),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        tripService.setResolvedTemporalValue(
          identity.actor,
          trip.id,
          trip.version,
          { type: 'TRANSPORT', transportEdgeId: edgeId },
          {
            layer: 'PLANNED',
            pointKind: 'DEPARTURE',
            instant: '2030-10-01T10:00:00+08:00',
            timeZone: 'Asia/Shanghai',
            sourceKind: 'USER_VALUE',
          },
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await getTrip(userA, trip.id)).connections[0]!.state).toBe(
      'ACTIVE',
    );
  });

  it('stores PLANNED, ESTIMATED, and ACTUAL independently on a Node', async () => {
    let trip = await tripWithPlaces(userA, ['A']);
    const nodeId = trip.days[0]!.nodes[0]!.id;
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId },
      'PLANNED',
      '10:00:00',
    );
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId },
      'ESTIMATED',
      '10:15:00',
    );
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId },
      'ACTUAL',
      '10:12:00',
    );

    expect(
      trip.days[0]!.nodes[0]!.timeValues.map((value) => [
        value.layer,
        value.instant,
      ]),
    ).toEqual([
      ['PLANNED', '2030-10-01T02:00:00.000Z'],
      ['ESTIMATED', '2030-10-01T02:15:00.000Z'],
      ['ACTUAL', '2030-10-01T02:12:00.000Z'],
    ]);

    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId },
      'ESTIMATED',
      '10:20:00',
    );
    const values = trip.days[0]!.nodes[0]!.timeValues;
    expect(values.find((value) => value.layer === 'PLANNED')?.instant).toBe(
      '2030-10-01T02:00:00.000Z',
    );
    expect(values.find((value) => value.layer === 'ACTUAL')?.instant).toBe(
      '2030-10-01T02:12:00.000Z',
    );
    expect(values.find((value) => value.layer === 'ESTIMATED')?.instant).toBe(
      '2030-10-01T02:20:00.000Z',
    );
  });

  it('rejects invalid resolved times without writing or advancing Trip version', async () => {
    const trip = await tripWithPlaces(userA, ['A']);
    const nodeId = trip.days[0]!.nodes[0]!.id;
    for (const input of [
      { instant: '2030-02-30T10:00:00Z', timeZone: 'UTC' },
      { instant: '2030-02-29T10:00:00Z', timeZone: 'Asia/Tokyo' },
      { instant: '2030-10-01T10:00:00+15:00', timeZone: 'Asia/Shanghai' },
      { instant: '2030-10-01T10:00:00.1234Z', timeZone: 'UTC' },
      { instant: '2030-10-01T10:00:00Z', timeZone: '+08:00' },
      { instant: '2030-10-01T10:00:00Z', timeZone: 'Not/A_Zone' },
    ]) {
      await expect(
        tripService.setResolvedTemporalValue(
          userA.actor,
          trip.id,
          trip.version,
          { type: 'NODE', nodeId },
          {
            layer: 'PLANNED',
            pointKind: 'ARRIVAL',
            instant: input.instant,
            timeZone: input.timeZone,
            sourceKind: 'USER_VALUE',
          },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await managed.client.temporalValue.count()).toBe(0);
    expect((await getTrip(userA, trip.id)).version).toBe(trip.version);
  });

  it('protects a Node ACTUAL from delete or place replacement atomically', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await setTransport(userA, trip, 0, 1);
    const nodeB = nodeNamed(trip, 'B');
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId: nodeB.id },
      'ACTUAL',
      '10:12:00',
    );
    const protectedVersion = trip.version;
    const transportId = trip.connections[0]!.transport!.id;

    for (const command of [
      { type: 'DELETE_NODE', nodeId: nodeB.id },
      {
        type: 'REPLACE_PLACE',
        nodeId: nodeB.id,
        place: customPlace('X'),
      },
    ]) {
      const response = await commandResponse(
        userA,
        trip.id,
        protectedVersion,
        command,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('FACT_PROTECTED');
    }

    trip = await getTrip(userA, trip.id);
    expect(trip.version).toBe(protectedVersion);
    expect(nodeNames(trip)).toEqual(['A', 'B']);
    expect(trip.connections[0]!.transport!.id).toBe(transportId);
    expect(await history(userA, trip.id)).toEqual([]);
    expect(await managed.client.dateOwnership.count()).toBe(1);
    expect(
      await managed.client.temporalValue.count({
        where: { nodeId: nodeB.id, layer: 'ACTUAL' },
      }),
    ).toBe(1);
  });

  it('protects a Node ACTUAL from cross-occurrence movement atomically', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await addVisit(userA, trip, 'C', 0, '2030-10-02');
    trip = await setTransport(userA, trip, 0, 1);
    trip = await setTransport(userA, trip, 1, 2);
    const nodeB = nodeNamed(trip, 'B');
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId: nodeB.id },
      'ACTUAL',
      '10:12:00',
    );
    const sourceDay = trip.days[0]!;
    const targetDay = trip.days[1]!;
    const protectedVersion = trip.version;
    const protectedSnapshot = {
      effectiveStartDate: trip.effectiveStartDate,
      effectiveEndDate: trip.effectiveEndDate,
      days: trip.days,
      connections: trip.connections,
    };
    const ownershipBefore = await managed.client.dateOwnership.findMany({
      where: { tripId: trip.id },
      orderBy: { localDate: 'asc' },
    });

    const response = await commandResponse(userA, trip.id, trip.version, {
      type: 'MOVE_NODE',
      nodeId: nodeB.id,
      dayOccurrenceId: targetDay.dayOccurrenceId,
      position: 1,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('FACT_PROTECTED');
    trip = await getTrip(userA, trip.id);
    expect(trip.version).toBe(protectedVersion);
    expect({
      effectiveStartDate: trip.effectiveStartDate,
      effectiveEndDate: trip.effectiveEndDate,
      days: trip.days,
      connections: trip.connections,
    }).toEqual(protectedSnapshot);
    expect(
      await managed.client.itineraryNode.findUniqueOrThrow({
        where: { id: nodeB.id },
        select: { dayOccurrenceId: true, position: true },
      }),
    ).toEqual({ dayOccurrenceId: sourceDay.dayOccurrenceId, position: 1 });
    expect(
      await managed.client.temporalValue.count({
        where: { nodeId: nodeB.id, layer: 'ACTUAL' },
      }),
    ).toBe(1);
    expect(await history(userA, trip.id)).toEqual([]);
    expect(
      await managed.client.dateOwnership.findMany({
        where: { tripId: trip.id },
        orderBy: { localDate: 'asc' },
      }),
    ).toEqual(ownershipBefore);
  });

  it('allows PLANNED and ESTIMATED facts to move across occurrences', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await addVisit(userA, trip, 'C', 0, '2030-10-02');
    const nodeB = nodeNamed(trip, 'B');
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId: nodeB.id },
      'PLANNED',
      '10:00:00',
    );
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId: nodeB.id },
      'ESTIMATED',
      '10:15:00',
    );
    const targetDayOccurrenceId = trip.days[1]!.dayOccurrenceId;

    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'MOVE_NODE',
      nodeId: nodeB.id,
      dayOccurrenceId: targetDayOccurrenceId,
      position: 0,
    });

    expect(trip.days[1]!.nodes.map((node) => node.place?.name)).toEqual([
      'B',
      'C',
    ]);
    const persistedLayers = await managed.client.temporalValue.findMany({
      where: { nodeId: nodeB.id },
      select: { layer: true },
    });
    expect(persistedLayers.map((value) => value.layer).sort()).toEqual([
      'ESTIMATED',
      'PLANNED',
    ]);
  });

  it('allows same-occurrence reorder when the Node has an ACTUAL fact', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    const nodeB = nodeNamed(trip, 'B');
    trip = await setTime(
      userA,
      trip,
      { type: 'NODE', nodeId: nodeB.id },
      'ACTUAL',
      '10:12:00',
    );
    const versionBeforeMove = trip.version;

    trip = await executeCommand(userA, trip.id, trip.version, {
      type: 'MOVE_NODE',
      nodeId: nodeB.id,
      dayOccurrenceId: trip.days[0]!.dayOccurrenceId,
      position: 0,
    });

    expect(trip.version).toBe(versionBeforeMove + 1);
    expect(nodeNames(trip)).toEqual(['B', 'A']);
    expect(
      await managed.client.temporalValue.count({
        where: { nodeId: nodeB.id, layer: 'ACTUAL' },
      }),
    ).toBe(1);
  });

  it('serializes concurrent ACTUAL write and cross-occurrence MOVE_NODE', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await addVisit(userA, trip, 'C', 0, '2030-10-02');
    const nodeB = nodeNamed(trip, 'B');
    const sourceDayOccurrenceId = trip.days[0]!.dayOccurrenceId;
    const targetDayOccurrenceId = trip.days[1]!.dayOccurrenceId;
    const baseTripVersion = trip.version;
    const actualWrite = tripService
      .setResolvedTemporalValue(
        userA.actor,
        trip.id,
        baseTripVersion,
        { type: 'NODE', nodeId: nodeB.id },
        {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: '2030-10-01T10:12:00+08:00',
          timeZone: 'Asia/Shanghai',
          sourceKind: 'PROVIDER_OBSERVATION',
          sourceRef: 'SYNTHETIC_P3A_RACE',
          observedAt: '2030-10-01T10:13:00+08:00',
        },
      )
      .then(
        () => true,
        () => false,
      );
    const moveWrite = commandResponse(userA, trip.id, baseTripVersion, {
      type: 'MOVE_NODE',
      nodeId: nodeB.id,
      dayOccurrenceId: targetDayOccurrenceId,
      position: 0,
    });

    const [actualSucceeded, moveResponse] = await Promise.all([
      actualWrite,
      moveWrite,
    ]);
    const moveSucceeded = moveResponse.statusCode === 200;
    expect(Number(actualSucceeded) + Number(moveSucceeded)).toBe(1);

    const persistedNode = await managed.client.itineraryNode.findUniqueOrThrow({
      where: { id: nodeB.id },
      include: { temporalValues: true },
    });
    if (actualSucceeded) {
      expect(moveResponse.statusCode).toBe(409);
      expect(['FACT_PROTECTED', 'VERSION_CONFLICT']).toContain(
        moveResponse.json().error.code,
      );
      expect(persistedNode.dayOccurrenceId).toBe(sourceDayOccurrenceId);
      expect(persistedNode.temporalValues).toHaveLength(1);
      expect(persistedNode.temporalValues[0]!.layer).toBe('ACTUAL');
    } else {
      expect(moveResponse.statusCode).toBe(200);
      expect(persistedNode.dayOccurrenceId).toBe(targetDayOccurrenceId);
      expect(persistedNode.temporalValues).toEqual([]);
    }
    expect((await getTrip(userA, trip.id)).version).toBe(baseTripVersion + 1);
  });

  it('rejects different ACTUAL overwrites on both Node and Transport', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await setTransport(userA, trip, 0, 1);
    const nodeId = trip.days[0]!.nodes[0]!.id;
    const edgeId = trip.connections[0]!.transport!.id;

    for (const subject of [
      { type: 'NODE' as const, nodeId },
      { type: 'TRANSPORT' as const, transportEdgeId: edgeId },
    ]) {
      trip = await setTime(userA, trip, subject, 'ACTUAL', '10:12:00');
      const protectedVersion = trip.version;
      await expect(
        tripService.setResolvedTemporalValue(
          userA.actor,
          trip.id,
          trip.version,
          subject,
          {
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: '2030-10-01T10:13:00+08:00',
            timeZone: 'Asia/Shanghai',
            sourceKind: 'PROVIDER_OBSERVATION',
            sourceRef: 'SYNTHETIC_P2B_CORRECTION',
            observedAt: '2030-10-01T10:14:00+08:00',
          },
        ),
      ).rejects.toMatchObject({ code: 'FACT_PROTECTED' });
      trip = await getTrip(userA, trip.id);
      expect(trip.version).toBe(protectedVersion);
    }
    expect(
      await managed.client.temporalValue.count({ where: { layer: 'ACTUAL' } }),
    ).toBe(2);
  });

  it.each(['DERIVED', 'SYSTEM_SUGGESTION'] as const)(
    'rejects %s ACTUAL without persistence or version change',
    async (sourceKind) => {
      const trip = await tripWithPlaces(userA, ['A']);
      await expect(
        tripService.setResolvedTemporalValue(
          userA.actor,
          trip.id,
          trip.version,
          { type: 'NODE', nodeId: trip.days[0]!.nodes[0]!.id },
          {
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: '2030-10-01T10:00:00Z',
            timeZone: 'UTC',
            sourceKind,
          },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      const repositoryResult = await tripRepository.setTemporalValue({
        ownerUserId: userA.actor.userId,
        tripId: trip.id,
        baseTripVersion: trip.version,
        subject: { type: 'NODE', nodeId: trip.days[0]!.nodes[0]!.id },
        value: {
          layer: 'ACTUAL',
          pointKind: 'ARRIVAL',
          instant: new Date('2030-10-01T10:00:00.000Z'),
          timeZone: 'UTC',
          sourceKind,
          sourceRef: null,
          observedAt: null,
        },
      });
      expect(repositoryResult.status).toBe('FACT_PROTECTED');
      expect(await managed.client.temporalValue.count()).toBe(0);
      expect((await getTrip(userA, trip.id)).version).toBe(trip.version);
    },
  );

  it.each(['DELETE_NODE', 'REPLACE_PLACE'] as const)(
    'serializes concurrent ACTUAL write and %s without losing a committed fact',
    async (commandType) => {
      const trip = await tripWithPlaces(userA, ['A']);
      const node = trip.days[0]!.nodes[0]!;
      const actualWrite = tripService
        .setResolvedTemporalValue(
          userA.actor,
          trip.id,
          trip.version,
          { type: 'NODE', nodeId: node.id },
          {
            layer: 'ACTUAL',
            pointKind: 'ARRIVAL',
            instant: '2030-10-01T10:00:00Z',
            timeZone: 'UTC',
            sourceKind: 'USER_VALUE',
          },
        )
        .then(
          () => true,
          () => false,
        );
      const structuralWrite = commandResponse(
        userA,
        trip.id,
        trip.version,
        commandType === 'DELETE_NODE'
          ? { type: commandType, nodeId: node.id }
          : {
              type: commandType,
              nodeId: node.id,
              place: customPlace('X'),
            },
      );
      const [actualSucceeded, response] = await Promise.all([
        actualWrite,
        structuralWrite,
      ]);
      const structuralSucceeded = response.statusCode === 200;
      expect(Number(actualSucceeded) + Number(structuralSucceeded)).toBe(1);

      const persistedNode = await managed.client.itineraryNode.findUnique({
        where: { id: node.id },
        include: { temporalValues: true, place: true },
      });
      if (actualSucceeded) {
        expect(response.statusCode).toBe(409);
        expect(persistedNode?.temporalValues).toHaveLength(1);
        expect(persistedNode?.place?.name).toBe('A');
      } else if (commandType === 'DELETE_NODE') {
        expect(persistedNode).toBeNull();
      } else {
        expect(persistedNode?.temporalValues).toEqual([]);
        expect(persistedNode?.place?.name).toBe('X');
      }
      expect((await getTrip(userA, trip.id)).version).toBe(trip.version + 1);
    },
  );

  it('requires explicit instants and IANA zones without using server timezone', async () => {
    const trip = await tripWithPlaces(userA, ['A']);
    const nodeId = trip.days[0]!.nodes[0]!.id;
    await expect(
      tripService.setResolvedTemporalValue(
        userA.actor,
        trip.id,
        trip.version,
        { type: 'NODE', nodeId },
        {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-11-03T01:30:00',
          timeZone: 'America/New_York',
          sourceKind: 'USER_VALUE',
        },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCENARIO' });
    await expect(
      tripService.setResolvedTemporalValue(
        userA.actor,
        trip.id,
        trip.version,
        { type: 'NODE', nodeId },
        {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2030-11-03T01:30:00-04:00',
          timeZone: 'Not/A_Zone',
          sourceKind: 'USER_VALUE',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('preserves all Transport temporal layers in immutable history', async () => {
    let trip = await tripWithPlaces(userA, ['A', 'B']);
    trip = await setTransport(userA, trip, 0, 1);
    const edgeId = trip.connections[0]!.transport!.id;
    for (const [layer, clock] of [
      ['PLANNED', '10:00:00'],
      ['ESTIMATED', '10:15:00'],
      ['ACTUAL', '10:12:00'],
    ] as const) {
      trip = await setTime(
        userA,
        trip,
        { type: 'TRANSPORT', transportEdgeId: edgeId },
        layer,
        clock,
      );
    }
    trip = await addVisit(userA, trip, 'C', 1);

    const records = await history(userA, trip.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.timeValues.map((value) => value.layer)).toEqual([
      'PLANNED',
      'ESTIMATED',
      'ACTUAL',
    ]);
    expect(await managed.client.temporalValue.count()).toBe(0);
    expect(await managed.client.transportEdgeHistoryTimeValue.count()).toBe(3);
  });

  it('exposes committed P2B tables, subject check, and endpoint constraints', async () => {
    const tables = await managed.client.$queryRaw<
      Array<{ table_name: string }>
    >`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'TransportEdge',
          'TransportEdgeHistory',
          'TemporalValue',
          'TransportEdgeHistoryTimeValue'
        )
      ORDER BY table_name
    `;
    expect(tables.map((row) => row.table_name)).toEqual([
      'TemporalValue',
      'TransportEdge',
      'TransportEdgeHistory',
      'TransportEdgeHistoryTimeValue',
    ]);
    const constraints = await managed.client.$queryRaw<
      Array<{ constraint_name: string }>
    >`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name IN ('TransportEdge', 'TemporalValue')
    `;
    expect(constraints.map((row) => row.constraint_name)).toEqual(
      expect.arrayContaining([
        'TransportEdge_distinct_endpoints_check',
        'TransportEdge_fromNodeId_tripId_fkey',
        'TransportEdge_toNodeId_tripId_fkey',
        'TemporalValue_exactly_one_subject_check',
      ]),
    );
  });

  async function createTrip(identity: SyntheticIdentity): Promise<TripView> {
    const response = await app.inject({
      method: 'POST',
      url: '/trips',
      headers: bearer(identity),
      payload: {
        name: `SYNTHETIC P2B ${randomUUID()}`,
        planningAnchorDate: '2030-10-01',
        defaultPeopleCount: 2,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as TripView;
  }

  async function tripWithPlaces(
    identity: SyntheticIdentity,
    names: readonly string[],
    localDate = '2030-10-01',
  ): Promise<TripView> {
    let trip = await createTrip(identity);
    for (const [position, name] of names.entries()) {
      trip = await addVisit(identity, trip, name, position, localDate);
    }
    return trip;
  }

  async function addVisit(
    identity: SyntheticIdentity,
    trip: TripView,
    name: string,
    position: number,
    localDate = '2030-10-01',
  ): Promise<TripView> {
    return executeCommand(identity, trip.id, trip.version, {
      type: 'ADD_PLACE_VISIT',
      targetDay: targetDay(trip, localDate),
      position,
      place: customPlace(name),
      note: `SYNTHETIC ${name}`,
    });
  }

  async function addFreeAction(
    identity: SyntheticIdentity,
    trip: TripView,
    position: number,
    localDate = '2030-10-01',
  ): Promise<TripView> {
    return executeCommand(identity, trip.id, trip.version, {
      type: 'ADD_FREE_ACTION',
      targetDay: targetDay(trip, localDate),
      position,
      note: 'SYNTHETIC free action',
    });
  }

  async function setTransport(
    identity: SyntheticIdentity,
    trip: TripView,
    fromIndex: number,
    toIndex: number,
    options: { readonly mode: string; readonly fixedService: boolean } = {
      mode: 'DRIVING',
      fixedService: false,
    },
  ): Promise<TripView> {
    const nodes = trip.days.flatMap((day) => day.nodes);
    return executeCommand(identity, trip.id, trip.version, {
      type: 'SET_MANUAL_TRANSPORT',
      fromNodeId: nodes[fromIndex]!.id,
      toNodeId: nodes[toIndex]!.id,
      mode: options.mode,
      fixedService: options.fixedService,
      serviceLabel: `SYNTHETIC ${options.mode}`,
    });
  }

  async function setTime(
    identity: SyntheticIdentity,
    trip: TripView,
    subject:
      | { readonly type: 'NODE'; readonly nodeId: string }
      | { readonly type: 'TRANSPORT'; readonly transportEdgeId: string },
    layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL',
    clock: string,
  ): Promise<TripView> {
    return tripService.setResolvedTemporalValue(
      identity.actor,
      trip.id,
      trip.version,
      subject,
      {
        layer,
        pointKind: 'ARRIVAL',
        instant: `2030-10-01T${clock}+08:00`,
        timeZone: 'Asia/Shanghai',
        sourceKind: layer === 'ACTUAL' ? 'PROVIDER_OBSERVATION' : 'USER_VALUE',
        sourceRef: 'SYNTHETIC_P2B',
        ...(layer === 'ACTUAL'
          ? { observedAt: '2030-10-01T10:13:00+08:00' }
          : {}),
      },
    );
  }

  async function getTrip(
    identity: SyntheticIdentity,
    tripId: string,
  ): Promise<TripView> {
    const response = await app.inject({
      method: 'GET',
      url: `/trips/${tripId}`,
      headers: bearer(identity),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
  }

  async function executeCommand(
    identity: SyntheticIdentity,
    tripId: string,
    baseTripVersion: number,
    command: Record<string, unknown>,
  ): Promise<TripView> {
    const response = await commandResponse(
      identity,
      tripId,
      baseTripVersion,
      command,
    );
    expect(response.statusCode).toBe(200);
    return response.json() as TripView;
  }

  function commandResponse(
    identity: SyntheticIdentity,
    tripId: string,
    baseTripVersion: number,
    command: Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: `/trips/${tripId}/commands`,
      headers: bearer(identity),
      payload: { baseTripVersion, command },
    });
  }

  function history(
    identity: SyntheticIdentity,
    tripId: string,
  ): Promise<readonly TransportHistoryView[]> {
    return tripService.listTransportHistory(identity.actor, tripId);
  }
});

interface SyntheticIdentity {
  readonly credential: string;
  readonly actor: Actor;
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
      preference: {
        create: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' },
      },
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
    actor: {
      userId: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
    },
  };
}

function bearer(identity: SyntheticIdentity) {
  return { authorization: `Bearer ${identity.credential}` };
}

function customPlace(name: string) {
  return {
    type: 'CUSTOM',
    name,
    latitude: 31.2304,
    longitude: 121.4737,
    address: null,
  };
}

function targetDay(trip: TripView, localDate: string) {
  const existing = trip.days.find((day) => day.localDate === localDate);
  return existing === undefined
    ? { type: 'NEW', localDate, sequence: trip.days.length }
    : { type: 'EXISTING', dayOccurrenceId: existing.dayOccurrenceId };
}

function activeConnections(trip: TripView): readonly ConnectionView[] {
  return trip.connections.filter((connection) => connection.state === 'ACTIVE');
}

function nodeNamed(trip: TripView, name: string) {
  const node = trip.days
    .flatMap((day) => day.nodes)
    .find((candidate) => candidate.place?.name === name);
  expect(node).toBeDefined();
  return node!;
}

function nodeNames(trip: TripView): string[] {
  return trip.days.flatMap((day) => day.nodes).map((node) => node.place!.name);
}

function connectionLabel(trip: TripView, connection: ConnectionView): string {
  return `${nodeNameById(trip, connection.fromNodeId)}→${nodeNameById(
    trip,
    connection.toNodeId,
  )}`;
}

function nodeNameById(trip: TripView, nodeId: string): string {
  return (
    trip.days.flatMap((day) => day.nodes).find((node) => node.id === nodeId)
      ?.place?.name ?? 'FREE_ACTION'
  );
}

function historyLabel(trip: TripView, record: TransportHistoryView): string {
  return `${nodeNameById(trip, record.originalFromNodeId)}→${nodeNameById(
    trip,
    record.originalToNodeId,
  )}`;
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
  await managed.client.adoptedRoute.deleteMany();
  await managed.client.transportEdgeHistoryTimeValue.deleteMany();
  await managed.client.transportEdgeHistory.deleteMany();
  await managed.client.temporalValue.deleteMany();
  await managed.client.transportEdge.deleteMany();
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
