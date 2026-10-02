import type { RouteLocationView } from '@travel/contracts';
export type MapLocation = Pick<
  RouteLocationView,
  'name' | 'latitude' | 'longitude'
>;
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
export function placeMap(location: MapLocation, apple = false): string | null {
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
  mode = 'walking',
): string | null {
  const point = coordinates(destination);
  if (!point) return null;
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('destination', point);
  url.searchParams.set('travelmode', mode);
  const from = origin ? coordinates(origin) : null;
  if (from) url.searchParams.set('origin', from);
  return url.toString();
}
