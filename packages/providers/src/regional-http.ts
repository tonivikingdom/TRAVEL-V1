export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function string(v: unknown, max = 500): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new Error('INVALID_PROVIDER_RESPONSE');
  return v.trim();
}
export function coordinate(v: unknown): {
  latitude: number;
  longitude: number;
} {
  const r = record(v),
    latitude = r.latitude ?? r.lat,
    longitude = r.longitude ?? r.lng;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new Error('INVALID_PROVIDER_COORDINATES');
  return { latitude, longitude };
}
export async function json(
  fetcher: typeof fetch,
  url: URL | string,
  init: RequestInit = {},
) {
  const response = await fetcher(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('UPSTREAM_UNAVAILABLE');
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('INVALID_PROVIDER_RESPONSE');
  return record(JSON.parse(text));
}
