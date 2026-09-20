import type { RouteProviderQueryInput } from '@travel/application';
import { describe, expect, it, vi } from 'vitest';

import {
  GoogleConsumerExperimentalRouteProvider,
  localDateAndTime,
} from '../src/google-consumer-transit-route-provider.js';

const token = 'SYNTHETIC_TEST_TOKEN_DO_NOT_LOG';
const baseInput: RouteProviderQueryInput = {
  origin: {
    placeId: 'origin-place',
    name: 'Hotel Mahoroba',
    latitude: 42.4930624,
    longitude: 141.1419064,
  },
  destination: {
    placeId: 'destination-place',
    name: '洞爷湖景乃之風',
    latitude: 42.565637,
    longitude: 140.8222622,
  },
  earliestDeparture: new Date('2026-09-22T01:00:00.000Z'),
  latestArrival: null,
  preference: {
    type: 'DEPART_AT',
    instant: new Date('2026-09-22T01:00:00.000Z'),
    timeZone: 'Asia/Tokyo',
  },
};

describe('GoogleConsumerExperimentalRouteProvider', () => {
  it('maps the Travel query to the sidecar business contract', async () => {
    const fetchImplementation = vi.fn(async (_url, init) => {
      expect(String(_url)).toBe('http://127.0.0.1:8787/v1/transit/search');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Bearer ${token}`,
      );
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual(sidecarQuery());
      return jsonResponse(successResponse(body));
    });
    const result = await provider(fetchImplementation).queryRoutes(baseInput);

    expect(result).toMatchObject({
      status: 'SUCCESS',
      candidates: [
        {
          candidateId:
            'GOOGLE_CONSUMER_EXPERIMENTAL:google-0-1790042400-1790046000',
          provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
          providerCandidateRef: 'google-0-1790042400-1790046000',
          durationSeconds: 3600,
          fare: { amount: '3910', currency: 'JPY' },
          legs: [
            { mode: 'WALKING', fixedService: false },
            {
              mode: 'BUS',
              fixedService: true,
              serviceLabel: '北斗16号',
            },
            { mode: 'WALKING', fixedService: false },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    ['2026-09-21T15:30:00.000Z', '2026-09-22', '00:30'],
    ['2026-09-22T00:00:00.000Z', '2026-09-22', '09:00'],
    ['2026-09-22T01:04:00.000Z', '2026-09-22', '10:04'],
    ['2026-09-22T06:00:00.000Z', '2026-09-22', '15:00'],
    ['2026-09-22T14:30:00.000Z', '2026-09-22', '23:30'],
  ])('converts %s to Tokyo wall clock %s %s', (utc, date, time) => {
    expect(localDateAndTime(new Date(utc), 'Asia/Tokyo')).toEqual({
      date,
      time,
    });
  });

  it('maps ARRIVE_BY without changing the sidecar time direction', async () => {
    const input: RouteProviderQueryInput = {
      ...baseInput,
      preference: {
        type: 'ARRIVE_BY',
        instant: new Date('2026-09-22T06:00:00.000Z'),
        timeZone: 'Asia/Tokyo',
      },
    };
    const fetchImplementation = vi.fn(async (_url, init) => {
      const query = JSON.parse(String(init?.body));
      expect(query).toMatchObject({
        date: '2026-09-22',
        time: '15:00',
        timezone: 'Asia/Tokyo',
        timeMode: 'ARRIVE_BY',
      });
      return jsonResponse(successResponse(query));
    });
    await expect(
      provider(fetchImplementation).queryRoutes(input),
    ).resolves.toMatchObject({ status: 'SUCCESS' });
  });

  it('rejects NONE without calling the sidecar', async () => {
    const fetchImplementation = vi.fn();
    await expect(
      provider(fetchImplementation).queryRoutes({
        ...baseInput,
        preference: { type: 'NONE' },
      }),
    ).resolves.toEqual({ status: 'UNSUPPORTED_QUERY' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['WALK', 'WALKING', false],
    ['BUS', 'BUS', true],
    ['TRAIN', 'RAIL', true],
    ['SUBWAY', 'RAIL', true],
    ['TRAM', 'RAIL', true],
    ['FERRY', 'FERRY', true],
    ['OTHER', 'OTHER', false],
  ] as const)('maps %s to %s', async (sidecarMode, routeMode, fixedService) => {
    const query = sidecarQuery();
    const response = successResponse(query, {
      legs: [transitLeg(sidecarMode)],
    });
    const result = await provider(() =>
      Promise.resolve(jsonResponse(response)),
    ).queryRoutes(baseInput);
    expect(result).toMatchObject({
      status: 'SUCCESS',
      candidates: [{ legs: [{ mode: routeMode, fixedService }] }],
    });
  });

  it('requires explicit timetable endpoints before marking transit fixed', async () => {
    const query = sidecarQuery();
    const response = successResponse(query, {
      legs: [
        {
          ...transitLeg('BUS'),
          departureTime: null,
          arrivalTime: null,
          durationSeconds: null,
          serviceName: null,
          lineName: '洞爺湖線',
        },
      ],
    });
    const result = await provider(() =>
      Promise.resolve(jsonResponse(response)),
    ).queryRoutes(baseInput);
    expect(result).toMatchObject({
      status: 'SUCCESS',
      candidates: [
        {
          legs: [{ fixedService: false, serviceLabel: '洞爺湖線' }],
        },
      ],
    });
  });

  it('uses exact shared boundary coordinates and rejects discontinuity', async () => {
    const query = sidecarQuery();
    const response = successResponse(query);
    const success = await provider(() =>
      Promise.resolve(jsonResponse(response)),
    ).queryRoutes(baseInput);
    if (success.status !== 'SUCCESS') throw new Error('expected success');
    expect(success.candidates[0]!.legs[0]!.to).toEqual(
      success.candidates[0]!.legs[1]!.from,
    );

    const broken = structuredClone(response);
    broken.candidates[0]!.legs[0]!.to = stop('登別駅', 42.45, 141.18);
    broken.candidates[0]!.legs[1]!.from = stop('登別駅', 42.46, 141.18);
    await expect(
      provider(() => Promise.resolve(jsonResponse(broken))).queryRoutes(
        baseInput,
      ),
    ).resolves.toEqual(unavailable());
  });

  it('normalizes malformed fare to null without inventing an amount', async () => {
    const response = successResponse(sidecarQuery());
    response.candidates[0]!.fare = {
      amount: '3,910' as unknown as number,
      currency: 'JPY',
      displayText: '3,910円',
    };
    const result = await provider(() =>
      Promise.resolve(jsonResponse(response)),
    ).queryRoutes(baseInput);
    expect(result).toMatchObject({
      status: 'SUCCESS',
      candidates: [{ fare: null }],
    });
  });

  it.each([
    ['NO_ROUTES', { status: 'NO_MATCHING_CANDIDATE' }],
    ['UNSUPPORTED_MODE', { status: 'UNSUPPORTED_QUERY' }],
    ['BUSY', unavailable()],
    ['SCHEMA_CHANGED', unavailable()],
    ['REQUEST_MISMATCH', unavailable()],
    ['UPSTREAM_TIMEOUT', unavailable()],
    ['UPSTREAM_BLOCKED', unavailable()],
    ['UPSTREAM_ERROR', unavailable()],
    ['BROWSER_UNAVAILABLE', unavailable()],
    ['PROVIDER_DISABLED', unavailable()],
  ])('maps sidecar error %s', async (code, expected) => {
    const result = await provider(() =>
      Promise.resolve(jsonResponse(errorResponse(String(code)), 422)),
    ).queryRoutes(baseInput);
    expect(result).toEqual(expected);
  });

  it.each([401, 429, 500])(
    'maps HTTP %s without a trusted error envelope to unavailable',
    async (status) => {
      await expect(
        provider(() =>
          Promise.resolve(jsonResponse({ message: 'failure' }, status)),
        ).queryRoutes(baseInput),
      ).resolves.toEqual(unavailable());
    },
  );

  it('fails closed for duplicate candidates, inconsistent duration, or query mismatch', async () => {
    const query = sidecarQuery();
    const duplicate = successResponse(query);
    duplicate.candidates.push(structuredClone(duplicate.candidates[0]!));
    duplicate.candidateCount = 2;
    const badDuration = successResponse(query);
    badDuration.candidates[0]!.durationSeconds = 3599;
    const mismatch = successResponse({ ...query, time: '10:01' });
    const unknownMode = successResponse(query);
    unknownMode.candidates[0]!.legs[1]!.mode = 'CABLE_CAR';
    const inconsistentTime = successResponse(query);
    inconsistentTime.candidates[0]!.arrivalTime.localDateTime =
      '2026-09-22T11:01:00';
    for (const response of [
      duplicate,
      badDuration,
      mismatch,
      unknownMode,
      inconsistentTime,
    ]) {
      await expect(
        provider(() => Promise.resolve(jsonResponse(response))).queryRoutes(
          baseInput,
        ),
      ).resolves.toEqual(unavailable());
    }
  });

  it('fails closed for malformed JSON and network failure', async () => {
    await expect(
      provider(() => Promise.resolve(new Response('{not-json'))).queryRoutes(
        baseInput,
      ),
    ).resolves.toEqual(unavailable());
    await expect(
      provider(() => Promise.reject(new Error('network failed'))).queryRoutes(
        baseInput,
      ),
    ).resolves.toEqual(unavailable());
  });

  it('aborts an overlong request without retrying', async () => {
    const fetchImplementation = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const result = await new GoogleConsumerExperimentalRouteProvider({
      baseUrl: 'http://127.0.0.1:8787',
      token,
      timeoutMs: 5,
      fetchImplementation,
    }).queryRoutes(baseInput);
    expect(result).toEqual(unavailable());
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

function provider(fetchImplementation: typeof fetch) {
  return new GoogleConsumerExperimentalRouteProvider({
    baseUrl: 'http://127.0.0.1:8787',
    token,
    timeoutMs: 1_000,
    fetchImplementation,
  });
}

function sidecarQuery() {
  return {
    origin: {
      label: 'Hotel Mahoroba',
      latitude: 42.4930624,
      longitude: 141.1419064,
    },
    destination: {
      label: '洞爷湖景乃之風',
      latitude: 42.565637,
      longitude: 140.8222622,
    },
    date: '2026-09-22',
    time: '10:00',
    timezone: 'Asia/Tokyo',
    timeMode: 'DEPART_AT',
  };
}

function successResponse(
  requestedQuery: ReturnType<typeof sidecarQuery>,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: 'OK',
    requestId: 'request-id',
    provider: 'GOOGLE_CONSUMER_EXPERIMENTAL',
    requestedQuery,
    queryVerified: true,
    fetchedAt: '2026-09-20T05:09:00.000Z',
    elapsedMs: 7428,
    candidateCount: 1,
    candidates: [
      {
        id: 'google-0-1790042400-1790046000',
        sourceIndex: 0,
        departureTime: time('2026-09-22T10:00:00', '2026-09-22T01:00:00.000Z'),
        arrivalTime: time('2026-09-22T11:00:00', '2026-09-22T02:00:00.000Z'),
        durationSeconds: 3600,
        fare: { currency: 'JPY', amount: 3910, displayText: '3,910円' },
        legs: [walkingLeg(300), transitLeg('BUS'), walkingLeg(300)],
        warnings: [],
        ...overrides,
      },
    ],
    warnings: [],
    cacheHit: false,
    timing: {
      browserStartupMs: 0,
      contextCreationMs: 1,
      navigationMs: 100,
      directionsResponseMs: 7000,
      parseMs: 10,
      sentinelMs: 10,
      totalMs: 7428,
    },
  };
}

function walkingLeg(durationSeconds: number) {
  return {
    mode: 'WALK',
    from: null,
    to: null,
    departureTime: null,
    arrivalTime: null,
    durationSeconds,
    distanceMeters: 100,
    lineName: null,
    lineShortName: null,
    serviceName: null,
    headsign: null,
    stopCount: null,
    intermediateStops: [],
  };
}

function transitLeg(mode: string) {
  return {
    mode,
    from: stop('登別駅', 42.4520246, 141.1808589),
    to: stop('洞爺駅', 42.5506226, 140.7637296),
    departureTime: time('2026-09-22T10:10:00', '2026-09-22T01:10:00.000Z'),
    arrivalTime: time('2026-09-22T10:50:00', '2026-09-22T01:50:00.000Z'),
    durationSeconds: 2400,
    distanceMeters: null,
    lineName: '北斗',
    lineShortName: null,
    serviceName: '北斗16号',
    headsign: '函館行',
    stopCount: 3,
    intermediateStops: [],
  };
}

function stop(name: string, latitude: number, longitude: number) {
  return {
    name,
    latitude,
    longitude,
    arrivalTime: null,
    departureTime: null,
  };
}

function time(localDateTime: string, utc: string) {
  return { localDateTime, timezone: 'Asia/Tokyo', utc };
}

function errorResponse(code: string) {
  return {
    status: 'ERROR',
    requestId: 'request-id',
    error: { code, message: 'redacted upstream failure' },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function unavailable() {
  return {
    status: 'PROVIDER_UNAVAILABLE' as const,
    reason: 'UPSTREAM_UNAVAILABLE' as const,
  };
}
