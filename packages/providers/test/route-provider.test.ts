import { describe, expect, it } from 'vitest';
import { validateRouteCandidate } from '@travel/domain';

import {
  createDevelopmentSyntheticGroundTransitRouteProvider,
  createDevelopmentSyntheticRouteProvider,
  SyntheticRouteProvider,
  UnconfiguredRouteProvider,
} from '../src/index.js';

const input = {
  origin: {
    placeId: 'origin',
    name: 'Origin',
    latitude: 35.0,
    longitude: 139.0,
  },
  destination: {
    placeId: 'destination',
    name: 'Destination',
    latitude: 35.1,
    longitude: 139.1,
  },
  earliestDeparture: new Date('2030-10-01T10:00:00Z'),
  latestArrival: null,
  preference: {
    type: 'DEPART_AT' as const,
    instant: new Date('2030-10-01T10:00:00Z'),
    timeZone: 'Asia/Tokyo',
  },
};

describe('route providers', () => {
  it('creates an explicitly SYNTHETIC normalized development candidate', async () => {
    const provider = createDevelopmentSyntheticRouteProvider(
      () => new Date('2030-01-01T00:00:00Z'),
    );
    const result = await provider.queryRoutes(input);

    expect(result).toMatchObject({
      status: 'SUCCESS',
      candidates: [
        {
          provider: 'SYNTHETIC',
          observedAt: new Date('2030-01-01T00:00:00Z'),
          fare: null,
          legs: [{ mode: 'WALKING', fixedService: false }],
        },
      ],
    });
  });

  it('keeps a bounded synthetic replacement candidate valid across millisecond offsets', async () => {
    const earliestDeparture = new Date('2030-10-01T10:00:00.603Z');
    const latestArrival = new Date('2030-10-01T10:40:00.300Z');
    const result = await createDevelopmentSyntheticGroundTransitRouteProvider(
      () => new Date('2030-10-01T09:59:00Z'),
    ).queryRoutes({
      ...input,
      earliestDeparture,
      latestArrival,
      preference: {
        type: 'DEPART_AT',
        instant: earliestDeparture,
        timeZone: 'Asia/Tokyo',
      },
    });
    expect(result.status).toBe('SUCCESS');
    if (result.status !== 'SUCCESS') return;
    expect(
      validateRouteCandidate(result.candidates[0]!, {
        earliestDeparture,
        latestArrival,
      }),
    ).toEqual({ accepted: true });
    expect(Number.isInteger(result.candidates[0]!.durationSeconds)).toBe(true);
  });

  it('supports configurable success, no-result, unavailable, and unsupported fixtures', async () => {
    for (const expected of [
      { status: 'NO_MATCHING_CANDIDATE' as const },
      {
        status: 'PROVIDER_UNAVAILABLE' as const,
        reason: 'UPSTREAM_UNAVAILABLE' as const,
      },
      { status: 'UNSUPPORTED_QUERY' as const },
    ]) {
      const provider = new SyntheticRouteProvider(() => expected);
      await expect(provider.queryRoutes(input)).resolves.toEqual(expected);
    }
  });

  it('returns an explicit unconfigured error instead of synthetic fallback', async () => {
    await expect(
      new UnconfiguredRouteProvider().queryRoutes(input),
    ).resolves.toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'ROUTE_PROVIDER_UNCONFIGURED',
    });
  });
});
