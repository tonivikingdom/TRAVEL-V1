import type {
  FlightMonitorContext,
  FlightMonitoringRepository,
  NotificationRecord,
} from '@travel/application';
import type { FlightBindingView, FlightSnapshotView } from '@travel/contracts';
import {
  decideAcceptedFlightRefresh,
  futureNormalCheckpoints,
  nextCancellationCheck,
  nextDelayCheck,
  type FlightMonitorNotificationDecision,
  type MonitorDecisionState,
} from '@travel/domain';

import {
  Prisma,
  type FlightBinding,
  type FlightMonitorState,
  type PrismaClient,
} from './generated/prisma/client.js';

const JOB_ATTEMPTS = 5;
const ELIGIBILITY_WINDOW_MS = 24 * 60 * 60_000;

export class PrismaFlightMonitoringRepository implements FlightMonitoringRepository {
  constructor(private readonly client: PrismaClient) {}

  async ensureEligibleMonitoring(now: Date): Promise<number> {
    const bindings = await this.client.flightBinding.findMany({
      select: { id: true, status: true, latestSnapshot: true },
    });
    let eligible = 0;
    for (const binding of bindings) {
      const snapshot = binding.latestSnapshot as unknown as FlightSnapshotView;
      const scheduled = instant(snapshot.departure.scheduledUtc);
      if (
        scheduled === null ||
        ['DEPARTED', 'EN_ROUTE', 'LANDED', 'ARRIVED'].includes(
          binding.status,
        ) ||
        scheduled.getTime() - now.getTime() > ELIGIBILITY_WINDOW_MS
      ) {
        continue;
      }
      eligible += 1;
      await this.client.$transaction(async (transaction) => {
        const locked = await lockBinding(transaction, binding.id);
        if (locked === null) return;
        const lockedSnapshot =
          locked.latestSnapshot as unknown as FlightSnapshotView;
        const lockedScheduled = instant(lockedSnapshot.departure.scheduledUtc);
        if (
          lockedScheduled === null ||
          ['DEPARTED', 'EN_ROUTE', 'LANDED', 'ARRIVED'].includes(
            locked.status,
          ) ||
          lockedScheduled.getTime() - now.getTime() > ELIGIBILITY_WINDOW_MS
        ) {
          return;
        }
        const state = await transaction.flightMonitorState.upsert({
          where: { flightBindingId: binding.id },
          create: { flightBindingId: binding.id },
          update: {},
        });
        if (await hasLiveMonitorJob(transaction, binding.id)) return;

        const expectedMode =
          locked.status === 'CANCELLED'
            ? 'CANCELLED'
            : locked.status === 'DELAYED' ||
                hasPositiveDepartureDelay(lockedSnapshot, lockedScheduled)
              ? 'DELAYED'
              : 'NORMAL';
        if (state.mode !== expectedMode) {
          await scheduleJob(
            transaction,
            binding.id,
            state.generation,
            now,
            'reconcile',
          );
          return;
        }
        if (state.mode === 'CANCELLED') {
          const next = nextCancellationCheck(lockedScheduled, now);
          if (next !== null) {
            await scheduleJob(
              transaction,
              binding.id,
              state.generation,
              next,
              'cancelled',
            );
          }
          return;
        }
        if (state.mode === 'DELAYED') {
          await scheduleJob(
            transaction,
            binding.id,
            state.generation,
            nextDelayCheck(lockedSnapshot.departure, now),
            'delayed',
          );
          return;
        }
        await scheduleNormalJobs(
          transaction,
          binding.id,
          state.generation,
          lockedScheduled,
          now,
        );
      });
    }
    return eligible;
  }

  async findContext(
    flightBindingId: string,
  ): Promise<FlightMonitorContext | null> {
    const binding = await this.client.flightBinding.findUnique({
      where: { id: flightBindingId },
      include: { owner: true, monitorState: true },
    });
    if (binding === null) return null;
    const state =
      binding.monitorState ??
      (await this.client.flightMonitorState.upsert({
        where: { flightBindingId },
        create: { flightBindingId },
        update: {},
      }));
    return toContext(binding, state);
  }

