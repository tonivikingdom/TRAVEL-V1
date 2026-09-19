import { AbsoluteInstantError, parseAbsoluteIsoInstant } from '@travel/domain';

import { ApplicationError } from './errors.js';

const SUPPORTED_IANA_TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

export function parseAbsoluteInstantInput(value: string, field: string): Date {
  if (typeof value !== 'string') {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  try {
    return parseAbsoluteIsoInstant(value, field);
  } catch (error) {
    if (error instanceof AbsoluteInstantError && error.reason === 'FORMAT') {
      throw new ApplicationError(
        'UNSUPPORTED_SCENARIO',
        `${field} 必须是带 Z 或明确 UTC offset 的绝对时刻。`,
        400,
      );
    }
    if (error instanceof AbsoluteInstantError) {
      throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
    }
    throw error;
  }
}

export function validateIanaTimeZoneInput(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 100 ||
    (value !== 'UTC' && !SUPPORTED_IANA_TIME_ZONES.has(value))
  ) {
    throw new ApplicationError('VALIDATION_ERROR', 'timeZone 无效。', 400);
  }
  return value;
}
