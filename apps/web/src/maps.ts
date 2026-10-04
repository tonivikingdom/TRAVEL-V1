import { coordinates, type MapLocation } from './map-position.js';
export { coordinates, type MapLocation } from './map-position.js';
import {
  regionMapAdapter,
  unconfiguredMapAdapter,
  reliablePoint,
  externalMapUrl,
  externalNavigationUrl,
} from './map-adapter.js';
export function placeMap(location: MapLocation, apple = false): string | null {
  const adapter = regionMapAdapter();
  if (adapter !== unconfiguredMapAdapter) {
    const saved = reliablePoint(location);
    return saved
      ? externalMapUrl(adapter, { kind: 'place', points: [saved] })
      : null;
  }
  // Inherited compatibility only; A's configured capability replaces this path.
  const point = coordinates(location);
  if (!point) return null;
  const url = new URL(
    apple ? 'https://maps.apple.com/' : 'https://www.google.com/maps/search/',
  );
  if (apple) {
    url.searchParams.set('ll', point);
    url.searchParams.set('q', location.name);
  } else {
    url.searchParams.set('api', '1');
    url.searchParams.set('query', point);
  }
  return url.toString();
}
export function navigation(
  destination: MapLocation,
  origin?: MapLocation,
  mode: string | null = 'walking',
): string | null {
  const adapter = regionMapAdapter();
  if (adapter !== unconfiguredMapAdapter) {
    const saved = reliablePoint(destination);
    const from = origin ? reliablePoint(origin) : null;
    if (!saved || (origin && !from)) return null;
    return externalNavigationUrl(adapter, saved, {
      mode,
      ...(from ? { origin: from } : {}),
    });
  }
  // Retain existing callers until A wires its Region capability; no new policy.
  const point = coordinates(destination);
  if (!point) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', point);
  if (mode) url.searchParams.set('travelmode', mode);
  const from = origin ? coordinates(origin) : null;
  if (origin && !from) return null;
  if (from) url.searchParams.set('origin', from);
  return url.toString();
}

export function mapMode(
  mode: string,
): 'walking' | 'driving' | 'transit' | null {
  if (mode === 'WALKING') return 'walking';
  if (mode === 'DRIVING' || mode === 'TAXI') return 'driving';
  if (['RAIL', 'BUS', 'FERRY'].includes(mode)) return 'transit';
  return null;
}
