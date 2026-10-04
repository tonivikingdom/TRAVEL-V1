import type { PlaceSearchProvider } from '@travel/application';
import type { PlaceSearchCandidate } from '@travel/contracts';
const attribution = 'Powered by Geoapify · © OpenStreetMap contributors';
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim().length && v.length <= max ? v.trim() : null;
export class GeoapifyPlaceSearchProvider implements PlaceSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async search(
    query: string,
    language: string,
  ): Promise<readonly PlaceSearchCandidate[]> {
    const url = new URL('https://api.geoapify.com/v1/geocode/search');
    url.search = new URLSearchParams({
      text: query,
      lang: language,
      limit: '5',
      format: 'json',
      apiKey: this.apiKey,
    }).toString();
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Place Provider unavailable');
    const body = record(await response.json());
    if (!Array.isArray(body.results))
      throw new Error('Invalid Place Provider response');
    return body.results.slice(0, 5).flatMap((value) => {
      const r = record(value),
        source = record(r.datasource);
      // Reject data sources whose storage/attribution has not been assessed.
      if (source.sourcename !== 'openstreetmap') return [];
      const externalId = text(r.place_id, 300),
        name = text(r.name, 200) ?? text(r.address_line1, 200),
        formattedAddress = text(r.formatted, 500);
      if (!externalId || !name) return [];
      const coordinates =
        typeof r.lat === 'number' &&
        typeof r.lon === 'number' &&
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        Math.abs(r.lat) <= 90 &&
        Math.abs(r.lon) <= 180
          ? { latitude: r.lat, longitude: r.lon }
          : null;
      return [
        {
          provider: 'geoapify',
          externalId,
          name,
          formattedAddress,
          coordinates,
          attribution,
          synthetic: false,
        },
      ];
    });
  }
}
export class UnconfiguredPlaceSearchProvider implements PlaceSearchProvider {
  async search(): Promise<readonly PlaceSearchCandidate[]> {
    throw new Error('Place Search unconfigured');
  }
}
export class SyntheticPlaceSearchProvider implements PlaceSearchProvider {
  async search(query: string): Promise<readonly PlaceSearchCandidate[]> {
    if (query === 'unavailable') throw new Error('SYNTHETIC outage');
    return [0, 1, 2].map((i) => ({
      provider: 'synthetic',
      externalId: `synthetic-station-${i}`,
      name: 'SYNTHETIC 東京駅・中央改札口から歩いて訪れる非常に長い日本語の地点名称',
      formattedAddress: `SYNTHETIC 日本 東京都千代田区丸の内一丁目・${i + 1}番地・北口地下連絡通路`,
      coordinates:
        i === 2
          ? null
          : {
              latitude: Number((35.681236 + i / 1000).toFixed(6)),
              longitude: 139.767125,
            },
      attribution: 'SYNTHETIC fixture — not a real search result',
      synthetic: true,
    }));
  }
}
export function createPlaceSearchProvider(
  env: NodeJS.ProcessEnv,
): PlaceSearchProvider {
  const provider = env.PLACE_SEARCH_PROVIDER ?? 'unconfigured';
  if (provider === 'synthetic') {
    if (
      !['development', 'test'].includes(env.APP_ENV ?? '') ||
      env.SYNTHETIC_CI_ONLY !== 'true'
    )
      throw new Error('Synthetic Place Search is development/test only');
    return new SyntheticPlaceSearchProvider();
  }
  if (provider === 'unconfigured') return new UnconfiguredPlaceSearchProvider();
  if (provider !== 'geoapify')
    throw new Error('Unsupported PLACE_SEARCH_PROVIDER');
  if (
    env.PLACE_SEARCH_LIVE_API_ENABLED !== 'true' ||
    env.PLACE_SEARCH_STORAGE_APPROVED !== 'true' ||
    !env.GEOAPIFY_API_KEY?.trim()
  )
    return new UnconfiguredPlaceSearchProvider();
  return new GeoapifyPlaceSearchProvider(env.GEOAPIFY_API_KEY);
}
