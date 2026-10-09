import { expect, it, vi } from 'vitest';
import type { RouteProviderQueryInput } from '@travel/application';
import { GooglePlaceSearchProvider } from '../src/regional-place-adapters.js';
import { GoogleOrdinaryRouteProvider } from '../src/regional-route-adapters.js';
import { bindProviderEndpoints } from '../src/endpoint-binding.js';

const coordinates = { latitude: 35.68, longitude: 139.76 };
it('SYNTHETIC Google search identity stays paired with Provider and WGS84 coordinates', async () => {
  const provider = new GooglePlaceSearchProvider(
    'SYNTHETIC_KEY',
    async () =>
      new Response(
        JSON.stringify({
          places: [
            {
              id: 'SYNTHETIC_GOOGLE_PLACE_ID',
              displayName: { text: 'SYNTHETIC place' },
              location: coordinates,
            },
          ],
        }),
      ),
  );
  const candidate = (await provider.search('SYNTHETIC', 'en'))[0]!;
  expect(candidate).toMatchObject({
    provider: 'google',
    externalId: 'SYNTHETIC_GOOGLE_PLACE_ID',
    providerPlaceRef: 'SYNTHETIC_GOOGLE_PLACE_ID',
    coordinateSystem: 'WGS84',
    coordinates,
  });
});
it('SYNTHETIC internal Place ID and extra unverified provider refs never become Google Place ID waypoints', async () => {
  const origin = {
    placeId: 'SYNTHETIC_INTERNAL_PLACE_ID',
    name: 'SYNTHETIC origin',
    ...coordinates,
    timeZone: 'Asia/Tokyo',
    provider: 'baidu',
    providerPlaceRef: 'SYNTHETIC_UNVERIFIED_ID',
  };
  const query: RouteProviderQueryInput = {
    origin,
    destination: {
      ...origin,
      placeId: 'SYNTHETIC_INTERNAL_DESTINATION',
      latitude: 35.69,
    },
    travelMode: 'WALKING',
    earliestDeparture: null,
    latestArrival: null,
    preference: { type: 'NONE' },
  };
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ routes: [] })),
  );
  await new GoogleOrdinaryRouteProvider(
    'SYNTHETIC',
    fetcher,
    () => new Date('2031-01-01T00:00:00Z'),
  ).queryRoutes(query);
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(body.origin).toEqual({ location: { latLng: coordinates } });
  expect(body.origin).not.toHaveProperty('placeId');
  expect(body.destination).not.toHaveProperty('placeId');
  expect(String(fetcher.mock.calls[0]![1]!.body)).not.toContain(
    'SYNTHETIC_UNVERIFIED_ID',
  );
});
it.each(['nearby', 'over-limit', 'swapped', 'collapsed'] as const)(
  'SYNTHETIC Place-ID-looking metadata cannot bypass %s road endpoint protection',
  (fault) => {
    const from = { ...coordinates, providerPlaceRef: 'SYNTHETIC_GOOGLE_ID_A' },
      to = {
        latitude: 35.69,
        longitude: 139.77,
        providerPlaceRef: 'SYNTHETIC_GOOGLE_ID_B',
      };
    const start =
      fault === 'nearby'
        ? { ...from, latitude: 35.6801 }
        : fault === 'over-limit'
          ? { ...from, latitude: 35.682 }
          : fault === 'swapped'
            ? to
            : from;
    const end = fault === 'swapped' ? from : fault === 'collapsed' ? from : to;
    expect(() => bindProviderEndpoints('GOOGLE', from, to, start, end)).toThrow(
      'INVALID_PROVIDER_ENDPOINTS',
    );
    expect(from.latitude).toBe(35.68);
  },
);
