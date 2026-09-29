import type {
  GroundTransitExecutionResponse,
  GroundTransitLegView,
  GroundTransitRefreshResponse,
} from '@travel/contracts';
import {
  assessGroundTransitSafety,
  GROUND_TRANSIT_POLICY,
  validGroundTransitObservation,
} from '@travel/domain';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  GroundTransitLegRecord,
  GroundTransitProvider,
  GroundTransitRepository,
} from './ground-transit-ports.js';
import type { ExecutionRiskService } from './execution-risk-service.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class GroundTransitService {
  constructor(
    private readonly repository: GroundTransitRepository,
    private readonly provider: GroundTransitProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly executionRiskService?: ExecutionRiskService,
  ) {}

  async getTrip(
    actor: Actor,
    tripId: string,
  ): Promise<GroundTransitExecutionResponse> {
    validateUuid(tripId);
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const result = await this.repository.listOwned({
      ownerUserId: actor.userId,
      tripId,
    });
    if (result === null) throw notFound();
    return {
      tripId,
      tripVersion: result.tripVersion,
      legs: result.legs.map((leg) => toView(leg, this.now())),
    };
  }

  async refresh(
    actor: Actor,
    tripId: string,
    transportEdgeId: string,
  ): Promise<GroundTransitRefreshResponse> {
    validateUuid(tripId);
    validateUuid(transportEdgeId);
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const leg = await this.repository.findCurrentOwned({
      ownerUserId: actor.userId,
      tripId,
      transportEdgeId,
    });
    if (leg === null) throw notFound();
    return this.refreshLeg(actor.userId, tripId, leg);
  }

  async executeJob(
    adoptedRouteId: string,
    capabilityRevision: number | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      capabilityRevision === null ||
      !UUID.test(adoptedRouteId) ||
      signal?.aborted
    )
      return;
    const legs = await this.repository.listJobLegs({
      adoptedRouteId,
      capabilityRevision,
      now: this.now(),
    });
    for (const { ownerUserId, leg } of legs) {
      if (signal?.aborted) return;
      await this.refreshLeg(
        ownerUserId,
        leg.tripId,
        leg,
        capabilityRevision,
        signal,
      );
    }
  }

  ensureEligibleMonitoring(): Promise<number> {
    return this.repository.ensureEligibleMonitoring(this.now());
  }

  async recordDerivedLocationTransition(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly nodeId: string;
    readonly transition: 'ARRIVAL' | 'DEPARTURE';
    readonly observedAt: Date;
    readonly expectedLocationCapabilityRevision: number;
  }): Promise<void> {
    await this.repository.recordDerivedLocationTransition(input);
  }

  private async refreshLeg(
    ownerUserId: string,
    tripId: string,
    leg: GroundTransitLegRecord,
    expectedCapabilityRevision?: number,
    signal?: AbortSignal,
  ): Promise<GroundTransitRefreshResponse> {
    if (leg.baseline === null) {
      return { status: 'IDENTITY_UNKNOWN', leg: toView(leg, this.now()) };
    }
    const result = await this.provider.fetchObservation({
      leg,
      ...(signal ? { signal } : {}),
    });
    if (result.status === 'UNAVAILABLE') {
      const now = this.now();
      const failure = await this.repository.recordProviderFailure({
        ownerUserId,
        tripId,
        transportEdgeId: leg.transportEdgeId,
        now,
        ...(expectedCapabilityRevision === undefined
          ? {}
          : { expectedCapabilityRevision }),
      });
      if (failure === 'NOT_FOUND') throw notFound();
      if (failure === 'CAPABILITY_CHANGED') {
        return { status: 'STALE_IGNORED', leg: toView(leg, now) };
      }
      if (failure === 'CURRENT' && this.executionRiskService !== undefined) {
        try {
          await this.executionRiskService.evaluateTripRisks(
            { userId: ownerUserId, email: '', role: 'USER', status: 'ACTIVE' },
            tripId,
            {
              groupKey: `ground-transit-provider-unavailable:${leg.id}:${Math.floor(now.getTime() / GROUND_TRANSIT_POLICY.monitorIntervalMs)}`,
              sourceTransportEdgeId: leg.transportEdgeId,
              ...(expectedCapabilityRevision === undefined
                ? {}
                : {
                    expectedGroundTransitCapabilityRevision:
                      expectedCapabilityRevision,
                  }),
            },
          );
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.code === 'CAPABILITY_CHANGED'
          ) {
            return { status: 'STALE_IGNORED', leg: toView(leg, now) };
          }
          throw error;
        }
      }
      throw new ApplicationError(
        'GROUND_TRANSIT_PROVIDER_UNAVAILABLE',
        '地面交通执行信息暂时不可用；已采用路线保持不变。',
        503,
        true,
      );
    }
    if (!validGroundTransitObservation(result.observation)) {
      throw new ApplicationError(
        'GROUND_TRANSIT_PROVIDER_BAD_RESPONSE',
        '地面交通信息格式无效；已采用路线保持不变。',
        502,
        true,
      );
    }
    const committed = await this.repository.commitObservation({
      ownerUserId,
      tripId,
      transportEdgeId: leg.transportEdgeId,
      observation: result.observation,
      now: this.now(),
      ...(expectedCapabilityRevision === undefined
        ? {}
        : { expectedCapabilityRevision }),
    });
    if (committed.status === 'NOT_FOUND' || committed.leg === null)
      throw notFound();
    if (committed.status === 'CAPABILITY_CHANGED') {
      // A running provider response belongs to an older generation; never commit it.
      return {
        status: 'STALE_IGNORED',
        leg: toView(committed.leg, this.now()),
      };
    }
    if (this.executionRiskService !== undefined) {
      try {
        await this.executionRiskService.evaluateTripRisks(
          { userId: ownerUserId, email: '', role: 'USER', status: 'ACTIVE' },
          tripId,
          {
            groupKey:
              committed.status === 'APPLIED' ||
              committed.status === 'IDEMPOTENT'
                ? `ground-transit-observation:${committed.leg.id}:${result.observation.fetchedAt.toISOString()}`
                : `ground-transit-recheck:${committed.leg.id}:${Math.floor(this.now().getTime() / GROUND_TRANSIT_POLICY.monitorIntervalMs)}`,
            sourceTransportEdgeId: leg.transportEdgeId,
            ...(expectedCapabilityRevision === undefined
              ? {}
              : {
                  expectedGroundTransitCapabilityRevision:
                    expectedCapabilityRevision,
                }),
          },
        );
      } catch (error) {
        if (!(
          error instanceof ApplicationError &&
          error.code === 'CAPABILITY_CHANGED'
        )) {
          throw error;
        }
        // The observation committed before pause; no later risk/notification may cross it.
      }
    }
    return { status: committed.status, leg: toView(committed.leg, this.now()) };
  }
}

