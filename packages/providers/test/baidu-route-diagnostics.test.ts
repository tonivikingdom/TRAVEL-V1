import { expect, it, vi } from 'vitest';
import type { RouteProviderQueryInput } from '@travel/application';
import { validateRouteCandidate } from '@travel/domain';
import { BaiduOrdinaryRouteProvider } from '../src/regional-route-adapters.js';
import { baiduToWgs84 } from '../src/baidu-coordinates.js';
import {
  type ProviderDiagnostic,
  safeDiagnostic,
} from '../src/contract-diagnostics.js';
const now = new Date('2031-01-01T00:00:00Z');
const raw = [
  { lat: 39.915, lng: 116.404 },
  { lat: 39.925, lng: 116.414 },
];
const secret = 'SYNTHETIC_PRIVATE_AK';
function input(): RouteProviderQueryInput {
  return {
    travelMode: 'WALKING',
    origin: {
      ...baiduToWgs84(raw[0]!.lat, raw[0]!.lng),
      name: 'SYNTHETIC private origin',
      placeId: 'SYNTHETIC:a',
      timeZone: 'Asia/Shanghai',
    },
    destination: {
      ...baiduToWgs84(raw[1]!.lat, raw[1]!.lng),
      name: 'SYNTHETIC private destination',
      placeId: 'SYNTHETIC:b',
      timeZone: 'Asia/Shanghai',
    },
    preference: { type: 'NONE' },
    earliestDeparture: null,
    latestArrival: null,
  };
}
function body() {
  return {
    status: 0,
    message: secret,
    result: {
      origin: { originPt: { ...raw[0]! } },
      destination: { destinationPt: { ...raw[1]! } },
      routes: [{ duration: 900, steps: [{ instructions: secret }] }],
    },
  };
}
async function run(payload: unknown, q = input()) {
  const diagnostics: ProviderDiagnostic[] = [];
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(payload)),
  );
  const result = await new BaiduOrdinaryRouteProvider(
    secret,
    fetcher,
    () => now,
    false,
    (d) => diagnostics.push(d),
  ).queryRoutes(q);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const d of diagnostics) expect(safeDiagnostic(d)).toEqual(d);
  const encoded = JSON.stringify(diagnostics);
  for (const privateValue of [
    secret,
    q.origin.name,
    q.destination.name,
    '39.915',
    '116.404',
    'https://',
    'originPt.lat',
  ])
    expect(encoded).not.toContain(privateValue);
  return { result, diagnostics, fetcher };
}
it('SYNTHETIC documented WALKING structure yields distinct parse, binding and candidate stages', async () => {
  const { result, diagnostics, fetcher } = await run(body());
  expect(result.status).toBe('SUCCESS');
  expect(diagnostics).toEqual([
    {
      stage: 'RESPONSE_SHAPE',
      field: 'response.result.routes',
      code: 'PASSED',
    },
    {
      stage: 'RESPONSE_SHAPE',
      field: 'response.result.origin/destination',
      code: 'PASSED',
    },
    {
      stage: 'COORDINATE_PARSE',
      field: 'response.result.origin.originPt/destination.destinationPt',
      code: 'PASSED',
    },
    {
      stage: 'ENDPOINT_BINDING',
      field: 'response.result.origin.originPt/destination.destinationPt',
      code: 'PASSED',
    },
    {
      stage: 'RESPONSE_SHAPE',
      field: 'response.result.routes[].duration',
      code: 'PASSED',
    },
    { stage: 'DOMAIN_VALIDATION', field: 'candidate', code: 'PASSED' },
  ]);
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.searchParams.get('coord_type')).toBe('wgs84');
  expect(url.searchParams.get('ret_coordtype')).toBe('bd09ll');
  if (result.status !== 'SUCCESS') throw new Error('Expected candidate');
  expect(
    validateRouteCandidate(result.candidates[0]!, {
      earliestDeparture: now,
      latestArrival: null,
    }),
  ).toEqual({ accepted: true });
  expect(result.candidates[0]!.legs[0]!.from.latitude).toBe(
    input().origin.latitude,
  );
});
it.each([undefined, null, {}, 'private', Array(6).fill({ duration: 900 })])(
  'SYNTHETIC invalid routes %j fails shape without binding',
  async (routes) => {
    const b = body();
    Object.assign(b.result, { routes });
    const { result, diagnostics } = await run(b);
    expect(result).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'UPSTREAM_UNAVAILABLE',
    });
    expect(diagnostics.at(-1)).toEqual({
      stage: 'RESPONSE_SHAPE',
      field: 'response.result.routes',
      code: 'INVALID_SHAPE',
    });
  },
);
it.each(['origin', 'destination', 'originPt', 'destinationPt'])(
  'SYNTHETIC missing %s has a structure diagnosis',
  async (field) => {
    const b = body();
    if (field === 'origin' || field === 'destination')
      delete (b.result as Record<string, unknown>)[field];
    else if (field === 'originPt')
      delete (b.result.origin as Record<string, unknown>)[field];
    else delete (b.result.destination as Record<string, unknown>)[field];
    const { result, diagnostics } = await run(b);
    expect(result.status).toBe('PROVIDER_UNAVAILABLE');
    expect(diagnostics.at(-1)).toMatchObject({
      stage: 'RESPONSE_SHAPE',
      code: 'INVALID_SHAPE',
    });
  },
);
it.each([
  { lat: '39.915', lng: 116.404 },
  { lat: 91, lng: 116.404 },
  { lat: 39.915, lng: 181 },
  { lat: null, lng: 116.404 },
  {},
])('SYNTHETIC illegal endpoint %j fails coordinate parse', async (point) => {
  const b = body();
  Object.assign(b.result.origin, { originPt: point });
  const { diagnostics } = await run(b);
  expect(diagnostics.at(-1)).toMatchObject({
    stage: 'COORDINATE_PARSE',
    code: 'INVALID_COORDINATES',
  });
});
it.each([0, -1, 1.5, 604801, '900', null])(
  'SYNTHETIC invalid duration %j is not mislabeled as endpoint failure',
  async (duration) => {
    const b = body();
    Object.assign(b.result.routes[0]!, { duration });
    const { result, diagnostics } = await run(b);
    expect(result.status).toBe('PROVIDER_UNAVAILABLE');
    expect(diagnostics.at(-1)).toEqual({
      stage: 'RESPONSE_SHAPE',
      field: 'response.result.routes[].duration',
      code: 'INVALID_DURATION',
    });
  },
);
it.each([
  'wrong-system',
  'far-offset',
  'near-offset',
  'reversed',
  'collapsed',
] as const)(
  'SYNTHETIC %s preserves strict endpoint rejection',
  async (kind) => {
    const b = body();
    let q = input();
    if (kind === 'wrong-system') {
      Object.assign(b.result.origin, { originPt: q.origin });
      Object.assign(b.result.destination, { destinationPt: q.destination });
    }
    if (kind === 'far-offset') b.result.origin.originPt.lat += 0.001;
    if (kind === 'near-offset') b.result.origin.originPt.lat += 0.000001;
    if (kind === 'reversed') {
      b.result.origin.originPt = { ...raw[1]! };
      b.result.destination.destinationPt = { ...raw[0]! };
    }
    if (kind === 'collapsed') {
      q = { ...q, destination: { ...q.origin } };
      b.result.destination.destinationPt = { ...raw[0]! };
    }
    const { result, diagnostics } = await run(b, q);
    expect(result).toEqual({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'UPSTREAM_UNAVAILABLE',
    });
    expect(diagnostics.at(-1)).toEqual({
      stage: 'ENDPOINT_BINDING',
      field: 'response.result.origin.originPt/destination.destinationPt',
      code:
        kind === 'near-offset'
          ? 'COORDINATE_EQUIVALENCE_REQUIRED'
          : kind === 'collapsed'
            ? 'ENDPOINT_REVERSED_OR_COLLAPSED'
            : 'OFFSET_LIMIT_EXCEEDED',
    });
  },
);
it('SYNTHETIC empty routes retains no-match result', async () => {
  const b = body();
  b.result.routes = [];
  const { result, diagnostics } = await run(b);
  expect(result.status).toBe('NO_MATCHING_CANDIDATE');
  expect(diagnostics.at(-1)).toMatchObject({
    stage: 'RESPONSE_SHAPE',
    code: 'PASSED',
  });
});
it('SYNTHETIC observer is optional and does not change failure return semantics', async () => {
  const b = body();
  b.result.origin.originPt.lat += 0.001;
  const without = await new BaiduOrdinaryRouteProvider(
    secret,
    async () => new Response(JSON.stringify(b)),
    () => now,
  ).queryRoutes(input());
  expect((await run(b)).result).toEqual(without);
});
