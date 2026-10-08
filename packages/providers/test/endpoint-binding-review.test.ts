import { expect, it, vi } from 'vitest';
import type { RouteProviderQueryInput } from '@travel/application';
import { baiduToWgs84 } from '../src/baidu-coordinates.js';
import {
  GoogleOrdinaryRouteProvider,
  BaiduOrdinaryRouteProvider,
} from '../src/regional-route-adapters.js';

const now = new Date('2031-01-01T00:00:00Z');
const googleOrigin = { latitude: 35.681236, longitude: 139.767125 };
const baiduOrigin = { lat: 39.915, lng: 116.404 };
function query(
  a: typeof googleOrigin,
  b: typeof googleOrigin,
): RouteProviderQueryInput {
  return {
    travelMode: 'WALKING',
    origin: {
      ...a,
      name: 'SYNTHETIC origin',
      placeId: 'SYNTHETIC:a',
      timeZone: 'Asia/Shanghai',
    },
    destination: {
      ...b,
      name: 'SYNTHETIC destination',
      placeId: 'SYNTHETIC:b',
      timeZone: 'Asia/Shanghai',
    },
    preference: { type: 'NONE' },
    earliestDeparture: null,
    latestArrival: null,
  };
}
it.each(['GOOGLE', 'BAIDU'] as const)(
  'SYNTHETIC %s rejects the independently reproduced midpoint collapse',
  async (provider) => {
    const a =
      provider === 'GOOGLE'
        ? googleOrigin
        : baiduToWgs84(baiduOrigin.lat, baiduOrigin.lng);
    const b = {
      ...a,
      latitude: a.latitude + (provider === 'GOOGLE' ? 0.0009 : 0.0004),
    };
    const midpoint =
      provider === 'GOOGLE'
        ? { ...a, latitude: (a.latitude + b.latitude) / 2 }
        : { ...baiduOrigin, lat: baiduOrigin.lat + 0.0002 };
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(
            provider === 'GOOGLE'
              ? {
                  routes: [
                    {
                      duration: '1s',
                      legs: [
                        {
                          startLocation: { latLng: midpoint },
                          endLocation: { latLng: midpoint },
                        },
                      ],
                    },
                  ],
                }
              : {
                  status: 0,
                  result: {
                    origin: { originPt: midpoint },
                    destination: { destinationPt: midpoint },
                    routes: [{ duration: 1 }],
                  },
                },
          ),
        ),
    );
    const adapter =
      provider === 'GOOGLE'
        ? new GoogleOrdinaryRouteProvider('SYNTHETIC', fetcher, () => now)
        : new BaiduOrdinaryRouteProvider('SYNTHETIC', fetcher, () => now);
    expect(await adapter.queryRoutes(query(a, b))).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'UPSTREAM_UNAVAILABLE',
    });
  },
);
it.each(['WALKING', 'DRIVING', 'CYCLING', 'TRANSIT'] as const)(
  'only confirmed Baidu TRANSIT 1002 is unsupported, not %s generically',
  async (mode) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ status: 1002, result: null })),
    );
    const q = query(googleOrigin, {
      ...googleOrigin,
      latitude: googleOrigin.latitude + 0.01,
    });
    const result = await new BaiduOrdinaryRouteProvider(
      'SYNTHETIC',
      fetcher,
      () => now,
    ).queryRoutes({ ...q, travelMode: mode });
    expect(result.status).toBe(
      mode === 'TRANSIT' ? 'UNSUPPORTED_QUERY' : 'PROVIDER_UNAVAILABLE',
    );
  },
);

it.each(['GOOGLE', 'BAIDU'] as const)(
  'SYNTHETIC %s rejects swapped, parallel-road, oversized and ambiguous endpoints',
  async (provider) => {
    const rawA =
      provider === 'GOOGLE'
        ? googleOrigin
        : { latitude: baiduOrigin.lat, longitude: baiduOrigin.lng };
    const rawB = { ...rawA, latitude: rawA.latitude + 0.0004 };
    const normalize = (p: typeof rawA) =>
      provider === 'GOOGLE' ? p : baiduToWgs84(p.latitude, p.longitude);
    const { bindProviderEndpoints } =
      await import('../src/endpoint-binding.js');
    const a = normalize(rawA),
      b = normalize(rawB);
    const closeB = { ...rawA, latitude: rawA.latitude + 0.00001 };
    expect(() =>
      bindProviderEndpoints(provider, a, normalize(closeB), closeB, rawA),
    ).toThrow('INVALID_PROVIDER_ENDPOINTS');
    for (const [start, end] of [
      [rawB, rawA],
      [
        { ...rawA, longitude: rawA.longitude + 0.0001 },
        { ...rawB, longitude: rawB.longitude + 0.0001 },
      ],
      [{ ...rawA, latitude: rawA.latitude + 0.01 }, rawB],
      [rawA, rawA],
      [
        { ...rawA, latitude: rawA.latitude + 0.000199 },
        { ...rawA, latitude: rawA.latitude + 0.000201 },
      ],
    ])
      expect(() => bindProviderEndpoints(provider, a, b, start, end)).toThrow(
        'INVALID_PROVIDER_ENDPOINTS',
      );
  },
);
it('SYNTHETIC safe precision-only binding preserves returned coordinates and whitelisted snapping evidence', async () => {
  const { bindProviderEndpoints } = await import('../src/endpoint-binding.js');
  const a = googleOrigin,
    b = { ...a, latitude: a.latitude + 0.01 };
  const returned = { ...a, latitude: a.latitude + 0.0000001 };
  const evidence = bindProviderEndpoints(
    'GOOGLE',
    a,
    b,
    { ...returned, hidden: 'SYNTHETIC_SECRET' },
    b,
  );
  expect(evidence.from).toEqual(returned);
  expect(evidence.evidenceRef).not.toContain('SYNTHETIC_SECRET');
  expect(
    JSON.parse(evidence.evidenceRef.replace('endpoint-evidence:v1:', '')),
  ).toMatchObject({ rawStart: returned, normalizedStart: returned });
  expect(() =>
    bindProviderEndpoints(
      'GOOGLE',
      a,
      { ...a, latitude: a.latitude + 0.0000001 },
      a,
      a,
    ),
  ).toThrow();
});
it.each([
  { status: 1001, http: 200, expected: 'NO_MATCHING_CANDIDATE' },
  { status: 1003, http: 200, expected: 'PROVIDER_UNAVAILABLE' },
  { status: 1002, http: 500, expected: 'PROVIDER_UNAVAILABLE' },
  { status: '1002', http: 200, expected: 'PROVIDER_UNAVAILABLE' },
])(
  'Baidu TRANSIT status $status / HTTP $http remains narrowly classified',
  async ({ status, http, expected }) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ status, result: null }), {
          status: http,
        }),
    );
    expect(
      (
        await new BaiduOrdinaryRouteProvider(
          'SYNTHETIC',
          fetcher,
          () => now,
        ).queryRoutes({
          ...query(googleOrigin, {
            ...googleOrigin,
            latitude: googleOrigin.latitude + 0.01,
          }),
          travelMode: 'TRANSIT',
        })
      ).status,
    ).toBe(expected);
  },
);
