import { describe, expect, it } from 'vitest';

import { deriveMinimumArrival } from '../src/index.js';

describe('deriveMinimumArrival', () => {
  it('keeps calculation provenance separate from the departure fact', () => {
    expect(
      deriveMinimumArrival({
        departureInstant: '2026-09-17T12:21:00.000Z',
        minimumLeadMinutes: 40,
        sourceRefs: ['departure:fixture-1', 'constraint:fixture-1'],
        policyVersion: 'SYNTHETIC-P0',
      }),
    ).toEqual({
      instant: '2026-09-17T11:41:00.000Z',
      sourceKind: 'CALCULATED',
      sourceRefs: ['departure:fixture-1', 'constraint:fixture-1'],
      ruleId: 'SCHEDULE.MINIMUM_ARRIVAL',
      policyVersion: 'SYNTHETIC-P0',
    });
  });

  it('rejects invalid minute values instead of silently correcting them', () => {
    expect(() =>
      deriveMinimumArrival({
        departureInstant: '2026-09-17T12:21:00.000Z',
        minimumLeadMinutes: -1,
        sourceRefs: [],
        policyVersion: 'SYNTHETIC-P0',
      }),
    ).toThrow(RangeError);
  });
});
