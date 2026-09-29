/** Deterministic, provider-neutral P5E2 policy. All comparisons use instants. */
export const GROUND_TRANSIT_POLICY = {
  version: 'ground-transit-execution-v1',
  realtimeFreshnessMs: 5 * 60_000,
  sustainedDeviationMinimumObservations: 2,
  sustainedDeviationMinimumMs: 2 * 60_000,
  minimumDeviationSeconds: 60,
  monitorIntervalMs: 5 * 60_000,
  monitorLeadMs: 2 * 60 * 60_000,
  monitorTailMs: 2 * 60 * 60_000,
} as const;

export type GroundTransitServiceClass = 'FIXED_SERVICE' | 'HIGH_FREQUENCY';
export type GroundTransitMode = 'RAIL' | 'BUS';
export type GroundTransitLegState =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'ARRIVED_PENDING_HANDOFF'
  | 'COMPLETED'
  | 'NO_LONGER_FEASIBLE'
  | 'UNKNOWN';

export interface GroundTransitBaseline {
  readonly provider: string;
  readonly mode: GroundTransitMode;
  readonly serviceClass: GroundTransitServiceClass;
  readonly serviceIdentityKey: string | null;
  readonly lineRef: string | null;
  readonly directionRef: string | null;
  readonly boardingHubRef: string | null;
  readonly alightingHubRef: string | null;
  readonly headwayMinSeconds: number | null;
  readonly headwayMaxSeconds: number | null;
  /** Complete transfer after alighting this leg to the next leg; never boarding access. */
  readonly minimumTransferSeconds: number | null;
  /** Access before boarding this leg; independent of transfer after alighting. */
  readonly boardingAccessMinimumSeconds?: number | null;
  readonly hasOnwardConnection?: boolean;
  readonly plannedDeparture: Date | null;
  readonly plannedArrival: Date | null;
}

export interface GroundTransitObservation {
  readonly provider: string;
  readonly observationIdentity: string;
  readonly fetchedAt: Date;
  readonly serviceClass: GroundTransitServiceClass;
  readonly mode: GroundTransitMode;
  readonly lineRef: string | null;
  readonly lineName: string | null;
  readonly directionRef: string | null;
  readonly directionLabel: string | null;
  readonly boardingHubRef: string | null;
  readonly alightingHubRef: string | null;
  readonly serviceIdentityKey: string | null;
  readonly scheduledDeparture: Date | null;
  readonly scheduledArrival: Date | null;
  readonly estimatedDeparture: Date | null;
  readonly estimatedArrival: Date | null;
  readonly actualDeparture: Date | null;
  readonly actualArrival: Date | null;
  readonly departurePlatform: string | null;
  readonly arrivalPlatform: string | null;
  readonly serviceStatus: 'ON_TIME' | 'DELAYED' | 'CANCELLED' | 'UNKNOWN';
  readonly headwayMinSeconds: number | null;
  readonly headwayMaxSeconds: number | null;
  readonly nextDepartureInSeconds: number | null;
  /** Complete transfer after alighting this leg to the next leg; never boarding access. */
  readonly minimumTransferSeconds: number | null;
}

export function validGroundTransitObservation(
  value: GroundTransitObservation,
): boolean {
  if (value === null || typeof value !== 'object') return false;
  const dates = [
    value.fetchedAt,
    value.scheduledDeparture,
    value.scheduledArrival,
    value.estimatedDeparture,
    value.estimatedArrival,
    value.actualDeparture,
    value.actualArrival,
  ];
  const strings = [
    value.lineRef,
    value.lineName,
    value.directionRef,
    value.directionLabel,
    value.boardingHubRef,
    value.alightingHubRef,
    value.serviceIdentityKey,
    value.departurePlatform,
    value.arrivalPlatform,
  ];
  const numbers = [
    value.headwayMinSeconds,
    value.headwayMaxSeconds,
    value.nextDepartureInSeconds,
    value.minimumTransferSeconds,
  ];
  return (
    typeof value.provider === 'string' &&
    value.provider.length > 0 &&
    value.provider.length <= 100 &&
    typeof value.observationIdentity === 'string' &&
    value.observationIdentity.length > 0 &&
    value.observationIdentity.length <= 300 &&
    (value.mode === 'RAIL' || value.mode === 'BUS') &&
    (value.serviceClass === 'FIXED_SERVICE' ||
      value.serviceClass === 'HIGH_FREQUENCY') &&
    ['ON_TIME', 'DELAYED', 'CANCELLED', 'UNKNOWN'].includes(
      value.serviceStatus,
    ) &&
    dates.every(
      (date) =>
        date === null ||
        (date instanceof Date && Number.isFinite(date.getTime())),
    ) &&
    strings.every(
      (text) =>
        text === null ||
        (typeof text === 'string' && text.length > 0 && text.length <= 300),
    ) &&
    numbers.every(
      (number) =>
        number === null || (Number.isSafeInteger(number) && number >= 0),
    ) &&
    (value.headwayMinSeconds === null ||
      value.headwayMaxSeconds === null ||
      value.headwayMinSeconds <= value.headwayMaxSeconds)
  );
}

