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
  /** Missing on legacy observations means UNKNOWN, never an inferred stop call. */
  readonly boardingTargetServiceability?: GroundTransitTargetServiceability;
  readonly alightingTargetServiceability?: GroundTransitTargetServiceability;
  readonly currentTerminusRef?: string | null;
  readonly currentTerminusLabel?: string | null;
  readonly operatingFromHubRef?: string | null;
  readonly operatingToHubRef?: string | null;
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
    value.currentTerminusRef ?? null,
    value.currentTerminusLabel ?? null,
    value.operatingFromHubRef ?? null,
    value.operatingToHubRef ?? null,
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
    [
      value.boardingTargetServiceability,
      value.alightingTargetServiceability,
    ].every(
      (item) =>
        item === undefined ||
        ['SERVED', 'NOT_SERVED', 'UNKNOWN'].includes(item),
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

export type GroundTransitTargetServiceability =
  'SERVED' | 'NOT_SERVED' | 'UNKNOWN';

export const GROUND_TRANSIT_OPERATIONAL_POLICY = {
  version: 'ground-transit-operational-v1',
  executionWindowMs: 60 * 60_000,
  shortFixedServiceDelaySeconds: 8 * 60,
  longFixedServiceDelaySeconds: 15 * 60,
  longLegSeconds: 45 * 60,
  farAwayDelayMultiplier: 2,
  highFrequencyHeadwayMultiplier: 2,
} as const;

export type GroundTransitChangeKind =
  | 'SERVICE_CANCELLED'
  | 'EARLY_DEPARTURE'
  | 'MATERIAL_DELAY'
  | 'DEPARTURE_PLATFORM_CHANGED'
  | 'ARRIVAL_PLATFORM_CHANGED'
  | 'BOARDING_TARGET_NO_LONGER_SERVED'
  | 'ALIGHTING_TARGET_NO_LONGER_SERVED'
  | 'SERVICE_SHORT_TURNED'
  | 'TERMINUS_CHANGED'
  | 'DOWNSTREAM_PROTECTED_CONNECTION_AT_RISK'
  | 'SERVICE_RESTORED';

export interface GroundTransitOperationalAssessment {
  readonly policyVersion: typeof GROUND_TRANSIT_OPERATIONAL_POLICY.version;
  readonly disposition:
    | 'CONTINUE_CURRENT_PLAN'
    | 'CURRENT_PLAN_AT_RISK'
    | 'CURRENT_PLAN_NO_LONGER_FEASIBLE';
  readonly requiredAction: 'NONE' | 'ROUTE_REEVALUATION_REQUIRED';
  readonly changeKinds: readonly GroundTransitChangeKind[];
  readonly reasonCodes: readonly string[];
  readonly targetServiceability: {
    readonly boarding: GroundTransitTargetServiceability;
    readonly alighting: GroundTransitTargetServiceability;
  };
  readonly requiresUserAttention: boolean;
  readonly notificationPriority: 'NORMAL' | 'STRONG' | null;
  readonly observationEvidenceRef: string | null;
  readonly irreversibleActualMiss: boolean;
}

/** Provider facts have no GPS-style hysteresis after identity and ordering acceptance. */
export function assessGroundTransitOperational(input: {
  readonly baseline: GroundTransitBaseline;
  readonly previousObservation: GroundTransitObservation | null;
  readonly latestObservation: GroundTransitObservation | null;
  readonly now: Date;
  readonly state: GroundTransitLegState;
  readonly current: boolean;
  readonly availableAtBoarding: Date | null;
  readonly actualServiceDeparture?: Date | null;
  readonly downstreamProtectedDeparture: Date | null;
}): GroundTransitOperationalAssessment {
  const { baseline, now } = input;
  const latest = input.latestObservation;
  const fresh =
    latest !== null &&
    latest.fetchedAt.getTime() <= now.getTime() &&
    now.getTime() - latest.fetchedAt.getTime() <=
      GROUND_TRANSIT_POLICY.realtimeFreshnessMs &&
    matchGroundTransitIdentity(baseline, latest) === 'MATCHED';
  // A confirmed destination arrival (or completed handoff) outranks later
  // operational reports about the vehicle's ability to serve that destination.
  const current =
    input.current &&
    input.state !== 'COMPLETED' &&
    input.state !== 'ARRIVED_PENDING_HANDOFF';
  const fact = fresh && current ? latest : null;
  const prior = input.previousObservation;
  const boarding = fact?.boardingTargetServiceability ?? 'UNKNOWN';
  const alighting = fact?.alightingTargetServiceability ?? 'UNKNOWN';
  const departure =
    fact?.actualDeparture ??
    fact?.estimatedDeparture ??
    baseline.plannedDeparture;
  const arrival =
    fact?.actualArrival ?? fact?.estimatedArrival ?? baseline.plannedArrival;
  const baselineDeparture = baseline.plannedDeparture?.getTime() ?? null;
  const baselineArrival = baseline.plannedArrival?.getTime() ?? null;
  const departureDelta =
    departure !== null && baselineDeparture !== null
      ? departure.getTime() - baselineDeparture
      : null;
  const arrivalDelta =
    arrival !== null && baselineArrival !== null
      ? arrival.getTime() - baselineArrival
      : null;
  const executionWindow =
    input.state === 'IN_PROGRESS' ||
    input.state === 'ARRIVED_PENDING_HANDOFF' ||
    (baselineDeparture !== null &&
      Math.abs(baselineDeparture - now.getTime()) <=
        GROUND_TRANSIT_OPERATIONAL_POLICY.executionWindowMs);
  const actualDeparture =
    input.actualServiceDeparture ?? fact?.actualDeparture ?? null;
  const latestArrivalMiss =
    actualDeparture !== null &&
    input.availableAtBoarding !== null &&
    input.availableAtBoarding.getTime() > actualDeparture.getTime();
  const earlyInfeasible =
    departureDelta !== null &&
    departureDelta < 0 &&
    departure !== null &&
    input.availableAtBoarding !== null &&
    input.availableAtBoarding.getTime() +
      (baseline.boardingAccessMinimumSeconds ?? 0) * 1000 >
      departure.getTime();
  const targetLost = boarding === 'NOT_SERVED' || alighting === 'NOT_SERVED';
  // HIGH_FREQUENCY adoption identifies a corridor, not one vehicle. A generic
  // cancellation report cannot invalidate the entire corridor.
  const cancelled =
    baseline.serviceClass === 'FIXED_SERVICE' &&
    fact?.serviceStatus === 'CANCELLED';
  const priorFailureUnrebutted =
    input.state === 'NO_LONGER_FEASIBLE' &&
    !(
      fact !== null &&
      !cancelled &&
      boarding === 'SERVED' &&
      alighting === 'SERVED'
    );
  const downstreamImpact =
    arrival !== null &&
    input.downstreamProtectedDeparture !== null &&
    (arrival.getTime() > input.downstreamProtectedDeparture.getTime() ||
      (baseline.minimumTransferSeconds !== null &&
        arrival.getTime() + baseline.minimumTransferSeconds * 1000 >
          input.downstreamProtectedDeparture.getTime()));
  const priorArrival =
    prior?.actualArrival ?? prior?.estimatedArrival ?? baseline.plannedArrival;
  const priorDownstreamImpact =
    priorArrival !== null &&
    input.downstreamProtectedDeparture !== null &&
    (priorArrival.getTime() > input.downstreamProtectedDeparture.getTime() ||
      (baseline.minimumTransferSeconds !== null &&
        priorArrival.getTime() + baseline.minimumTransferSeconds * 1000 >
          input.downstreamProtectedDeparture.getTime()));
  const newDownstreamImpact = downstreamImpact && !priorDownstreamImpact;
  const durationSeconds =
    baselineDeparture !== null && baselineArrival !== null
      ? Math.max(0, (baselineArrival - baselineDeparture) / 1000)
      : 0;
  const baseDelayThreshold =
    baseline.serviceClass === 'HIGH_FREQUENCY'
      ? (baseline.headwayMaxSeconds ??
          GROUND_TRANSIT_OPERATIONAL_POLICY.longFixedServiceDelaySeconds) *
        GROUND_TRANSIT_OPERATIONAL_POLICY.highFrequencyHeadwayMultiplier
      : durationSeconds <= GROUND_TRANSIT_OPERATIONAL_POLICY.longLegSeconds
        ? GROUND_TRANSIT_OPERATIONAL_POLICY.shortFixedServiceDelaySeconds
        : GROUND_TRANSIT_OPERATIONAL_POLICY.longFixedServiceDelaySeconds;
  const threshold = executionWindow
    ? baseDelayThreshold
    : baseDelayThreshold *
      GROUND_TRANSIT_OPERATIONAL_POLICY.farAwayDelayMultiplier;
  const delayThresholdMs = threshold * 1000;
  const materialDelay =
    arrivalDelta !== null && arrivalDelta >= delayThresholdMs;
  const previousArrivalDelta =
    priorArrival !== null && baselineArrival !== null
      ? priorArrival.getTime() - baselineArrival
      : null;
  // A persistent incident is not a new user-visible event. Escalation is
  // expressed in context-relative threshold bands, not each ETA drift.
  const currentDelayBand =
    materialDelay && arrivalDelta !== null
      ? Math.floor(arrivalDelta / delayThresholdMs)
      : 0;
  const previousDelayBand =
    previousArrivalDelta !== null && previousArrivalDelta >= delayThresholdMs
      ? Math.floor(previousArrivalDelta / delayThresholdMs)
      : 0;
  const materialDelayEscalated = currentDelayBand > previousDelayBand;
  const changes: GroundTransitChangeKind[] = [];
  if (fact !== null) {
    if (cancelled && prior?.serviceStatus !== 'CANCELLED')
      changes.push('SERVICE_CANCELLED');
    if (
      departureDelta !== null &&
      departureDelta < 0 &&
      (prior?.estimatedDeparture?.getTime() ?? baselineDeparture) !==
        departure?.getTime()
    )
      changes.push('EARLY_DEPARTURE');
    if (materialDelayEscalated) changes.push('MATERIAL_DELAY');
    if (newDownstreamImpact)
      changes.push('DOWNSTREAM_PROTECTED_CONNECTION_AT_RISK');
    if (
      fact.departurePlatform !== null &&
      prior?.departurePlatform !== null &&
      prior?.departurePlatform !== undefined &&
      fact.departurePlatform !== prior.departurePlatform
    )
      changes.push('DEPARTURE_PLATFORM_CHANGED');
    if (
      fact.arrivalPlatform !== null &&
      prior?.arrivalPlatform !== null &&
      prior?.arrivalPlatform !== undefined &&
      fact.arrivalPlatform !== prior.arrivalPlatform
    )
      changes.push('ARRIVAL_PLATFORM_CHANGED');
    if (
      boarding === 'NOT_SERVED' &&
      prior?.boardingTargetServiceability !== 'NOT_SERVED'
    )
      changes.push('BOARDING_TARGET_NO_LONGER_SERVED');
    if (
      alighting === 'NOT_SERVED' &&
      prior?.alightingTargetServiceability !== 'NOT_SERVED'
    )
      changes.push('ALIGHTING_TARGET_NO_LONGER_SERVED');
    const terminusChanged =
      fact.currentTerminusRef !== null &&
      fact.currentTerminusRef !== undefined &&
      prior?.currentTerminusRef !== null &&
      prior?.currentTerminusRef !== undefined &&
      fact.currentTerminusRef !== prior.currentTerminusRef;
    if (
      targetLost &&
      fact.currentTerminusRef !== null &&
      fact.currentTerminusRef !== undefined &&
      (changes.includes('BOARDING_TARGET_NO_LONGER_SERVED') ||
        changes.includes('ALIGHTING_TARGET_NO_LONGER_SERVED') ||
        terminusChanged)
    )
      changes.push('SERVICE_SHORT_TURNED');
    if (terminusChanged) changes.push('TERMINUS_CHANGED');
    if (
      !latestArrivalMiss &&
      !earlyInfeasible &&
      ((baseline.serviceClass === 'FIXED_SERVICE' &&
        prior?.serviceStatus === 'CANCELLED' &&
        !cancelled &&
        boarding === 'SERVED' &&
        alighting === 'SERVED') ||
        ((prior?.boardingTargetServiceability === 'NOT_SERVED' ||
          prior?.alightingTargetServiceability === 'NOT_SERVED') &&
          boarding === 'SERVED' &&
          alighting === 'SERVED' &&
          !cancelled))
    )
      changes.push('SERVICE_RESTORED');
  }
  const infeasible =
    current &&
    (cancelled ||
      targetLost ||
      latestArrivalMiss ||
      earlyInfeasible ||
      priorFailureUnrebutted);
  const atRisk =
    current &&
    !infeasible &&
    (downstreamImpact ||
      (departureDelta !== null && departureDelta < 0 && executionWindow) ||
      (materialDelay && executionWindow));
  const attention =
    current &&
    ((infeasible && changes.length > 0) ||
      changes.includes('SERVICE_RESTORED') ||
      (changes.includes('EARLY_DEPARTURE') && executionWindow) ||
      (materialDelayEscalated && (executionWindow || downstreamImpact)) ||
      newDownstreamImpact ||
      (executionWindow &&
        (changes.includes('DEPARTURE_PLATFORM_CHANGED') ||
          changes.includes('ARRIVAL_PLATFORM_CHANGED'))));
  return {
    policyVersion: GROUND_TRANSIT_OPERATIONAL_POLICY.version,
    disposition: infeasible
      ? 'CURRENT_PLAN_NO_LONGER_FEASIBLE'
      : atRisk
        ? 'CURRENT_PLAN_AT_RISK'
        : 'CONTINUE_CURRENT_PLAN',
    requiredAction:
      infeasible || downstreamImpact ? 'ROUTE_REEVALUATION_REQUIRED' : 'NONE',
    changeKinds: changes,
    reasonCodes: [
      ...(cancelled ? ['SERVICE_CANCELLED'] : []),
      ...(boarding === 'NOT_SERVED' ? ['BOARDING_TARGET_NOT_SERVED'] : []),
      ...(alighting === 'NOT_SERVED' ? ['ALIGHTING_TARGET_NOT_SERVED'] : []),
      ...(latestArrivalMiss ? ['IRREVERSIBLE_ACTUAL_MISS'] : []),
      ...(priorFailureUnrebutted ? ['PRIOR_FAILURE_NOT_YET_REBUTTED'] : []),
      ...(earlyInfeasible ? ['EARLY_DEPARTURE_MISSED'] : []),
      ...(downstreamImpact ? ['DOWNSTREAM_PROTECTED_CONNECTION_AT_RISK'] : []),
    ],
    targetServiceability: { boarding, alighting },
    requiresUserAttention: attention,
    notificationPriority: attention
      ? infeasible || changes.includes('SERVICE_RESTORED')
        ? 'STRONG'
        : 'NORMAL'
      : null,
    observationEvidenceRef:
      fact === null
        ? null
        : `ground-transit-observation:${fact.observationIdentity}`,
    irreversibleActualMiss: latestArrivalMiss,
  };
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
    (baseline.serviceClass === 'FIXED_SERVICE' &&
      realtime?.serviceStatus === 'CANCELLED') ||
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
    baseline.serviceClass === 'FIXED_SERVICE' &&
    realtime?.serviceStatus === 'CANCELLED'
      ? 'SERVICE_CANCELLED'
      : null,
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

/** Provider reports may invalidate a pending trip, but cannot manufacture
 * ridership or rewind independently confirmed destination arrival. */
export function resolveGroundTransitProviderState(input: {
  readonly previous: GroundTransitLegState;
  readonly noLongerFeasible: boolean;
  /** fromState of the latest transition into NO_LONGER_FEASIBLE. */
  readonly beforeFailureState: GroundTransitLegState | null;
}): GroundTransitLegState {
  if (
    input.previous === 'COMPLETED' ||
    input.previous === 'ARRIVED_PENDING_HANDOFF'
  )
    return input.previous;
  if (input.noLongerFeasible) return 'NO_LONGER_FEASIBLE';
  if (input.previous !== 'NO_LONGER_FEASIBLE') return input.previous;
  return input.beforeFailureState === 'IN_PROGRESS'
    ? 'IN_PROGRESS'
    : input.beforeFailureState === 'UNKNOWN'
      ? 'UNKNOWN'
      : 'PENDING';
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
