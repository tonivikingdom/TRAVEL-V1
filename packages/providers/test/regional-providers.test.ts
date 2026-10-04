import { describe, it, expect, vi } from 'vitest';
import {
  classifyProviderRegion,
  mapProviderProjection,
  RegionalRouteProvider,
  RegionalPlaceSearchProvider,
  createRegionalProviders,
  GoogleOrdinaryRouteProvider,
  BaiduOrdinaryRouteProvider,
  GooglePlaceSearchProvider,
  BaiduPlaceSearchProvider,
} from '../src/index.js';
import { baiduToWgs84 } from '../src/baidu-coordinates.js';
import { validateRouteCandidate } from '@travel/domain';
import type { RouteProviderQueryInput } from '@travel/application';
const now = new Date('2031-01-01T00:00:00Z');
const locations = {
  cn: { latitude: 39.9042, longitude: 116.4074 },
  jp: { latitude: 35.681236, longitude: 139.767125 },
  global: { latitude: 48.8566, longitude: 2.3522 },
  hk: { latitude: 22.3193, longitude: 114.1694 },
  mo: { latitude: 22.1987, longitude: 113.5439 },
  tw: { latitude: 25.033, longitude: 121.5654 },
};
const input = (
  p = locations.jp,
  travelMode: RouteProviderQueryInput['travelMode'] = 'WALKING',
): RouteProviderQueryInput => ({
  origin: {
    ...p,
    placeId: 'SYNTHETIC:origin',
    name: 'SYNTHETIC origin',
    timeZone: 'Asia/Tokyo',
  },
  destination: {
    ...p,
    longitude: p.longitude + 0.001,
    placeId: 'SYNTHETIC:destination',
    name: 'SYNTHETIC destination',
    timeZone: 'Asia/Tokyo',
  },
  travelMode: travelMode!,
  earliestDeparture: now,
  latestArrival: null,
  preference: { type: 'DEPART_AT', instant: now, timeZone: 'Asia/Tokyo' },
});
const http = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body)));
describe('regional policy — SYNTHETIC coordinates/HTTP, no live calls', () => {
  it.each([
    ['cn', 'MAINLAND_CHINA'],
    ['jp', 'JAPAN'],
    ['global', 'GLOBAL_OTHER'],
    ['hk', 'GLOBAL_OTHER'],
    ['mo', 'GLOBAL_OTHER'],
    ['tw', 'GLOBAL_OTHER'],
  ] as const)('%s has deterministic policy %s', (name, region) =>
    expect(classifyProviderRegion(locations[name])).toBe(region),
  );
  it.each([
    { latitude: NaN, longitude: 1 },
    { latitude: 91, longitude: 1 },
    { latitude: 1, longitude: 181 },
  ])('invalid coordinates are unresolved', (p) =>
    expect(classifyProviderRegion(p)).toBeNull(),
  );
  it('does not treat China bounding rectangle as China or exclude inland islands', () => {
    expect(
      classifyProviderRegion({ latitude: 37.5665, longitude: 126.978 }),
    ).toBe('GLOBAL_OTHER');
    expect(classifyProviderRegion({ latitude: 20.02, longitude: 110.32 })).toBe(
      'MAINLAND_CHINA',
    );
    expect(
      classifyProviderRegion({ latitude: 43.0618, longitude: 141.3545 }),
    ).toBe('JAPAN');
  });
  it('map contract projects one policy and contains no key/SDK readiness claim', () => {
    expect(mapProviderProjection(locations.cn)).toEqual({
      region: 'MAINLAND_CHINA',
      provider: 'BAIDU',
      coordinates: locations.cn,
      coordinateSystem: 'WGS84',
    });
    expect(mapProviderProjection(locations.jp).provider).toBe('GOOGLE');
  });
  it.each([
    ['cn', 'WALKING', 'baiduRoute'],
    ['cn', 'DRIVING', 'baiduRoute'],
    ['jp', 'WALKING', 'googleRoute'],
    ['jp', 'DRIVING', 'googleRoute'],
    ['jp', 'TRANSIT', 'japanTransit'],
    ['global', 'WALKING', 'googleRoute'],
    ['global', 'DRIVING', 'googleRoute'],
  ] as const)('%s %s dispatches only %s', async (place, mode, slot) => {
    const providers = {
      baiduRoute: {
        queryRoutes: vi.fn(async () => ({
          status: 'NO_MATCHING_CANDIDATE' as const,
        })),
      },
      googleRoute: {
        queryRoutes: vi.fn(async () => ({
          status: 'NO_MATCHING_CANDIDATE' as const,
        })),
      },
      japanTransit: {
        queryRoutes: vi.fn(async () => ({
          status: 'NO_MATCHING_CANDIDATE' as const,
        })),
      },
    };
    await new RegionalRouteProvider(providers).queryRoutes(
      input(locations[place], mode),
    );
    for (const [name, p] of Object.entries(providers))
      expect(p.queryRoutes).toHaveBeenCalledTimes(name === slot ? 1 : 0);
  });
  it.each(['cn', 'jp', 'global', 'hk', 'mo', 'tw'] as const)(
    'place %s uses contextual region, not query language',
    async (key) => {
      const baiduPlace = { search: vi.fn(async () => []) },
        googlePlace = { search: vi.fn(async () => []) };
      await new RegionalPlaceSearchProvider({ baiduPlace, googlePlace }).search(
        'SYNTHETIC query',
        'ja',
        locations[key],
      );
      expect(baiduPlace.search).toHaveBeenCalledTimes(key === 'cn' ? 1 : 0);
      expect(googlePlace.search).toHaveBeenCalledTimes(key === 'cn' ? 0 : 1);
    },
  );
  it('missing context and cross-region routes never dispatch or fallback', async () => {
    const googleRoute = {
      queryRoutes: vi.fn(async () => ({
        status: 'NO_MATCHING_CANDIDATE' as const,
      })),
    };
    const router = new RegionalRouteProvider({ googleRoute });
    expect(
      await router.queryRoutes({
        ...input(),
        destination: { ...input().destination, ...locations.cn },
      }),
    ).toEqual({ status: 'UNSUPPORTED_QUERY' });
    expect(await router.queryRoutes(input(locations.jp, 'TRANSIT'))).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'ROUTE_PROVIDER_UNCONFIGURED',
    });
    expect(googleRoute.queryRoutes).not.toHaveBeenCalled();
    await expect(
      new RegionalPlaceSearchProvider({}).search('東京', 'ja'),
    ).rejects.toThrow('CONTEXT_REQUIRED');
  });
  it('upstream failure is sanitized and never silently switches region', async () => {
    expect(
      await new RegionalRouteProvider({
        googleRoute: {
          queryRoutes: async () => {
            throw new Error('SYNTHETIC secret');
          },
        },
      }).queryRoutes(input()),
    ).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'UPSTREAM_UNAVAILABLE',
    });
  });
  it.each(['staging', 'production'])(
    'config gates fail closed in %s but allow independent Google region',
    async (APP_ENV) => {
      const fetcher = http({
        routes: [
          {
            duration: '600s',
            legs: [
              {
                startLocation: { latLng: locations.jp },
                endLocation: {
                  latLng: {
                    ...locations.jp,
                    longitude: locations.jp.longitude + 0.001,
                  },
                },
              },
            ],
          },
        ],
      });
      const p = createRegionalProviders(
        {
          APP_ENV,
          GOOGLE_SERVER_API_KEY: 'SYNTHETIC',
          GOOGLE_LIVE_API_ENABLED: 'true',
          GOOGLE_ENTITLEMENT_APPROVED: 'true',
          GOOGLE_STORAGE_APPROVED: 'true',
          GOOGLE_ATTRIBUTION_APPROVED: 'true',
        },
        { fetcher },
      );
      expect((await p.routes.queryRoutes(input())).status).toBe('SUCCESS');
      expect((await p.routes.queryRoutes(input(locations.cn))).status).toBe(
        'PROVIDER_UNAVAILABLE',
      );
      expect(
        (
          await createRegionalProviders(
            { APP_ENV, GOOGLE_SERVER_API_KEY: 'SYNTHETIC' },
            { fetcher },
          ).routes.queryRoutes(input())
        ).status,
      ).toBe('PROVIDER_UNAVAILABLE');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['google', 'baidu'])(
    '%s normalizes only explicit public fields and real duration',
    async (provider) => {
      const fetcher = http(
        provider === 'google'
          ? {
              routes: [
                {
                  duration: '600s',
                  legs: [
                    {
                      startLocation: { latLng: locations.jp },
                      endLocation: {
                        latLng: {
                          ...locations.jp,
                          longitude: locations.jp.longitude + 0.001,
                        },
                      },
                    },
                  ],
                  secretField: 'SYNTHETIC HIDDEN',
                },
              ],
            }
          : {
              status: 0,
              result: {
                origin: { lat: 39.915, lng: 116.404 },
                destination: { lat: 39.916, lng: 116.405 },
                routes: [{ duration: 600, secretField: 'SYNTHETIC HIDDEN' }],
              },
            },
      );
      const p =
        provider === 'google'
          ? new GoogleOrdinaryRouteProvider('SYNTHETIC', fetcher, () => now)
          : new BaiduOrdinaryRouteProvider('SYNTHETIC', fetcher, () => now);
      const q = input();
      const r = await p.queryRoutes(
        provider === 'google'
          ? q
          : {
              ...q,
              origin: { ...q.origin, ...baiduToWgs84(39.915, 116.404) },
              destination: {
                ...q.destination,
                ...baiduToWgs84(39.916, 116.405),
              },
            },
      );
      expect(r.status).toBe('SUCCESS');
      if (r.status !== 'SUCCESS') throw new Error('expected candidate');
      expect(
        validateRouteCandidate(r.candidates[0]!, {
          earliestDeparture: now,
          latestArrival: null,
        }),
      ).toEqual({ accepted: true });
      expect(r.candidates[0]?.fare).toBeNull();
      expect(JSON.stringify(r)).not.toContain('secretField');
    },
  );
  it.each(['google', 'baidu'])(
    '%s ARRIVE_BY is unsupported and makes zero HTTP calls',
    async (provider) => {
      const fetcher = http({});
      const p =
        provider === 'google'
          ? new GoogleOrdinaryRouteProvider('SYNTHETIC', fetcher)
          : new BaiduOrdinaryRouteProvider('SYNTHETIC', fetcher);
      expect(
        await p.queryRoutes({
          ...input(),
          preference: {
            type: 'ARRIVE_BY',
            instant: now,
            timeZone: 'Asia/Tokyo',
          },
        }),
      ).toEqual({ status: 'UNSUPPORTED_QUERY' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('Baidu future driving is unsupported; Google DEPART_AT drives with the exact authorized bound', async () => {
    const at = new Date(now.getTime() + 3600000),
      query = {
        ...input(locations.jp, 'DRIVING'),
        earliestDeparture: at,
        preference: {
          type: 'DEPART_AT' as const,
          instant: at,
          timeZone: 'Asia/Tokyo',
        },
      };
    const fetcher = http({
      routes: [
        {
          duration: '600s',
          legs: [
            {
              startLocation: { latLng: locations.jp },
              endLocation: {
                latLng: {
                  ...locations.jp,
                  longitude: locations.jp.longitude + 0.001,
                },
              },
            },
          ],
        },
      ],
    });
    expect(
      (
        await new BaiduOrdinaryRouteProvider(
          'SYNTHETIC',
          fetcher,
          () => now,
        ).queryRoutes(query)
      ).status,
    ).toBe('UNSUPPORTED_QUERY');
    expect(
      (
        await new GoogleOrdinaryRouteProvider(
          'SYNTHETIC',
          fetcher,
          () => now,
        ).queryRoutes(query)
      ).status,
    ).toBe('SUCCESS');
    const request = (
      fetcher.mock.calls as unknown as [string, RequestInit][]
    )[0]![1];
    expect(JSON.parse(request.body as string).departureTime).toBe(
      at.toISOString(),
    );
  });
  it('unknown timezone/mode fails before HTTP; no hint timezone fallback', async () => {
    const fetcher = http({});
    const p = new GoogleOrdinaryRouteProvider('SYNTHETIC', fetcher);
    expect(
      await p.queryRoutes({
        ...input(),
        origin: { placeId: 'x', name: 'SYNTHETIC unknown', ...locations.jp },
      }),
    ).toEqual({ status: 'UNSUPPORTED_QUERY' });
    const { travelMode: _mode, ...withoutMode } = input();
    void _mode;
    expect(
      await new RegionalRouteProvider({}).queryRoutes(withoutMode),
    ).toEqual({ status: 'UNSUPPORTED_QUERY' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('Google Place returns IDs/coordinates without Provider payload', async () => {
    const fetcher = http({
      places: [
        {
          id: 'SYNTHETIC:place',
          displayName: { text: 'SYNTHETIC place' },
          formattedAddress: 'SYNTHETIC address',
          location: locations.jp,
          hidden: 'SYNTHETIC hidden',
        },
      ],
    });
    const r = await new GooglePlaceSearchProvider('SYNTHETIC', fetcher).search(
      'SYNTHETIC',
      'zh',
      locations.jp,
    );
    expect(r[0]).toMatchObject({
      provider: 'google',
      externalId: 'SYNTHETIC:place',
      coordinates: locations.jp,
    });
    expect(r[0]).not.toHaveProperty('hidden');
  });
  it('Baidu Place converts declared BD09 output before exposing WGS84', async () => {
    const fetcher = http({
      status: 0,
      results: [
        {
          uid: 'SYNTHETIC:place',
          name: 'SYNTHETIC Beijing',
          location: { lat: 39.915, lng: 116.404 },
        },
      ],
    });
    const r = await new BaiduPlaceSearchProvider('SYNTHETIC', fetcher).search(
      'SYNTHETIC',
      'en',
      locations.cn,
    );
    expect(r[0]?.coordinates?.latitude).toBeCloseTo(39.90725, 4);
    expect(r[0]?.coordinates?.longitude).toBeCloseTo(116.39138, 4);
    expect(r[0]?.provider).toBe('baidu');
  });
  it.each(['missing', 'wrong-origin', 'wrong-destination'])(
    'Google %s endpoint fails closed without a normalized candidate',
    async (fault) => {
      const from = fault === 'wrong-origin' ? locations.global : locations.jp;
      const to =
        fault === 'wrong-destination'
          ? locations.global
          : { ...locations.jp, longitude: locations.jp.longitude + 0.001 };
      const fetcher = http({
        routes: [
          {
            duration: '600s',
            ...(fault === 'missing'
              ? {}
              : {
                  legs: [
                    {
                      startLocation: { latLng: from },
                      endLocation: { latLng: to },
                    },
                  ],
                }),
          },
        ],
      });
      expect(
        await new GoogleOrdinaryRouteProvider(
          'SYNTHETIC',
          fetcher,
          () => now,
        ).queryRoutes(input()),
      ).toEqual({
        status: 'PROVIDER_UNAVAILABLE',
        reason: 'UPSTREAM_UNAVAILABLE',
      });
    },
  );
  it('Baidu missing endpoint evidence fails closed; invalid zone never calls Provider', async () => {
    const fetcher = http({
      status: 0,
      result: { routes: [{ duration: 600 }] },
    });
    expect(
      (
        await new BaiduOrdinaryRouteProvider(
          'SYNTHETIC',
          fetcher,
          () => now,
        ).queryRoutes(input())
      ).status,
    ).toBe('PROVIDER_UNAVAILABLE');
    fetcher.mockClear();
    expect(
      (
        await new GoogleOrdinaryRouteProvider(
          'SYNTHETIC',
          fetcher,
          () => now,
        ).queryRoutes({
          ...input(),
          origin: { ...input().origin, timeZone: 'SYNTHETIC_INVALID' },
        })
      ).status,
    ).toBe('UNSUPPORTED_QUERY');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
