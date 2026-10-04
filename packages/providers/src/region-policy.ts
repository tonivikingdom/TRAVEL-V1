import { boundaries } from './region-boundaries.js';
import type {
  ProviderRegion,
  RegionalMapCapabilityView,
} from '@travel/contracts';
export type { ProviderRegion } from '@travel/contracts';
export interface RegionalCoordinates {
  readonly latitude: number;
  readonly longitude: number;
}
type Ring = readonly (readonly number[])[];
type Geometry = { readonly type: string; readonly coordinates: unknown };
function polygons(g: Geometry): readonly (readonly Ring[])[] {
  return (
    g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  ) as readonly (readonly Ring[])[];
}
function inRing(p: RegionalCoordinates, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!,
      x = p.longitude,
      y = p.latitude;
    if (
      a[1]! > y !== b[1]! > y &&
      x < ((b[0]! - a[0]!) * (y - a[1]!)) / (b[1]! - a[1]!) + a[0]!
    )
      inside = !inside;
  }
  return inside;
}
function contains(p: RegionalCoordinates, g: Geometry): boolean {
  return polygons(g).some(
    (poly) => inRing(p, poly[0]!) && !poly.slice(1).some((r) => inRing(p, r)),
  );
}
function nearBoundary(p: RegionalCoordinates, g: Geometry): boolean {
  const scale = Math.cos((p.latitude * Math.PI) / 180);
  return polygons(g).some((poly) =>
    poly.some((ring) =>
      ring.some((a, i) => {
        const b = ring[(i + 1) % ring.length]!;
        const ax = (a[0]! - p.longitude) * scale,
          ay = a[1]! - p.latitude;
        const dx = (b[0]! - a[0]!) * scale,
          dy = b[1]! - a[1]!;
        const t = Math.max(
          0,
          Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
        );
        return Math.hypot(ax + t * dx, ay + t * dy) * 111.2 < 1;
      }),
    ),
  );
}
/** WGS84 only; no language/IP/timezone inference. Coarse-boundary uncertainty fails closed. */
export function classifyProviderRegion(
  p: RegionalCoordinates,
): ProviderRegion | null {
  if (
    !Number.isFinite(p.latitude) ||
    !Number.isFinite(p.longitude) ||
    Math.abs(p.latitude) > 90 ||
    Math.abs(p.longitude) > 180
  )
    return null;
  for (const name of ['Hong Kong S.A.R.', 'Macao S.A.R', 'Taiwan'] as const)
    if (contains(p, boundaries[name])) return 'GLOBAL_OTHER';
  if (nearBoundary(p, boundaries.China) || nearBoundary(p, boundaries.Japan))
    return null;
  if (contains(p, boundaries.China)) return 'MAINLAND_CHINA';
  if (contains(p, boundaries.Japan)) return 'JAPAN';
  return 'GLOBAL_OTHER';
}
export function mapProviderProjection(
  p: RegionalCoordinates,
): RegionalMapCapabilityView {
  const region = classifyProviderRegion(p);
  return {
    region,
    provider:
      region === null
        ? null
        : region === 'MAINLAND_CHINA'
          ? ('BAIDU' as const)
          : ('GOOGLE' as const),
    coordinates: { latitude: p.latitude, longitude: p.longitude },
    coordinateSystem: 'WGS84' as const,
  };
}
