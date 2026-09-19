import { describe, expect, it } from 'vitest';

import {
  assessDwell,
  evaluateBuffer,
  expandRouteQueryStart,
  rankRouteCandidates,
  suggestedExternalBoardingBufferSeconds,
  type NormalizedRouteCandidate,
} from '../src/index.js';

describe('P5C planning policy', () => {
  it('keeps projected dwell separate from system suggestion and user minimum', () => {
    expect(
      assessDwell({
        arrival: instant('2030-01-01T10:00:00Z'),
        departure: instant('2030-01-01T11:20:00Z'),
        systemSuggestedDurationSeconds: 3_600,
        userMinimumDurationSeconds: 3_000,
      }),
    ).toMatchObject({ projectedDwellSeconds: 4_800, status: 'NORMAL' });
    expect(
      assessDwell({
        arrival: instant('2030-01-01T10:00:00Z'),
        departure: instant('2030-01-01T10:45:00Z'),
        systemSuggestedDurationSeconds: 3_600,
        userMinimumDurationSeconds: null,
      }).status,
    ).toBe('SOFT_DEVIATION');
    expect(
      assessDwell({
        arrival: instant('2030-01-01T10:00:00Z'),
        departure: instant('2030-01-01T10:45:00Z'),
        systemSuggestedDurationSeconds: 3_600,
        userMinimumDurationSeconds: 3_000,
      }),
    ).toMatchObject({
      status: 'USER_REQUIREMENT_VIOLATION',
      requiresUserAdjustment: true,
      adjustedUserMinimumDurationSeconds: 2_700,
    });
    expect(
      assessDwell({
        arrival: instant('2030-01-01T10:00:00Z'),
        departure: instant('2030-01-01T10:00:00Z'),
        systemSuggestedDurationSeconds: null,
        userMinimumDurationSeconds: 600,
      }),
    ).toMatchObject({
      status: 'INFEASIBLE',
      requiresUserAdjustment: false,
    });
  });

  it('expands a planning start by 15 minutes without crossing an absolute fact', () => {
    expect(
      expandRouteQueryStart({
        planningEarliestDeparture: instant('2030-01-01T11:00:00Z'),
        absoluteEarliestDeparture: instant('2030-01-01T10:50:00Z'),
      })?.toISOString(),
    ).toBe('2030-01-01T10:50:00.000Z');
    expect(
      expandRouteQueryStart({
        planningEarliestDeparture: instant('2030-01-01T11:00:00Z'),
        absoluteEarliestDeparture: null,
      })?.toISOString(),
    ).toBe('2030-01-01T10:45:00.000Z');
  });

  it('ranks earliest arrival first instead of shortest route duration', () => {
    const ranked = rankRouteCandidates(
      [
        candidate('short-late', '10:00', '11:00', '40.00'),
        candidate('early', '09:06', '10:42', '50.00'),
      ],
      instant('2030-01-01T09:05:00Z'),
    );
    expect(ranked.fastestCandidateId).toBe('early');
    expect(ranked.ordered[0]?.candidateId).toBe('early');
  });

  it('selects the cheapest comparable fare inside 140 percent and deduplicates fastest', () => {
    const input = [
      candidate('fast', '09:10', '10:00', '20.00'),
      candidate('value', '09:20', '10:20', '10.00'),
      candidate('outside', '10:00', '11:30', '1.00'),
      candidate('unknown', '09:15', '10:10', null),
    ];
    const ranked = rankRouteCandidates(
      [input[2]!, input[0]!, input[3]!, input[1]!],
      instant('2030-01-01T09:00:00Z'),
    );
    expect(ranked.valueCandidateId).toBe('value');
    expect(ranked.ordered.map((item) => item.candidateId)).toEqual([
      'fast',
      'value',
      'unknown',
      'outside',
    ]);
    expect(
      rankRouteCandidates(
        [...input].reverse(),
        instant('2030-01-01T09:00:00Z'),
      ).ordered.map((item) => item.candidateId),
    ).toEqual(ranked.ordered.map((item) => item.candidateId));

    const fastestIsCheapest = rankRouteCandidates(
      [
        candidate('fast-cheap', '09:10', '10:00', '5.00'),
        candidate('slower', '09:20', '10:20', '10.00'),
      ],
      instant('2030-01-01T09:00:00Z'),
    );
    expect(fastestIsCheapest.valueCandidateId).toBeNull();
    expect(fastestIsCheapest.ordered.map((item) => item.candidateId)).toEqual([
      'fast-cheap',
      'slower',
    ]);
  });

  it('never compares amounts across currencies for the value position', () => {
    const ranked = rankRouteCandidates(
      [
        candidate('fast', '09:10', '10:00', '20.00', 'CNY'),
        candidate('usd', '09:20', '10:10', '1.00', 'USD'),
        candidate('jpy', '09:30', '10:20', '1.00', 'JPY'),
      ],
      instant('2030-01-01T09:00:00Z'),
    );
    expect(ranked.valueCandidateId).toBeNull();
  });

  it('keeps suggested, preferred, and minimum buffer risk semantics distinct', () => {
    expect(
      evaluateBuffer({
        kind: 'SYSTEM_SUGGESTED_BUFFER',
        requiredSeconds: 1_200,
        availableSeconds: 1_080,
        acknowledged: false,
      }).disposition,
    ).toBe('SOFT_DEVIATION');
    expect(
      evaluateBuffer({
        kind: 'USER_PREFERRED_BUFFER',
        requiredSeconds: 1_200,
        availableSeconds: 1_080,
        acknowledged: true,
      }).disposition,
    ).toBe('ACKNOWLEDGED_SOFT_DEVIATION');
    expect(
      evaluateBuffer({
        kind: 'SYSTEM_MINIMUM_CONNECTION',
        requiredSeconds: 900,
        availableSeconds: 720,
        acknowledged: true,
      }).disposition,
    ).toBe('ONGOING_EXECUTION_RISK');
  });

  it('uses deterministic product defaults and leaves cruise first boarding unknown', () => {
    expect(
      suggestedExternalBoardingBufferSeconds({
        countryCode: 'IN',
        scenario: 'AIRPORT_INTERNATIONAL',
      }),
    ).toBe(14_400);
    expect(
      suggestedExternalBoardingBufferSeconds({
        countryCode: null,
        scenario: 'AIRPORT_DOMESTIC',
      }),
    ).toBe(7_200);
    expect(
      suggestedExternalBoardingBufferSeconds({
        countryCode: 'US',
        scenario: 'CRUISE_FIRST_BOARDING',
      }),
    ).toBeNull();
  });
});

