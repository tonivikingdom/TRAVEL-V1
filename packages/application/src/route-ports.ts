import type { NormalizedRouteCandidate } from '@travel/domain';

export interface RouteProviderLocationInput {
  /** Opaque query-location identity; may be an external execution origin ID. No Place is implied. */
  readonly placeId: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeZone?: string;
}

export type RouteProviderTimePreference =
  | { readonly type: 'NONE' }
  | {
      readonly type: 'DEPART_AT' | 'ARRIVE_BY';
      readonly instant: Date;
      readonly timeZone: string;
    };

export interface RouteProviderQueryInput {
  readonly travelMode?: 'WALKING' | 'DRIVING' | 'TRANSIT';
  readonly origin: RouteProviderLocationInput;
  readonly destination: RouteProviderLocationInput;
  readonly earliestDeparture: Date | null;
  readonly latestArrival: Date | null;
  readonly preference: RouteProviderTimePreference;
}

export type RouteProviderResult =
  | {
      readonly status: 'SUCCESS';
      readonly candidates: readonly NormalizedRouteCandidate[];
    }
  | { readonly status: 'NO_MATCHING_CANDIDATE' }
  | {
      readonly status: 'PROVIDER_UNAVAILABLE';
      readonly reason: 'ROUTE_PROVIDER_UNCONFIGURED' | 'UPSTREAM_UNAVAILABLE';
    }
  | { readonly status: 'UNSUPPORTED_QUERY' };

export interface RouteProvider {
  queryRoutes(input: RouteProviderQueryInput): Promise<RouteProviderResult>;
}
