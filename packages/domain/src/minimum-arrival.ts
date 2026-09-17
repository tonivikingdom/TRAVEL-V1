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
const ABSOLUTE_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

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

  const departureEpoch = parseAbsoluteIsoInstant(input.departureInstant);

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

function parseAbsoluteIsoInstant(value: string): number {
  const match = ABSOLUTE_ISO_PATTERN.exec(value);
  if (match === null) {
    throw new RangeError(
      'departureInstant must be an ISO-8601 date-time with Z or an explicit UTC offset',
    );
  }

  const [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    offsetText,
  ] = match.slice(1);
  if (offsetText === undefined) {
    throw new RangeError('departureInstant must use a valid UTC offset');
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const milliseconds =
    fractionText === undefined ? 0 : Number(fractionText.padEnd(3, '0'));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new RangeError('departureInstant must be a valid ISO-8601 instant');
  }

  const offsetMinutes = parseOffsetMinutes(offsetText);
  const localEpoch = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    milliseconds,
  );
  const departureEpoch = localEpoch - offsetMinutes * 60_000;

  if (!Number.isFinite(departureEpoch)) {
    throw new RangeError('departureInstant must be a valid ISO-8601 instant');
  }

  return departureEpoch;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseOffsetMinutes(offset: string): number {
  if (offset === 'Z') {
    return 0;
  }

  const sign = offset.startsWith('+') ? 1 : -1;
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));

  if (
    offset === '-00:00' ||
    hours > 23 ||
    minutes > 59 ||
    (hours === 23 && minutes > 59)
  ) {
    throw new RangeError('departureInstant must use a valid UTC offset');
  }

  return sign * (hours * 60 + minutes);
}