function instant(value: string): Date {
  return new Date(value);
}

function candidate(
  candidateId: string,
  departure: string,
  arrival: string,
  amount: string | null,
  currency = 'CNY',
): NormalizedRouteCandidate {
  const departureInstant = instant(`2030-01-01T${departure}:00Z`);
  const arrivalInstant = instant(`2030-01-01T${arrival}:00Z`);
  return {
    candidateId,
    provider: 'SYNTHETIC',
    providerCandidateRef: candidateId,
    observedAt: instant('2030-01-01T09:00:00Z'),
    validUntil: instant('2030-01-01T12:00:00Z'),
    departure: { instant: departureInstant, timeZone: 'UTC' },
    arrival: { instant: arrivalInstant, timeZone: 'UTC' },
    durationSeconds:
      (arrivalInstant.getTime() - departureInstant.getTime()) / 1_000,
    fare: amount === null ? null : { amount, currency },
    legs: [
      {
        mode: 'RAIL',
        from: {
          name: 'A',
          latitude: 1,
          longitude: 1,
          providerPlaceRef: 'a',
        },
        to: {
          name: 'B',
          latitude: 2,
          longitude: 2,
          providerPlaceRef: 'b',
        },
        departure: { instant: departureInstant, timeZone: 'UTC' },
        arrival: { instant: arrivalInstant, timeZone: 'UTC' },
        durationSeconds:
          (arrivalInstant.getTime() - departureInstant.getTime()) / 1_000,
        fixedService: true,
        serviceLabel: candidateId,
        providerRef: candidateId,
      },
    ],
  };
}
