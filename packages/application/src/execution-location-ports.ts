import type {
  ExecutionDerivedLocationState,
  ExecutionLocationDecision,
} from '@travel/domain';

import type { TemporalValueRecord } from './trip-ports.js';

export interface ExecutionEventRecord {
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
}

export interface ExecutionContextNodeRecord {
  readonly id: string;
  readonly sequence: number;
  readonly position: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly providerHubRef: string | null;
  readonly actualArrival: TemporalValueRecord | null;
  readonly actualDeparture: TemporalValueRecord | null;
  readonly executionStatus: 'POSSIBLY_SKIPPED' | 'SKIPPED' | null;
}

export interface ExecutionFlightDepartureRecord {
  readonly flightBindingId: string;
  readonly departureNodeId: string;
  readonly airportIata: string;
  readonly monitoringCapabilityRevision: number;
}

export interface ExecutionContextRecord {
  readonly tripId: string;
  readonly ownerUserId: string;
  readonly tripVersion: number;
  readonly nodes: readonly ExecutionContextNodeRecord[];
  readonly locationState: ExecutionDerivedLocationState | null;
  readonly observationWatermarkAt: Date | null;
  readonly suppressedArrivalNodeIds: readonly string[];
  readonly possibleSkippedNodeIds: readonly string[];
  readonly confirmedSkippedNodeIds: readonly string[];
  readonly flightDepartures: readonly ExecutionFlightDepartureRecord[];
  readonly pendingAirportArrivalEvents: readonly ExecutionEventRecord[];
  readonly locationAssistance: {
    readonly state: 'NOT_ENABLED' | 'ENABLED' | 'PAUSED' | 'STOPPED';
    readonly revision: number;
  };
  readonly autoRecord: {
    readonly state: 'NOT_ENABLED' | 'ENABLED' | 'PAUSED' | 'STOPPED';
    readonly revision: number;
  };
}

export type CommitExecutionResult =
  | {
      readonly status: 'SUCCESS';
      readonly event: ExecutionEventRecord | null;
      readonly resultingTripVersion: number;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly status:
        | 'NOT_FOUND'
        | 'VERSION_CONFLICT'
        | 'RETRY'
        | 'FACT_PROTECTED'
        | 'IDEMPOTENCY_CONFLICT'
        | 'INVALID_CONTEXT'
        | 'UNDO_CONFLICT'
        | 'CAPABILITY_CHANGED';
    };

export type AirportTriggerClaimResult =
  | { readonly status: 'CLAIMED'; readonly claimToken: string }
  | { readonly status: 'BUSY' | 'COMPLETED' | 'NOT_ELIGIBLE' };

export interface ExecutionLocationRepository {
  findOwnedContext(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<ExecutionContextRecord | null>;
  findEventByIdempotencyKey(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  }): Promise<
    | {
        readonly status: 'MATCH';
        readonly event: ExecutionEventRecord;
        readonly tripVersion: number;
      }
    | { readonly status: 'CONFLICT' | 'NOT_FOUND' }
  >;
  commitLocation(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly expectedTripVersion: number;
    readonly expectedObservationWatermarkAt: Date | null;
    readonly decision: ExecutionLocationDecision;
    readonly observedAt: Date;
    readonly expectedLocationCapabilityRevision: number;
    readonly expectedAutoRecordCapabilityRevision: number;
    readonly autoRecordEnabled: boolean;
  }): Promise<CommitExecutionResult>;
  commitManual(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly type: 'ARRIVAL' | 'DEPARTURE' | 'SKIP_CONFIRMED';
    readonly nodeId: string;
    readonly occurredAt: Date;
    readonly expectedCurrentNodeId: string | null;
    readonly expectedTargetNodeId: string | null;
  }): Promise<CommitExecutionResult>;
  undoEvent(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly eventId: string;
    readonly baseTripVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<CommitExecutionResult>;
  claimAirportTrigger(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly eventId: string;
    readonly claimToken: string;
    readonly claimedAt: Date;
    readonly expiredBefore: Date;
  }): Promise<AirportTriggerClaimResult>;
  completeAirportTrigger(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly eventId: string;
    readonly claimToken: string;
    readonly completedAt: Date;
  }): Promise<boolean>;
  releaseAirportTriggerClaim(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly eventId: string;
    readonly claimToken: string;
  }): Promise<void>;
}
