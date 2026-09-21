import type {
  AssistanceCapabilityRecord,
  AssistanceCapabilityRepository,
  AssistanceMutationRepositoryResult,
} from '@travel/application';
import type {
  AssistanceAction,
  AssistanceState,
  AssistanceStopReason,
  TripAssistanceKind,
} from '@travel/contracts';
import { decideAssistanceTransition } from '@travel/domain';

import {
  Prisma,
  type FlightMonitoringCapability,
  type PrismaClient,
  type TripAssistanceCapability,
} from './generated/prisma/client.js';

type Transaction = Prisma.TransactionClient;

export class PrismaAssistanceCapabilityRepository implements AssistanceCapabilityRepository {
  constructor(private readonly client: PrismaClient) {}

  async getTripCapabilities(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<readonly AssistanceCapabilityRecord[] | null> {
    const trip = await this.client.trip.findFirst({
      where: { id: input.tripId, ownerUserId: input.ownerUserId },
      select: { id: true, assistanceCapabilities: true },
    });
    if (trip === null) return null;
    return (['LOCATION_ASSISTANCE', 'AUTO_RECORD'] as const).map((kind) => {
      const capability = trip.assistanceCapabilities.find(
        (candidate) => candidate.kind === kind,
      );
      return capability === undefined
        ? absentTripCapability(input.tripId, kind)
        : toTripRecord(capability);
    });
  }

  async mutateTripCapability(
    input: Parameters<
      AssistanceCapabilityRepository['mutateTripCapability']
    >[0],
  ): Promise<AssistanceMutationRepositoryResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const trip = await lockOwnedTrip(
        transaction,
        input.ownerUserId,
        input.tripId,
      );
      if (trip === null) return { status: 'NOT_FOUND' as const };
      const replay = await transaction.tripAssistanceReceipt.findFirst({
        where: {
          ownerUserId: input.ownerUserId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (replay !== null) {
        return replay.requestHash === input.requestHash
          ? {
              status: 'SUCCESS' as const,
              capability: parsePayload(replay.resultPayload),
              idempotentReplay: true,
            }
          : { status: 'IDEMPOTENCY_CONFLICT' as const };
      }
      const current = await transaction.tripAssistanceCapability.findUnique({
        where: { tripId_kind: { tripId: input.tripId, kind: input.kind } },
      });
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.baseRevision) {
        return { status: 'REVISION_CONFLICT' as const };
      }
      const decision = decideAssistanceTransition(
        current?.state ?? 'NOT_ENABLED',
        input.action,
      );
      if (decision.status === 'CONFLICT') {
        return { status: 'TRANSITION_CONFLICT' as const };
      }
      const capability =
        decision.status === 'NO_CHANGE'
          ? current
          : await transaction.tripAssistanceCapability.upsert({
              where: {
                tripId_kind: { tripId: input.tripId, kind: input.kind },
              },
              create: {
                ownerUserId: input.ownerUserId,
                tripId: input.tripId,
                kind: input.kind,
                state: decision.state,
                revision: 1,
                ...transitionTimes(input.action, input.now),
                stopReason: decision.stopReason,
              },
              update: {
                state: decision.state,
                revision: { increment: 1 },
                ...transitionTimes(input.action, input.now),
                stopReason: decision.stopReason,
              },
            });
      if (capability === null) {
        throw new Error(
          'NOT_ENABLED capability cannot be a no-change mutation',
        );
      }
      if (
        input.kind === 'LOCATION_ASSISTANCE' &&
        decision.status === 'APPLY' &&
        (decision.state === 'PAUSED' || decision.state === 'STOPPED')
      ) {
        await transaction.executionLocationState.deleteMany({
          where: { tripId: input.tripId },
        });
      }
      const record = toTripRecord(capability);
      await transaction.tripAssistanceReceipt.create({
        data: {
          ownerUserId: input.ownerUserId,
          capabilityId: capability.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          action: input.action,
          baseRevision: input.baseRevision,
          resultingRevision: capability.revision,
          resultingState: capability.state,
          resultingStopReason: capability.stopReason,
          resultPayload: payload(record),
        },
      });
      return {
        status: 'SUCCESS' as const,
        capability: record,
        idempotentReplay: false,
      };
    });
  }