  async recordAirportArrival(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
    readonly airportIata: string;
    readonly now: Date;
  }): Promise<FlightMonitorContext | null> {
    const binding = await this.client.flightBinding.findFirst({
      where: {
        id: input.flightBindingId,
        ownerUserId: input.ownerUserId,
        tripId: input.tripId,
      },
      select: { id: true },
    });
    if (binding === null) return null;
    await this.client.flightMonitorState.upsert({
      where: { flightBindingId: input.flightBindingId },
      create: {
        flightBindingId: input.flightBindingId,
        arrivedAtAirportAt: input.now,
        arrivedAirportIata: input.airportIata,
      },
      update: {
        arrivedAtAirportAt: input.now,
        arrivedAirportIata: input.airportIata,
      },
    });
    return this.findContext(input.flightBindingId);
  }

  async commitRefresh(
    input: Parameters<FlightMonitoringRepository['commitRefresh']>[0],
  ): Promise<NotificationRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const binding = await lockBinding(transaction, input.flightBindingId);
      if (
        binding === null ||
        binding.lastRefreshedAt.getTime() !== input.acceptedFetchedAt.getTime()
      ) {
        return null;
      }
      const current = await transaction.flightMonitorState.findUnique({
        where: { flightBindingId: input.flightBindingId },
      });
      if (current === null) return null;
      if (
        input.recordSuccessfulRefresh &&
        current.lastDecisionFetchedAt !== null &&
        current.lastDecisionFetchedAt.getTime() >=
          input.acceptedFetchedAt.getTime()
      ) {
        return null;
      }
      const latestSnapshot =
        binding.latestSnapshot as unknown as FlightSnapshotView;
      const previousSnapshot = input.recordSuccessfulRefresh
        ? current.lastDecisionSnapshot === null
          ? (binding.selectedSnapshot as unknown as FlightSnapshotView)
          : (current.lastDecisionSnapshot as unknown as FlightSnapshotView)
        : latestSnapshot;
      const decision = decideAcceptedFlightRefresh({
        previous: previousSnapshot,
        next: latestSnapshot,
        state: toDecisionState(current),
        now: input.now,
      });
      const replaceSchedule =
        decision.state.mode === 'STOPPED' || decision.replaceSchedule;
      await transaction.flightMonitorState.update({
        where: { flightBindingId: input.flightBindingId },
        data: stateUpdate(
          decision.state,
          input.recordSuccessfulRefresh ? input.now : null,
          current,
          input.recordSuccessfulRefresh
            ? {
                fetchedAt: input.acceptedFetchedAt,
                snapshot: latestSnapshot,
              }
            : null,
        ),
      });

      if (replaceSchedule) {
        await cancelQueuedJobs(transaction, input.flightBindingId, input.now);
      }
      if (decision.state.mode === 'NORMAL' && replaceSchedule) {
        const snapshot =
          binding.latestSnapshot as unknown as FlightSnapshotView;
        const scheduled = requiredInstant(snapshot.departure.scheduledUtc);
        await scheduleNormalJobs(
          transaction,
          input.flightBindingId,
          current.generation,
          scheduled,
          input.now,
          true,
        );
      } else if (decision.nextCheckAt !== null) {
        await scheduleJob(
          transaction,
          input.flightBindingId,
          current.generation,
          decision.nextCheckAt,
          decision.state.mode.toLowerCase(),
          replaceSchedule,
        );
      }
      return createNotification(transaction, {
        binding,
        notification: decision.notification,
        hasDownstreamImpact: input.hasDownstreamImpact,
        occurredAt: input.now,
        generation: `${current.generation}:${input.acceptedFetchedAt.toISOString()}`,
      });
    });
  }

  async commitProviderFailure(
    input: Parameters<FlightMonitoringRepository['commitProviderFailure']>[0],
  ): Promise<NotificationRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const binding = await lockBinding(transaction, input.flightBindingId);
      if (binding === null) return null;
      const state = await transaction.flightMonitorState.findUnique({
        where: { flightBindingId: input.flightBindingId },
      });
      if (state === null) return null;
      await transaction.flightMonitorState.update({
        where: { flightBindingId: input.flightBindingId },
        data: stateUpdate(input.state, null, state),
      });
      if (
        input.nextCheckAt !== null &&
        ['DELAYED', 'CANCELLED', 'BAGGAGE'].includes(input.state.mode)
      ) {
        await cancelQueuedJobs(transaction, input.flightBindingId, input.now);
      }
      if (input.nextCheckAt !== null) {
        await scheduleJob(
          transaction,
          input.flightBindingId,
          state.generation,
          input.nextCheckAt,
          `${input.state.mode.toLowerCase()}-failure`,
          ['DELAYED', 'CANCELLED', 'BAGGAGE'].includes(input.state.mode),
        );
      }
      return createNotification(transaction, {
        binding,
        notification: input.notification,
        hasDownstreamImpact: false,
        occurredAt: input.now,
        generation: `${state.generation}:provider-unavailable`,
      });
    });
  }

  async cancelFutureMonitoring(
    flightBindingId: string,
    now: Date,
  ): Promise<void> {
    await this.client.$transaction((transaction) =>
      cancelQueuedJobs(transaction, flightBindingId, now),
    );
  }
}

