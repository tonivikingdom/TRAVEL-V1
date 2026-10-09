import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  classifyProviderFailure,
  PROVIDER_GATES,
  PROVIDER_KEYS,
  providerDoctor,
} from './provider-doctor.js';
const now = new Date('2031-01-01T00:00:00Z');
const keys = Object.fromEntries(
  PROVIDER_KEYS.map((name) => [name, `SYNTHETIC_${name}_SECRET_DO_NOT_PRINT`]),
);
it('configuration mode reports only SET/UNSET, immutable gates, hosts and actual wiring, with zero requests', async () => {
  const fetcher = vi.fn(),
    env = Object.freeze({
      ...keys,
      GOOGLE_ENTITLEMENT_APPROVED: 'true',
      BAIDU_STORAGE_APPROVED: 'invalid',
    });
  const report = await providerDoctor(env, { fetcher });
  expect(fetcher).not.toHaveBeenCalled();
  expect(report.requestCount).toBe(0);
  expect(Object.values(report.keys)).toEqual(['SET', 'SET', 'SET', 'SET']);
  expect(report.gates.GOOGLE_ENTITLEMENT_APPROVED).toBe('TRUE');
  expect(report.gates.BAIDU_STORAGE_APPROVED).toBe('INVALID');
  expect(report.browser.baiduCoordinates).toBe(
    'WIRED_OFFICIAL_JSAPI4_WGS84_TO_BD09',
  );
  for (const secret of Object.values(keys))
    expect(JSON.stringify(report)).not.toContain(secret);
  expect(env.BAIDU_STORAGE_APPROVED).toBe('invalid');
});
it('missing secrets and a production instance make zero live requests', async () => {
  const fetcher = vi.fn();
  const missing = await providerDoctor({}, { live: true, fetcher });
  expect(missing.capabilities.every((c) => c.status === 'SECRET_UNSET')).toBe(
    true,
  );
  const production = await providerDoctor(
    { ...keys, APP_ENV: 'production' },
    { live: true, fetcher },
  );
  expect(
    production.capabilities.every(
      (c) => c.status === 'LIVE_CHECK_REQUIRES_DEV_OR_TEST',
    ),
  ).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});
