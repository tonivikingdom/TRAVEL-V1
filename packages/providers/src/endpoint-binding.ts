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
): {
  from: ReturnType<typeof coordinate>;
  to: ReturnType<typeof coordinate>;
  evidenceRef: string;
} {
  const normalize = (p: ReturnType<typeof coordinate>) =>
    provider === 'BAIDU' ? baiduToWgs84(p.latitude, p.longitude) : p;
  const same = (
    a: ReturnType<typeof coordinate>,
    b: ReturnType<typeof coordinate>,
  ) =>
    a.latitude.toFixed(6) === b.latitude.toFixed(6) &&
    a.longitude.toFixed(6) === b.longitude.toFixed(6);
  const a = coordinate(origin),
    b = coordinate(destination),
    rawStart = coordinate(from),
    rawEnd = coordinate(to),
    start = normalize(rawStart),
    end = normalize(rawEnd);
  const distinct = a.latitude !== b.latitude || a.longitude !== b.longitude;
  if (
    distanceMeters(a, start) > ENDPOINT_LIMIT_METERS[provider] ||
    distanceMeters(b, end) > ENDPOINT_LIMIT_METERS[provider] ||
    // Distance alone does not identify a road/place. Without authoritative
    // access legs, accept only coordinate equivalence at Place's Decimal(9,6)
    // precision; do not rewrite a snapped road endpoint into a requested place.
    !same(a, start) ||
    !same(b, end) ||
    same(start, end) ||
    (distinct &&
      (same(a, b) ||
        distanceMeters(a, start) >= distanceMeters(b, start) ||
        distanceMeters(b, end) >= distanceMeters(a, end)))
  )
    throw new Error('INVALID_PROVIDER_ENDPOINTS');
  return {
    from: start,
    to: end,
    // Application-owned opaque provenance, NOT a provider-issued service ID.
    // Whitelist numbers only: no raw response, URLs, messages or credentials.
    evidenceRef: `endpoint-evidence:v1:${JSON.stringify({
      provider,
      coordinateSystem: provider === 'BAIDU' ? 'BD09' : 'WGS84',
      requestedOrigin: a,
      requestedDestination: b,
      rawStart,
      rawEnd,
      normalizedStart: start,
      normalizedEnd: end,
      originOffsetMeters: distanceMeters(a, start),
      destinationOffsetMeters: distanceMeters(b, end),
    })}`,
  };
}
