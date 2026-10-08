import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteProviderQueryInput } from '@travel/application';
import {
  BaiduOrdinaryRouteProvider,
  GoogleOrdinaryRouteProvider,
  baiduToWgs84,
  createRegionalProviders,
} from '../src/index.js';

// SYNTHETIC endpoints, responses, credentials and duration. No network fetch.
const frozen = new Date('2026-10-08T04:00:00Z');
const target = new Date('2026-10-10T10:00:00Z'); // 18:00 Asia/Shanghai
export const raw = [
  { lat: 39.915, lng: 116.404 },
  { lat: 39.925, lng: 116.414 },
];
function query(mode: 'DRIVING' | 'TRANSIT'): RouteProviderQueryInput {
  return {
    travelMode: mode,
    origin: {
      ...baiduToWgs84(raw[0]!.lat, raw[0]!.lng),
      placeId: 'SYNTHETIC:origin',
      name: 'SYNTHETIC 出发地点',
      timeZone: 'Asia/Shanghai',
    },
    destination: {
      ...baiduToWgs84(raw[1]!.lat, raw[1]!.lng),
      placeId: 'SYNTHETIC:station',
      name: 'SYNTHETIC 高铁站',
      timeZone: 'Asia/Shanghai',
    },
    earliestDeparture: target,
    latestArrival: new Date('2026-10-10T10:45:00Z'),
    preference: {
      type: 'DEPART_AT',
      instant: target,
      timeZone: 'Asia/Shanghai',
    },
  };
}
function response(mode: 'DRIVING' | 'TRANSIT') {
  return {
    status: 0,
    result: {
      origin:
        mode === 'DRIVING'
          ? raw[0]
          : { city_id: 'SYNTHETIC:city', location: raw[0] },
      destination:
        mode === 'DRIVING'
          ? raw[1]
          : { city_id: 'SYNTHETIC:city', location: raw[1] },
      routes: [
        {
          duration: 1800,
          steps: [
            {
              platform: 'SYNTHETIC unknown platform',
              line: 'SYNTHETIC raw line',
            },
          ],
          taxi_wait_time: 99,
        },
      ],
    },
  };
}
const env = {
  APP_ENV: 'test',
  BAIDU_SERVER_API_KEY: 'SYNTHETIC_NO_REAL_KEY',
  BAIDU_LIVE_API_ENABLED: 'true',
  BAIDU_ENTITLEMENT_APPROVED: 'true',
  BAIDU_STORAGE_APPROVED: 'true',
  BAIDU_ATTRIBUTION_APPROVED: 'true',
  BAIDU_COORDINATES_APPROVED: 'true',
  BAIDU_FUTURE_DRIVING_APPROVED: 'true',
};
describe('V1 actual travel scenario contracts — SYNTHETIC HTTP, frozen 2026-10-08', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(frozen);
  });
  afterEach(() => vi.useRealTimers());
  it('Oct10 18:00 Shanghai stays the exact future UNIX instant through regional composition', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(response('DRIVING'))),
    );
    const result = await createRegionalProviders(env, {
      fetcher,
    }).routes.queryRoutes(query('DRIVING'));
    expect(result.status).toBe('SUCCESS');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.hostname).toBe('api.map.baidu.com');
    expect(url.searchParams.get('departure_time')).toBe(
      String(target.getTime() / 1000),
    );
    expect(url.searchParams.get('departure_time')).not.toBe(
      String(frozen.getTime() / 1000),
    );
    if (result.status !== 'SUCCESS')
      throw new Error('Expected SYNTHETIC route');
    const c = result.candidates[0]!;
    expect(c.departure).toEqual({ instant: target, timeZone: 'Asia/Shanghai' });
    expect(c.arrival.instant.toISOString()).toBe('2026-10-10T10:30:00.000Z');
    expect(c.observedAt).toEqual(frozen);
    expect(c.legs[0]!.fixedService).toBe(false);
    expect(c.legs[0]!.serviceLabel).toBeNull();
    expect(c.fare).toBeNull();
    expect(JSON.stringify(c)).not.toMatch(
      /taxi_wait|wait_time|SYNTHETIC_NO_REAL_KEY/,
    );
  });
  it.each([
    'BAIDU_FUTURE_DRIVING_APPROVED',
    'BAIDU_ENTITLEMENT_APPROVED',
    'BAIDU_LIVE_API_ENABLED',
  ])('missing %s fails explicitly with zero HTTP attempts', async (gate) => {
    const fetcher = vi.fn<typeof fetch>();
    const r = await createRegionalProviders(
      { ...env, [gate]: 'false' },
      { fetcher },
    ).routes.queryRoutes(query('DRIVING'));
    expect(r.status).toBe(
      gate === 'BAIDU_FUTURE_DRIVING_APPROVED'
        ? 'UNSUPPORTED_QUERY'
        : 'PROVIDER_UNAVAILABLE',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('future prediction rejection never retries a current-traffic endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            status: 210,
            message: 'SYNTHETIC entitlement rejected',
          }),
        ),
    );
    expect(
      await createRegionalProviders(env, { fetcher }).routes.queryRoutes(
        query('DRIVING'),
      ),
    ).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'UPSTREAM_UNAVAILABLE',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      new URL(String(fetcher.mock.calls[0]![0])).searchParams.has(
        'departure_time',
      ),
    ).toBe(true);
  });
  it.each(['ARRIVE_BY', 'OVER_SEVEN_DAYS', 'PAST'] as const)(
    '%s is unsupported, never NOW',
    async (fault) => {
      const q = query('DRIVING');
      const fetcher = vi.fn<typeof fetch>();
      const instant =
        fault === 'OVER_SEVEN_DAYS'
          ? new Date('2026-10-16T10:00:00Z')
          : fault === 'PAST'
            ? new Date('2026-10-07T10:00:00Z')
            : target;
      expect(
        (
          await new BaiduOrdinaryRouteProvider(
            'SYNTHETIC',
            fetcher,
            () => frozen,
            true,
          ).queryRoutes({
            ...q,
            earliestDeparture: null,
            preference: {
              type: fault === 'ARRIVE_BY' ? 'ARRIVE_BY' : 'DEPART_AT',
              instant,
              timeZone: 'Asia/Shanghai',
            },
          })
        ).status,
      ).toBe('UNSUPPORTED_QUERY');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('Google future driving sends absolute departureTime and does not use current time', async () => {
    const q = query('DRIVING');
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            routes: [
              {
                duration: '1800s',
                legs: [
                  {
                    startLocation: { latLng: q.origin },
                    endLocation: { latLng: q.destination },
                  },
                ],
              },
            ],
          }),
        ),
    );
    const r = await new GoogleOrdinaryRouteProvider(
      'SYNTHETIC',
      fetcher,
      () => frozen,
    ).queryRoutes(q);
    expect(r.status).toBe('SUCCESS');
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject(
      {
        departureTime: target.toISOString(),
        routingPreference: 'TRAFFIC_AWARE',
        travelMode: 'DRIVE',
      },
    );
  });
  it('same-city public transit is duration-only, never an invented timetable/transfer/platform', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(response('TRANSIT'))),
    );
    const r = await createRegionalProviders(env, {
      fetcher,
    }).routes.queryRoutes(query('TRANSIT'));
    expect(r.status).toBe('SUCCESS');
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('departure_date')).toBe('2026-10-10');
    expect(url.searchParams.get('departure_time')).toBe('18:00');
    if (r.status !== 'SUCCESS') throw new Error('Expected SYNTHETIC route');
    expect(r.candidates[0]!.legs).toHaveLength(1);
    expect(r.candidates[0]!.legs[0]).toMatchObject({
      mode: 'TRANSIT',
      fixedService: false,
      serviceLabel: null,
    });
    expect(r.candidates[0]!.legs[0]).not.toHaveProperty('groundTransit');
    expect(JSON.stringify(r)).not.toMatch(/platform|raw line|taxi_wait/);
  });
});
