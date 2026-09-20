import { describe, expect, it, vi } from 'vitest';

import {
  AeroDataBoxFlightProvider,
  readFlightProviderConfig,
  UnconfiguredFlightProvider,
} from '../src/index.js';

const input = { flightNumber: ' nh 53 ', date: '2026-09-22' };

describe('AeroDataBoxFlightProvider', () => {
  it('normalizes a complete flight without leaking raw provider fields', async () => {
    const provider = createProvider(payload());
    const [flight] = await provider.search(input);
    expect(flight).toMatchObject({
      provider: 'aerodatabox',
      canonicalFlightNumber: 'NH53',
      status: 'DELAYED',
      departure: {
        airportIata: 'HND',
        timeZone: 'Asia/Tokyo',
        scheduledUtc: '2026-09-22T00:00:00.000Z',
        revisedUtc: '2026-09-22T00:15:00.000Z',
        predictedUtc: '2026-09-22T00:20:00.000Z',
      },
      departureDelayMinutes: 15,
      departureDelayBasis: 'REVISED_TIME',
    });
    expect(JSON.stringify(flight)).not.toContain('secretProviderField');
  });

  it('uses runway rather than revised time as delay evidence', async () => {
    const data = payload();
    (data[0]!.departure as Record<string, unknown>).runwayTime = {
      utc: '2026-09-22T00:30:00Z',
    };
    const [flight] = await createProvider(data).search(input);
    expect(flight?.departureDelayMinutes).toBe(30);
    expect(flight?.departureDelayBasis).toBe('RUNWAY_TIME');
  });

  it('never uses predicted time for delay', async () => {
    const data = payload();
    delete (data[0]!.departure as Partial<Record<string, unknown>>).revisedTime;
    const [flight] = await createProvider(data).search(input);
    expect(flight?.departureDelayMinutes).toBeNull();
    expect(flight?.departureDelayBasis).toBeNull();
  });

  it.each([
    ['Boarding', 'BOARDING'],
    ['Departed', 'DEPARTED'],
    ['EnRoute', 'EN_ROUTE'],
    ['Landed', 'LANDED'],
    ['Arrived', 'ARRIVED'],
    ['Cancelled', 'CANCELLED'],
    ['Diverted', 'DIVERTED'],
    ['something-new', 'UNKNOWN'],
  ] as const)('maps status %s to %s', async (raw, expected) => {
    const data = payload();
    data[0]!.status = raw;
    const [flight] = await createProvider(data).search(input);
    expect(flight?.status).toBe(expected);
  });

  it('converts local wall-clock timestamps with the airport timezone', async () => {
    const data = payload();
    (data[0]!.departure as Record<string, unknown>).scheduledTime = {
      local: '2026-09-22 09:00:00',
    };
    const [flight] = await createProvider(data).search(input);
    expect(flight?.departure.scheduledUtc).toBe('2026-09-22T00:00:00.000Z');
    expect(flight?.departure.scheduledLocal).toContain('+09:00');
  });

  it('returns no result for 404', async () => {
    const provider = createProvider(null, 404);
    await expect(provider.search(input)).resolves.toEqual([]);
  });

  it.each([
    [401, 'FLIGHT_PROVIDER_AUTH_ERROR'],
    [429, 'FLIGHT_PROVIDER_RATE_LIMIT'],
    [500, 'FLIGHT_PROVIDER_UNAVAILABLE'],
    [400, 'FLIGHT_PROVIDER_BAD_RESPONSE'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    await expect(
      createProvider({}, status).search(input),
    ).rejects.toMatchObject({ code });
  });

  it('maps timeout separately', async () => {
    const provider = new AeroDataBoxFlightProvider('synthetic', {
      timeoutMs: 1,
      fetchImpl: vi.fn(async (_url, init) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
        throw new Error('unreachable');
      }),
    });
    await expect(provider.search(input)).rejects.toMatchObject({
      code: 'FLIGHT_PROVIDER_TIMEOUT',
    });
  });

  it('maps network errors separately', async () => {
    const provider = new AeroDataBoxFlightProvider('synthetic', {
      fetchImpl: vi.fn(async () => {
        throw new Error('network secret should not be forwarded');
      }),
    });
    await expect(provider.search(input)).rejects.toMatchObject({
      code: 'FLIGHT_PROVIDER_UNAVAILABLE',
      message: '航班数据源暂时不可用。',
    });
  });

  it('caches search but bypasses cache on refresh', async () => {
    const fetchImpl = vi.fn(async () => response(payload()));
    const provider = new AeroDataBoxFlightProvider('synthetic', { fetchImpl });
    await provider.search(input);
    await provider.search(input);
    await provider.refresh(input);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('sends only the required RapidAPI headers and normalized URL', async () => {
    const fetchImpl = vi.fn(async () => response(payload()));
    const provider = new AeroDataBoxFlightProvider('not-logged', { fetchImpl });
    await provider.search(input);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://aerodatabox.p.rapidapi.com/flights/number/NH53/2026-09-22',
      expect.objectContaining({
        headers: {
          accept: 'application/json',
          'X-RapidAPI-Key': 'not-logged',
          'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
        },
      }),
    );
  });

  it('makes duplicate provider IDs unique without changing canonical facts', async () => {
    const duplicate = payload()[0]!;
    const flights = await createProvider([duplicate, duplicate]).search(input);
    expect(flights.map((flight) => flight.candidateId)).toEqual([
      'aerodatabox:provider-flight-1',
      'aerodatabox:provider-flight-1:2',
    ]);
  });

  it('rejects malformed successful payloads', async () => {
    await expect(
      createProvider({ unexpected: true }).search(input),
    ).rejects.toMatchObject({ code: 'FLIGHT_PROVIDER_BAD_RESPONSE' });
  });

  it('returns an explicit unconfigured error without fallback', async () => {
    await expect(
      new UnconfiguredFlightProvider().search(input),
    ).rejects.toMatchObject({ code: 'FLIGHT_PROVIDER_NOT_CONFIGURED' });
  });

  it.each([
    { flightNumber: 'bad', date: '2026-09-22' },
    { flightNumber: 'NH53', date: 'not-a-date' },
  ])('rejects malformed lookup input before network I/O', async (invalid) => {
    const fetchImpl = vi.fn(async () => response(payload()));
    const provider = new AeroDataBoxFlightProvider('synthetic', { fetchImpl });
    await expect(provider.search(invalid)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('flight provider configuration', () => {
  it('prioritizes the AeroDataBox-specific key', () => {
    expect(
      readFlightProviderConfig({
        FLIGHT_PROVIDER: 'aerodatabox',
        FLIGHT_LIVE_API_ENABLED: 'true',
        AERODATABOX_RAPIDAPI_KEY: 'specific',
        RAPIDAPI_KEY: 'generic',
      }),
    ).toMatchObject({ apiKey: 'specific', liveApiEnabled: true });
  });

  it('defaults live calls off and accepts the generic fallback key', () => {
    expect(readFlightProviderConfig({ RAPIDAPI_KEY: 'generic' })).toMatchObject(
      {
        provider: 'unconfigured',
        liveApiEnabled: false,
        apiKey: 'generic',
      },
    );
  });

  it('rejects invalid live flags and hosts', () => {
    expect(() =>
      readFlightProviderConfig({ FLIGHT_LIVE_API_ENABLED: 'yes' }),
    ).toThrow();
    expect(() =>
      readFlightProviderConfig({ AERODATABOX_RAPIDAPI_HOST: 'https://bad' }),
    ).toThrow();
  });
});

function createProvider(body: unknown, status = 200) {
  return new AeroDataBoxFlightProvider('SYNTHETIC_TEST_ONLY', {
    now: () => new Date('2026-09-20T00:00:00Z'),
    fetchImpl: vi.fn(async () => response(body, status)),
  });
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function payload() {
  return [
    {
      id: 'provider-flight-1',
      number: 'NH 53',
      status: 'Delayed',
      airline: { name: 'All Nippon Airways', iata: 'NH', icao: 'ANA' },
      departure: {
        airport: { name: 'Haneda', iata: 'HND', timeZone: 'Asia/Tokyo' },
        scheduledTime: { utc: '2026-09-22T00:00:00Z' },
        revisedTime: { utc: '2026-09-22T00:15:00Z' },
        predictedTime: { utc: '2026-09-22T00:20:00Z' },
        terminal: '2',
        gate: '62',
      },
      arrival: {
        airport: { name: 'New Chitose', iata: 'CTS', timeZone: 'Asia/Tokyo' },
        scheduledTime: { utc: '2026-09-22T01:30:00Z' },
        revisedTime: { utc: '2026-09-22T01:45:00Z' },
        baggageBelt: '4',
      },
      aircraft: { model: 'Boeing 787', reg: 'JA001A', modeS: 'ABC123' },
      callSign: 'ANA53',
      secretProviderField: 'must-not-cross-boundary',
    },
  ];
}
