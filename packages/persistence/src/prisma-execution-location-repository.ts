import type {
  CommitExecutionResult,
  ExecutionContextRecord,
  ExecutionEventRecord,
  ExecutionLocationRepository,
  TemporalValueRecord,
} from '@travel/application';
import type { ExecutionDerivedLocationState } from '@travel/domain';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;

interface LockedTripRow {
  readonly id: string;
  readonly version: number;
}

interface AdvisoryLockRow {
  readonly locked: boolean;
}

interface LockedAirportTriggerRow {
  readonly id: string;
  readonly undoneAt: Date | null;
  readonly airportTriggerClaimedAt: Date | null;
  readonly airportTriggerCompletedAt: Date | null;
}

export class PrismaExecutionLocationRepository implements ExecutionLocationRepository {
  constructor(private readonly client: PrismaClient) {}

  async findOwnedContext(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<ExecutionContextRecord | null> {
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: {
        id: true,
        ownerUserId: true,
        version: true,
        executionLocationState: true,
        dayOccurrences: {
          orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
          select: {
            sequence: true,
            nodes: {
              orderBy: [{ position: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                position: true,
                providerHubRef: true,
                place: { select: { latitude: true, longitude: true } },
                temporalValues: {
                  where: { layer: 'ACTUAL' },
                  orderBy: [{ pointKind: 'asc' }, { id: 'asc' }],
                },
                executionState: true,
              },
            },
          },
        },
        flightBindings: {
          select: {
            id: true,
            latestSnapshot: true,
            transportEdge: { select: { fromNodeId: true } },
          },
        },
        executionEvents: {
          where: {
            type: 'ARRIVAL',
            undoneAt: null,
            airportTriggerCompletedAt: null,
          },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (trip === null) return null;
    const nodes = trip.dayOccurrences.flatMap((occurrence) =>
      occurrence.nodes.map((node) => ({
        id: node.id,
        sequence: occurrence.sequence,
        position: node.position,
        latitude: node.place === null ? null : Number(node.place.latitude),
        longitude: node.place === null ? null : Number(node.place.longitude),
        providerHubRef: node.providerHubRef,
        actualArrival: toTemporal(
          node.temporalValues.find((value) => value.pointKind === 'ARRIVAL'),
        ),
        actualDeparture: toTemporal(
          node.temporalValues.find((value) => value.pointKind === 'DEPARTURE'),
        ),
        executionStatus: node.executionState?.status ?? null,
      })),
    );
    return {
      tripId: trip.id,
      ownerUserId: trip.ownerUserId,
      tripVersion: trip.version,
      nodes,
      locationState:
        trip.executionLocationState === null
          ? null
          : {
              currentNodeId: trip.executionLocationState.currentNodeId,
              targetNodeId: trip.executionLocationState.targetNodeId,
              lastObservedAt: trip.executionLocationState.lastObservedAt,
              lastDistanceToCurrentTargetMeters:
                trip.executionLocationState.lastDistanceToCurrentTargetMeters,
              lastDistanceToNextTargetMeters:
                trip.executionLocationState.lastDistanceToNextTargetMeters,
              outsideTargetConsecutiveCount:
                trip.executionLocationState.outsideTargetConsecutiveCount,
              locationStatus: trip.executionLocationState.locationStatus,
            },
      possibleSkippedNodeIds: nodes
        .filter((node) => node.executionStatus === 'POSSIBLY_SKIPPED')
        .map((node) => node.id),
      confirmedSkippedNodeIds: nodes
        .filter((node) => node.executionStatus === 'SKIPPED')
        .map((node) => node.id),
      flightDepartures: trip.flightBindings.flatMap((binding) => {
        const snapshot = binding.latestSnapshot as unknown as {
          readonly departure?: { readonly airportIata?: unknown };
        };
        const airportIata = snapshot.departure?.airportIata;
        return typeof airportIata === 'string' &&
          /^[A-Z]{3}$/u.test(airportIata)
          ? [
              {
                flightBindingId: binding.id,
                departureNodeId: binding.transportEdge.fromNodeId,
                airportIata,
              },
            ]
          : [];
      }),
      pendingAirportArrivalEvents: trip.executionEvents.map(toEventRecord),
    };
  }

  async findEventByIdempotencyKey(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }) {
    const event = await this.client.executionEvent.findFirst({
      where: {
        ownerUserId: input.ownerUserId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (event === null) return { status: 'NOT_FOUND' as const };
    if (
      event.tripId !== input.tripId ||
      event.requestHash !== input.requestHash
    ) {
      return { status: 'CONFLICT' as const };
    }
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: { version: true },
    });
    if (trip === null) return { status: 'NOT_FOUND' as const };
    return {
      status: 'MATCH' as const,
      event: toEventRecord(event),
      tripVersion: trip.version,
    };
  }

  async commitLocation(
    input: Parameters<ExecutionLocationRepository['commitLocation']>[0],
  ): Promise<CommitExecutionResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await lockOwnedTrip(
        transaction,
        input.ownerUserId,
        input.tripId,
      );
      if (trip === null) return { status: 'NOT_FOUND' as const };
      const currentState = await transaction.executionLocationState.findUnique({
        where: { tripId: input.tripId },
      });
      if (
        (currentState?.lastObservedAt.getTime() ?? null) !==
          (input.expectedLastObservedAt?.getTime() ?? null) ||
        trip.version !== input.expectedTripVersion
      ) {
        return { status: 'RETRY' as const };
      }

      let event: ExecutionEventRecord | null = null;
      let version = trip.version;
      if (
        input.decision.status === 'CONFIRMED_ARRIVAL' ||
        input.decision.status === 'CONFIRMED_DEPARTURE'
      ) {
        const type =
          input.decision.status === 'CONFIRMED_ARRIVAL'
            ? 'ARRIVAL'
            : 'DEPARTURE';
        const result = await createFactEvent(transaction, {
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
          nodeId: input.decision.nodeId,
          type,
          source: 'LOCATION',
          occurredAt: input.observedAt,
          idempotencyKey: null,
          requestHash: null,
          possiblySkippedNodeIds:
            input.decision.status === 'CONFIRMED_ARRIVAL'
              ? input.decision.possiblySkippedNodeIds
              : [],
        });
        if (result.status !== 'CREATED') {
          return result.status === 'FACT_PROTECTED'
            ? { status: 'FACT_PROTECTED' as const }
            : {
                status: 'SUCCESS' as const,
                event: toEventRecord(result.event),
                resultingTripVersion: trip.version,
                idempotentReplay: true,
              };
        }
        event = toEventRecord(result.event);
        version += 1;
        await transaction.trip.update({
          where: { id: input.tripId },
          data: { version: { increment: 1 } },
        });
      }
      await upsertLocationState(
        transaction,
        input.tripId,
        input.decision.state,
      );
      return {
        status: 'SUCCESS' as const,
        event,
        resultingTripVersion: version,
        idempotentReplay: false,
      };
    });
  }

  async commitManual(
    input: Parameters<ExecutionLocationRepository['commitManual']>[0],
  ): Promise<CommitExecutionResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const replay = await transaction.executionEvent.findFirst({
        where: {
          ownerUserId: input.ownerUserId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      const trip = await lockOwnedTrip(
        transaction,
        input.ownerUserId,
        input.tripId,
      );
      if (trip === null) return { status: 'NOT_FOUND' as const };
      if (replay !== null) {
        return replay.tripId === input.tripId &&
          replay.requestHash === input.requestHash
          ? {
              status: 'SUCCESS' as const,
              event: toEventRecord(replay),
              resultingTripVersion: trip.version,
              idempotentReplay: true,
            }
          : { status: 'IDEMPOTENCY_CONFLICT' as const };
      }
      const active = await transaction.executionEvent.findFirst({
        where: {
          tripId: input.tripId,
          nodeId: input.nodeId,
          type: input.type,
          undoneAt: null,
        },
      });
      if (active !== null) {
        return {
          status: 'SUCCESS' as const,
          event: toEventRecord(active),
          resultingTripVersion: trip.version,
          idempotentReplay: true,
        };
      }
      if (trip.version !== input.baseTripVersion) {
        return { status: 'VERSION_CONFLICT' as const };
      }
      const node = await transaction.itineraryNode.findFirst({
        where: { id: input.nodeId, tripId: input.tripId },
        select: { id: true },
      });
      if (node === null) return { status: 'NOT_FOUND' as const };
      const expectedNodeId =
        input.type === 'ARRIVAL'
          ? input.expectedTargetNodeId
          : input.type === 'DEPARTURE'
            ? input.expectedCurrentNodeId
            : input.nodeId;
      if (expectedNodeId !== input.nodeId) {
        return { status: 'INVALID_CONTEXT' as const };
      }
      if (input.type === 'SKIP_CONFIRMED') {
        const state = await transaction.nodeExecutionState.findUnique({
          where: { nodeId: input.nodeId },
        });
        if (
          state?.tripId !== input.tripId ||
          state.status !== 'POSSIBLY_SKIPPED'
        ) {
          return { status: 'INVALID_CONTEXT' as const };
        }
        const created = await transaction.executionEvent.create({
          data: {
            ownerUserId: input.ownerUserId,
            tripId: input.tripId,
            nodeId: input.nodeId,
            type: 'SKIP_CONFIRMED',
            source: 'MANUAL',
            occurredAt: input.occurredAt,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
          },
        });
        await transaction.nodeExecutionState.update({
          where: { nodeId: input.nodeId },
          data: { status: 'SKIPPED' },
        });
        await finishManualMutation(transaction, input.tripId);
        return {
          status: 'SUCCESS' as const,
          event: toEventRecord(created),
          resultingTripVersion: trip.version + 1,
          idempotentReplay: false,
        };
      }
      const result = await createFactEvent(transaction, {
        ownerUserId: input.ownerUserId,
        tripId: input.tripId,
        nodeId: input.nodeId,
        type: input.type,
        source: 'MANUAL',
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        possiblySkippedNodeIds: [],
      });
      if (result.status === 'FACT_PROTECTED') {
        return { status: 'FACT_PROTECTED' as const };
      }
      if (result.status === 'EXISTING') {
        return {
          status: 'SUCCESS' as const,
          event: toEventRecord(result.event),
          resultingTripVersion: trip.version,
          idempotentReplay: true,
        };
      }
      await finishManualMutation(transaction, input.tripId);
      return {
        status: 'SUCCESS' as const,
        event: toEventRecord(result.event),
        resultingTripVersion: trip.version + 1,
        idempotentReplay: false,
      };
    });
  }

  async undoEvent(
    input: Parameters<ExecutionLocationRepository['undoEvent']>[0],
  ): Promise<CommitExecutionResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await lockOwnedTrip(
        transaction,
        input.ownerUserId,
        input.tripId,
      );
      if (trip === null) return { status: 'NOT_FOUND' as const };
      const event = await transaction.executionEvent.findFirst({
        where: {
          id: input.eventId,
          ownerUserId: input.ownerUserId,
          tripId: input.tripId,
        },
      });
      if (event === null) return { status: 'NOT_FOUND' as const };
      if (event.undoneAt !== null) {
        if (
          event.undoIdempotencyKey === input.idempotencyKey &&
          event.undoRequestHash === input.requestHash
        ) {
          return {
            status: 'SUCCESS' as const,
            event: toEventRecord(event),
            resultingTripVersion: trip.version,
            idempotentReplay: true,
          };
        }
        return event.undoIdempotencyKey === input.idempotencyKey
          ? { status: 'IDEMPOTENCY_CONFLICT' as const }
          : { status: 'UNDO_CONFLICT' as const };
      }
      if (trip.version !== input.baseTripVersion) {
        return { status: 'VERSION_CONFLICT' as const };
      }
      if (event.type === 'SKIP_CONFIRMED') {
        const state = await transaction.nodeExecutionState.findUnique({
          where: { nodeId: event.nodeId },
        });
        if (state?.status !== 'SKIPPED') {
          return { status: 'UNDO_CONFLICT' as const };
        }
        await transaction.nodeExecutionState.update({
          where: { nodeId: event.nodeId },
          data: { status: 'POSSIBLY_SKIPPED' },
        });
      } else {
        const pointKind = event.type === 'ARRIVAL' ? 'ARRIVAL' : 'DEPARTURE';
        const value = await transaction.temporalValue.findFirst({
          where: { nodeId: event.nodeId, pointKind, layer: 'ACTUAL' },
        });
        if (
          value === null ||
          value.sourceRef !== `execution-event:${event.id}` ||
          (value.sourceKind !== 'EXECUTION_OBSERVATION' &&
            value.sourceKind !== 'USER_VALUE')
        ) {
          return { status: 'FACT_PROTECTED' as const };
        }
        await transaction.temporalValue.delete({ where: { id: value.id } });
        if (event.type === 'ARRIVAL') {
          await transaction.nodeExecutionState.deleteMany({
            where: {
              detectedByEventId: event.id,
              status: 'POSSIBLY_SKIPPED',
            },
          });
        }
      }
      const undone = await transaction.executionEvent.update({
        where: { id: event.id },
        data: {
          undoneAt: input.now,
          undoIdempotencyKey: input.idempotencyKey,
          undoRequestHash: input.requestHash,
          airportTriggerClaimedAt: null,
          airportTriggerClaimToken: null,
        },
      });
      await transaction.executionLocationState.deleteMany({
        where: { tripId: input.tripId },
      });
      await transaction.trip.update({
        where: { id: input.tripId },
        data: { version: { increment: 1 } },
      });
      return {
        status: 'SUCCESS' as const,
        event: toEventRecord(undone),
        resultingTripVersion: trip.version + 1,
        idempotentReplay: false,
      };
    });
  }

  async claimAirportTrigger(
    input: Parameters<ExecutionLocationRepository['claimAirportTrigger']>[0],
  ) {
    return this.client.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<LockedAirportTriggerRow[]>(
        Prisma.sql`
          SELECT
            "id",
            "undoneAt",
            "airportTriggerClaimedAt",
            "airportTriggerCompletedAt"
          FROM "ExecutionEvent"
          WHERE "id" = ${input.eventId}::uuid
            AND "ownerUserId" = ${input.ownerUserId}::uuid
            AND "tripId" = ${input.tripId}::uuid
            AND "type" = 'ARRIVAL'
          FOR UPDATE
        `,
      );
      const event = rows[0];
      if (event === undefined || event.undoneAt !== null) {
        return { status: 'NOT_ELIGIBLE' as const };
      }
      if (event.airportTriggerCompletedAt !== null) {
        return { status: 'COMPLETED' as const };
      }
      if (
        event.airportTriggerClaimedAt !== null &&
        event.airportTriggerClaimedAt.getTime() > input.expiredBefore.getTime()
      ) {
        return { status: 'BUSY' as const };
      }
      await transaction.executionEvent.update({
        where: { id: event.id },
        data: {
          airportTriggerClaimedAt: input.claimedAt,
          airportTriggerClaimToken: input.claimToken,
        },
      });
      return { status: 'CLAIMED' as const, claimToken: input.claimToken };
    });
  }

  async completeAirportTrigger(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly eventId: string;
    readonly claimToken: string;
    readonly completedAt: Date;
  }): Promise<boolean> {
    const result = await this.client.executionEvent.updateMany({
      where: {
        id: input.eventId,
        ownerUserId: input.ownerUserId,
        tripId: input.tripId,
        type: 'ARRIVAL',
        undoneAt: null,
        airportTriggerCompletedAt: null,
        airportTriggerClaimToken: input.claimToken,
      },
      data: {
        airportTriggerClaimedAt: null,
        airportTriggerClaimToken: null,
        airportTriggerCompletedAt: input.completedAt,
      },
    });
    return result.count === 1;
  }

  async releaseAirportTriggerClaim(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly eventId: string;
    readonly claimToken: string;
  }): Promise<void> {
    await this.client.executionEvent.updateMany({
      where: {
        id: input.eventId,
        ownerUserId: input.ownerUserId,
        tripId: input.tripId,
        type: 'ARRIVAL',
        undoneAt: null,
        airportTriggerCompletedAt: null,
        airportTriggerClaimToken: input.claimToken,
      },
      data: {
        airportTriggerClaimedAt: null,
        airportTriggerClaimToken: null,
      },
    });
  }
}

