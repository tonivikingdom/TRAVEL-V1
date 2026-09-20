import type { AuthService, FlightService } from '@travel/application';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApi } from '../src/app.js';

const userId = '00000000-0000-4000-8000-000000000001';
const tripId = '00000000-0000-4000-8000-000000000002';
const edgeId = '00000000-0000-4000-8000-000000000003';
const bindingId = '00000000-0000-4000-8000-000000000004';
const apps: Array<ReturnType<typeof buildApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('P5D2 flight HTTP surface', () => {
  it('exposes authenticated search without persisting', async () => {
    const search = vi.fn(async () => ({ flights: [flight()] }));
    const app = api({ search });
    const response = await app.inject({
      method: 'POST',
      url: '/flights/search',
      headers: { authorization: 'Bearer synthetic' },
      payload: { flightNumber: 'NH53', date: '2026-09-22' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      flights: [{ canonicalFlightNumber: 'NH53' }],
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ userId }), {
      flightNumber: 'NH53',
      date: '2026-09-22',
    });
  });

  it('passes only typed adopt fields to FlightService', async () => {
    const adopt = vi.fn(async () => ({
      flightBinding: { id: bindingId },
      resultingTripVersion: 2,
      idempotentReplay: false,
    }));
    const app = api({ adopt });
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${tripId}/flights/adopt`,
      headers: { authorization: 'Bearer synthetic' },
      payload: {
        baseTripVersion: 1,
        transportEdgeId: edgeId,
        flight: flight(),
        ignoredClientDelta: { shouldNotPass: true },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      tripId,
      {
        baseTripVersion: 1,
        transportEdgeId: edgeId,
        flight: flight(),
      },
    );
  });

  it('refreshes by owner-scoped Trip and binding path IDs', async () => {
    const refresh = vi.fn(async () => ({
      flightBinding: { id: bindingId },
      resultingTripVersion: 2,
      factsChanged: false,
      actualConflict: false,
      actualConflicts: [],
      changes: { changeTypes: [] },
      requiresAttention: false,
      requiresRouteReevaluation: false,
      riskEvaluation: { risks: [] },
    }));
    const app = api({ refresh });
    const response = await app.inject({
      method: 'POST',
      url: `/trips/${tripId}/flights/${bindingId}/refresh`,
      headers: { authorization: 'Bearer synthetic' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      tripId,
      bindingId,
    );
  });
});

function api(flightMethods: Record<string, ReturnType<typeof vi.fn>>) {
  const app = buildApi({
    readinessProbe: {
      async check() {
        return { name: 'postgresql', status: 'READY' };
      },
    },
    authService: {
      authenticate: vi.fn(async () => ({
        actor: {
          userId,
          email: 'owner@synthetic.example.test',
          role: 'USER',
          status: 'ACTIVE',
        },
        user: {
          id: userId,
          email: 'owner@synthetic.example.test',
          role: 'USER',
          status: 'ACTIVE',
          preferences: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' },
        },
        sessionDigest: 'digest',
      })),
    } as unknown as AuthService,
    flightService: flightMethods as unknown as FlightService,
  });
  apps.push(app);
  return app;
}

function flight() {
  const movement = (iata: string, utc: string) => ({
    airportName: iata,
    airportIata: iata,
    airportIcao: null,
    timeZone: 'Asia/Tokyo',
    scheduledLocal: utc,
    scheduledUtc: utc,
    revisedLocal: null,
    revisedUtc: null,
    predictedLocal: null,
    predictedUtc: null,
    runwayLocal: null,
    runwayUtc: null,
    terminal: null,
    gate: null,
    checkInDesk: null,
    baggageBelt: null,
  });
  return {
    provider: 'aerodatabox',
    candidateId: 'aerodatabox:nh53',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2026-09-22',
    status: 'SCHEDULED',
    rawStatus: 'Scheduled',
    airline: { name: 'ANA', iata: 'NH', icao: 'ANA' },
    departure: movement('HND', '2026-09-22T00:00:00.000Z'),
    arrival: movement('CTS', '2026-09-22T01:30:00.000Z'),
    aircraft: null,
    departureDelayMinutes: null,
    arrivalDelayMinutes: null,
    departureDelayBasis: null,
    arrivalDelayBasis: null,
    fetchedAt: '2026-09-20T00:00:00.000Z',
  } as const;
}
