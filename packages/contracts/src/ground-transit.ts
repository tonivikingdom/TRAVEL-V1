export type GroundTransitLegStateView =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'ARRIVED_PENDING_HANDOFF'
  | 'COMPLETED'
  | 'NO_LONGER_FEASIBLE'
  | 'UNKNOWN';

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
  readonly safety: {
    readonly policyVersion: string;
    readonly realtimeFreshness: 'FRESH' | 'STALE' | 'UNAVAILABLE';
    readonly headwayWaitReserveSeconds: number | null;
    readonly transferMinimumSeconds: number | null;
    readonly headwayBasis: string;
    readonly transferBasis: string;
    readonly executionWindow: {
      readonly plannedDeparture: string | null;
      readonly plannedArrival: string | null;
    };
    readonly totalSystemMinimumSeconds: number | null;
    readonly etaRangeSeconds: readonly [number, number] | null;
    readonly feasibility: 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';
    readonly reasonCodes: readonly string[];
    readonly requiresRouteReevaluation: boolean;
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
