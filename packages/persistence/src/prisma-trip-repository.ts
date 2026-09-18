import type {
  PlaceRecord,
  RepositoryPlaceInput,
  RepositoryTemporalSubject,
  RepositoryTemporalValueInput,
  RepositoryTripCommand,
  TemporalValueRecord,
  TransportEdgeRecord,
  TransportHistoryRecord,
  TransportInvalidationReason,
  TripAggregateRecord,
  TripMutationResult,
  TripRepository,
} from '@travel/application';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

const tripInclude = {
  dateOwnerships: { orderBy: { localDate: 'asc' } },
  nodes: {
    include: {
      place: true,
      temporalValues: { orderBy: [{ pointKind: 'asc' }, { layer: 'asc' }] },
    },
    orderBy: [{ localDate: 'asc' }, { position: 'asc' }, { id: 'asc' }],
  },
  transportEdges: {
    include: {
      temporalValues: { orderBy: [{ pointKind: 'asc' }, { layer: 'asc' }] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.TripInclude;

const transportInclude = {
  temporalValues: { orderBy: [{ pointKind: 'asc' }, { layer: 'asc' }] },
} satisfies Prisma.TransportEdgeInclude;

const historyInclude = {
  temporalValues: { orderBy: [{ pointKind: 'asc' }, { layer: 'asc' }] },
} satisfies Prisma.TransportEdgeHistoryInclude;

type TripWithProjectionData = Prisma.TripGetPayload<{
  include: typeof tripInclude;
}>;
type TransportWithTimes = Prisma.TransportEdgeGetPayload<{
  include: typeof transportInclude;
}>;
type HistoryWithTimes = Prisma.TransportEdgeHistoryGetPayload<{
  include: typeof historyInclude;
}>;
type Transaction = Prisma.TransactionClient;
type FailureStatus = Exclude<TripMutationResult['status'], 'SUCCESS'>;

interface LockedTripRow {
  readonly id: string;
  readonly version: number;
}

interface DateBoundsRow {
  readonly minimum: Date | null;
  readonly maximum: Date | null;
}

interface AdvisoryLockRow {
  readonly locked: boolean;
}

export class PrismaTripRepository implements TripRepository {
  constructor(private readonly client: PrismaClient) {}

  async create(input: {
    readonly ownerUserId: string;
    readonly name: string;
    readonly planningAnchorDate: Date;
    readonly defaultPeopleCount: number;
  }): Promise<TripAggregateRecord> {
    return toTripRecord(
      await this.client.trip.create({
        data: input,
        include: tripInclude,
      }),
    );
  }

  async listOwned(
    ownerUserId: string,
  ): Promise<readonly TripAggregateRecord[]> {
    const trips = await this.client.trip.findMany({
      where: { ownerUserId },
      include: tripInclude,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    return trips.map(toTripRecord);
  }

  async findOwnedById(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<TripAggregateRecord | null> {
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      include: tripInclude,
    });
    return trip === null ? null : toTripRecord(trip);
  }

  async updateMetadata(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly name?: string;
    readonly planningAnchorDate?: Date;
    readonly defaultPeopleCount?: number;
  }): Promise<TripMutationResult> {
    try {
      return await this.client.$transaction(async (transaction) => {
        await lockOwner(transaction, input.ownerUserId);
        await requireLockedTrip(transaction, input);
        await transaction.trip.update({
          where: { id: input.tripId },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.planningAnchorDate === undefined
              ? {}
              : { planningAnchorDate: input.planningAnchorDate }),
            ...(input.defaultPeopleCount === undefined
              ? {}
              : { defaultPeopleCount: input.defaultPeopleCount }),
            version: { increment: 1 },
          },
        });
        return {
          status: 'SUCCESS',
          trip: toTripRecord(
            await loadTrip(transaction, input.tripId, input.ownerUserId),
          ),
        };
      });
    } catch (error) {
      return failureResult(error);
    }
  }

  async executeCommand(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly command: RepositoryTripCommand;
  }): Promise<TripMutationResult> {
    try {
      return await this.client.$transaction(async (transaction) => {
        await lockOwner(transaction, input.ownerUserId);
        await requireLockedTrip(transaction, input);
        await applyCommand(transaction, input);
        const range = await reconcileDateOwnership(transaction, input);
        await transaction.trip.update({
          where: { id: input.tripId },
          data: {
            effectiveStartDate: range?.minimum ?? null,
            effectiveEndDate: range?.maximum ?? null,
            version: { increment: 1 },
          },
        });
        return {
          status: 'SUCCESS',
          trip: toTripRecord(
            await loadTrip(transaction, input.tripId, input.ownerUserId),
          ),
        };
      });
    } catch (error) {
      if (isDateOwnershipConflict(error)) {
        return { status: 'DATE_OWNED' };
      }
      return failureResult(error);
    }
  }

  async setTemporalValue(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly subject: RepositoryTemporalSubject;
    readonly value: RepositoryTemporalValueInput;
  }): Promise<TripMutationResult> {
    try {
      return await this.client.$transaction(async (transaction) => {
        await lockOwner(transaction, input.ownerUserId);
        await requireLockedTrip(transaction, input);
        await upsertTemporalValue(transaction, input);
        await transaction.trip.update({
          where: { id: input.tripId },
          data: { version: { increment: 1 } },
        });
        return {
          status: 'SUCCESS',
          trip: toTripRecord(
            await loadTrip(transaction, input.tripId, input.ownerUserId),
          ),
        };
      });
    } catch (error) {
      return failureResult(error);
    }
  }

  async listTransportHistoryOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<readonly TransportHistoryRecord[] | null> {
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: { id: true },
    });
    if (trip === null) {
      return null;
    }
    const records = await this.client.transportEdgeHistory.findMany({
      where: { tripId: input.tripId },
      include: historyInclude,
      orderBy: [{ invalidatedAt: 'desc' }, { id: 'desc' }],
    });
    return records.map(toTransportHistoryRecord);
  }
}

