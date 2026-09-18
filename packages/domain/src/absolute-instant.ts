export type AbsoluteInstantErrorReason =
  'FORMAT' | 'INVALID_COMPONENT' | 'INVALID_OFFSET' | 'PRECISION';

export class AbsoluteInstantError extends RangeError {
  constructor(
    readonly reason: AbsoluteInstantErrorReason,
    fieldName: string,
  ) {
    super(absoluteInstantMessage(reason, fieldName));
    this.name = 'AbsoluteInstantError';
  }
}

const ABSOLUTE_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/u;

/**
 * Parses an already resolved ISO-8601 instant without consulting the host time
 * zone. Persistence uses millisecond precision, so longer fractions are
 * rejected instead of silently truncated.
 */
export function parseAbsoluteIsoInstant(
  value: string,
  fieldName = 'instant',
): Date {
  const match = ABSOLUTE_ISO_PATTERN.exec(value);
  if (match === null) {
    throw new AbsoluteInstantError('FORMAT', fieldName);
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
    throw new AbsoluteInstantError('INVALID_OFFSET', fieldName);
  }
  if (fractionText !== undefined && fractionText.length > 3) {
    throw new AbsoluteInstantError('PRECISION', fieldName);
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
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new AbsoluteInstantError('INVALID_COMPONENT', fieldName);
  }

  const offsetMinutes = parseOffsetMinutes(offsetText, fieldName);
  const local = new Date(0);
  local.setUTCHours(hour, minute, second, milliseconds);
  local.setUTCFullYear(year, month - 1, day);
  const timestamp = local.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(timestamp)) {
    throw new AbsoluteInstantError('INVALID_COMPONENT', fieldName);
  }
  return new Date(timestamp);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseOffsetMinutes(offset: string, fieldName: string): number {
  if (offset === 'Z') {
    return 0;
  }
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  if (
    offset === '-00:00' ||
    hours > 14 ||
    minutes > 59 ||
    (hours === 14 && minutes !== 0)
  ) {
    throw new AbsoluteInstantError('INVALID_OFFSET', fieldName);
  }
  const sign = offset.startsWith('+') ? 1 : -1;
  return sign * (hours * 60 + minutes);
}

function absoluteInstantMessage(
  reason: AbsoluteInstantErrorReason,
  fieldName: string,
): string {
  switch (reason) {
    case 'FORMAT':
      return `${fieldName} must be an ISO-8601 date-time with Z or an explicit UTC offset`;
    case 'INVALID_OFFSET':
      return `${fieldName} must use a valid UTC offset`;
    case 'PRECISION':
      return `${fieldName} must not exceed millisecond precision`;
    case 'INVALID_COMPONENT':
      return `${fieldName} must be a valid ISO-8601 instant`;
  }
}
