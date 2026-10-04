import type { PlaceSearchProvider } from '@travel/application';
import type { PlaceSearchCandidate } from '@travel/contracts';
import { coordinate, json, record, string } from './regional-http.js';
import {
  classifyProviderRegion,
  type RegionalCoordinates,
} from './region-policy.js';
import { baiduToWgs84 } from './baidu-coordinates.js';
export class GooglePlaceSearchProvider implements PlaceSearchProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async search(
    query: string,
    language: string,
    context?: RegionalCoordinates,
  ): Promise<readonly PlaceSearchCandidate[]> {
    const body = await json(
      this.fetcher,
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.key,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.location',
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: language,
          pageSize: 5,
          ...(context
            ? { locationBias: { circle: { center: context, radius: 50000 } } }
            : {}),
        }),
      },
    );
    if (body.error) throw new Error('UPSTREAM_UNAVAILABLE');
    if (body.places === undefined) return [];
    if (!Array.isArray(body.places))
      throw new Error('INVALID_PROVIDER_RESPONSE');
    return body.places.slice(0, 5).map((value) => {
      const p = record(value),
        coordinates = coordinate(p.location);
      if (
        classifyProviderRegion(coordinates) === 'MAINLAND_CHINA' ||
        classifyProviderRegion(coordinates) === null
      )
        throw new Error('UNSUPPORTED_PLACE_REGION');
      return {
        provider: 'google',
        externalId: string(p.id, 300),
        providerPlaceRef: string(p.id, 300),
        timeZone: null,
        coordinateSystem: 'WGS84' as const,
        name: string(record(p.displayName).text, 200),
        formattedAddress:
          p.formattedAddress == null ? null : string(p.formattedAddress),
        coordinates,
        attribution: 'Google Maps',
        synthetic: false,
      };
    });
  }
}
export class BaiduPlaceSearchProvider implements PlaceSearchProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async search(
    query: string,
    _language: string,
    context?: RegionalCoordinates,
  ): Promise<readonly PlaceSearchCandidate[]> {
    if (!context) throw new Error('PLACE_SEARCH_REGION_CONTEXT_REQUIRED');
    const url = new URL('https://api.map.baidu.com/place/v2/search');
    // Bounded contextual search, not geocoding a name into an assumed city.
    url.search = new URLSearchParams({
      query,
      bounds: `${context.latitude - 0.25},${context.longitude - 0.25},${context.latitude + 0.25},${context.longitude + 0.25}`,
      coord_type: '1',
      scope: '2',
      output: 'json',
      page_size: '5',
      ak: this.key,
    }).toString();
    const body = await json(this.fetcher, url);
    if (body.status !== 0 || !Array.isArray(body.results))
      throw new Error('UPSTREAM_UNAVAILABLE');
    return body.results.slice(0, 5).map((value) => {
      const p = record(value),
        raw = coordinate(p.location),
        coordinates = baiduToWgs84(raw.latitude, raw.longitude);
      if (classifyProviderRegion(coordinates) !== 'MAINLAND_CHINA')
        throw new Error('UNSUPPORTED_PLACE_REGION');
      return {
        provider: 'baidu',
        externalId: string(p.uid, 300),
        providerPlaceRef: string(p.uid, 300),
        timeZone: null,
        coordinateSystem: 'WGS84' as const,
        name: string(p.name, 200),
        formattedAddress: p.address == null ? null : string(p.address),
        coordinates,
        attribution: '百度地图',
        synthetic: false,
      };
    });
  }
}
