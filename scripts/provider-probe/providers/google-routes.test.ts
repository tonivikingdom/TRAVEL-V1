import { describe, expect, it, vi } from 'vitest';

import {
  GoogleRoutesProbeAdapter,
  normalizeGoogleRoutesResponse,
} from './google-routes.js';
import type { ProbeScenario, RouteProbeQuery } from '../types.js';

const scenario: ProbeScenario = {
  id: 'synthetic-google-route',
  suiteId: 'synthetic',
  name: 'SYNTHETIC Google route',
  origin: { name: 'A', lat: 42.7, lng: 141.6 },
  destination: { name: 'B', lat: 43, lng: 141.3 },
};
const departQuery: RouteProbeQuery = {
  origin: scenario.origin,
  destination: scenario.destination,
  mode: 'DEPART_AT',
  instant: '2030-01-01T00:00:00.000Z',
  timeZone: 'Asia/Tokyo',
};
const arriveQuery: RouteProbeQuery = {
  ...departQuery,
  mode: 'ARRIVE_BY',
  instant: '2030-01-01T01:00:00.000Z',
};
const capabilities = {
  publicTransit: true,
  rail: true,
  bus: true,
  subway: true,
  ferry: true,
  walking: true,
  departAt: true,
  arriveBy: true,
  fare: null,
  realtime: null,
  lineNames: null,
} as const;

describe('GoogleRoutesProbeAdapter', () => {
  it('normalizes a successful rail route and fare', () => {
    const [route] = normalizeGoogleRoutesResponse(
      successResponse(),
      departQuery,
    );
    expect(route).toMatchObject({
      departure: '2030-01-01T00:10:00.000Z',
      arrival: '2030-01-01T00:50:00.000Z',
      totalDurationSeconds: 3_000,
      fare: { amount: '1150', currency: 'JPY' },
      transferCount: 0,
      walkingSeconds: 300,
      timeConstraintSatisfied: true,
    });
    expect(route?.legs).toEqual([
      expect.objectContaining({ mode: 'WALK', durationSeconds: 300 }),
      expect.objectContaining({
        mode: 'RAIL',
        lineName: '快速エアポート',
        operatorName: '北海道旅客鉄道',
      }),
    ]);
  });

  it('normalizes bus plus walking and permits a missing fare', () => {
    const response = successResponse();
    const route = (response as { routes: Record<string, unknown>[] })
      .routes[0]!;
    delete route.travelAdvisory;
    const transit = (route.legs as { steps: Record<string, unknown>[] }[])[0]!
      .steps[1]!;
    const details = transit.transitDetails as Record<string, unknown>;
    const line = details.transitLine as Record<string, unknown>;
    line.vehicle = { type: 'BUS' };
    line.name = '道南バス';

    const [normalized] = normalizeGoogleRoutesResponse(response, departQuery);
    expect(normalized).toMatchObject({ fare: null });
    expect(normalized?.legs.map((leg) => leg.mode)).toEqual(['WALK', 'BUS']);
  });

  it('sends departureTime only for DEPART_AT', async () => {
    const fetchMock = successfulFetch();
    const adapter = new GoogleRoutesProbeAdapter('SYNTHETIC_KEY', fetchMock);
    await adapter.route(scenario, departQuery, capabilities);
    const body = requestBodyFrom(fetchMock);
    expect(body.departureTime).toBe(departQuery.instant);
    expect(body).not.toHaveProperty('arrivalTime');
  });

  it('sends arrivalTime only for ARRIVE_BY', async () => {
    const fetchMock = successfulFetch();
    const adapter = new GoogleRoutesProbeAdapter('SYNTHETIC_KEY', fetchMock);
    await adapter.route(scenario, arriveQuery, capabilities);
    const body = requestBodyFrom(fetchMock);
    expect(body.arrivalTime).toBe(arriveQuery.instant);
    expect(body).not.toHaveProperty('departureTime');
  });

  it('normalizes multiple alternatives', () => {
    const response = successResponse() as { routes: unknown[] };
    response.routes.push(structuredClone(response.routes[0]));
    expect(normalizeGoogleRoutesResponse(response, departQuery)).toHaveLength(
      2,
    );
  });

  it('treats an empty successful proto JSON response as no route', async () => {
    const adapter = new GoogleRoutesProbeAdapter(
      'SYNTHETIC_KEY',
      vi.fn().mockResolvedValue(jsonResponse({}, 200)),
    );
    await expect(
      adapter.route(scenario, departQuery, capabilities),
    ).resolves.toMatchObject({ providerStatus: 'NO_ROUTE', routeCount: 0 });
  });

  it.each([
    [403, 'AUTH_OR_SERVICE_CONFIGURATION_ERROR'],
    [429, 'RATE_LIMITED'],
    [400, 'MALFORMED_REQUEST'],
    [503, 'PROVIDER_ERROR'],
  ] as const)('maps HTTP %s to %s', async (status, expected) => {
    const adapter = new GoogleRoutesProbeAdapter(
      'SYNTHETIC_KEY',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { message: 'synthetic failure' } }, status),
        ),
    );
    await expect(
      adapter.route(scenario, departQuery, capabilities),
    ).resolves.toMatchObject({ providerStatus: expected, httpStatus: status });
  });

  it('reports malformed response instead of silently returning no routes', async () => {
    const adapter = new GoogleRoutesProbeAdapter(
      'SYNTHETIC_KEY',
      vi.fn().mockResolvedValue(jsonResponse({ unexpected: [] }, 200)),
    );
    await expect(
      adapter.route(scenario, departQuery, capabilities),
    ).resolves.toMatchObject({ providerStatus: 'MALFORMED_RESPONSE' });
  });
});

function successResponse(): unknown {
  return {
    routes: [
      {
        duration: '3000s',
        distanceMeters: 45_000,
        travelAdvisory: {
          transitFare: { currencyCode: 'JPY', units: '1150' },
        },
        legs: [
          {
            steps: [
              { travelMode: 'WALK', staticDuration: '300s' },
              {
                travelMode: 'TRANSIT',
                staticDuration: '2400s',
                transitDetails: {
                  stopDetails: {
                    departureStop: { name: '新千歳空港' },
                    arrivalStop: { name: '札幌' },
                    departureTime: '2030-01-01T00:10:00Z',
                    arrivalTime: '2030-01-01T00:50:00Z',
                  },
                  transitLine: {
                    name: '快速エアポート',
                    agencies: [{ name: '北海道旅客鉄道' }],
                    vehicle: { type: 'HEAVY_RAIL' },
                  },
                  headsign: '札幌',
                  stopCount: 6,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function successfulFetch() {
  return vi.fn(
    async (input: string | URL, init?: RequestInit): Promise<Response> => {
      void input;
      void init;
      return jsonResponse(successResponse(), 200);
    },
  );
}

function requestBodyFrom(
  fetchMock: ReturnType<typeof successfulFetch>,
): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
