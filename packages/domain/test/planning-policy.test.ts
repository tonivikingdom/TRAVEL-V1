import { describe, expect, it } from 'vitest';

import {
  assessDwell,
  evaluateBuffer,
  expandRouteQueryStart,
  rankArriveByCandidates,
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

  it.each([
    ['midnight', '2030-01-02T00:05:00Z', '2030-01-01T23:50:00.000Z'],
    [
      'DST-forward-offset',
      '2030-03-10T03:05:00-04:00',
      '2030-03-10T06:50:00.000Z',
    ],
    [
      'DST-backward-offset',
      '2030-11-03T01:05:00-05:00',
      '2030-11-03T05:50:00.000Z',
    ],
    [
      'international-date-line',
      '2030-01-10T00:05:00+14:00',
      '2030-01-09T09:50:00.000Z',
    ],
  ])(
    'expands %s using the absolute instant only',
    (_label, value, expected) => {
      expect(
        expandRouteQueryStart({
          planningEarliestDeparture: instant(value),
          absoluteEarliestDeparture: null,
        })?.toISOString(),
      ).toBe(expected);
    },
  );

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

  it('applies the 140 percent effective-time boundary exactly', () => {
    const available = instant('2030-01-01T09:00:00.000Z');
    const fastest = candidateAt(
      'fast',
      '2030-01-01T09:00:00.000Z',
      '2030-01-01T09:16:40.000Z',
      '100.00',
    );
    const atBoundary = candidateAt(
      'at-140',
      '2030-01-01T09:10:00.000Z',
      '2030-01-01T09:23:20.000Z',
      '10.00',
    );
    const belowBoundary = candidateAt(
      'below-140',
      '2030-01-01T09:10:00.000Z',
      '2030-01-01T09:23:19.990Z',
      '20.00',
    );
    const aboveBoundary = candidateAt(
      'above-140',
      '2030-01-01T09:10:00.000Z',
      '2030-01-01T09:23:20.001Z',
      '0.01',
    );

    expect(
      rankRouteCandidates([fastest, atBoundary], available).valueCandidateId,
    ).toBe('at-140');
    expect(
      rankRouteCandidates([fastest, belowBoundary], available).valueCandidateId,
    ).toBe('below-140');
    expect(
      rankRouteCandidates([fastest, aboveBoundary], available).valueCandidateId,
    ).toBeNull();
  });

  it('uses exact bounded decimal comparison and rejects malformed or excessive fares', () => {
    const available = instant('2030-01-01T09:00:00Z');
    const ranked = rankRouteCandidates(
      [
        candidate('fast', '09:00', '10:00', null),
        candidate(
          'precise-high',
          '09:00',
          '10:01',
          '999999999999999999999999999999.000000000000000000000000000001',
        ),
        candidate(
          'precise-low',
          '09:00',
          '10:02',
          '999999999999999999999999999999.000000000000000000000000000000',
        ),
      ],
      available,
    );
    expect(ranked.valueCandidateId).toBe('precise-low');
    expect(() =>
      rankRouteCandidates(
        [candidate('bad', '09:00', '10:00', '01.00')],
        available,
      ),
    ).toThrow('bounded canonical decimal');
    expect(() =>
      rankRouteCandidates(
        [candidate('huge-scale', '09:00', '10:00', `1.${'0'.repeat(33)}`)],
        available,
      ),
    ).toThrow('bounded canonical decimal');
  });

  it('is deterministic for shuffled input and resolves transfer/walking ties by ID', () => {
    const available = instant('2030-01-01T09:00:00Z');
    const base = [
      candidateWithLegs('z-two-legs', 2, 0),
      candidateWithLegs('b-walking', 1, 600),
      candidateWithLegs('a-stable', 1, 0),
      candidateWithLegs('c-stable', 1, 0),
    ];
    const expected = ['a-stable', 'c-stable', 'b-walking', 'z-two-legs'];
    for (let seed = 1; seed <= 40; seed += 1) {
      const shuffled = deterministicShuffle(base, seed);
      expect(
        rankRouteCandidates(shuffled, available).ordered.map(
          (value) => value.candidateId,
        ),
      ).toEqual(expected);
    }
  });

  it('prefers earliest arrival over early departure or short in-vehicle duration', () => {
    const ranked = rankRouteCandidates(
      [
        candidateAt(
          'early-depart-late-arrive',
          '2030-01-01T09:01:00Z',
          '2030-01-01T11:00:00Z',
          null,
        ),
        candidateAt(
          'wait-then-short',
          '2030-01-01T10:20:00Z',
          '2030-01-01T10:30:00Z',
          null,
        ),
        candidateAt(
          'earliest-arrival',
          '2030-01-01T09:30:00Z',
          '2030-01-01T10:20:00Z',
          null,
        ),
      ],
      instant('2030-01-01T09:00:00Z'),
    );
    expect(ranked.fastestCandidateId).toBe('earliest-arrival');
  });

  it('handles a single candidate without inventing a duplicate value slot', () => {
    const ranked = rankRouteCandidates(
      [candidate('only', '09:10', '10:00', '1.00')],
      instant('2030-01-01T09:00:00Z'),
    );
    expect(ranked.ordered.map((value) => value.candidateId)).toEqual(['only']);
    expect(ranked.valueCandidateId).toBeNull();
  });

  it('ranks ARRIVE_BY by latest departure, then duration, fare, transfers, walking, and ID', () => {
    const candidates = [
      candidateAt('late-long', '2030-01-01T10:20:00Z', '2030-01-01T11:20:00Z', '5.00'),
      candidateAt('late-short', '2030-01-01T10:20:00Z', '2030-01-01T11:00:00Z', '20.00'),
      candidateAt('earlier-cheap', '2030-01-01T10:10:00Z', '2030-01-01T10:30:00Z', '1.00'),
      candidateAt('null-fare', '2030-01-01T10:15:00Z', '2030-01-01T10:35:00Z', null),
      candidateAt('usd', '2030-01-01T10:15:00Z', '2030-01-01T10:35:00Z', '0.01', 'USD'),
    ];
    const ranked = rankArriveByCandidates(candidates);
    expect(ranked.ordered.map((item) => item.candidateId)).toEqual([
      'late-short',
      'late-long',
      'null-fare',
      'usd',
      'earlier-cheap',
    ]);
    expect(ranked.primaryCandidateId).toBe('late-short');
    expect(ranked.valueCandidateId).toBeNull();
  });

  it('keeps ARRIVE_BY ordering deterministic for shuffled and identical candidates', () => {
    const base = [
      candidateAt('z', '2030-01-01T10:00:00Z', '2030-01-01T10:30:00Z', '2.00'),
      candidateAt('a', '2030-01-01T10:00:00Z', '2030-01-01T10:30:00Z', '2.00'),
      candidateAt('m', '2030-01-01T10:00:00Z', '2030-01-01T10:30:00Z', '2.00'),
    ];
    const expected = ['a', 'm', 'z'];
    for (let seed = 1; seed <= 40; seed += 1) {
      expect(
        rankArriveByCandidates(deterministicShuffle(base, seed)).ordered.map(
          (value) => value.candidateId,
        ),
      ).toEqual(expected);
    }
    expect(
      rankArriveByCandidates([
        candidateWithLegs('z-two-legs', 2, 0),
        candidateWithLegs('b-walking', 1, 600),
        candidateWithLegs('a-stable', 1, 0),
        candidateWithLegs('c-stable', 1, 0),
      ]).ordered.map((value) => value.candidateId),
    ).toEqual(['a-stable', 'c-stable', 'b-walking', 'z-two-legs']);
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

  it('acknowledges a preference breach without suppressing a minimum execution risk', () => {
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
        availableSeconds: 1_080,
        acknowledged: true,
      }).disposition,
    ).toBe('NONE');

    expect(
      evaluateBuffer({
        kind: 'USER_PREFERRED_BUFFER',
        requiredSeconds: 1_200,
        availableSeconds: 720,
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
    expect(
      suggestedExternalBoardingBufferSeconds({
        countryCode: ' cl ',
        scenario: 'AIRPORT_DOMESTIC',
      }),
    ).toBe(10_800);
    expect(
      suggestedExternalBoardingBufferSeconds({
        countryCode: 'xx',
        scenario: 'AIRPORT_INTERNATIONAL',
      }),
    ).toBe(10_800);
    expect(
      evaluateBuffer({
        kind: 'SYSTEM_MINIMUM_CONNECTION',
        requiredSeconds: null,
        availableSeconds: 1,
        acknowledged: true,
      }),
    ).toMatchObject({ breached: false, disposition: 'NONE' });
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

function candidateAt(
  candidateId: string,
  departure: string,
  arrival: string,
  amount: string | null,
  currency = 'CNY',
): NormalizedRouteCandidate {
  const departureInstant = instant(departure);
  const arrivalInstant = instant(arrival);
  const base = candidate(candidateId, '09:00', '10:00', amount, currency);
  return {
    ...base,
    departure: { instant: departureInstant, timeZone: 'UTC' },
    arrival: { instant: arrivalInstant, timeZone: 'UTC' },
    durationSeconds:
      (arrivalInstant.getTime() - departureInstant.getTime()) / 1_000,
    legs: [
      {
        ...base.legs[0]!,
        departure: { instant: departureInstant, timeZone: 'UTC' },
        arrival: { instant: arrivalInstant, timeZone: 'UTC' },
        durationSeconds:
          (arrivalInstant.getTime() - departureInstant.getTime()) / 1_000,
      },
    ],
  };
}

function candidateWithLegs(
  candidateId: string,
  legCount: number,
  walkingSeconds: number,
): NormalizedRouteCandidate {
  const base = candidate(candidateId, '09:00', '10:00', null);
  return {
    ...base,
    legs: Array.from({ length: legCount }, (_, index) => ({
      ...base.legs[0]!,
      mode: index === 0 && walkingSeconds > 0 ? ('WALKING' as const) : 'RAIL',
      durationSeconds: index === 0 ? walkingSeconds : 0,
    })),
  };
}

function deterministicShuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}
