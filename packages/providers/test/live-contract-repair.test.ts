import { expect, it, vi } from 'vitest';
import type { RouteProviderQueryInput } from '@travel/application';
import { GooglePlaceSearchProvider } from '../src/regional-place-adapters.js';
import { GoogleOrdinaryRouteProvider } from '../src/regional-route-adapters.js';

const now = new Date('2031-01-01T00:00:00Z');
const input = (): RouteProviderQueryInput => ({
  origin: {
    placeId: 'SYNTHETIC:origin',
    name: 'SYNTHETIC origin',
    latitude: 35.68,
    longitude: 139.76,
    timeZone: 'Asia/Tokyo',
  },
  destination: {
    placeId: 'SYNTHETIC:destination',
    name: 'SYNTHETIC destination',
    latitude: 35.69,
    longitude: 139.77,
    timeZone: 'Asia/Tokyo',
  },
  travelMode: 'DRIVING',
  earliestDeparture: null,
  latestArrival: null,
  preference: { type: 'NONE' },
});
const emptyRoutes = () => new Response(JSON.stringify({ routes: [] }));
it('SYNTHETIC Google Places sends only LatLng fields from a full trusted location', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ places: [] })),
  );
  await new GooglePlaceSearchProvider('SYNTHETIC_SECRET', fetcher).search(
    'SYNTHETIC',
    'en',
    input().origin,
  );
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(body.locationBias.circle.center).toEqual({
    latitude: 35.68,
    longitude: 139.76,
  });
});
it('SYNTHETIC Google NOW omits departureTime rather than sending a captured timestamp', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => emptyRoutes());
  await new GoogleOrdinaryRouteProvider(
    'SYNTHETIC_SECRET',
    fetcher,
    () => now,
  ).queryRoutes(input());
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(body).not.toHaveProperty('departureTime');
  expect(body.routingPreference).toBe('TRAFFIC_AWARE');
});
it.each([-1, NaN])(
  'SYNTHETIC explicit invalid/past departure %s fails closed without becoming NOW',
  async (offset) => {
    const fetcher = vi.fn<typeof fetch>(async () => emptyRoutes());
    const result = await new GoogleOrdinaryRouteProvider(
      'SYNTHETIC_SECRET',
      fetcher,
      () => now,
    ).queryRoutes({
      ...input(),
      preference: {
        type: 'DEPART_AT',
        instant: new Date(now.getTime() + offset),
        timeZone: 'Asia/Tokyo',
      },
    });
    expect(result.status).toBe('UNSUPPORTED_QUERY');
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each([0, 1, 3_600_000])(
  'SYNTHETIC explicit departure %sms ahead preserves the absolute instant across timezones',
  async (offset) => {
    const fetcher = vi.fn<typeof fetch>(async () => emptyRoutes());
    const instant = new Date(now.getTime() + offset);
    await new GoogleOrdinaryRouteProvider(
      'SYNTHETIC_SECRET',
      fetcher,
      () => now,
    ).queryRoutes({
      ...input(),
      preference: { type: 'DEPART_AT', instant, timeZone: 'Pacific/Honolulu' },
    });
    expect(
      JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).departureTime,
    ).toBe(instant.toISOString());
  },
);
it('SYNTHETIC independent future earliest bound is sent, while an explicit earlier request is rejected', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => emptyRoutes());
  const earliestDeparture = new Date(now.getTime() + 60000);
  const provider = new GoogleOrdinaryRouteProvider(
    'SYNTHETIC_SECRET',
    fetcher,
    () => now,
  );
  await provider.queryRoutes({ ...input(), earliestDeparture });
  expect(
    JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).departureTime,
  ).toBe(earliestDeparture.toISOString());
  expect(
    (
      await provider.queryRoutes({
        ...input(),
        earliestDeparture,
        preference: {
          type: 'DEPART_AT',
          instant: new Date(now.getTime() + 30000),
          timeZone: 'Asia/Tokyo',
        },
      })
    ).status,
  ).toBe('UNSUPPORTED_QUERY');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['bad-zone', 'bad-earliest', 'past-after-delay', 'arrive-by'] as const)(
  'SYNTHETIC invalid %s makes zero Google requests',
  async (fault) => {
    const fetcher = vi.fn<typeof fetch>();
    const query = input();
    const changed: RouteProviderQueryInput =
      fault === 'bad-earliest'
        ? { ...query, earliestDeparture: new Date(NaN) }
        : {
            ...query,
            preference: {
              type: fault === 'arrive-by' ? 'ARRIVE_BY' : 'DEPART_AT',
              instant: new Date(now.getTime() + 1000),
              timeZone:
                fault === 'bad-zone' ? 'INVALID/SYNTHETIC' : 'Asia/Tokyo',
            },
          };
    expect(
      (
        await new GoogleOrdinaryRouteProvider(
          'SYNTHETIC',
          fetcher,
          () =>
            new Date(now.getTime() + (fault === 'past-after-delay' ? 2000 : 0)),
        ).queryRoutes(changed)
      ).status,
    ).toBe('UNSUPPORTED_QUERY');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(['legs', 'duration', 'location', 'snapping', 'domain'] as const)(
  'SYNTHETIC Google %s has a distinct safe failure stage',
  async (fault) => {
    const query = input();
    const diagnostics: unknown[] = [];
    const body = {
      routes: [
        {
          duration: '600s',
          legs: [
            {
              startLocation: {
                latLng: {
                  latitude: query.origin.latitude,
                  longitude: query.origin.longitude,
                },
              },
              endLocation: {
                latLng: {
                  latitude: query.destination.latitude,
                  longitude: query.destination.longitude,
                },
              },
            },
          ],
        },
      ],
    };
    if (fault === 'legs') body.routes[0]!.legs = [];
    if (fault === 'duration')
      body.routes[0]!.duration = 'SYNTHETIC_PRIVATE_MESSAGE';
    if (fault === 'location')
      body.routes[0]!.legs[0]!.startLocation.latLng.latitude = NaN;
    if (fault === 'snapping')
      body.routes[0]!.legs[0]!.startLocation.latLng.latitude += 0.0001;
    if (fault === 'domain') body.routes[0]!.duration = '999999999s';
    const result = await new GoogleOrdinaryRouteProvider(
      'SYNTHETIC',
      async () => new Response(JSON.stringify(body)),
      () => now,
      (d) => diagnostics.push(d),
    ).queryRoutes(query);
    expect(result.status).toBe('PROVIDER_UNAVAILABLE');
    expect(diagnostics.at(-1)).toMatchObject(
      fault === 'snapping'
        ? { stage: 'ENDPOINT_BINDING', code: 'COORDINATE_EQUIVALENCE_REQUIRED' }
        : fault === 'location'
          ? { stage: 'COORDINATE_PARSE', code: 'INVALID_COORDINATES' }
          : fault === 'domain'
            ? { stage: 'DOMAIN_VALIDATION', code: 'DOMAIN_VALIDATION_FAILED' }
            : {
                stage: 'RESPONSE_SHAPE',
                code:
                  fault === 'duration' ? 'INVALID_DURATION' : 'INVALID_SHAPE',
              },
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      'SYNTHETIC_PRIVATE_MESSAGE',
    );
  },
);

it('SYNTHETIC Baidu Place parses documented BD09 lat/lng and preserves unknown timezone without private payload', async () => {
  const { BaiduPlaceSearchProvider } =
    await import('../src/regional-place-adapters.js');
  const { baiduToWgs84 } = await import('../src/baidu-coordinates.js');
  const diagnostics: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          status: 0,
          results: [
            {
              uid: 'SYNTHETIC:poi',
              name: 'SYNTHETIC poi',
              address: 'SYNTHETIC address',
              location: { lat: 39.915, lng: 116.404 },
              private: 'SYNTHETIC_PRIVATE_SECRET',
            },
          ],
        }),
      ),
  );
  const places = await new BaiduPlaceSearchProvider(
    'SYNTHETIC_SERVER_SECRET',
    fetcher,
    (d) => diagnostics.push(d),
  ).search('SYNTHETIC', 'zh-CN', { latitude: 39.90725, longitude: 116.39138 });
  expect(places[0]!.coordinates).toEqual(baiduToWgs84(39.915, 116.404));
  expect(places[0]!.timeZone).toBeNull();
  expect(places[0]!.providerPlaceRef).toBe('SYNTHETIC:poi');
  expect(JSON.stringify({ places, diagnostics })).not.toContain(
    'SYNTHETIC_PRIVATE_SECRET',
  );
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.searchParams.get('coord_type')).toBe('1');
});
it.each(['shape', 'coordinates', 'region', 'identity'] as const)(
  'SYNTHETIC Baidu Place %s fails at the exact stage without guessing',
  async (fault) => {
    const { BaiduPlaceSearchProvider } =
      await import('../src/regional-place-adapters.js');
    const diagnostics: unknown[] = [];
    const p = {
      uid: 'SYNTHETIC',
      name: 'SYNTHETIC',
      location: { lat: 39.915, lng: 116.404 },
    };
    if (fault === 'coordinates') p.location.lat = NaN;
    if (fault === 'region') p.location = { lat: 35.68, lng: 139.76 };
    if (fault === 'identity') p.uid = '';
    const body =
      fault === 'shape'
        ? { status: 0, results: null }
        : { status: 0, results: [p] };
    await expect(
      new BaiduPlaceSearchProvider(
        'SYNTHETIC',
        async () => new Response(JSON.stringify(body)),
        (d) => diagnostics.push(d),
      ).search('SYNTHETIC', 'zh-CN', { latitude: 39.9, longitude: 116.4 }),
    ).rejects.toThrow('PROVIDER_CONTRACT_REJECTED');
    expect(diagnostics.at(-1)).toMatchObject(
      fault === 'coordinates'
        ? { stage: 'COORDINATE_PARSE', code: 'INVALID_COORDINATES' }
        : fault === 'region'
          ? { stage: 'COORDINATE_PARSE', code: 'OUTSIDE_REGION' }
          : { stage: 'RESPONSE_SHAPE', code: 'INVALID_SHAPE' },
    );
  },
);