export type GroundTransitObservationAcceptance =
  'APPLIED' | 'STALE_IGNORED' | 'IDEMPOTENT' | 'OBSERVATION_CONFLICT';

export function decideGroundTransitObservationOrdering(input: {
  readonly previousFetchedAt: Date | null;
  readonly previousObservationIdentity: string | null;
  readonly previousFactsHash: string | null;
  readonly incomingFetchedAt: Date;
  readonly incomingObservationIdentity: string;
  readonly incomingFactsHash: string;
}): GroundTransitObservationAcceptance {
  if (input.previousFetchedAt === null) return 'APPLIED';
  const difference =
    input.incomingFetchedAt.getTime() - input.previousFetchedAt.getTime();
  if (difference < 0) return 'STALE_IGNORED';
  if (difference > 0) return 'APPLIED';
  return input.incomingObservationIdentity ===
    input.previousObservationIdentity &&
    input.incomingFactsHash === input.previousFactsHash
    ? 'IDEMPOTENT'
    : 'OBSERVATION_CONFLICT';
}

export type GroundTransitIdentityResult =
  'MATCHED' | 'IDENTITY_UNKNOWN' | 'DIFFERENT_SERVICE';

export function matchGroundTransitIdentity(
  baseline: GroundTransitBaseline,
  observation: GroundTransitObservation,
): GroundTransitIdentityResult {
  if (
    baseline.provider !== observation.provider ||
    baseline.mode !== observation.mode ||
    baseline.serviceClass !== observation.serviceClass
  )
    return 'DIFFERENT_SERVICE';
  if (baseline.serviceClass === 'FIXED_SERVICE') {
    if (
      baseline.serviceIdentityKey === null ||
      observation.serviceIdentityKey === null
    )
      return 'IDENTITY_UNKNOWN';
    return baseline.serviceIdentityKey === observation.serviceIdentityKey
      ? 'MATCHED'
      : 'DIFFERENT_SERVICE';
  }
  const basis = [
    baseline.lineRef,
    baseline.directionRef,
    baseline.boardingHubRef,
    baseline.alightingHubRef,
  ];
  const current = [
    observation.lineRef,
    observation.directionRef,
    observation.boardingHubRef,
    observation.alightingHubRef,
  ];
  if (
    basis.some((value) => value === null) ||
    current.some((value) => value === null)
  )
    return 'IDENTITY_UNKNOWN';
  if (baseline.plannedDeparture === null || baseline.plannedArrival === null)
    return 'IDENTITY_UNKNOWN';
  if (
    observation.fetchedAt.getTime() <
      baseline.plannedDeparture.getTime() -
        GROUND_TRANSIT_POLICY.monitorLeadMs ||
    observation.fetchedAt.getTime() >
      baseline.plannedArrival.getTime() + GROUND_TRANSIT_POLICY.monitorTailMs
  )
    return 'IDENTITY_UNKNOWN';
  return basis.every((value, index) => value === current[index])
    ? 'MATCHED'
    : 'DIFFERENT_SERVICE';
}

export interface GroundTransitSafetyAssessment {
  readonly policyVersion: typeof GROUND_TRANSIT_POLICY.version;
  readonly realtimeFreshness: 'FRESH' | 'STALE' | 'UNAVAILABLE';
  readonly headwayWaitReserveSeconds: number | null;
  readonly transferMinimumSeconds: number | null;
  readonly boardingAccessMinimumSeconds: number | null;
  readonly headwayBasis:
    | 'NEXT_DEPARTURE_REALTIME'
    | 'REALTIME_HEADWAY_UPPER'
    | 'ADOPTED_HEADWAY_UPPER'
    | 'UNKNOWN'
    | 'NOT_APPLICABLE';
  readonly transferBasis: 'PROVIDER' | 'ADOPTED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  readonly boardingAccessBasis: 'ADOPTED' | 'UNKNOWN' | 'NOT_APPLICABLE';
  readonly executionWindow: {
    readonly plannedDeparture: Date | null;
    readonly plannedArrival: Date | null;
  };
  readonly totalSystemMinimumSeconds: number | null;
  readonly etaRangeSeconds: readonly [number, number] | null;
  readonly feasibility: 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN';
  readonly reasonCodes: readonly string[];
  readonly requiresRouteReevaluation: boolean;
}

