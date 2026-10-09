import { expect, it, vi } from 'vitest';
import {
  providerDoctor,
  PROVIDER_KEYS,
  baiduBusinessDiagnosis,
  type ProviderCapabilityId,
} from './provider-doctor.js';
import { safeDiagnostic } from '../packages/providers/src/contract-diagnostics.js';
const keys = Object.fromEntries(
  PROVIDER_KEYS.map((n) => [n, 'SYNTHETIC_PRIVATE_SECRET_' + n]),
);
const now = new Date('2031-01-01T00:00:00Z');
it('SYNTHETIC only selection dispatches exactly four allowed capabilities and never the five Baidu routes', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
  const report = await providerDoctor(
    { ...keys, APP_ENV: 'test' },
    {
      live: true,
      only: [
        'google-places',
        'google-walking',
        'google-driving',
        'baidu-place',
      ],
      fetcher,
      now: () => now,
    },
  );
  expect(report.capabilities.map((c) => c.name)).toEqual([
    'Google Places',
    'Google Walking',
    'Google Driving',
    'Baidu Place',
  ]);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(report.requestCount).toBe(4);
  expect(report.capabilities.every((c) => c.requestCount === 1)).toBe(true);
  expect(report.productionAuthorization).toBe('NOT_REVIEWED');
});
it.each(
  (
    [
      [],
      ['google-places', 'google-places'],
      ['SYNTHETIC_PRIVATE_SECRET'],
      ['google-places', 'unknown'],
    ] as string[][]
  ).map((only) => ({ only })),
)('SYNTHETIC invalid selection %j makes zero requests', async ({ only }) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    providerDoctor(keys, {
      live: true,
      fetcher,
      only: only as ProviderCapabilityId[],
    }),
  ).rejects.toThrow('INVALID_CAPABILITY_SELECTION');
  expect(fetcher).not.toHaveBeenCalled();
});
it('SYNTHETIC selected config-only Doctor makes zero requests', async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    (await providerDoctor(keys, { only: ['baidu-place'], fetcher }))
      .requestCount,
  ).toBe(0);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  [0, 'SUCCESS', 'NOT_INDICATED'],
  [2, 'INVALID_REQUEST_OR_VERSION', 'NOT_INDICATED'],
  [3, 'KEY_PERMISSION_REQUIRED', 'UNKNOWN'],
  [4, 'QUOTA_LIMIT', 'NOT_INDICATED'],
  [5, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [8, 'INVALID_REQUEST_OR_VERSION', 'NOT_INDICATED'],
  [9, 'ADVANCED_PERMISSION_REQUIRED', 'REVIEW_REQUIRED'],
  [101, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [200, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [201, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [202, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [203, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [210, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [211, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [240, 'API_NOT_ENABLED', 'NOT_INDICATED'],
  [250, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [251, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [252, 'AUTH_REJECTED', 'NOT_INDICATED'],
  [260, 'INVALID_REQUEST_OR_VERSION', 'NOT_INDICATED'],
  [261, 'SERVICE_RETIRED', 'NOT_INDICATED'],
  [302, 'QUOTA_LIMIT', 'NOT_INDICATED'],
  [401, 'QUOTA_LIMIT', 'NOT_INDICATED'],
  [1002, 'PROVIDER_ERROR', 'NOT_INDICATED'],
  [123456, 'UNKNOWN_BUSINESS_STATUS', 'UNKNOWN'],
] as const)(
  'SYNTHETIC Baidu status %s is a safe exact diagnosis %s, not HTTP-200 entitlement',
  async (code, label, commercial) => {
    expect(baiduBusinessDiagnosis(code)).toBe(label);
    const report = await providerDoctor(keys, {
      live: true,
      only: ['baidu-walking'],
      now: () => now,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            status: code,
            message: keys.BAIDU_SERVER_API_KEY,
            private: keys.GOOGLE_SERVER_API_KEY,
          }),
        ),
    });
    const result = report.capabilities[0]!;
    expect(result.businessDiagnosis).toBe(label);
    expect(result.commercialAuthorization).toBe(commercial);
    expect(result.businessStatus).toBe(code === 123456 ? undefined : code);
    if (code !== 0) expect(result.status).not.toBe('LIVE_CONTRACT_PASS');
    for (const secret of Object.values(keys))
      expect(JSON.stringify(report)).not.toContain(secret);
  },
);
it('SYNTHETIC unknown diagnostic properties/paths and extra secret values cannot escape the closed whitelist', () => {
  expect(
    safeDiagnostic({
      stage: 'HTTP_STATUS',
      field: 'response',
      code: 'PASSED',
      secret: keys.GOOGLE_SERVER_API_KEY,
    } as never),
  ).toEqual({ stage: 'HTTP_STATUS', field: 'response', code: 'PASSED' });
  expect(
    safeDiagnostic({
      stage: 'HTTP_STATUS',
      field: keys.BAIDU_SERVER_API_KEY,
      code: 'PASSED',
    } as never),
  ).toBeNull();
});
it('SYNTHETIC Doctor refreshes NOW per request after delayed earlier responses', async () => {
  let instant = now.getTime();
  const requests: Record<string, unknown>[] = [];
  const report = await providerDoctor(keys, {
    live: true,
    only: ['google-places', 'google-driving'],
    now: () => new Date(instant),
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      requests.push(body);
      instant += 30000;
      if (requests.length === 1)
        return new Response(JSON.stringify({ places: [] }));
      return new Response(
        JSON.stringify({
          routes: [
            {
              duration: '600s',
              legs: [
                {
                  startLocation: body.origin.location,
                  endLocation: body.destination.location,
                },
              ],
            },
          ],
        }),
      );
    },
  });
  expect(requests[1]).not.toHaveProperty('departureTime');
  expect(report.capabilities[1]!.status).toBe('LIVE_CONTRACT_PASS');
  expect(report.capabilities[1]!.diagnostics.at(-1)).toMatchObject({
    stage: 'DOMAIN_VALIDATION',
    code: 'PASSED',
  });
});

it('SYNTHETIC Baidu business code cannot override an HTTP transport failure', async () => {
  const report = await providerDoctor(keys, {
    live: true,
    only: ['baidu-place'],
    fetcher: async () =>
      new Response(
        JSON.stringify({ status: 240, message: 'SYNTHETIC_PRIVATE' }),
        { status: 500 },
      ),
  });
  expect(report.capabilities[0]!.status).toBe('PROVIDER_ERROR');
  expect(report.capabilities[0]!.httpStatus).toBe(500);
});

it.each(['shape', 'coordinate', 'binding'] as const)(
  'SYNTHETIC Doctor propagates Baidu %s stages without leaking response fields',
  async (kind) => {
    const from = { lat: 39.915, lng: 116.404 },
      to = { lat: 39.925, lng: 116.414 };
    const b = {
      status: 0,
      message: keys.BAIDU_SERVER_API_KEY,
      result: {
        origin: { originPt: from },
        destination: { destinationPt: to },
        routes: [{ duration: 600 }],
      },
    };
    // Doctor's trusted Beijing fixture remains unchanged. Only the failure fixture
    // uses alternate coordinates; no synthetic success is mislabeled as live.
    if (kind === 'shape')
      Object.assign(b.result, {
        routes: { private: keys.GOOGLE_SERVER_API_KEY },
      });
    if (kind === 'coordinate')
      Object.assign(from, { lat: keys.BAIDU_SERVER_API_KEY });
    const report = await providerDoctor(keys, {
      live: true,
      only: ['baidu-walking'],
      now: () => now,
      fetcher: async () => new Response(JSON.stringify(b)),
    });
    const c = report.capabilities[0]!;
    expect(report.requestCount).toBe(1);
    expect(c.businessStatus).toBe(0);
    const end = c.diagnostics.at(-1)!;
    // All unbound endpoints must stop before downstream Domain validation.
    expect(c.status).toBe('CONTRACT_MISMATCH');
    expect(end.stage).toBe(
      kind === 'shape'
        ? 'RESPONSE_SHAPE'
        : kind === 'coordinate'
          ? 'COORDINATE_PARSE'
          : 'ENDPOINT_BINDING',
    );
    for (const privateValue of [...Object.values(keys), '39.915', '116.404'])
      expect(JSON.stringify(report)).not.toContain(privateValue);
  },
);