async function createFactEvent(
  transaction: Transaction,
  input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly nodeId: string;
    readonly type: 'ARRIVAL' | 'DEPARTURE';
    readonly source: 'LOCATION' | 'MANUAL';
    readonly occurredAt: Date;
    readonly idempotencyKey: string | null;
    readonly requestHash: string | null;
    readonly possiblySkippedNodeIds: readonly string[];
  },
) {
  const node = await transaction.itineraryNode.findFirst({
    where: { id: input.nodeId, tripId: input.tripId },
    select: { id: true },
  });
  if (node === null) return { status: 'FACT_PROTECTED' as const };
  const existingEvent = await transaction.executionEvent.findFirst({
    where: {
      tripId: input.tripId,
      nodeId: input.nodeId,
      type: input.type,
      undoneAt: null,
    },
  });
  if (existingEvent !== null) {
    return { status: 'EXISTING' as const, event: existingEvent };
  }
  const pointKind = input.type === 'ARRIVAL' ? 'ARRIVAL' : 'DEPARTURE';
  const existingFact = await transaction.temporalValue.findFirst({
    where: { nodeId: input.nodeId, pointKind, layer: 'ACTUAL' },
  });
  if (existingFact !== null) {
    return { status: 'FACT_PROTECTED' as const };
  }
  const event = await transaction.executionEvent.create({
    data: {
      ownerUserId: input.ownerUserId,
      tripId: input.tripId,
      nodeId: input.nodeId,
      type: input.type,
      source: input.source,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    },
  });
  await transaction.temporalValue.create({
    data: {
      nodeId: input.nodeId,
      layer: 'ACTUAL',
      pointKind,
      instant: input.occurredAt,
      timeZone: 'UTC',
      sourceKind:
        input.source === 'LOCATION' ? 'EXECUTION_OBSERVATION' : 'USER_VALUE',
      sourceRef: `execution-event:${event.id}`,
      observedAt: input.occurredAt,
    },
  });
  for (const nodeId of input.possiblySkippedNodeIds) {
    await transaction.nodeExecutionState.upsert({
      where: { nodeId },
      create: {
        nodeId,
        tripId: input.tripId,
        status: 'POSSIBLY_SKIPPED',
        detectedByEventId: event.id,
      },
      update: {
        status: 'POSSIBLY_SKIPPED',
        detectedByEventId: event.id,
      },
    });
  }
  return { status: 'CREATED' as const, event };
}

