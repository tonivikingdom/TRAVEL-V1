import type {
  GroundTransitBaseline,
  GroundTransitObservation,
} from '@travel/domain';

export interface GroundTransitLegRecord {
  readonly id: string;
  readonly tripId: string;
  readonly transportEdgeId: string;
  readonly adoptedRouteId: string;
  readonly legIndex: number;
  readonly provider: string;
  readonly mode: 'RAIL' | 'BUS';
  readonly serviceClass: 'FIXED_SERVICE' | 'HIGH_FREQUENCY' | null;
  readonly serviceIdentityKey: string | null;
  readonly baseline: GroundTransitBaseline | null;
  readonly state:
    | 'PENDING'
    | 'IN_PROGRESS'
    | 'ARRIVED_PENDING_HANDOFF'
    | 'COMPLETED'
    | 'NO_LONGER_FEASIBLE'
    | 'UNKNOWN';
  readonly latestObservation: GroundTransitObservation | null;
  readonly latestFetchedAt: Date | null;
  readonly observationCount: number;
  readonly deviationCount: number;
  readonly deviationStartedAt: Date | null;
  readonly current: boolean;
}

export type GroundTransitCommitStatus =
  | 'APPLIED'
  | 'STALE_IGNORED'
  | 'IDEMPOTENT'
  | 'OBSERVATION_CONFLICT'
  | 'IDENTITY_UNKNOWN'
  | 'DIFFERENT_SERVICE'
  | 'CAPABILITY_CHANGED'
  | 'NOT_FOUND';

export interface GroundTransitRepository {
  listOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<{
    readonly tripVersion: number;
    readonly legs: readonly GroundTransitLegRecord[];
  } | null>;
  findCurrentOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly transportEdgeId: string;
  }): Promise<GroundTransitLegRecord | null>;
  commitObservation(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly transportEdgeId: string;
    readonly observation: GroundTransitObservation;
    readonly expectedCapabilityRevision?: number;
    readonly now: Date;
  }): Promise<{
    readonly status: GroundTransitCommitStatus;
    readonly leg: GroundTransitLegRecord | null;
  }>;
  ensureEligibleMonitoring(now: Date): Promise<number>;
  listJobLegs(input: {
    readonly adoptedRouteId: string;
    readonly capabilityRevision: number;
    readonly now: Date;
  }): Promise<
    readonly {
      readonly ownerUserId: string;
      readonly leg: GroundTransitLegRecord;
    }[]
  >;
  recordDerivedLocationTransition(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly nodeId: string;
    readonly transition: 'ARRIVAL' | 'DEPARTURE';
    readonly observedAt: Date;
    readonly expectedLocationCapabilityRevision: number;
  }): Promise<void>;
}

export type GroundTransitProviderResult =
  | {
      readonly status: 'SUCCESS';
      readonly observation: GroundTransitObservation;
    }
  | { readonly status: 'UNAVAILABLE' };

export interface GroundTransitProvider {
  readonly name: string;
  fetchObservation(input: {
    readonly leg: GroundTransitLegRecord;
    readonly signal?: AbortSignal;
  }): Promise<GroundTransitProviderResult>;
}
