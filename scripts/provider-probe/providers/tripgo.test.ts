import { describe, expect, it, vi } from 'vitest';

import {
  TripGoProbeAdapter,
  normalizeTripGoRoutingResponse,
} from './tripgo.js';
import type { ProbeScenario, RouteProbeQuery } from '../types.js';

const scenario: ProbeScenario = {
  id: 'synthetic-route',
  suiteId: 'synthetic',
  name: 'SYNTHETIC route',
  origin: { name: 'A', lat: 42.7, lng: 141.6 },
  destination: { name: 'B', lat: 43.0, lng: 141.3 },
};
const query: RouteProbeQuery = {
  origin: scenario.origin,
  destination: scenario.destination,
  mode: 'DEPART_AT',
  instant: '2030-01-01T00:00:00.000Z',
  timeZone: 'Asia/Tokyo',
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

describe('TripGoProbeAdapter', () => {
  it('sends the health check as JSON and validates the provider flag', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ healthCheckPassed: true }, 200));
    const adapter = new TripGoProbeAdapter('SYNTHETIC_TEST_KEY', fetchMock);

    await expect(adapter.healthCheck()).resolves.toMatchObject({
      status: 'PASS',
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-TripGo-HealthCheck': 'true',
        }),
        body: '{}',
      }),
    );
  });

  it('expands segment references through templates and normalizes routes', () => {
    const routes = normalizeTripGoRoutingResponse(successResponse(), query);
    expect(routes).toEqual([
      expect.objectContaining({
        totalDurationSeconds: 1_800,
        fare: { amount: '1150', currency: 'JPY' },
        transferCount: 0,
        walkingSeconds: 300,
        timeConstraintSatisfied: true,
        legs: [
          expect.objectContaining({ mode: 'WALK', durationSeconds: 300 }),
          expect.objectContaining({
            mode: 'RAIL',
            lineName: 'Airport Rapid',
            operatorName: 'JR Hokkaido',
            timing: 'REALTIME',
          }),
        ],
      }),
    ]);
  });

  it.each([
    [401, 'AUTH_ERROR'],
    [429, 'RATE_LIMITED'],
    [503, 'PROVIDER_ERROR'],
  ] as const)('maps HTTP %s to %s', async (status, expected) => {
    const adapter = new TripGoProbeAdapter(
      'SYNTHETIC_TEST_KEY',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'synthetic' }, status)),
    );
    const result = await adapter.route(scenario, query, capabilities);
    expect(result.providerStatus).toBe(expected);
    expect(result.routes).toEqual([]);
  });

  it('reports malformed response instead of silently skipping segments', async () => {
    const adapter = new TripGoProbeAdapter(
      'SYNTHETIC_TEST_KEY',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ groups: [{}], segmentTemplates: [] }, 200),
        ),
    );
    const result = await adapter.route(scenario, query, capabilities);
    expect(result.providerStatus).toBe('MALFORMED_RESPONSE');
    expect(result.notes[0]).toContain('trips');
  });

  it('reports NO_ROUTE for a valid empty routing response', async () => {
    const adapter = new TripGoProbeAdapter(
      'SYNTHETIC_TEST_KEY',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ groups: [], segmentTemplates: [] }, 200),
        ),
    );
    const result = await adapter.route(scenario, query, capabilities);
    expect(result.providerStatus).toBe('NO_ROUTE');
    expect(result.routeCount).toBe(0);
  });

  it('classifies a covered-area error returned with HTTP 200 as unsupported', async () => {
    const adapter = new TripGoProbeAdapter(
      'SYNTHETIC_TEST_KEY',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: 'Origin lies outside covered area.',
            errorCode: 1002,
            usererror: true,
          },
          200,
        ),
      ),
    );

    await expect(
      adapter.route(scenario, query, capabilities),
    ).resolves.toMatchObject({
      providerStatus: 'UNSUPPORTED',
      httpStatus: 200,
      notes: ['Origin lies outside covered area.'],
    });
  });

  it('does not send a request when the API key is absent', async () => {
    const fetchMock = vi.fn();
    const adapter = new TripGoProbeAdapter(undefined, fetchMock);
    await expect(adapter.healthCheck()).resolves.toMatchObject({
      status: 'NOT_CONFIGURED',
      message: 'TRIPGO_API_KEY is not configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function successResponse(): unknown {
  const start = Date.parse('2030-01-01T00:00:00Z') / 1_000;
  return {
    groups: [
      {
        trips: [
          {
            id: 'trip-1',
            depart: start,
            arrive: start + 1_800,
            moneyCost: 1150,
            currency: 'JPY',
            segments: [
              {
                id: 'walk-1',
                segmentTemplateHashCode: 1,
                startTime: start,
                endTime: start + 300,
              },
              {
                id: 'rail-1',
                segmentTemplateHashCode: 2,
                startTime: start + 300,
                endTime: start + 1_800,
                serviceName: 'Airport Rapid',
                realTime: true,
              },
            ],
          },
        ],
      },
    ],
    segmentTemplates: [
      {
        hashCode: 1,
        type: 'unscheduled',
        modeInfo: { identifier: 'wa_wal', description: 'Walk' },
        from: { name: 'Airport terminal' },
        to: { name: 'Airport station' },
      },
      {
        hashCode: 2,
        type: 'scheduled',
        modeInfo: { identifier: 'pt_pub_train', description: 'Rail' },
        operator: 'JR Hokkaido',
        from: { name: 'New Chitose Airport' },
        to: { name: 'Sapporo' },
      },
    ],
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
