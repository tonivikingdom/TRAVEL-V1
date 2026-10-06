import { expect, it } from 'vitest';
import { endpointWithinBinding } from '../src/route-endpoint-binding.js';
import { GoogleOrdinaryRouteProvider } from '../src/regional-route-adapters.js';
const point = { latitude: 35.681236, longitude: 139.767125 };
it('SYNTHETIC Google snapping uses a bounded 100 m policy', () => {
  expect(
    endpointWithinBinding(
      point,
      { ...point, latitude: point.latitude + 0.0008 },
      'GOOGLE',
    ),
  ).toBe(true);
  expect(
    endpointWithinBinding(
      point,
      { ...point, latitude: point.latitude + 0.001 },
      'GOOGLE',
    ),
  ).toBe(false);
  expect(
    endpointWithinBinding(point, { ...point, latitude: NaN }, 'GOOGLE'),
  ).toBe(false);
});
it('Baidu approximation has a separate bounded error budget, not exact official truth', () => {
  expect(
    endpointWithinBinding(
      point,
      { ...point, latitude: point.latitude + 0.0004 },
      'BAIDU',
    ),
  ).toBe(true);
  expect(
    endpointWithinBinding(
      point,
      { ...point, latitude: point.latitude + 0.0006 },
      'BAIDU',
    ),
  ).toBe(false);
});
it('legal snapped Google endpoints normalize to the authorized requested endpoints', async () => {
  const now = new Date('2031-01-01T00:00:00Z');
  const provider = new GoogleOrdinaryRouteProvider(
    'SYNTHETIC',
    async () =>
      new Response(
        JSON.stringify({
          routes: [
            {
              duration: '600s',
              legs: [
                {
                  startLocation: {
                    latLng: { ...point, latitude: point.latitude + 0.0004 },
                  },
                  endLocation: {
                    latLng: { ...point, longitude: point.longitude + 0.0004 },
                  },
                },
              ],
            },
          ],
        }),
      ),
    () => now,
  );
  const location = {
    ...point,
    placeId: 'SYNTHETIC',
    name: 'SYNTHETIC',
    timeZone: 'Asia/Tokyo',
  };
  const result = await provider.queryRoutes({
    origin: location,
    destination: location,
    earliestDeparture: now,
    latestArrival: null,
    travelMode: 'WALKING',
    preference: { type: 'DEPART_AT', instant: now, timeZone: 'Asia/Tokyo' },
  });
  expect(result.status).toBe('SUCCESS');
  if (result.status === 'SUCCESS')
    expect(result.candidates[0]?.legs[0]?.from.latitude).toBe(point.latitude);
});

it.each(['TRANSIT', 'CYCLING'] as const)(
  'unverified Baidu %s contract fails closed before any HTTP',
  async (travelMode) => {
    const { BaiduOrdinaryRouteProvider } =
      await import('../src/regional-route-adapters.js');
    const { vi } = await import('vitest');
    const fetcher = vi.fn();
    const now = new Date('2031-01-01T00:00:00Z');
    const location = {
      ...point,
      placeId: 'SYNTHETIC',
      name: 'SYNTHETIC',
      timeZone: 'Asia/Shanghai',
    };
    expect(
      await new BaiduOrdinaryRouteProvider(
        'SYNTHETIC',
        fetcher,
        () => now,
      ).queryRoutes({
        origin: location,
        destination: location,
        earliestDeparture: now,
        latestArrival: null,
        travelMode: travelMode as unknown as NonNullable<
          import('@travel/application').RouteProviderQueryInput['travelMode']
        >,
        preference: {
          type: 'DEPART_AT',
          instant: now,
          timeZone: 'Asia/Shanghai',
        },
      }),
    ).toEqual({ status: 'UNSUPPORTED_QUERY' });
    expect(fetcher).not.toHaveBeenCalled();
  },
);