function toView(leg: GroundTransitLegRecord, now: Date): GroundTransitLegView {
  const safety =
    leg.baseline === null
      ? {
          policyVersion: GROUND_TRANSIT_POLICY.version,
          realtimeFreshness: 'UNAVAILABLE' as const,
          headwayWaitReserveSeconds: null,
          transferMinimumSeconds: null,
          boardingAccessMinimumSeconds: null,
          headwayBasis: 'UNKNOWN',
          transferBasis: 'UNKNOWN',
          boardingAccessBasis: 'UNKNOWN',
          executionWindow: { plannedDeparture: null, plannedArrival: null },
          totalSystemMinimumSeconds: null,
          etaRangeSeconds: null,
          feasibility: 'UNKNOWN' as const,
          reasonCodes: ['LEG_METADATA_UNKNOWN'],
          requiresRouteReevaluation: false,
        }
      : assessGroundTransitSafety({
          baseline: leg.baseline,
          observation: leg.latestObservation,
          now,
          availableAt: null,
          downstreamLatestAt: null,
          boundary: 'BOARDING',
        });
  const transfer =
    leg.baseline === null || leg.baseline.hasOnwardConnection !== true
      ? null
      : assessGroundTransitSafety({
          baseline: leg.baseline,
          observation: leg.latestObservation,
          now,
          availableAt: null,
          downstreamLatestAt: null,
          boundary: 'TRANSFER_TO_NEXT',
        });
  return {
    id: leg.id,
    transportEdgeId: leg.transportEdgeId,
    adoptedRouteId: leg.adoptedRouteId,
    legIndex: leg.legIndex,
    mode: leg.mode,
    provider: leg.provider,
    serviceClass: leg.serviceClass,
    serviceIdentityKey: leg.serviceIdentityKey,
    state: leg.state,
    baseline:
      leg.baseline === null
        ? null
        : {
            ...leg.baseline,
            plannedDeparture:
              leg.baseline.plannedDeparture?.toISOString() ?? null,
            plannedArrival: leg.baseline.plannedArrival?.toISOString() ?? null,
          },
    latestObservation:
      leg.latestObservation === null
        ? null
        : {
            ...leg.latestObservation,
            fetchedAt: leg.latestObservation.fetchedAt.toISOString(),
          },
    latestFetchedAt: leg.latestFetchedAt?.toISOString() ?? null,
    observationCount: leg.observationCount,
    current: leg.current,
    deviationConsecutiveObservations: leg.deviationCount,
    deviationStartedAt: leg.deviationStartedAt?.toISOString() ?? null,
    safety: {
      ...safety,
      transferMinimumSeconds: transfer?.transferMinimumSeconds ?? null,
      transferBasis:
        transfer?.transferBasis ??
        (leg.baseline === null ? 'UNKNOWN' : 'NOT_APPLICABLE'),
      reasonCodes: [...safety.reasonCodes, ...(transfer?.reasonCodes ?? [])],
      executionWindow: {
        plannedDeparture:
          safety.executionWindow.plannedDeparture?.toISOString() ?? null,
        plannedArrival:
          safety.executionWindow.plannedArrival?.toISOString() ?? null,
      },
    },
  };
}

function validateUuid(value: string) {
  if (!UUID.test(value))
    throw new ApplicationError('VALIDATION_ERROR', '资源 ID 无效。', 400);
}

function notFound() {
  return new ApplicationError('NOT_FOUND', '找不到该资源。', 404);
}
