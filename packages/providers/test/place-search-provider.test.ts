import { describe, expect, it, vi } from 'vitest';
import {
  createPlaceSearchProvider,
  GeoapifyPlaceSearchProvider,
} from '../src/place-search-provider.js';
const result = {
  datasource: { sourcename: 'openstreetmap' },
  place_id: 'osm:123',
  name: '東京駅',
  formatted: '日本 東京都千代田区',
  lat: 35.68,
  lon: 139.76,
};
describe('Place Search provider boundary (SYNTHETIC HTTP)', () => {
  it('uses fixed HTTPS endpoint, Japanese localization, bounded results and reliable Provider coordinates', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [result, { ...result, place_id: 'osm:456' }],
          }),
        ),
    );
    const candidates = await new GeoapifyPlaceSearchProvider(
      'SYNTHETIC_KEY',
      fetcher,
    ).search('東京駅', 'ja');
    const url = (fetcher.mock.calls as unknown as [URL][])[0]?.[0];
    expect(String(url)).toContain(
      'https://api.geoapify.com/v1/geocode/search?',
    );
    expect(String(url)).toContain('lang=ja');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      coordinates: { latitude: 35.68, longitude: 139.76 },
      externalId: 'osm:123',
      synthetic: false,
    });
    expect(candidates[0]?.attribution).toContain('OpenStreetMap');
  });
  it('keeps absent/invalid coordinates unknown, excludes unsupported data sources and does not merge names', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { ...result, lat: null },
              { ...result, lon: 999 },
              { ...result, datasource: { sourcename: 'unassessed' } },
            ],
          }),
        ),
    );
    const candidates = await new GeoapifyPlaceSearchProvider(
      'SYNTHETIC_KEY',
      fetcher,
    ).search('東京駅', 'ja');
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.coordinates === null)).toBe(true);
  });
  it.each([401, 429, 503])(
    'fails locally for HTTP %s without exposing credentials',
    async (status) => {
      const provider = new GeoapifyPlaceSearchProvider(
        'SYNTHETIC_SECRET',
        async () => new Response('', { status }),
      );
      await expect(provider.search('東京駅', 'ja')).rejects.toThrow(
        'Place Provider unavailable',
      );
    },
  );
  it('rejects malformed responses', async () => {
    await expect(
      new GeoapifyPlaceSearchProvider(
        'SYNTHETIC_KEY',
        async () => new Response('{}'),
      ).search('東京駅', 'ja'),
    ).rejects.toThrow('Invalid Place Provider');
  });
  it('requires live, storage and key gates; has no fallback synthetic production data', async () => {
    await expect(
      createPlaceSearchProvider({
        PLACE_SEARCH_PROVIDER: 'geoapify',
        GEOAPIFY_API_KEY: 'SYNTHETIC_KEY',
      }).search('x', 'ja'),
    ).rejects.toThrow('unconfigured');
    expect(() =>
      createPlaceSearchProvider({
        PLACE_SEARCH_PROVIDER: 'synthetic',
        APP_ENV: 'production',
        SYNTHETIC_CI_ONLY: 'true',
      }),
    ).toThrow('development/test');
    expect(
      createPlaceSearchProvider({
        PLACE_SEARCH_PROVIDER: 'geoapify',
        PLACE_SEARCH_LIVE_API_ENABLED: 'true',
        PLACE_SEARCH_STORAGE_APPROVED: 'true',
        GEOAPIFY_API_KEY: 'SYNTHETIC_KEY',
      }),
    ).toBeInstanceOf(GeoapifyPlaceSearchProvider);
  });
});