  async getFlightCapability(
    input: Parameters<AssistanceCapabilityRepository['getFlightCapability']>[0],
  ) {
    const binding = await this.client.flightBinding.findFirst({
      where: {
        id: input.flightBindingId,
        tripId: input.tripId,
        ownerUserId: input.ownerUserId,
      },
      include: { monitoringCapability: true },
    });
    if (binding === null) return null;
    const snapshot = binding.latestSnapshot as unknown as {
      readonly departure?: { readonly scheduledUtc?: unknown };
    };
    const value = snapshot.departure?.scheduledUtc;
    return {
      capability:
        binding.monitoringCapability === null
          ? absentFlightCapability(binding.id)
          : toFlightRecord(binding.monitoringCapability),
      scheduledDepartureAt:
        typeof value === 'string' && !Number.isNaN(new Date(value).getTime())
          ? new Date(value)
          : null,
      flightStatus: binding.status,
    };
  }

  async mutateFlightCapability(
    input: Parameters<
      AssistanceCapabilityRepository['mutateFlightCapability']
    >[0],
  ): Promise<AssistanceMutationRepositoryResult> {
    return this.client.$transaction(async (transaction) => {
      await lockOwner(transaction, input.ownerUserId);
      const binding = await lockOwnedBinding(transaction, input);
      if (binding === null) return { status: 'NOT_FOUND' as const };
      const replay = await transaction.flightAssistanceReceipt.findFirst({
        where: {
          ownerUserId: input.ownerUserId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (replay !== null) {
        return replay.requestHash === input.requestHash
          ? {
              status: 'SUCCESS' as const,
              capability: parsePayload(replay.resultPayload),
              idempotentReplay: true,
            }
          : { status: 'IDEMPOTENCY_CONFLICT' as const };
      }
      const current = await transaction.flightMonitoringCapability.findUnique({
        where: { flightBindingId: input.flightBindingId },
      });
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.baseRevision) {
        return { status: 'REVISION_CONFLICT' as const };
      }
      const decision = decideAssistanceTransition(
        current?.state ?? 'NOT_ENABLED',
        input.action,
      );
      if (decision.status === 'CONFLICT') {
        return { status: 'TRANSITION_CONFLICT' as const };
      }
      const capability =
        decision.status === 'NO_CHANGE'
          ? current
          : await transaction.flightMonitoringCapability.upsert({
              where: { flightBindingId: input.flightBindingId },
              create: {
                ownerUserId: input.ownerUserId,
                tripId: input.tripId,
                flightBindingId: input.flightBindingId,
                state: decision.state,
                revision: 1,
                ...transitionTimes(input.action, input.now),
                stopReason: decision.stopReason,
              },
              update: {
                state: decision.state,
                revision: { increment: 1 },
                ...transitionTimes(input.action, input.now),
                stopReason: decision.stopReason,
              },
            });
      if (capability === null) {
        throw new Error(
          'NOT_ENABLED capability cannot be a no-change mutation',
        );
      }
      if (
        decision.status === 'APPLY' &&
        (decision.state === 'PAUSED' || decision.state === 'STOPPED')
      ) {
        await cancelFlightJobs(transaction, input.flightBindingId, input.now);
      }
      const record = toFlightRecord(capability);
      await transaction.flightAssistanceReceipt.create({
        data: {
          ownerUserId: input.ownerUserId,
          capabilityId: capability.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          action: input.action,
          baseRevision: input.baseRevision,
          resultingRevision: capability.revision,
          resultingState: capability.state,
          resultingStopReason: capability.stopReason,
          resultPayload: payload(record),
        },
      });
      return {
        status: 'SUCCESS' as const,
        capability: record,
        idempotentReplay: false,
      };
    });
  }
}

function absentTripCapability(
  tripId: string,
  kind: TripAssistanceKind,
): AssistanceCapabilityRecord {
  return absent(kind, 'TRIP', tripId);
}

function absentFlightCapability(
  flightBindingId: string,
): AssistanceCapabilityRecord {
  return absent('FLIGHT_MONITORING', 'FLIGHT_BINDING', flightBindingId);
}

function absent(
  kind: AssistanceCapabilityRecord['kind'],
  scope: AssistanceCapabilityRecord['scope'],
  scopeId: string,
): AssistanceCapabilityRecord {
  return {
    id: null,
    kind,
    scope,
    scopeId,
    state: 'NOT_ENABLED',
    revision: 0,
    enabledAt: null,
    resumedAt: null,
    pausedAt: null,
    stoppedAt: null,
    stopReason: null,
  };
}

function toTripRecord(
  value: TripAssistanceCapability,
): AssistanceCapabilityRecord {
  return toRecord(value, value.kind, 'TRIP', value.tripId);
}

function toFlightRecord(
  value: FlightMonitoringCapability,
): AssistanceCapabilityRecord {
  return toRecord(
    value,
    'FLIGHT_MONITORING',
    'FLIGHT_BINDING',
    value.flightBindingId,
  );
}

function toRecord(
  value: {
    readonly id: string;
    readonly state: Exclude<AssistanceState, 'NOT_ENABLED'>;
    readonly revision: number;
    readonly enabledAt: Date | null;
    readonly resumedAt: Date | null;
    readonly pausedAt: Date | null;
    readonly stoppedAt: Date | null;
    readonly stopReason: AssistanceStopReason | null;
  },
  kind: AssistanceCapabilityRecord['kind'],
  scope: AssistanceCapabilityRecord['scope'],
  scopeId: string,
): AssistanceCapabilityRecord {
  return { ...value, kind, scope, scopeId };
}

function transitionTimes(action: AssistanceAction, now: Date) {
  switch (action) {
    case 'ENABLE':
      return {
        enabledAt: now,
        resumedAt: null,
        pausedAt: null,
        stoppedAt: null,
      };
    case 'RESUME':
      return { resumedAt: now, pausedAt: null, stoppedAt: null };
    case 'PAUSE':
      return { pausedAt: now };
    case 'STOP':
      return { stoppedAt: now };
  }
}

function payload(record: AssistanceCapabilityRecord): Prisma.InputJsonValue {
  return {
    ...record,
    enabledAt: record.enabledAt?.toISOString() ?? null,
    resumedAt: record.resumedAt?.toISOString() ?? null,
    pausedAt: record.pausedAt?.toISOString() ?? null,
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
  } as Prisma.InputJsonObject;
}

function parsePayload(value: Prisma.JsonValue): AssistanceCapabilityRecord {
  const item = value as Record<string, unknown>;
  return {
    id: typeof item.id === 'string' ? item.id : null,
    kind: item.kind as AssistanceCapabilityRecord['kind'],
    scope: item.scope as AssistanceCapabilityRecord['scope'],
    scopeId: String(item.scopeId),
    state: item.state as AssistanceState,
    revision: Number(item.revision),
    enabledAt: date(item.enabledAt),
    resumedAt: date(item.resumedAt),
    pausedAt: date(item.pausedAt),
    stoppedAt: date(item.stoppedAt),
    stopReason: (item.stopReason ?? null) as AssistanceStopReason | null,
  };
}

function date(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

async function lockOwner(transaction: Transaction, ownerUserId: string) {
  await transaction.$queryRaw`
    SELECT true FROM pg_advisory_xact_lock(hashtextextended(${ownerUserId}, 2))
  `;
}

async function lockOwnedTrip(
  transaction: Transaction,
  ownerUserId: string,
  tripId: string,
) {
  const rows = await transaction.$queryRaw<readonly { readonly id: string }[]>`
    SELECT "id" FROM "Trip"
    WHERE "id" = ${tripId}::uuid AND "ownerUserId" = ${ownerUserId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockOwnedBinding(
  transaction: Transaction,
  input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
  },
) {
  const rows = await transaction.$queryRaw<readonly { readonly id: string }[]>`
    SELECT "id" FROM "FlightBinding"
    WHERE "id" = ${input.flightBindingId}::uuid
      AND "tripId" = ${input.tripId}::uuid
      AND "ownerUserId" = ${input.ownerUserId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function cancelFlightJobs(
  transaction: Transaction,
  flightBindingId: string,
  now: Date,
) {
  await transaction.job.updateMany({
    where: {
      type: 'FLIGHT_MONITOR',
      payloadRef: flightBindingId,
      status: 'QUEUED',
    },
    data: {
      status: 'CANCELLED',
      cancelRequested: true,
      cancelledAt: now,
      completedAt: now,
    },
  });
  await transaction.job.updateMany({
    where: {
      type: 'FLIGHT_MONITOR',
      payloadRef: flightBindingId,
      status: 'RUNNING',
    },
    data: { cancelRequested: true },
  });
}