export function assessGroundTransitSafety(input: {
  readonly baseline: GroundTransitBaseline;
  readonly observation: GroundTransitObservation | null;
  readonly now: Date;
  readonly availableAt: Date | null;
  readonly downstreamLatestAt: Date | null;
  readonly boundary: 'BOARDING' | 'TRANSFER_TO_NEXT';
  /** Whether missing boarding access would affect a protected connection. */
  readonly boardingAccessRequired?: boolean;
}): GroundTransitSafetyAssessment {
  const { baseline, now } = input;
  const freshness =
    input.observation === null
      ? 'UNAVAILABLE'
      : now.getTime() - input.observation.fetchedAt.getTime() <=
            GROUND_TRANSIT_POLICY.realtimeFreshnessMs &&
          input.observation.fetchedAt.getTime() <= now.getTime()
        ? 'FRESH'
        : 'STALE';
  const identity =
    input.observation === null
      ? 'IDENTITY_UNKNOWN'
      : matchGroundTransitIdentity(baseline, input.observation);
  const realtime =
    freshness === 'FRESH' && identity === 'MATCHED' ? input.observation : null;
  const transferMinimumSeconds =
    input.boundary === 'TRANSFER_TO_NEXT'
      ? (realtime?.minimumTransferSeconds ?? baseline.minimumTransferSeconds)
      : null;
  const boardingAccessMinimumSeconds =
    input.boundary === 'BOARDING'
      ? (baseline.boardingAccessMinimumSeconds ?? null)
      : null;
  const headwayWaitReserveSeconds =
    input.boundary === 'BOARDING' && baseline.serviceClass === 'HIGH_FREQUENCY'
      ? (realtime?.nextDepartureInSeconds ??
        realtime?.headwayMaxSeconds ??
        baseline.headwayMaxSeconds)
      : input.boundary === 'BOARDING'
        ? 0
        : null;
  const totalSystemMinimumSeconds =
    input.boundary === 'TRANSFER_TO_NEXT'
      ? transferMinimumSeconds
      : headwayWaitReserveSeconds === null ||
          (input.boardingAccessRequired &&
            boardingAccessMinimumSeconds === null)
        ? null
        : headwayWaitReserveSeconds + (boardingAccessMinimumSeconds ?? 0);
  const etaRangeSeconds: readonly [number, number] | null =
    input.boundary !== 'BOARDING' || baseline.serviceClass !== 'HIGH_FREQUENCY'
      ? null
      : realtime?.nextDepartureInSeconds != null
        ? [realtime.nextDepartureInSeconds, realtime.nextDepartureInSeconds]
        : (realtime?.headwayMinSeconds ?? baseline.headwayMinSeconds) !==
              null &&
            (realtime?.headwayMaxSeconds ?? baseline.headwayMaxSeconds) !== null
          ? [
              realtime?.headwayMinSeconds ?? baseline.headwayMinSeconds!,
              realtime?.headwayMaxSeconds ?? baseline.headwayMaxSeconds!,
            ]
          : null;
  const departure =
    realtime?.actualDeparture ??
    realtime?.estimatedDeparture ??
    baseline.plannedDeparture;
  const arrival =
    realtime?.actualArrival ??
    realtime?.estimatedArrival ??
    baseline.plannedArrival;
  const availableAt =
    input.boundary === 'TRANSFER_TO_NEXT'
      ? (input.availableAt ?? arrival)
      : input.availableAt;
  const earliestReady =
    availableAt !== null && totalSystemMinimumSeconds !== null
      ? availableAt.getTime() + totalSystemMinimumSeconds * 1_000
      : null;
  const departureFeasible =
    input.boundary === 'BOARDING'
      ? departure === null || earliestReady === null
        ? null
        : earliestReady <= departure.getTime()
      : input.downstreamLatestAt === null || earliestReady === null
        ? null
        : earliestReady <= input.downstreamLatestAt.getTime();
  const arrivalFeasible =
    input.boundary === 'BOARDING' ||
    arrival === null ||
    input.downstreamLatestAt === null
      ? null
      : arrival.getTime() <= input.downstreamLatestAt.getTime();
  const feasibility =
    realtime?.serviceStatus === 'CANCELLED' ||
    departureFeasible === false ||
    arrivalFeasible === false
      ? 'INFEASIBLE'
      : totalSystemMinimumSeconds === null ||
          (departureFeasible === null && arrivalFeasible === null)
        ? 'UNKNOWN'
        : 'FEASIBLE';
  const reasonCodes = [
    freshness === 'STALE' ? 'REALTIME_STALE' : null,
    identity === 'IDENTITY_UNKNOWN' && input.observation !== null
      ? 'IDENTITY_UNKNOWN'
      : null,
    identity === 'DIFFERENT_SERVICE' ? 'DIFFERENT_SERVICE' : null,
    realtime?.serviceStatus === 'CANCELLED' ? 'SERVICE_CANCELLED' : null,
    input.boundary === 'BOARDING' &&
    baseline.serviceClass === 'HIGH_FREQUENCY' &&
    headwayWaitReserveSeconds === null
      ? 'HEADWAY_UNKNOWN'
      : null,
    input.boundary === 'TRANSFER_TO_NEXT' && transferMinimumSeconds === null
      ? 'TRANSFER_MINIMUM_UNKNOWN'
      : null,
    input.boundary === 'BOARDING' &&
    input.boardingAccessRequired &&
    boardingAccessMinimumSeconds === null
      ? 'BOARDING_ACCESS_UNKNOWN'
      : null,
  ].filter((value): value is string => value !== null);
  return {
    policyVersion: GROUND_TRANSIT_POLICY.version,
    realtimeFreshness: freshness,
    headwayWaitReserveSeconds,
    transferMinimumSeconds,
    boardingAccessMinimumSeconds,
    headwayBasis:
      input.boundary !== 'BOARDING' ||
      baseline.serviceClass !== 'HIGH_FREQUENCY'
        ? 'NOT_APPLICABLE'
        : realtime?.nextDepartureInSeconds !== null &&
            realtime?.nextDepartureInSeconds !== undefined
          ? 'NEXT_DEPARTURE_REALTIME'
          : realtime?.headwayMaxSeconds !== null &&
              realtime?.headwayMaxSeconds !== undefined
            ? 'REALTIME_HEADWAY_UPPER'
            : baseline.headwayMaxSeconds !== null
              ? 'ADOPTED_HEADWAY_UPPER'
              : 'UNKNOWN',
    transferBasis:
      input.boundary !== 'TRANSFER_TO_NEXT'
        ? 'NOT_APPLICABLE'
        : realtime?.minimumTransferSeconds != null
          ? 'PROVIDER'
          : baseline.minimumTransferSeconds !== null
            ? 'ADOPTED'
            : 'UNKNOWN',
    boardingAccessBasis:
      input.boundary !== 'BOARDING'
        ? 'NOT_APPLICABLE'
        : boardingAccessMinimumSeconds === null
          ? 'UNKNOWN'
          : 'ADOPTED',
    executionWindow: {
      plannedDeparture: baseline.plannedDeparture,
      plannedArrival: baseline.plannedArrival,
    },
    totalSystemMinimumSeconds,
    etaRangeSeconds,
    feasibility,
    reasonCodes,
    requiresRouteReevaluation: feasibility === 'INFEASIBLE',
  };
}

