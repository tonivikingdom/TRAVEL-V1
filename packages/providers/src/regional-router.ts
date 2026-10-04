import type {
  PlaceSearchProvider,
  RouteProvider,
  RouteProviderQueryInput,
  RouteProviderResult,
} from '@travel/application';
import type { PlaceSearchCandidate } from '@travel/contracts';
import {
  classifyProviderRegion,
  type RegionalCoordinates,
} from './region-policy.js';
export interface RegionalProviderSlots {
  readonly baiduRoute?: RouteProvider;
  readonly googleRoute?: RouteProvider;
  /** B owns implementation. No fallback to ordinary Google routing. */
  readonly japanTransit?: RouteProvider;
  readonly baiduPlace?: PlaceSearchProvider;
  readonly googlePlace?: PlaceSearchProvider;
}
export class RegionalRouteProvider implements RouteProvider {
  constructor(private readonly slots: RegionalProviderSlots) {}
  async queryRoutes(
    input: RouteProviderQueryInput,
  ): Promise<RouteProviderResult> {
    const from = classifyProviderRegion(input.origin),
      to = classifyProviderRegion(input.destination);
    if (!from || !to || from !== to || !input.travelMode)
      return { status: 'UNSUPPORTED_QUERY' };
    const provider =
      from === 'MAINLAND_CHINA'
        ? this.slots.baiduRoute
        : from === 'JAPAN' && input.travelMode === 'TRANSIT'
          ? this.slots.japanTransit
          : this.slots.googleRoute;
    if (!provider)
      return {
        status: 'PROVIDER_UNAVAILABLE',
        reason: 'ROUTE_PROVIDER_UNCONFIGURED',
      };
    try {
      return await provider.queryRoutes(input);
    } catch {
      return { status: 'PROVIDER_UNAVAILABLE', reason: 'UPSTREAM_UNAVAILABLE' };
    }
  }
}
export class RegionalPlaceSearchProvider implements PlaceSearchProvider {
  constructor(private readonly slots: RegionalProviderSlots) {}
  async search(
    query: string,
    language: string,
    context?: RegionalCoordinates,
  ): Promise<readonly PlaceSearchCandidate[]> {
    if (!context) throw new Error('PLACE_SEARCH_REGION_CONTEXT_REQUIRED');
    const region = classifyProviderRegion(context);
    if (!region) throw new Error('PLACE_SEARCH_REGION_UNRESOLVED');
    const provider =
      region === 'MAINLAND_CHINA'
        ? this.slots.baiduPlace
        : this.slots.googlePlace;
    if (!provider) throw new Error('PLACE_SEARCH_PROVIDER_UNCONFIGURED');
    return provider.search(query, language, context);
  }
}