async function finishManualMutation(
  transaction: Transaction,
  tripId: string,
): Promise<void> {
  await transaction.executionLocationState.deleteMany({ where: { tripId } });
  await transaction.trip.update({
    where: { id: tripId },
    data: { version: { increment: 1 } },
  });
}

async function upsertLocationState(
  transaction: Transaction,
  tripId: string,
  state: ExecutionDerivedLocationState,
): Promise<void> {
  const data = {
    currentNodeId: state.currentNodeId,
    targetNodeId: state.targetNodeId,
    lastObservedAt: state.lastObservedAt,
    lastDistanceToCurrentTargetMeters: state.lastDistanceToCurrentTargetMeters,
    lastDistanceToNextTargetMeters: state.lastDistanceToNextTargetMeters,
    outsideTargetConsecutiveCount: state.outsideTargetConsecutiveCount,
    locationStatus: state.locationStatus,
  };
  await transaction.executionLocationState.upsert({
    where: { tripId },
    create: { tripId, ...data },
    update: data,
  });
}

async function lockOwner(
  transaction: Transaction,
  ownerUserId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<AdvisoryLockRow[]>(Prisma.sql`
    SELECT TRUE AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 2))
  `);
  if (rows[0]?.locked !== true) throw new Error('Owner lock failed');
}

