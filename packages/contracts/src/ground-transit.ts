export type GroundTransitLegStateView =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'ARRIVED_PENDING_HANDOFF'
  | 'COMPLETED'
  | 'NO_LONGER_FEASIBLE'
  | 'UNKNOWN';

export interface GroundTransitBoardingSafetyView {
  readonly policyVersion: string;
  readonly realtimeFreshness: 'FRESH' | 'STALE' | 'UNAVAILABLE';
  readonly headwayWaitReserveSeconds: number | null;
  readonly boardingAccessMinimumSeconds: number | null;
  readonly headwayBasis: string;
  readonly boardingAccessBasis: string;
  readonly executionWindow: {
    readonly plannedDeparture: string | null;
    readonly plannedArrival: string | null;
  };
  readonly totalSystemMinimumSeconds: number | null;
  readonly etaRangeSeconds: readonly [number, number] | null;
  readonly feasibility: 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';
  readonly reasonCodes: readonly string[];
  readonly requiresRouteReevaluation: boolean;
}

export interface GroundTransitTransferSafetyView {
  readonly policyVersion: string;
  readonly realtimeFreshness: 'FRESH' | 'STALE' | 'UNAVAILABLE';
  readonly transferMinimumSeconds: number | null;
  readonly transferBasis: string;
  readonly totalSystemMinimumSeconds: number | null;
  readonly feasibility: 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';
  readonly reasonCodes: readonly string[];
  readonly requiresRouteReevaluation: boolean;
}

export interface GroundTransitLegView {
  readonly id: string;
  readonly transportEdgeId: string;
  readonly adoptedRouteId: string;
  readonly legIndex: number;
  readonly mode: 'RAIL' | 'BUS';
  readonly provider: string;
  readonly serviceClass: 'FIXED_SERVICE' | 'HIGH_FREQUENCY' | null;
  readonly serviceIdentityKey: string | null;
  readonly state: GroundTransitLegStateView;
  readonly baseline: unknown;
  readonly latestObservation: unknown | null;
  readonly latestFetchedAt: string | null;
  readonly observationCount: number;
  readonly deviationConsecutiveObservations: number;
  readonly deviationStartedAt: string | null;
  readonly current: boolean;
  readonly operational: {
    readonly policyVersion: string;
    readonly disposition:
      | 'CONTINUE_CURRENT_PLAN'
      | 'CURRENT_PLAN_AT_RISK'
      | 'CURRENT_PLAN_NO_LONGER_FEASIBLE';
    readonly requiredAction: 'NONE' | 'ROUTE_REEVALUATION_REQUIRED';
    readonly changeKinds: readonly string[];
    readonly reasonCodes: readonly string[];
    readonly targetServiceability: {
      readonly boarding: 'SERVED' | 'NOT_SERVED' | 'UNKNOWN';
      readonly alighting: 'SERVED' | 'NOT_SERVED' | 'UNKNOWN';
    };
    readonly requiresUserAttention: boolean;
    readonly notificationPriority: 'NORMAL' | 'STRONG' | null;
    readonly observationEvidenceRef: string | null;
    readonly irreversibleActualMiss: boolean;
  };
  readonly safety: {
    readonly boarding: GroundTransitBoardingSafetyView;
    readonly transferToNext: GroundTransitTransferSafetyView | null;
  };
}

export interface GroundTransitExecutionResponse {
  readonly tripId: string;
  readonly tripVersion: number;
  readonly legs: readonly GroundTransitLegView[];
}

export interface GroundTransitRefreshResponse {
  readonly status:
    | 'APPLIED'
    | 'STALE_IGNORED'
    | 'IDEMPOTENT'
    | 'OBSERVATION_CONFLICT'
    | 'IDENTITY_UNKNOWN'
    | 'DIFFERENT_SERVICE';
  readonly leg: GroundTransitLegView;
}