type Transaction = Prisma.TransactionClient;

async function hasLiveMonitorJob(
  transaction: Transaction,
  flightBindingId: string,
): Promise<boolean> {
  return (
    (await transaction.job.count({
      where: {
        type: 'FLIGHT_MONITOR',
        payloadRef: flightBindingId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
    })) > 0
  );
}

async function lockBinding(transaction: Transaction, flightBindingId: string) {
  const rows = await transaction.$queryRaw<FlightBinding[]>`
    SELECT * FROM "FlightBinding"
    WHERE "id" = ${flightBindingId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function scheduleNormalJobs(
  transaction: Transaction,
  flightBindingId: string,
  generation: string,
  scheduledDeparture: Date,
  now: Date,
  reactivateCancelled = false,
) {
  for (const runAt of futureNormalCheckpoints(scheduledDeparture, now)) {
    await scheduleJob(
      transaction,
      flightBindingId,
      generation,
      runAt,
      'normal',
      reactivateCancelled,
    );
  }
}

async function scheduleJob(
  transaction: Transaction,
  flightBindingId: string,
  generation: string,
  runAt: Date,
  reason: string,
  reactivateCancelled = false,
) {
  const uniqueKey = `flight-monitor:${flightBindingId}:${generation}:${reason}:${runAt.getTime()}`;
  if (reactivateCancelled) {
    await transaction.job.updateMany({
      where: { uniqueKey, status: 'CANCELLED' },
      data: {
        status: 'QUEUED',
        runAt,
        attempts: 0,
        maxAttempts: JOB_ATTEMPTS,
        leaseOwner: null,
        leaseUntil: null,
        cancelRequested: false,
        completedAt: null,
        cancelledAt: null,
        lastErrorCode: null,
      },
    });
  }
  await transaction.job.upsert({
    where: { uniqueKey },
    create: {
      type: 'FLIGHT_MONITOR',
      status: 'QUEUED',
      runAt,
      attempts: 0,
      maxAttempts: JOB_ATTEMPTS,
      uniqueKey,
      payloadRef: flightBindingId,
    },
    update: {},
  });
}

async function cancelQueuedJobs(
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
}

function stateUpdate(
  state: MonitorDecisionState,
  successfulRefreshAt: Date | null,
  current: FlightMonitorState | undefined,
  completedDecision: {
    readonly fetchedAt: Date;
    readonly snapshot: FlightSnapshotView;
  } | null = null,
) {
  return {
    mode: state.mode,
    arrivedAtAirportAt:
      state.arrivedAtAirportAt ?? current?.arrivedAtAirportAt ?? null,
    ...(successfulRefreshAt === null
      ? {}
      : { lastSuccessfulMonitorRefreshAt: successfulRefreshAt }),
    ...(completedDecision === null
      ? {}
      : {
          lastDecisionFetchedAt: completedDecision.fetchedAt,
          lastDecisionSnapshot:
            completedDecision.snapshot as unknown as Prisma.InputJsonValue,
        }),
    lastNotifiedDelayMinutes: state.lastNotifiedDelayMinutes,
    earlyDepartureNotified: state.earlyDepartureNotified,
    lastNotifiedDepartureGate: state.lastNotifiedDepartureGate,
    providerUnavailableWarned: state.providerUnavailableWarned,
    cancellationNotified: state.cancellationNotified,
    baggageWindowStartedAt: state.baggageWindowStartedAt,
    baggageWindowEndsAt: state.baggageWindowEndsAt,
    lastNotifiedBaggage: state.lastNotifiedBaggage,
  } as const;
}

async function createNotification(
  transaction: Transaction,
  input: {
    readonly binding: FlightBinding;
    readonly notification: FlightMonitorNotificationDecision | null;
    readonly hasDownstreamImpact: boolean;
    readonly occurredAt: Date;
    readonly generation: string;
  },
): Promise<NotificationRecord | null> {
  if (input.notification === null) return null;
  const kind = 'FLIGHT_IMPORTANT_CHANGE';
  const dedupeKey = [
    'flight-monitor',
    input.binding.id,
    input.generation,
    ...input.notification.changeKinds,
  ].join(':');
  return transaction.notificationEvent.upsert({
    where: {
      ownerUserId_dedupeKey: {
        ownerUserId: input.binding.ownerUserId,
        dedupeKey,
      },
    },
    create: {
      ownerUserId: input.binding.ownerUserId,
      tripId: input.binding.tripId,
      flightBindingId: input.binding.id,
      flightNumber: input.binding.displayFlightNumber,
      kind,
      dedupeKey,
      title:
        input.notification.priority === 'STRONG'
          ? '航班重要状态变化'
          : '航班状态更新',
      body: input.notification.summary,
      priority: input.notification.priority,
      summary: input.notification.summary,
      changeKinds: input.notification
        .changeKinds as unknown as Prisma.InputJsonValue,
      hasDownstreamImpact: input.hasDownstreamImpact,
      occurredAt: input.occurredAt,
    },
    update: {},
  });
}

function toContext(
  binding: FlightBinding & {
    readonly owner: {
      readonly email: string;
      readonly role: 'ADMIN' | 'USER';
      readonly status: 'ACTIVE' | 'DISABLED';
    };
  },
  state: FlightMonitorState,
): FlightMonitorContext {
  return {
    actor: {
      userId: binding.ownerUserId,
      email: binding.owner.email,
      role: binding.owner.role,
      status: binding.owner.status,
    },
    binding: toBindingView(binding),
    state: {
      mode: state.mode,
      arrivedAtAirportAt: state.arrivedAtAirportAt,
      lastSuccessfulMonitorRefreshAt: state.lastSuccessfulMonitorRefreshAt,
      lastNotifiedDelayMinutes: state.lastNotifiedDelayMinutes,
      earlyDepartureNotified: state.earlyDepartureNotified,
      lastNotifiedDepartureGate: state.lastNotifiedDepartureGate,
      providerUnavailableWarned: state.providerUnavailableWarned,
      cancellationNotified: state.cancellationNotified,
      baggageWindowStartedAt: state.baggageWindowStartedAt,
      baggageWindowEndsAt: state.baggageWindowEndsAt,
      lastNotifiedBaggage: state.lastNotifiedBaggage,
    },
  };
}

function toBindingView(binding: FlightBinding): FlightBindingView {
  return {
    id: binding.id,
    tripId: binding.tripId,
    transportEdgeId: binding.transportEdgeId,
    provider: 'aerodatabox',
    providerFlightRef: binding.providerFlightRef,
    canonicalFlightNumber: binding.canonicalFlightNumber,
    displayFlightNumber: binding.displayFlightNumber,
    serviceDate: binding.serviceDate.toISOString().slice(0, 10),
    selectedSnapshot: binding.selectedSnapshot as unknown as FlightSnapshotView,
    latestSnapshot: binding.latestSnapshot as unknown as FlightSnapshotView,
    status: binding.status,
    lastRefreshedAt: binding.lastRefreshedAt.toISOString(),
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

function requiredInstant(value: string | null): Date {
  const result = instant(value);
  if (result === null) throw new Error('Flight scheduled departure is missing');
  return result;
}

function hasPositiveDepartureDelay(
  snapshot: FlightSnapshotView,
  scheduled: Date,
): boolean {
  const revised = instant(snapshot.departure.revisedUtc);
  return revised !== null && revised.getTime() > scheduled.getTime();
}

function toDecisionState(state: FlightMonitorState): MonitorDecisionState {
  return {
    mode: state.mode,
    arrivedAtAirportAt: state.arrivedAtAirportAt,
    lastNotifiedDelayMinutes: state.lastNotifiedDelayMinutes,
    earlyDepartureNotified: state.earlyDepartureNotified,
    lastNotifiedDepartureGate: state.lastNotifiedDepartureGate,
    providerUnavailableWarned: state.providerUnavailableWarned,
    cancellationNotified: state.cancellationNotified,
    baggageWindowStartedAt: state.baggageWindowStartedAt,
    baggageWindowEndsAt: state.baggageWindowEndsAt,
    lastNotifiedBaggage: state.lastNotifiedBaggage,
  };
}

function instant(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