async function lockOwnedTrip(
  transaction: Transaction,
  ownerUserId: string,
  tripId: string,
): Promise<LockedTripRow | null> {
  const rows = await transaction.$queryRaw<LockedTripRow[]>(Prisma.sql`
    SELECT "id", "version"
    FROM "Trip"
    WHERE "id" = ${tripId}::uuid
      AND "ownerUserId" = ${ownerUserId}::uuid
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

function toEventRecord(event: {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly nodeId: string;
  readonly type: 'ARRIVAL' | 'DEPARTURE' | 'SKIP_CONFIRMED';
  readonly source: 'LOCATION' | 'MANUAL';
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly undoneAt: Date | null;
  readonly airportTriggerCompletedAt: Date | null;
}): ExecutionEventRecord {
  return event;
}

function toTemporal(
  value:
    | {
        readonly id: string;
        readonly layer: 'PLANNED' | 'ESTIMATED' | 'ACTUAL';
        readonly pointKind: 'ARRIVAL' | 'DEPARTURE';
        readonly instant: Date;
        readonly timeZone: string;
        readonly sourceKind:
          | 'USER_VALUE'
          | 'ADOPTED_TRANSPORT_FACT'
          | 'SYSTEM_SUGGESTION'
          | 'DERIVED'
          | 'PROVIDER_OBSERVATION'
          | 'EXECUTION_OBSERVATION';
        readonly sourceRef: string | null;
        readonly observedAt: Date | null;
        readonly createdAt: Date;
        readonly updatedAt: Date;
      }
    | undefined,
): TemporalValueRecord | null {
  return value ?? null;
}
