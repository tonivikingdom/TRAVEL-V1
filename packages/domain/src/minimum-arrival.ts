export interface MinimumArrivalInput {
  readonly departureInstant: string;
  readonly minimumLeadMinutes: number;
  readonly sourceRefs: readonly string[];
  readonly policyVersion: string;
}

export interface DerivedTimeValue {
  readonly instant: string;
  readonly sourceKind: 'CALCULATED';
  readonly sourceRefs: readonly string[];
  readonly ruleId: 'SCHEDULE.MINIMUM_ARRIVAL';
  readonly policyVersion: string;
}

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Minimal deterministic domain example.
 *
 * It deliberately accepts an already resolved instant. Local date/time and IANA
 * time-zone disambiguation belong to later, explicitly gated domain work.
 */
export function deriveMinimumArrival(
  input: MinimumArrivalInput,
): DerivedTimeValue {
  if (
    !Number.isInteger(input.minimumLeadMinutes) ||
    input.minimumLeadMinutes < 0
  ) {
    throw new RangeError('minimumLeadMinutes must be a non-negative integer');
  }

  const departureEpoch = Date.parse(input.departureInstant);
  if (!Number.isFinite(departureEpoch)) {
    throw new RangeError('departureInstant must be a valid ISO-8601 instant');
  }

  return {
    instant: new Date(
      departureEpoch - input.minimumLeadMinutes * MILLISECONDS_PER_MINUTE,
    ).toISOString(),
    sourceKind: 'CALCULATED',
    sourceRefs: [...input.sourceRefs],
    ruleId: 'SCHEDULE.MINIMUM_ARRIVAL',
    policyVersion: input.policyVersion,
  };
}