export function resolveGroundTransitLegState(input: {
  readonly previous: GroundTransitLegState;
  readonly destinationArrived: boolean;
  readonly executionHandoffComplete: boolean;
  readonly reliableMovementOnCorridor: boolean;
  readonly fixedServiceNoLongerFeasible: boolean;
}): GroundTransitLegState {
  if (input.previous === 'COMPLETED') return 'COMPLETED';
  if (input.destinationArrived && input.executionHandoffComplete)
    return 'COMPLETED';
  if (input.destinationArrived) return 'ARRIVED_PENDING_HANDOFF';
  if (input.fixedServiceNoLongerFeasible) return 'NO_LONGER_FEASIBLE';
  if (input.reliableMovementOnCorridor) return 'IN_PROGRESS';
  return input.previous;
}

export function isSustainedGroundTransitDeviation(input: {
  readonly consecutiveObservations: number;
  readonly startedAt: Date | null;
  readonly now: Date;
}): boolean {
  return (
    input.startedAt !== null &&
    input.consecutiveObservations >=
      GROUND_TRANSIT_POLICY.sustainedDeviationMinimumObservations &&
    input.now.getTime() - input.startedAt.getTime() >=
      GROUND_TRANSIT_POLICY.sustainedDeviationMinimumMs
  );
}
