import { coordinate } from './regional-http.js';
import { baiduToWgs84 } from './baidu-coordinates.js';

// Project safety limits, NOT provider promises of snapping accuracy. Google
// RouteLeg documents road-snapped endpoints; Baidu inverse is non-authoritative.
export const ENDPOINT_LIMIT_METERS = { GOOGLE: 100, BAIDU: 30 } as const;
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = (n: number) => (n * Math.PI) / 180;
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function bindProviderEndpoints(
  provider: keyof typeof ENDPOINT_LIMIT_METERS,
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
  from: unknown,
  to: unknown,
): void {
  const normalize = (value: unknown) => {
    const p = coordinate(value);
    return provider === 'BAIDU' ? baiduToWgs84(p.latitude, p.longitude) : p;
  };
  const a = coordinate(origin),
    b = coordinate(destination),
    start = normalize(from),
    end = normalize(to);
  if (
    distanceMeters(a, start) > ENDPOINT_LIMIT_METERS[provider] ||
    distanceMeters(b, end) > ENDPOINT_LIMIT_METERS[provider] ||
    distanceMeters(b, start) + 5 < distanceMeters(a, start) ||
    distanceMeters(a, end) + 5 < distanceMeters(b, end)
  )
    throw new Error('INVALID_PROVIDER_ENDPOINTS');
}
