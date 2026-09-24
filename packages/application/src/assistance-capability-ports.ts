import type {
  AssistanceAction,
  AssistanceState,
  AssistanceStopReason,
  TripAssistanceKind,
} from '@travel/contracts';

export interface AssistanceCapabilityRecord {
  readonly id: string | null;
  readonly kind: TripAssistanceKind | 'FLIGHT_MONITORING';
  readonly scope: 'TRIP' | 'FLIGHT_BINDING';
  readonly scopeId: string;
  readonly state: AssistanceState;
  readonly revision: number;
  readonly enabledAt: Date | null;
  readonly resumedAt: Date | null;
  readonly pausedAt: Date | null;
  readonly stoppedAt: Date | null;
  readonly stopReason: AssistanceStopReason | null;
}

export type AssistanceMutationRepositoryResult =
  | {
      readonly status: 'SUCCESS';
      readonly capability: AssistanceCapabilityRecord;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly status:
        | 'NOT_FOUND'
        | 'REVISION_CONFLICT'
        | 'TRANSITION_CONFLICT'
        | 'IDEMPOTENCY_CONFLICT';
    };

export interface AssistanceCapabilityRepository {
  getTripCapabilities(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<readonly AssistanceCapabilityRecord[] | null>;
  mutateTripCapability(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly kind: TripAssistanceKind;
    readonly action: AssistanceAction;
    readonly baseRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<AssistanceMutationRepositoryResult>;
  getFlightCapability(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
  }): Promise<{
    readonly capability: AssistanceCapabilityRecord;
    readonly scheduledDepartureAt: Date | null;
    readonly flightStatus: string;
    readonly hasActiveMonitoringWork: boolean;
  } | null>;
  mutateFlightCapability(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
    readonly action: AssistanceAction;
    readonly baseRevision: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<AssistanceMutationRepositoryResult>;
}
