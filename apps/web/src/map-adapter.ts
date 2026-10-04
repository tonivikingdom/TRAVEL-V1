import { coordinates, type MapLocation } from './map-position.js';

/** Read-only saved coordinates. Coordinate-system conversion belongs to A's adapter. */
export type MapPoint = MapLocation & { latitude: number; longitude: number };
export interface MapRequest {
  readonly kind: 'place' | 'transport';
  readonly points: readonly MapPoint[];
  /** Only supplied when geometry has a reliable source; never connect guessed legs. */
  readonly geometry?: readonly MapPoint[];
}
export interface MapNavigationOptions {
  readonly origin?: MapPoint;
  readonly mode: string | null;
}
export interface MapSession {
  zoom(delta: number): void;
  reset(): void;
  destroy(): void;
}
/** A owns region/provider selection, credentials, coordinate conversion and URLs. */
export interface MapAdapter {
  readonly embedded: boolean;
  readonly synthetic: boolean;
  readonly provider?: 'BAIDU' | 'GOOGLE';
  readonly unavailableText?: string;
  readonly invalidationSignal?: AbortSignal;
  /** Resolve only an authoritative capability; never classify coordinates here. */
  resolve?(request: MapRequest, signal: AbortSignal): Promise<MapAdapter>;
  mount(
    host: HTMLElement,
    request: MapRequest,
    signal: AbortSignal,
  ): Promise<MapSession>;
  externalMapUrl(request: MapRequest): string | null;
  externalNavigationUrl(
    destination: MapPoint,
    options?: MapNavigationOptions,
  ): string | null;
}
export function reliablePoint(
  location: MapLocation | null | undefined,
): MapPoint | null {
  return location && coordinates(location) ? (location as MapPoint) : null;
}
export function externalMapUrl(
  adapter: MapAdapter,
  request: MapRequest,
): string | null {
  try {
    return safeExternalUrl(adapter.externalMapUrl(request));
  } catch {
    return null;
  }
}
export function externalNavigationUrl(
  adapter: MapAdapter,
  destination: MapPoint,
  options?: MapNavigationOptions,
): string | null {
  try {
    return safeExternalUrl(adapter.externalNavigationUrl(destination, options));
  } catch {
    return null;
  }
}
function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export const unconfiguredMapAdapter: MapAdapter = {
  embedded: false,
  synthetic: false,
  mount: async () => {
    throw new Error('Region map integration unavailable');
  },
  externalMapUrl: () => null,
  externalNavigationUrl: () => null,
};
let activeAdapter = unconfiguredMapAdapter;
/** Production composition point for A. No default region policy or SDK load here. */
export function configureMapAdapter(adapter: MapAdapter): void {
  activeAdapter = adapter;
}
export function regionMapAdapter(): MapAdapter {
  return activeAdapter;
}
