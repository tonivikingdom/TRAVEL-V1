import { describe, expect, it } from 'vitest';

import {
  validateRouteCandidate,
  type NormalizedRouteCandidate,
} from '../src/route-query.js';

describe('route candidate hard-bound validation', () => {
  it('accepts a multi-leg candidate and preserves walking and explicit fixedService facts', () => {
    const candidate = routeCandidate();
    expect(
      validateRouteCandidate(candidate, {
        earliestDeparture: new Date('2030-01-01T10:00:00.000Z'),
        latestArrival: new Date('2030-01-01T11:00:00.000Z'),
      }),
    ).toEqual({ accepted: true });
    expect(candidate.legs.map((leg) => leg.mode)).toEqual([
      'BUS',
      'WALKING',
      'RAIL',
    ]);
    expect(candidate.legs.map((leg) => leg.fixedService)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('rejects departure before the hard lower bound', () => {
    expect(
      validateRouteCandidate(routeCandidate(), {
        earliestDeparture: new Date('2030-01-01T10:01:00.000Z'),
        latestArrival: null,
      }),
    ).toEqual({
      accepted: false,
      reason: 'DEPARTURE_BEFORE_EARLIEST',
    });
  });

  it('rejects arrival after the hard upper bound', () => {
    expect(
      validateRouteCandidate(routeCandidate(), {
        earliestDeparture: null,
        latestArrival: new Date('2030-01-01T10:59:00.000Z'),
      }),
    ).toEqual({ accepted: false, reason: 'ARRIVAL_AFTER_LATEST' });
  });

  it('uses instants for cross-timezone duration instead of local clock text', () => {
    const candidate = routeCandidate({
      departure: {
        instant: new Date('2030-01-01T08:00:00.000Z'),
        timeZone: 'Asia/Tokyo',
      },
      arrival: {
        instant: new Date('2030-01-01T18:00:00.000Z'),
        timeZone: 'America/Los_Angeles',
      },
      durationSeconds: 36_000,
    });
    expect(
      validateRouteCandidate(candidate, {
        earliestDeparture: null,
        latestArrival: null,
      }),
    ).toEqual({ accepted: true });
  });

  it('rejects an internally inconsistent provider duration', () => {
    expect(
      validateRouteCandidate(routeCandidate({ durationSeconds: 1 }), {
        earliestDeparture: null,
        latestArrival: null,
      }),
    ).toEqual({ accepted: false, reason: 'INVALID_CANDIDATE' });
  });

  it('rejects malformed or non-canonical fare data before policy ranking', () => {
    for (const fare of [
      { amount: '-1.00', currency: 'CNY' },
      { amount: '1e3', currency: 'CNY' },
      { amount: '1.00', currency: 'cny' },
      { amount: `1.${'0'.repeat(33)}`, currency: 'CNY' },
      { amount: '9'.repeat(65), currency: 'CNY' },
    ]) {
      expect(
        validateRouteCandidate(routeCandidate({ fare }), {
          earliestDeparture: null,
          latestArrival: null,
        }),
      ).toEqual({ accepted: false, reason: 'INVALID_CANDIDATE' });
    }
  });
});

function routeCandidate(
  overrides: Partial<NormalizedRouteCandidate> = {},
): NormalizedRouteCandidate {
  const departure =
    overrides.departure ??
    ({
      instant: new Date('2030-01-01T10:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    } as const);
  const arrival =
    overrides.arrival ??
    ({
      instant: new Date('2030-01-01T11:00:00.000Z'),
      timeZone: 'Asia/Shanghai',
    } as const);
  const legLocation = {
    name: 'SYNTHETIC stop',
    latitude: null,
    longitude: null,
    providerPlaceRef: null,
  } as const;
  return {
    candidateId: 'SYNTHETIC-CANDIDATE-1',
    provider: 'SYNTHETIC',
    providerCandidateRef: 'SYNTHETIC-REF-1',
    observedAt: new Date('2030-01-01T09:59:00.000Z'),
    validUntil: null,
    departure,
    arrival,
    durationSeconds:
      overrides.durationSeconds ??
      (arrival.instant.getTime() - departure.instant.getTime()) / 1_000,
    legs: [
      {
        mode: 'BUS',
        from: legLocation,
        to: legLocation,
        departure: null,
        arrival: null,
        durationSeconds: null,
        fixedService: false,
        serviceLabel: null,
        providerRef: null,
      },
      {
        mode: 'WALKING',
        from: legLocation,
        to: legLocation,
        departure: null,
        arrival: null,
        durationSeconds: null,
        fixedService: false,
        serviceLabel: null,
        providerRef: null,
      },
      {
        mode: 'RAIL',
        from: legLocation,
        to: legLocation,
        departure: null,
        arrival: null,
        durationSeconds: null,
        fixedService: true,
        serviceLabel: 'SYNTHETIC RAIL',
        providerRef: 'SYNTHETIC-LEG-3',
      },
    ],
    fare: null,
    ...overrides,
  };
}