async function lockOwner(
  transaction: Transaction,
  ownerUserId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<AdvisoryLockRow[]>(Prisma.sql`
    SELECT TRUE AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 2))
  `);
  if (rows[0]?.locked !== true) {
    throw new Error('Failed to acquire the owner date-ownership lock');
  }
}

async function requireLockedTrip(
  transaction: Transaction,
  input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
  },
): Promise<void> {
  const rows = await transaction.$queryRaw<LockedTripRow[]>(Prisma.sql`
    SELECT "id", "version"
    FROM "Trip"
    WHERE "id" = ${input.tripId}::uuid
      AND "ownerUserId" = ${input.ownerUserId}::uuid
    FOR UPDATE
  `);
  const trip = rows[0];
  if (trip === undefined) {
    throw new TripTransactionAbort('NOT_FOUND');
  }
  if (trip.version !== input.baseTripVersion) {
    throw new TripTransactionAbort('VERSION_CONFLICT');
  }
}

async function applyCommand(
  transaction: Transaction,
  input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly command: RepositoryTripCommand;
  },
): Promise<void> {
  switch (input.command.type) {
    case 'ADD_PLACE_VISIT': {
      const place = await resolvePlace(
        transaction,
        input.ownerUserId,
        input.command.place,
      );
      await insertNode(transaction, {
        tripId: input.tripId,
        kind: 'PLACE_VISIT',
        localDate: input.command.localDate,
        position: input.command.position,
        placeId: place.id,
        note: input.command.note,
      });
      await archiveNonAdjacentTransports(
        transaction,
        input.tripId,
        'ADJACENCY_CHANGED',
      );
      return;
    }
    case 'ADD_FREE_ACTION':
      await insertNode(transaction, {
        tripId: input.tripId,
        kind: 'FREE_ACTION',
        localDate: input.command.localDate,
        position: input.command.position,
        placeId: null,
        note: input.command.note,
      });
      await archiveNonAdjacentTransports(
        transaction,
        input.tripId,
        'ADJACENCY_CHANGED',
      );
      return;
    case 'DELETE_NODE': {
      const node = await requireTripNode(
        transaction,
        input.tripId,
        input.command.nodeId,
      );
      await archiveEndpointTransports(
        transaction,
        input.tripId,
        node.id,
        'NODE_DELETED',
      );
      await transaction.itineraryNode.delete({ where: { id: node.id } });
      const remaining = await orderedNodeIds(
        transaction,
        input.tripId,
        node.localDate,
      );
      await rewritePositions(
        transaction,
        input.tripId,
        node.localDate,
        remaining,
      );
      await archiveNonAdjacentTransports(
        transaction,
        input.tripId,
        'ADJACENCY_CHANGED',
      );
      return;
    }
    case 'MOVE_NODE_WITHIN_DAY': {
      const node = await requireTripNode(
        transaction,
        input.tripId,
        input.command.nodeId,
      );
      const ordered = await orderedNodeIds(
        transaction,
        input.tripId,
        node.localDate,
      );
      if (input.command.position >= ordered.length) {
        throw new TripTransactionAbort('INVALID_POSITION');
      }
      const withoutNode = ordered.filter((id) => id !== node.id);
      withoutNode.splice(input.command.position, 0, node.id);
      await rewritePositions(
        transaction,
        input.tripId,
        node.localDate,
        withoutNode,
      );
      await archiveNonAdjacentTransports(
        transaction,
        input.tripId,
        'ADJACENCY_CHANGED',
      );
      return;
    }
    case 'REPLACE_PLACE': {
      const node = await requireTripNode(
        transaction,
        input.tripId,
        input.command.nodeId,
      );
      if (node.kind !== 'PLACE_VISIT') {
        throw new TripTransactionAbort('INVALID_COMMAND');
      }
      await archiveEndpointTransports(
        transaction,
        input.tripId,
        node.id,
        'ENDPOINT_REPLACED',
      );
      const place = await resolvePlace(
        transaction,
        input.ownerUserId,
        input.command.place,
      );
      await transaction.itineraryNode.update({
        where: { id: node.id },
        data: { placeId: place.id, note: null },
      });
      return;
    }
    case 'SET_MANUAL_TRANSPORT':
      await setManualTransport(transaction, input.tripId, input.command);
      return;
    case 'CLEAR_TRANSPORT':
      await clearTransport(
        transaction,
        input.tripId,
        input.command.transportEdgeId,
      );
      return;
  }
}

