import { describe, expect, it } from 'vitest';

import { deriveMinimumArrival } from '../src/index.js';

describe('deriveMinimumArrival', () => {
  const input = (departureInstant: string) => ({
    departureInstant,
    minimumLeadMinutes: 40,
    sourceRefs: ['departure:fixture-1', 'constraint:fixture-1'],
    policyVersion: 'SYNTHETIC-P0',
  });

  it('keeps calculation provenance separate from the departure fact', () => {
    expect(deriveMinimumArrival(input('2026-09-17T12:21:00.000Z'))).toEqual({
      instant: '2026-09-17T11:41:00.000Z',
      sourceKind: 'CALCULATED',
      sourceRefs: ['departure:fixture-1', 'constraint:fixture-1'],
      ruleId: 'SCHEDULE.MINIMUM_ARRIVAL',
      policyVersion: 'SYNTHETIC-P0',
    });
  });

  it('accepts an explicit UTC offset and normalizes to UTC', () => {
    expect(deriveMinimumArrival(input('2026-09-17T12:21:00+08:00'))).toEqual({
      instant: '2026-09-17T03:41:00.000Z',
      sourceKind: 'CALCULATED',
      sourceRefs: ['departure:fixture-1', 'constraint:fixture-1'],
      ruleId: 'SCHEDULE.MINIMUM_ARRIVAL',
      policyVersion: 'SYNTHETIC-P0',
    });
  });

  it.each(['2026-09-17T12:21:00', '2026-09-17', '2026-02-29T12:21:00Z'])(
    'rejects an absolute instant without a valid zone: %s',
    (departureInstant) => {
      expect(() => deriveMinimumArrival(input(departureInstant))).toThrow(
        RangeError,
      );
    },
  );

  it('does not depend on the host timezone for a legal absolute instant', () => {
    const runtimeProcess = (
      globalThis as unknown as {
        process: { env: Record<string, string | undefined> };
      }
    ).process;
    const originalTimezone = runtimeProcess.env.TZ;
    try {
      runtimeProcess.env.TZ = 'UTC';
      const utcResult = deriveMinimumArrival(input('2026-09-17T12:21:00Z'));
      runtimeProcess.env.TZ = 'America/Los_Angeles';
      const pacificResult = deriveMinimumArrival(input('2026-09-17T12:21:00Z'));

      expect(pacificResult).toEqual(utcResult);
    } finally {
      if (originalTimezone === undefined) {
        delete runtimeProcess.env.TZ;
      } else {
        runtimeProcess.env.TZ = originalTimezone;
      }
    }
  });

  it('rejects invalid minute values instead of silently correcting them', () => {
    expect(() =>
      deriveMinimumArrival({
        ...input('2026-09-17T12:21:00.000Z'),
        minimumLeadMinutes: -1,
        sourceRefs: [],
      }),
    ).toThrow(RangeError);
  });
});
