import type { RouteLocationView } from '@travel/contracts';
export type MapLocation = Pick<
  RouteLocationView,
  'name' | 'latitude' | 'longitude'
> & { readonly nodeId?: string };
export function coordinates(location: MapLocation): string | null {
  const { latitude: lat, longitude: lng } = location;
  return lat !== null &&
    lng !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
    ? `${lat},${lng}`
    : null;
}