it('provider template has four empty credentials and every actual gate false', async () => {
  const template = await readFile(
    new URL('../.env.provider.example', import.meta.url),
    'utf8',
  );
  for (const name of PROVIDER_KEYS)
    expect(template.split('\n')).toContain(`${name}=`);
  for (const name of PROVIDER_GATES)
    expect(template.split('\n')).toContain(`${name}=false`);
});
it.each([
  [
    'GOOGLE',
    403,
    { error: { details: [{ reason: 'SERVICE_DISABLED' }] } },
    'API_NOT_ENABLED',
  ],
  [
    'GOOGLE',
    403,
    { error: { details: [{ reason: 'BILLING_DISABLED' }] } },
    'BILLING_OR_ENTITLEMENT',
  ],
  ['GOOGLE', 401, {}, 'AUTH_REJECTED'],
  ['GOOGLE', 500, {}, 'PROVIDER_ERROR'],
  ['BAIDU', 200, { status: 9 }, 'BILLING_OR_ENTITLEMENT'],
  ['BAIDU', 200, { status: 240 }, 'API_NOT_ENABLED'],
  ['BAIDU', 200, { status: 5 }, 'AUTH_REJECTED'],
  ['BAIDU', 200, { status: 1 }, 'PROVIDER_ERROR'],
] as const)(
  'sanitized %s/%s classifies to %s without raw provider output',
  (provider, status, body, expected) => {
    expect(classifyProviderFailure(provider, status, body)).toBe(expected);
  },
);
it.each([
  'rejection',
  'proxy',
  'malformed',
  'provider-auth',
  'provider-http',
] as const)(
  'live %s is sanitized and dispatched at most once per capability, without retries',
  async (kind) => {
    const fetcher = vi.fn(async () => {
      if (kind === 'rejection') throw new Error(keys.GOOGLE_SERVER_API_KEY);
      return new Response(
        kind === 'proxy'
          ? 'Domain forbidden'
          : kind === 'malformed' || kind === 'provider-http'
            ? 'not-json'
            : JSON.stringify({
                status: 5,
                error: { message: keys.GOOGLE_SERVER_API_KEY },
              }),
        {
          status:
            kind === 'proxy'
              ? 403
              : kind === 'provider-auth'
                ? 401
                : kind === 'provider-http'
                  ? 502
                  : 200,
        },
      );
    });
    const report = await providerDoctor(Object.freeze(keys), {
      live: true,
      fetcher,
      now: () => now,
    });
    expect(report.requestCount).toBe(9);
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(report.capabilities.every((c) => c.requestCount === 1)).toBe(true);
    expect(
      report.capabilities.every(
        (c) =>
          c.status ===
          (kind === 'rejection' || kind === 'proxy'
            ? 'NETWORK_BLOCKED'
            : kind === 'provider-http'
              ? 'PROVIDER_ERROR'
              : kind === 'malformed'
                ? 'CONTRACT_MISMATCH'
                : 'AUTH_REJECTED'),
      ),
    ).toBe(true);
    for (const secret of Object.values(keys))
      expect(JSON.stringify(report)).not.toContain(secret);
  },
);
it('SYNTHETIC probes retain the request budget and gates; approximate wrong Baidu endpoints fail closed', async () => {
  const fetcher = vi.fn(
    async (value: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(value));
      if (url.hostname === 'places.googleapis.com')
        return new Response(
          JSON.stringify({
            places: [
              {
                id: 'SYNTHETIC',
                displayName: { text: 'SYNTHETIC station' },
                location: { latitude: 35.681236, longitude: 139.767125 },
              },
            ],
          }),
        );
      if (url.hostname === 'routes.googleapis.com') {
        const request = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            routes: [
              {
                duration: '600s',
                legs: [
                  {
                    startLocation: request.origin.location,
                    endLocation: request.destination.location,
                  },
                ],
              },
            ],
          }),
        );
      }
      if (url.pathname.includes('/place/'))
        return new Response(
          JSON.stringify({
            status: 0,
            results: [
              {
                uid: 'SYNTHETIC',
                name: 'SYNTHETIC place',
                location: { lat: 39.915, lng: 116.404 },
              },
            ],
          }),
        );
      const raw = (parameter: string) => {
        const [lat, lng] = url.searchParams
          .get(parameter)!
          .split(',')
          .map(Number);
        return { lat: lat! + 0.00775, lng: lng! + 0.01262 }; // Explicit SYNTHETIC fixtures, no official forward transform claim.
      };
      const a = raw('origin'),
        b = raw('destination');
      const transit = url.pathname.endsWith('transit'),
        driving = url.pathname.endsWith('driving');
      return new Response(
        JSON.stringify({
          status: 0,
          result: {
            origin: transit
              ? { city_id: 'SYNTHETIC:beijing', location: a }
              : driving
                ? a
                : { originPt: a },
            destination: transit
              ? { city_id: 'SYNTHETIC:beijing', location: b }
              : driving
                ? b
                : { destinationPt: b },
            routes: [{ duration: 600 }],
          },
        }),
      );
    },
  );
  const env = Object.freeze({ ...keys, APP_ENV: 'test' });
  const report = await providerDoctor(env, {
    live: true,
    fetcher: fetcher as typeof fetch,
    now: () => now,
  });
  expect(report.capabilities.map((c) => c.status)).toEqual([
    ...Array(4).fill('LIVE_CONTRACT_PASS'),
    ...Array(5).fill('CONTRACT_MISMATCH'),
  ]);
  expect(report.requestCount).toBe(9);
  expect(Object.values(report.gates).every((g) => g === 'FALSE')).toBe(true);
  const future = new URL(String(fetcher.mock.calls.at(-1)![0]));
  expect(future.pathname).toBe('/direction/v2/driving');
  expect(future.searchParams.get('departure_time')).toBe(
    String(now.getTime() / 1000 + 86400),
  );
});

it.each([
  ['TRANSIT', 200, 1002, 'UNSUPPORTED'],
  ['WALKING', 200, 1002, 'PROVIDER_ERROR'],
  ['DRIVING', 200, 1002, 'PROVIDER_ERROR'],
  ['CYCLING', 200, 1002, 'PROVIDER_ERROR'],
  ['TRANSIT', 500, 1002, 'PROVIDER_ERROR'],
  ['TRANSIT', 200, 1003, 'PROVIDER_ERROR'],
] as const)(
  'Doctor precisely classifies Baidu %s / HTTP %s / %s',
  (mode, http, code, expected) => {
    expect(
      classifyProviderFailure(
        'BAIDU',
        http,
        { status: code, result: null },
        mode,
      ),
    ).toBe(expected);
  },
);
it('SYNTHETIC Doctor reports TRANSIT 1002 as UNSUPPORTED while unrelated capabilities stay failures', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ status: 1002, result: null })),
  );
  const report = await providerDoctor(
    {
      APP_ENV: 'test',
      BAIDU_SERVER_API_KEY: 'SYNTHETIC_NETWORK_SECRET_PLACEHOLDER',
    },
    { live: true, fetcher, now: () => now },
  );
  expect(
    report.capabilities.find((c) => c.name === 'Baidu Transit')?.status,
  ).toBe('UNSUPPORTED');
  expect(
    report.capabilities.find((c) => c.name === 'Baidu Walking')?.status,
  ).toBe('PROVIDER_ERROR');
  expect(report.requestCount).toBe(6);
  expect(JSON.stringify(report)).not.toContain(
    'SYNTHETIC_NETWORK_SECRET_PLACEHOLDER',
  );
});
