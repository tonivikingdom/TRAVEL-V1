import { describe, expect, it, vi } from 'vitest';
import type { RouteProviderQueryInput } from '@travel/application';
import {
  createRuntimeRouteProvider,
  RegionalRouteProvider,
} from '../src/index.js';
const token = 'SYNTHETIC_RUNTIME_JAPAN_TOKEN_ONLY_32';
const input = (
  mode: 'TRANSIT' | 'WALKING' | 'DRIVING' = 'TRANSIT',
): RouteProviderQueryInput => ({
  origin: {
    placeId: 'SYNTHETIC:A',
    name: 'SYNTHETIC Tokyo',
    timeZone: 'Asia/Tokyo',
    latitude: 35.681236,
    longitude: 139.767125,
  },
  destination: {
    placeId: 'SYNTHETIC:B',
    name: 'SYNTHETIC Shinjuku',
    timeZone: 'Asia/Tokyo',
    latitude: 35.690921,
    longitude: 139.700258,
  },
  earliestDeparture: new Date('2030-10-01T01:00:00Z'),
  latestArrival: null,
  preference: {
    type: 'DEPART_AT',
    instant: new Date('2030-10-01T01:00:00Z'),
    timeZone: 'Asia/Tokyo',
  },
  travelMode: mode,
});
const env = {
  APP_ENV: 'test',
  GOOGLE_CONSUMER_TRANSIT_ENABLED: 'true',
  GOOGLE_CONSUMER_TRANSIT_TOKEN: token,
};
describe('SYNTHETIC runtime Japan slot; no live/paid calls', () => {
  it.each(['regional', 'google_consumer_experimental'])(
    'dispatches %s only through Region Router and sidecar',
    async (ROUTE_PROVIDER) => {
      const fetcher = vi.fn(async (url, init) => {
        expect(String(url)).toBe('http://127.0.0.1:8787/v1/transit/search');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${token}`,
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          timezone: 'Asia/Tokyo',
          timeMode: 'DEPART_AT',
          time: '10:00',
        });
        return new Response(
          JSON.stringify({
            status: 'ERROR',
            error: { code: 'UPSTREAM_ERROR' },
          }),
          { status: 503 },
        );
      });
      const p = createRuntimeRouteProvider(
        { ...env, ROUTE_PROVIDER },
        { fetcher },
      );
      expect(p).toBeInstanceOf(RegionalRouteProvider);
      expect(await p.queryRoutes(input())).toMatchObject({
        status: 'PROVIDER_UNAVAILABLE',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      for (const mode of ['WALKING', 'DRIVING'] as const)
        expect(await p.queryRoutes(input(mode))).toMatchObject({
          status: 'PROVIDER_UNAVAILABLE',
          reason: 'ROUTE_PROVIDER_UNCONFIGURED',
        });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    {},
    {
      GOOGLE_CONSUMER_TRANSIT_ENABLED: 'false',
      GOOGLE_CONSUMER_TRANSIT_TOKEN: token,
    },
    { GOOGLE_CONSUMER_TRANSIT_ENABLED: 'true' },
    { ROUTE_PROVIDER: 'google_consumer_experimental' },
  ])('missing gate/token disables only Japan slot', async (config) => {
    const fetcher = vi.fn();
    const p = createRuntimeRouteProvider(
      { APP_ENV: 'test', ...config },
      { fetcher },
    );
    expect(await p.queryRoutes(input())).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'ROUTE_PROVIDER_UNCONFIGURED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'missing-token', 'outage'] as const)(
    'Japan %s cannot fall back even when ordinary Google is configured',
    async (state) => {
      const fetcher = vi.fn(async (url) => {
        return new Response(
          JSON.stringify(
            String(url).includes('/v1/transit/search')
              ? { status: 'ERROR', error: { code: 'UPSTREAM_ERROR' } }
              : { routes: [] },
          ),
          { status: String(url).includes('/v1/transit/search') ? 503 : 200 },
        );
      });
      const p = createRuntimeRouteProvider(
        {
          ...env,
          GOOGLE_CONSUMER_TRANSIT_ENABLED:
            state === 'disabled' ? 'false' : 'true',
          GOOGLE_CONSUMER_TRANSIT_TOKEN: state === 'missing-token' ? '' : token,
          GOOGLE_LIVE_API_ENABLED: 'true',
          GOOGLE_ENTITLEMENT_APPROVED: 'true',
          GOOGLE_STORAGE_APPROVED: 'true',
          GOOGLE_ATTRIBUTION_APPROVED: 'true',
          GOOGLE_SERVER_API_KEY: 'SYNTHETIC_ORDINARY_TEST_ONLY',
        },
        { fetcher },
      );
      expect(await p.queryRoutes(input())).toMatchObject({
        status: 'PROVIDER_UNAVAILABLE',
      });
      expect(fetcher).toHaveBeenCalledTimes(state === 'outage' ? 1 : 0);
      if (state === 'outage')
        expect(String(fetcher.mock.calls[0]![0])).toContain(
          '/v1/transit/search',
        );
      await p.queryRoutes(input('WALKING'));
      expect(fetcher).toHaveBeenCalledTimes(state === 'outage' ? 2 : 1);
      expect(String(fetcher.mock.calls.at(-1)![0])).toContain(
        'routes.googleapis.com',
      );
    },
  );
  it('explicitly unconfigured runtime preserves unavailable before legacy missing-mode validation; zero I/O', async () => {
    const fetcher = vi.fn();
    const { travelMode: ignoredMode, ...withoutMode } = input();
    void ignoredMode;
    const p = createRuntimeRouteProvider(
      { APP_ENV: 'test', ROUTE_PROVIDER: 'unconfigured' },
      { fetcher },
    );
    expect(await p.queryRoutes(withoutMode)).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'ROUTE_PROVIDER_UNCONFIGURED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['staging', 'production'])(
    'never enables Consumer transit in %s',
    (APP_ENV) => {
      expect(() => createRuntimeRouteProvider({ ...env, APP_ENV })).toThrow(
        'development or test',
      );
      expect(() =>
        createRuntimeRouteProvider({
          ...env,
          APP_ENV,
          ROUTE_PROVIDER: 'google_consumer_experimental',
        }),
      ).toThrow('development or test');
      expect(createRuntimeRouteProvider({ APP_ENV })).toBeInstanceOf(
        RegionalRouteProvider,
      );
    },
  );
  it('sidecar transport failure cannot become no-routes or ordinary fallback', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('SYNTHETIC outage');
    });
    expect(
      await createRuntimeRouteProvider(env, { fetcher }).queryRoutes(input()),
    ).toMatchObject({ status: 'PROVIDER_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    'http://example.test:8787',
    'https://127.0.0.1:8787',
    'http://127.0.0.1:8787/path',
  ])('keeps existing loopback URL guard for %s', (baseUrl) => {
    expect(() =>
      createRuntimeRouteProvider({
        ...env,
        GOOGLE_CONSUMER_TRANSIT_BASE_URL: baseUrl,
      }),
    ).toThrow('HTTP loopback origin');
  });
  it('invalid timeout and switch remain errors', () => {
    expect(() =>
      createRuntimeRouteProvider({
        ...env,
        GOOGLE_CONSUMER_TRANSIT_TIMEOUT_MS: '999',
      }),
    ).toThrow('TIMEOUT_MS');
    expect(() =>
      createRuntimeRouteProvider({
        ...env,
        GOOGLE_CONSUMER_TRANSIT_ENABLED: 'yes',
      }),
    ).toThrow('true or false');
  });
});
