import type { TripView, RegionalMapCapabilityView } from '@travel/contracts';
// Load A only in the Node test runner, outside Web's production project graph.
export const { mapProviderProjection } = (await import(
  new URL('../../../packages/providers/src/region-policy.ts', import.meta.url)
    .href
)) as {
  mapProviderProjection(p: {
    latitude: number;
    longitude: number;
  }): RegionalMapCapabilityView;
};
const { boundaries } = (await import(
  new URL(
    '../../../packages/providers/src/region-boundaries.ts',
    import.meta.url,
  ).href
)) as { boundaries: { China: { coordinates: number[][][][] } } };
export const boundaryCoordinate = boundaries.China.coordinates[0]![0]![0]!;
/** SYNTHETIC API response from A's real policy; never bundled into production Web. */
export function regionalCapabilityFixture(trip: TripView, path: string) {
  const match = path.match(
    /^\/trips\/([^/]+)\/places\/([^/]+)\/provider-capability$/,
  );
  if (!match || match[1] !== trip.id) return undefined;
  const place = trip.days
    .flatMap((d) => d.nodes)
    .find((n) => n.id === match[2])?.place;
  return place ? mapProviderProjection(place) : undefined;
}
