import type {
  FlightExecutionTriggerRequest,
  FlightExecutionTriggerResponse,
  RefreshFlightResponse,
} from '@travel/contracts';
import {
  decideAcceptedFlightRefresh,
  decideProviderFailure,
  shouldRefreshFlightDetail,
  shouldSkipFixedRefresh,
} from '@travel/domain';

import { isApplicationError } from './errors.js';
import type { FlightMonitoringRepository } from './flight-monitoring-ports.js';
import type { FlightService } from './flight-service.js';
import type { Actor } from './authorization.js';
import { authorize } from './authorization.js';
import { ApplicationError } from './errors.js';

export interface FlightMonitoringServiceOptions {
  readonly now?: () => Date;
}

export class FlightMonitoringService {
  private readonly now: () => Date;

  constructor(
    private readonly flightService: FlightService,
    private readonly repository: FlightMonitoringRepository,
    options: FlightMonitoringServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  ensureEligibleMonitoring(): Promise<number> {
    return this.repository.ensureEligibleMonitoring(this.now());
  }

  async executeJob(
    flightBindingId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const context = await this.repository.findContext(flightBindingId);
    if (context === null || context.state.mode === 'STOPPED') return;
    const now = this.now();
    if (
      context.state.mode === 'NORMAL' &&
      shouldSkipFixedRefresh(context.state.lastSuccessfulMonitorRefreshAt, now)
    ) {
      const decision = decideAcceptedFlightRefresh({
        previous: context.binding.latestSnapshot,
        next: context.binding.latestSnapshot,
        state: context.state,
        now,
      });
      await this.repository.commitRefresh({
        flightBindingId,
        acceptedFetchedAt: new Date(context.binding.lastRefreshedAt),
        mode: decision.state.mode,
        state: decision.state,
        notification: decision.notification,
        hasDownstreamImpact: false,
        nextCheckAt: decision.nextCheckAt,
        replaceSchedule: decision.replaceSchedule,
        recordSuccessfulRefresh: false,
        now,
      });
      return;
    }
    await this.performRefresh(
      context.actor,
      context.binding.tripId,
      flightBindingId,
    );
  }

  async trigger(
    actor: Actor,
    tripId: string,
    flightBindingId: string,
    input: FlightExecutionTriggerRequest,
  ): Promise<FlightExecutionTriggerResponse> {
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const context = await this.repository.findContext(flightBindingId);
    if (
      context === null ||
      context.actor.userId !== actor.userId ||
      context.binding.tripId !== tripId
    ) {
      throw new ApplicationError('NOT_FOUND', '找不到该资源。', 404);
    }
    const now = this.now();
    let current = context;
    if (input.type === 'ARRIVED_AT_AIRPORT') {
      const airportIata = normalizeAirport(input.airportIata);
      if (
        airportIata !== context.binding.latestSnapshot.departure.airportIata
      ) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          '到机场事件与当前航班出发机场不匹配。',
          400,
        );
      }
      current =
        (await this.repository.recordAirportArrival({
          ownerUserId: actor.userId,
          tripId,
          flightBindingId,
          airportIata,
          now,
        })) ?? context;
    } else if (
      input.type !== 'FLIGHT_DETAIL_OPENED' &&
      input.type !== 'POST_FLIGHT_CHECK'
    ) {
      throw new ApplicationError('VALIDATION_ERROR', '航班执行事件无效。', 400);
    }

    if (
      input.type === 'FLIGHT_DETAIL_OPENED' &&
      !shouldRefreshFlightDetail(
        current.state.lastSuccessfulMonitorRefreshAt,
        now,
      )
    ) {
      return {
        flightBinding: current.binding,
        providerRefreshPerformed: false,
        notificationId: null,
      };
    }
    const result = await this.performRefresh(actor, tripId, flightBindingId);
    return {
      flightBinding: result.response?.flightBinding ?? current.binding,
      providerRefreshPerformed: true,
      notificationId: result.notificationId,
    };
  }

  private async performRefresh(
    actor: Actor,
    tripId: string,
    flightBindingId: string,
  ): Promise<{
    readonly response: RefreshFlightResponse | null;
    readonly notificationId: string | null;
  }> {
    const before = await this.repository.findContext(flightBindingId);
    if (before === null) return { response: null, notificationId: null };
    const now = this.now();
    try {
      const response = await this.flightService.refresh(
        actor,
        tripId,
        flightBindingId,
      );
      const after = await this.repository.findContext(flightBindingId);
      if (after === null) return { response, notificationId: null };
      const decision = decideAcceptedFlightRefresh({
        previous: before.binding.latestSnapshot,
        next: response.flightBinding.latestSnapshot,
        state: before.state,
        now,
      });
      const notification = await this.repository.commitRefresh({
        flightBindingId,
        acceptedFetchedAt: new Date(response.flightBinding.lastRefreshedAt),
        mode: decision.state.mode,
        state: decision.state,
        notification: decision.notification,
        hasDownstreamImpact: response.riskEvaluation.risks.length > 0,
        nextCheckAt: decision.nextCheckAt,
        replaceSchedule: decision.replaceSchedule,
        recordSuccessfulRefresh: true,
        now,
      });
      return { response, notificationId: notification?.id ?? null };
    } catch (error) {
      if (!isProviderFailure(error)) throw error;
      const failure = decideProviderFailure({
        snapshot: before.binding.latestSnapshot,
        state: before.state,
        now,
      });
      const notification = await this.repository.commitProviderFailure({
        flightBindingId,
        state: failure.state,
        notification: failure.notification,
        nextCheckAt: failure.nextCheckAt,
        now,
      });
      return { response: null, notificationId: notification?.id ?? null };
    }
  }
}

function isProviderFailure(error: unknown): boolean {
  return (
    isApplicationError(error) &&
    [
      'FLIGHT_PROVIDER_TIMEOUT',
      'FLIGHT_PROVIDER_UNAVAILABLE',
      'FLIGHT_PROVIDER_RATE_LIMIT',
      'FLIGHT_PROVIDER_NOT_CONFIGURED',
    ].includes(error.code)
  );
}

function normalizeAirport(value: string | undefined): string {
  const airport = value?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{3}$/u.test(airport)) {
    throw new ApplicationError('VALIDATION_ERROR', '机场代码无效。', 400);
  }
  return airport;
}
