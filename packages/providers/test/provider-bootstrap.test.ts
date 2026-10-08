import { expect, it, vi } from 'vitest';
import { validateRouteCandidate } from '@travel/domain';
import type { RouteProviderQueryInput } from '@travel/application';
import {
  BaiduOrdinaryRouteProvider,
  GoogleOrdinaryRouteProvider,
} from '../src/regional-route-adapters.js';
import {
  bindProviderEndpoints,
  distanceMeters,
  ENDPOINT_LIMIT_METERS,
} from '../src/endpoint-binding.js';
import { baiduToWgs84 } from '../src/baidu-coordinates.js';
import { createRegionalProviders } from '../src/regional-config.js';
const now = new Date('2031-01-01T00:00:00Z');
const raw = [
  { lat: 39.915, lng: 116.404 },
  { lat: 39.925, lng: 116.414 },
];
function input(
  mode: RouteProviderQueryInput['travelMode'] = 'WALKING',
): RouteProviderQueryInput {
  return {
    travelMode: mode,
    origin: {
      ...baiduToWgs84(raw[0]!.lat, raw[0]!.lng),
      name: 'SYNTHETIC origin',
      placeId: 'SYNTHETIC:origin',
      timeZone: 'Asia/Shanghai',
    },
    destination: {
      ...baiduToWgs84(raw[1]!.lat, raw[1]!.lng),
      name: 'SYNTHETIC destination',
      placeId: 'SYNTHETIC:destination',
      timeZone: 'Asia/Shanghai',
    },
    earliestDeparture: null,
    latestArrival: null,
    preference: { type: 'NONE' },
  };
}
function baiduBody(mode: RouteProviderQueryInput['travelMode']) {
  return {
    status: 0,
    result: {
      origin:
        mode === 'DRIVING'
          ? raw[0]
          : mode === 'TRANSIT'
            ? { city_id: 'SYNTHETIC:beijing', location: raw[0] }
            : { originPt: raw[0] },
      destination:
        mode === 'DRIVING'
          ? raw[1]
          : mode === 'TRANSIT'
            ? { city_id: 'SYNTHETIC:beijing', location: raw[1] }
            : { destinationPt: raw[1] },
      routes: [{ duration: 900, hidden: 'SYNTHETIC_SECRET' }],
    },
  };
}
it.each(['WALKING', 'DRIVING', 'CYCLING', 'TRANSIT'] as const)(
  'SYNTHETIC Baidu %s uses the documented v2 capability and canonical endpoints',
  async (mode) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(baiduBody(mode))),
    );
    const result = await new BaiduOrdinaryRouteProvider(
      'SYNTHETIC_SERVER_SECRET',
      fetcher,
      () => now,
    ).queryRoutes(input(mode));
    expect(result.status).toBe('SUCCESS');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(
      `/direction/v2/${mode === 'CYCLING' ? 'riding' : mode.toLowerCase()}`,
    );
    expect(url.searchParams.get('coord_type')).toBe('wgs84');
    expect(url.searchParams.get('ret_coordtype')).toBe('bd09ll');
    if (mode === 'TRANSIT') {
      expect(url.searchParams.get('departure_date')).toBe('2031-01-01');
      expect(url.searchParams.get('departure_time')).toBe('08:00');
    } else expect(url.searchParams.has('departure_time')).toBe(false);
    if (result.status !== 'SUCCESS') throw new Error('Expected route');
    expect(result.candidates[0]!.legs[0]!.mode).toBe(mode);
    expect(result.candidates[0]!.legs[0]!.fixedService).toBe(false);
    expect(result.candidates[0]!.legs[0]!.groundTransit).toBeUndefined();
    expect(
      validateRouteCandidate(result.candidates[0]!, {
        earliestDeparture: now,
        latestArrival: null,
      }),
    ).toEqual({ accepted: true });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SERVER_SECRET');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  },
);
it.each([1000, 3600000, 7 * 86400000])(
  'Baidu approved future driving %sms ahead sends the exact UNIX departure',
  async (offset) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(baiduBody('DRIVING'))),
    );
    const instant = new Date(now.getTime() + offset);
    const result = await new BaiduOrdinaryRouteProvider(
      'SYNTHETIC',
      fetcher,
      () => now,
      true,
    ).queryRoutes({
      ...input('DRIVING'),
      preference: { type: 'DEPART_AT', instant, timeZone: 'Asia/Shanghai' },
    });
    expect(result.status).toBe('SUCCESS');
    expect(
      new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get(
        'departure_time',
      ),
    ).toBe(String(Math.floor(instant.getTime() / 1000)));
    if (result.status === 'SUCCESS')
      expect(result.candidates[0]!.departure.instant).toEqual(instant);
  },
);
it.each([-1, 1, 7 * 86400000 + 1])(
  'Baidu invalid future bound %s never falls back to current traffic',
  async (offset) => {
    const fetcher = vi.fn();
    const result = await new BaiduOrdinaryRouteProvider(
      'SYNTHETIC',
      fetcher,
      () => now,
      true,
    ).queryRoutes({
      ...input('DRIVING'),
      preference: {
        type: 'DEPART_AT',
        instant: new Date(now.getTime() + offset),
        timeZone: 'Asia/Shanghai',
      },
    });
    expect(result.status).toBe('UNSUPPORTED_QUERY');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('Baidu transit rounds a current request forward to the supported minute precision', async () => {
  const observedAt = new Date(now.getTime() + 1500);
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(baiduBody('TRANSIT'))),
  );
  const result = await new BaiduOrdinaryRouteProvider(
    'SYNTHETIC',
    fetcher,
    () => observedAt,
  ).queryRoutes(input('TRANSIT'));
  expect(result.status).toBe('SUCCESS');
  expect(
    new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get(
      'departure_time',
    ),
  ).toBe('08:01');
  if (result.status === 'SUCCESS')
    expect(result.candidates[0]!.departure.instant).toEqual(
      new Date(now.getTime() + 60000),
    );
});
it('Baidu transit rejects explicit time precision it cannot send without one request', async () => {
  const fetcher = vi.fn();
  const result = await new BaiduOrdinaryRouteProvider(
    'SYNTHETIC',
    fetcher,
    () => now,
  ).queryRoutes({
    ...input('TRANSIT'),
    preference: {
      type: 'DEPART_AT',
      instant: new Date(now.getTime() + 61000),
      timeZone: 'Asia/Shanghai',
    },
  });
  expect(result.status).toBe('UNSUPPORTED_QUERY');
  expect(fetcher).not.toHaveBeenCalled();
});
it('future-driving approval is independent; absent approval and ARRIVE_BY make zero requests', async () => {
  const fetcher = vi.fn(),
    provider = new BaiduOrdinaryRouteProvider('SYNTHETIC', fetcher, () => now);
  for (const type of ['DEPART_AT', 'ARRIVE_BY'] as const)
    expect(
      (
        await provider.queryRoutes({
          ...input('DRIVING'),
          preference: {
            type,
            instant: new Date(now.getTime() + 3600000),
            timeZone: 'Asia/Shanghai',
          },
        })
      ).status,
    ).toBe('UNSUPPORTED_QUERY');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  'different-city',
  'missing-city',
  'invalid-duration',
  'wrong-endpoint',
] as const)(
  'Baidu transit %s does not become a valid synthetic timetable',
  async (fault) => {
    const body = baiduBody('TRANSIT');
    if (fault === 'different-city')
      body.result.destination = {
        city_id: 'SYNTHETIC:other',
        location: raw[1],
      };
    if (fault === 'missing-city')
      body.result.origin = { location: raw[0] } as typeof body.result.origin;
    if (fault === 'invalid-duration') body.result.routes[0]!.duration = NaN;
    if (fault === 'wrong-endpoint')
      body.result.origin = {
        city_id: 'SYNTHETIC:beijing',
        location: { lat: 31, lng: 121 },
      };
    const provider = new BaiduOrdinaryRouteProvider(
      'SYNTHETIC',
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body))),
      () => now,
    );
    expect((await provider.queryRoutes(input('TRANSIT'))).status).toBe(
      fault.includes('city') ? 'UNSUPPORTED_QUERY' : 'PROVIDER_UNAVAILABLE',
    );
  },
);
it('Baidu inverse is approximate and independently bounded; malformed/far/swapped endpoints fail closed', () => {
  const query = input();
  expect(() =>
    bindProviderEndpoints(
      'BAIDU',
      query.origin,
      query.destination,
      raw[0],
      raw[1],
    ),
  ).not.toThrow();
  for (const p of [
    undefined,
    { lat: NaN, lng: 116 },
    { lat: 31.2, lng: 121.4 },
    raw[1],
  ])
    expect(() =>
      bindProviderEndpoints(
        'BAIDU',
        query.origin,
        query.destination,
        p,
        raw[1],
      ),
    ).toThrow();
  expect(ENDPOINT_LIMIT_METERS.BAIDU).toBe(30);
  expect(baiduToWgs84(raw[0]!.lat, raw[0]!.lng).latitude).toBeCloseTo(
    39.90725,
    4,
  ); // SYNTHETIC regression, not official survey/round-trip evidence.
});
it.each([0, 25, 99, 101, 1000])(
  'Google snapping %sm preserves a strict bounded binding',
  async (meters) => {
    const origin = { latitude: 35.681236, longitude: 139.767125 },
      destination = { ...origin, longitude: origin.longitude + 0.02 };
    const snapped = {
      ...origin,
      latitude: origin.latitude + meters / 111195.08,
    };
    expect(distanceMeters(origin, snapped)).toBeCloseTo(meters, 1);
    const query = {
      ...input(),
      origin: { ...input().origin, ...origin },
      destination: { ...input().destination, ...destination },
    };
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            routes: [
              {
                duration: '600s',
                legs: [
                  {
                    startLocation: { latLng: snapped },
                    endLocation: { latLng: destination },
                  },
                ],
              },
            ],
          }),
        ),
    );
    const result = await new GoogleOrdinaryRouteProvider(
      'SYNTHETIC_SECRET',
      fetcher,
      () => now,
    ).queryRoutes(query);
    expect(result.status).toBe(
      meters <= 100 ? 'SUCCESS' : 'PROVIDER_UNAVAILABLE',
    );
    if (result.status === 'SUCCESS')
      expect(result.candidates[0]!.legs[0]!.from.latitude).toBe(
        origin.latitude,
      );
  },
);
it('Google snapped wrong destination and close reversed endpoints are rejected', () => {
  const a = { latitude: 35.68, longitude: 139.76 },
    b = { latitude: 35.6805, longitude: 139.76 };
  expect(() => bindProviderEndpoints('GOOGLE', a, b, b, a)).toThrow();
  expect(() =>
    bindProviderEndpoints('GOOGLE', a, b, a, {
      latitude: 35.7,
      longitude: 139.76,
    }),
  ).toThrow();
});
it('configured server credential alone cannot open production gates', async () => {
  const fetcher = vi.fn(),
    env = Object.freeze({
      APP_ENV: 'production',
      BAIDU_SERVER_API_KEY: 'SYNTHETIC_SERVER_SECRET',
      GOOGLE_SERVER_API_KEY: 'SYNTHETIC_SERVER_SECRET',
    });
  const providers = createRegionalProviders(env, { fetcher });
  expect((await providers.routes.queryRoutes(input('DRIVING'))).status).toBe(
    'PROVIDER_UNAVAILABLE',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