async function setManualTransport(
  transaction: Transaction,
  tripId: string,
  command: Extract<
    RepositoryTripCommand,
    { readonly type: 'SET_MANUAL_TRANSPORT' }
  >,
): Promise<void> {
  const timeline = await transaction.itineraryNode.findMany({
    where: { tripId },
    select: { id: true, kind: true },
    orderBy: [{ localDate: 'asc' }, { position: 'asc' }, { id: 'asc' }],
  });
  const fromIndex = timeline.findIndex(
    (node) => node.id === command.fromNodeId,
  );
  const toIndex = timeline.findIndex((node) => node.id === command.toNodeId);
  if (fromIndex < 0 || toIndex < 0) {
    throw new TripTransactionAbort('NOT_FOUND');
  }
  if (toIndex !== fromIndex + 1) {
    throw new TripTransactionAbort('NOT_ADJACENT');
  }
  const from = timeline[fromIndex];
  const to = timeline[toIndex];
  if (from?.kind !== 'PLACE_VISIT' || to?.kind !== 'PLACE_VISIT') {
    throw new TripTransactionAbort('TRANSPORT_NOT_APPLICABLE');
  }

  const existing = await transaction.transportEdge.findFirst({
    where: {
      tripId,
      fromNodeId: command.fromNodeId,
      toNodeId: command.toNodeId,
    },
    include: transportInclude,
  });
  if (existing !== null) {
    await archiveTransports(transaction, [existing], 'USER_REPLACED');
  }
  await transaction.transportEdge.create({
    data: {
      tripId,
      fromNodeId: command.fromNodeId,
      toNodeId: command.toNodeId,
      mode: command.mode,
      fixedService: command.fixedService,
      serviceLabel: command.serviceLabel,
      note: command.note,
      source: 'MANUAL',
    },
  });
}

async function clearTransport(
  transaction: Transaction,
  tripId: string,
  transportEdgeId: string,
): Promise<void> {
  const edge = await transaction.transportEdge.findFirst({
    where: { id: transportEdgeId, tripId },
    include: transportInclude,
  });
  if (edge === null) {
    throw new TripTransactionAbort('NOT_FOUND');
  }
  await archiveTransports(transaction, [edge], 'USER_CLEARED');
}

async function archiveEndpointTransports(
  transaction: Transaction,
  tripId: string,
  nodeId: string,
  reason: TransportInvalidationReason,
): Promise<void> {
  const edges = await transaction.transportEdge.findMany({
    where: {
      tripId,
      OR: [{ fromNodeId: nodeId }, { toNodeId: nodeId }],
    },
    include: transportInclude,
  });
  await archiveTransports(transaction, edges, reason);
}

