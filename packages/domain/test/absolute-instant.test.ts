import { describe, expect, it } from 'vitest';

import { parseAbsoluteIsoInstant } from '../src/index.js';

describe('parseAbsoluteIsoInstant', () => {
  it.each([
    '2030-02-30T10:00:00Z',
    '2030-02-29T10:00:00Z',
    '2030-01-01T24:00:00Z',
    '2030-01-01T10:60:00Z',
    '2030-01-01T10:00:60Z',
  ])('rejects an invalid calendar or clock component: %s', (value) => {
    expect(() => parseAbsoluteIsoInstant(value)).toThrow(RangeError);
  });

  it('accepts a valid leap-day and normalizes equivalent Z/offset values', () => {
    expect(parseAbsoluteIsoInstant('2032-02-29T10:00:00Z').toISOString()).toBe(
      '2032-02-29T10:00:00.000Z',
    );
    expect(parseAbsoluteIsoInstant('2032-02-29T18:00:00+08:00').getTime()).toBe(
      parseAbsoluteIsoInstant('2032-02-29T10:00:00Z').getTime(),
    );
  });

  it.each([
    '2030-01-01T10:00:00',
    '2030-01-01',
    '2030-01-01T10:00:00+14:01',
    '2030-01-01T10:00:00+15:00',
    '2030-01-01T10:00:00-00:00',
    '2030-01-01T10:00:00+08:60',
  ])('rejects a missing or invalid offset: %s', (value) => {
    expect(() => parseAbsoluteIsoInstant(value)).toThrow(RangeError);
  });

  it('accepts at most millisecond precision and rejects silent truncation', () => {
    expect(
      parseAbsoluteIsoInstant('2030-01-01T10:00:00.123Z').toISOString(),
    ).toBe('2030-01-01T10:00:00.123Z');
    expect(() => parseAbsoluteIsoInstant('2030-01-01T10:00:00.1234Z')).toThrow(
      RangeError,
    );
  });

  it('does not depend on the host timezone', () => {
    const runtimeProcess = (
      globalThis as unknown as {
        process: { env: Record<string, string | undefined> };
      }
    ).process;
    const originalTimezone = runtimeProcess.env.TZ;
    try {
      runtimeProcess.env.TZ = 'UTC';
      const utc = parseAbsoluteIsoInstant(
        '2030-01-01T18:00:00+08:00',
      ).getTime();
      runtimeProcess.env.TZ = 'America/Los_Angeles';
      const pacific = parseAbsoluteIsoInstant(
        '2030-01-01T18:00:00+08:00',
      ).getTime();
      expect(pacific).toBe(utc);
    } finally {
      if (originalTimezone === undefined) {
        delete runtimeProcess.env.TZ;
      } else {
        runtimeProcess.env.TZ = originalTimezone;
      }
    }
  });
});