async function archiveNonAdjacentTransports(
  transaction: Transaction,
  tripId: string,
  reason: TransportInvalidationReason,
): Promise<void> {
  const timeline = await transaction.itineraryNode.findMany({
    where: { tripId },
    select: { id: true },
    orderBy: [{ localDate: 'asc' }, { position: 'asc' }, { id: 'asc' }],
  });
  const adjacency = new Set<string>();
  for (let index = 0; index + 1 < timeline.length; index += 1) {
    const from = timeline[index];
    const to = timeline[index + 1];
    if (from !== undefined && to !== undefined) {
      adjacency.add(adjacencyKey(from.id, to.id));
    }
  }
  const current = await transaction.transportEdge.findMany({
    where: { tripId },
    include: transportInclude,
  });
  await archiveTransports(
    transaction,
    current.filter(
      (edge) => !adjacency.has(adjacencyKey(edge.fromNodeId, edge.toNodeId)),
    ),
    reason,
  );
}

async function archiveTransports(
  transaction: Transaction,
  edges: readonly TransportWithTimes[],
  reason: TransportInvalidationReason,
): Promise<void> {
  const invalidatedAt = new Date();
  for (const edge of edges) {
    await transaction.transportEdgeHistory.create({
      data: {
        originalTransportEdgeId: edge.id,
        tripId: edge.tripId,
        originalFromNodeId: edge.fromNodeId,
        originalToNodeId: edge.toNodeId,
        mode: edge.mode,
        fixedService: edge.fixedService,
        serviceLabel: edge.serviceLabel,
        note: edge.note,
        source: edge.source,
        originalCreatedAt: edge.createdAt,
        invalidatedAt,
        invalidationReason: reason,
        temporalValues: {
          create: edge.temporalValues.map((value) => ({
            layer: value.layer,
            pointKind: value.pointKind,
            instant: value.instant,
            timeZone: value.timeZone,
            sourceKind: value.sourceKind,
            sourceRef: value.sourceRef,
            observedAt: value.observedAt,
            originalCreatedAt: value.createdAt,
            originalUpdatedAt: value.updatedAt,
          })),
        },
      },
    });
    await transaction.transportEdge.delete({ where: { id: edge.id } });
  }
}

async function upsertTemporalValue(
  transaction: Transaction,
  input: {
    readonly tripId: string;
    readonly subject: RepositoryTemporalSubject;
    readonly value: RepositoryTemporalValueInput;
  },
): Promise<void> {
  const data = {
    layer: input.value.layer,
    pointKind: input.value.pointKind,
    instant: input.value.instant,
    timeZone: input.value.timeZone,
    sourceKind: input.value.sourceKind,
    sourceRef: input.value.sourceRef,
    observedAt: input.value.observedAt,
  };
  if (input.subject.type === 'NODE') {
    const node = await transaction.itineraryNode.findFirst({
      where: { id: input.subject.nodeId, tripId: input.tripId },
      select: { id: true },
    });
    if (node === null) {
      throw new TripTransactionAbort('NOT_FOUND');
    }
    await transaction.temporalValue.upsert({
      where: {
        nodeId_pointKind_layer: {
          nodeId: node.id,
          pointKind: input.value.pointKind,
          layer: input.value.layer,
        },
      },
      create: { nodeId: node.id, ...data },
      update: data,
    });
    return;
  }
  const edge = await transaction.transportEdge.findFirst({
    where: { id: input.subject.transportEdgeId, tripId: input.tripId },
    select: { id: true },
  });
  if (edge === null) {
    throw new TripTransactionAbort('NOT_FOUND');
  }
  await transaction.temporalValue.upsert({
    where: {
      transportEdgeId_pointKind_layer: {
        transportEdgeId: edge.id,
        pointKind: input.value.pointKind,
        layer: input.value.layer,
      },
    },
    create: { transportEdgeId: edge.id, ...data },
    update: data,
  });
}

function adjacencyKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}:${toNodeId}`;
}

async function insertNode(
  transaction: Transaction,
  input: {
    readonly tripId: string;
    readonly kind: 'PLACE_VISIT' | 'FREE_ACTION';
    readonly localDate: Date;
    readonly position: number;
    readonly placeId: string | null;
    readonly note: string | null;
  },
): Promise<void> {
  const existing = await transaction.itineraryNode.findMany({
    where: { tripId: input.tripId, localDate: input.localDate },
    select: { id: true, position: true },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  });
  if (input.position > existing.length) {
    throw new TripTransactionAbort('INVALID_POSITION');
  }
  const temporaryPosition =
    Math.max(-1, ...existing.map((node) => node.position)) + 1;
  const created = await transaction.itineraryNode.create({
    data: {
      tripId: input.tripId,
      kind: input.kind,
      localDate: input.localDate,
      position: temporaryPosition,
      placeId: input.placeId,
      note: input.note,
      source: 'USER_PLANNED',
    },
    select: { id: true },
  });
  const ordered = existing.map((node) => node.id);
  ordered.splice(input.position, 0, created.id);
  await rewritePositions(transaction, input.tripId, input.localDate, ordered);
}

async function rewritePositions(
  transaction: Transaction,
  tripId: string,
  localDate: Date,
  orderedIds: readonly string[],
): Promise<void> {
  if (orderedIds.length === 0) {
    return;
  }
  const offset = orderedIds.length * 2 + 1;
  await transaction.$executeRaw(Prisma.sql`
    UPDATE "ItineraryNode"
    SET "position" = "position" + ${offset}
    WHERE "tripId" = ${tripId}::uuid
      AND "localDate" = ${localDate}::date
  `);
  for (const [position, id] of orderedIds.entries()) {
    await transaction.itineraryNode.update({
      where: { id },
      data: { position },
    });
  }
}

async function orderedNodeIds(
  transaction: Transaction,
  tripId: string,
  localDate: Date,
): Promise<string[]> {
  return (
    await transaction.itineraryNode.findMany({
      where: { tripId, localDate },
      select: { id: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })
  ).map((node) => node.id);
}

async function requireTripNode(
  transaction: Transaction,
  tripId: string,
  nodeId: string,
) {
  const node = await transaction.itineraryNode.findFirst({
    where: { id: nodeId, tripId },
    select: { id: true, kind: true, localDate: true },
  });
  if (node === null) {
    throw new TripTransactionAbort('NOT_FOUND');
  }
  return node;
}

async function resolvePlace(
  transaction: Transaction,
  ownerUserId: string,
  input: RepositoryPlaceInput,
): Promise<PlaceRecord> {
  if (input.type === 'EXISTING') {
    const place = await transaction.place.findFirst({
      where: { id: input.placeId, ownerUserId },
    });
    if (place === null) {
      throw new TripTransactionAbort('NOT_FOUND');
    }
    return toPlaceRecord(place);
  }
  return toPlaceRecord(
    await transaction.place.create({
      data: {
        ownerUserId,
        name: input.name,
        latitude: input.latitude,
        longitude: input.longitude,
        address: input.address,
      },
    }),
  );
}

async function reconcileDateOwnership(
  transaction: Transaction,
  input: { readonly ownerUserId: string; readonly tripId: string },
): Promise<{ readonly minimum: Date; readonly maximum: Date } | null> {
  const rows = await transaction.$queryRaw<DateBoundsRow[]>(Prisma.sql`
    SELECT MIN("localDate") AS minimum, MAX("localDate") AS maximum
    FROM "ItineraryNode"
    WHERE "tripId" = ${input.tripId}::uuid
  `);
  const minimum = rows[0]?.minimum ?? null;
  const maximum = rows[0]?.maximum ?? null;
  if (minimum === null || maximum === null) {
    await transaction.dateOwnership.deleteMany({
      where: { tripId: input.tripId },
    });
    return null;
  }

  const conflict = await transaction.dateOwnership.findFirst({
    where: {
      ownerUserId: input.ownerUserId,
      localDate: { gte: minimum, lte: maximum },
      NOT: { tripId: input.tripId },
    },
    select: { tripId: true },
  });
  if (conflict !== null) {
    throw new TripTransactionAbort('DATE_OWNED');
  }

  await transaction.dateOwnership.deleteMany({
    where: {
      tripId: input.tripId,
      OR: [{ localDate: { lt: minimum } }, { localDate: { gt: maximum } }],
    },
  });
  await transaction.$executeRaw(Prisma.sql`
    INSERT INTO "DateOwnership" ("ownerUserId", "localDate", "tripId")
    SELECT ${input.ownerUserId}::uuid, day::date, ${input.tripId}::uuid
    FROM generate_series(${minimum}::date, ${maximum}::date, interval '1 day') AS day
    ON CONFLICT ("ownerUserId", "localDate") DO NOTHING
  `);
  const expectedDays = utcDayDifference(minimum, maximum) + 1;
  const actualDays = await transaction.dateOwnership.count({
    where: {
      tripId: input.tripId,
      localDate: { gte: minimum, lte: maximum },
    },
  });
  if (actualDays !== expectedDays) {
    throw new TripTransactionAbort('DATE_OWNED');
  }
  return { minimum, maximum };
}

async function loadTrip(
  transaction: Transaction,
  tripId: string,
  ownerUserId: string,
): Promise<TripWithProjectionData> {
  const trip = await transaction.trip.findFirst({
    where: { id: tripId, ownerUserId },
    include: tripInclude,
  });
  if (trip === null) {
    throw new TripTransactionAbort('NOT_FOUND');
  }
  return trip;
}

function toTripRecord(trip: TripWithProjectionData): TripAggregateRecord {
  return {
    id: trip.id,
    ownerUserId: trip.ownerUserId,
    name: trip.name,
    planningAnchorDate: trip.planningAnchorDate,
    defaultPeopleCount: trip.defaultPeopleCount,
    version: trip.version,
    effectiveStartDate: trip.effectiveStartDate,
    effectiveEndDate: trip.effectiveEndDate,
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
    ownedDates: trip.dateOwnerships.map((ownership) => ownership.localDate),
    nodes: trip.nodes.map((node) => ({
      id: node.id,
      tripId: node.tripId,
      kind: node.kind,
      localDate: node.localDate,
      position: node.position,
      place: node.place === null ? null : toPlaceRecord(node.place),
      note: node.note,
      source: node.source,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      timeValues: node.temporalValues.map(toTemporalValueRecord),
    })),
    transportEdges: trip.transportEdges.map(toTransportEdgeRecord),
  };
}

function toTransportEdgeRecord(edge: TransportWithTimes): TransportEdgeRecord {
  return {
    id: edge.id,
    tripId: edge.tripId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    mode: edge.mode,
    fixedService: edge.fixedService,
    serviceLabel: edge.serviceLabel,
    note: edge.note,
    source: edge.source,
    createdAt: edge.createdAt,
    updatedAt: edge.updatedAt,
    timeValues: edge.temporalValues.map(toTemporalValueRecord),
  };
}

function toTransportHistoryRecord(
  record: HistoryWithTimes,
): TransportHistoryRecord {
  return {
    id: record.id,
    originalTransportEdgeId: record.originalTransportEdgeId,
    tripId: record.tripId,
    originalFromNodeId: record.originalFromNodeId,
    originalToNodeId: record.originalToNodeId,
    mode: record.mode,
    fixedService: record.fixedService,
    serviceLabel: record.serviceLabel,
    note: record.note,
    source: record.source,
    originalCreatedAt: record.originalCreatedAt,
    invalidatedAt: record.invalidatedAt,
    invalidationReason: record.invalidationReason,
    timeValues: record.temporalValues.map((value) => ({
      id: value.id,
      layer: value.layer,
      pointKind: value.pointKind,
      instant: value.instant,
      timeZone: value.timeZone,
      sourceKind: value.sourceKind,
      sourceRef: value.sourceRef,
      observedAt: value.observedAt,
      createdAt: value.originalCreatedAt,
      updatedAt: value.originalUpdatedAt,
    })),
  };
}

function toTemporalValueRecord(value: {
  readonly id: string;
  readonly layer: TemporalValueRecord['layer'];
  readonly pointKind: TemporalValueRecord['pointKind'];
  readonly instant: Date;
  readonly timeZone: string;
  readonly sourceKind: TemporalValueRecord['sourceKind'];
  readonly sourceRef: string | null;
  readonly observedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): TemporalValueRecord {
  return value;
}

function toPlaceRecord(place: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly latitude: Prisma.Decimal;
  readonly longitude: Prisma.Decimal;
  readonly address: string | null;
  readonly createdAt: Date;
}): PlaceRecord {
  return {
    ...place,
    latitude: Number(place.latitude.toString()),
    longitude: Number(place.longitude.toString()),
  };
}

function utcDayDifference(minimum: Date, maximum: Date): number {
  return Math.round((maximum.getTime() - minimum.getTime()) / 86_400_000);
}

function failureResult(error: unknown): TripMutationResult {
  if (error instanceof TripTransactionAbort) {
    return { status: error.status };
  }
  throw error;
}

function isDateOwnershipConflict(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }
  const modelName = error.meta?.modelName;
  const target = error.meta?.target;
  return (
    modelName === 'DateOwnership' ||
    (Array.isArray(target) &&
      target.includes('ownerUserId') &&
      target.includes('localDate')) ||
    String(target).includes('DateOwnership')
  );
}

class TripTransactionAbort extends Error {
  constructor(readonly status: FailureStatus) {
    super(status);
    this.name = 'TripTransactionAbort';
  }
}
