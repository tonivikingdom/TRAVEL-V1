import { expect, it, vi } from 'vitest';
import { providerDoctor, PROVIDER_KEYS } from './provider-doctor.js';
import {
  providerResponseEvidence,
  safeResponseEvidence,
} from './provider-response-diagnostics.js';

const keys = Object.fromEntries(
  PROVIDER_KEYS.map((k) => [k, 'SYNTHETIC_SECRET']),
);
function response(body: string, type: string, url: string, status = 200) {
  const r = new Response(body, { status, headers: { 'content-type': type } });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}
it.each([
  ['<html><body>SYNTHETIC_PRIVATE</body></html>', 'text/html', 'HTML'],
  [
    '<?xml version="1.0"?><error>SYNTHETIC_PRIVATE</error>',
    'application/xml',
    'XML',
  ],
  ['', 'text/plain', 'EMPTY'],
  ['SYNTHETIC_PRIVATE', 'application/octet-stream', 'OTHER'],
] as const)(
  'SYNTHETIC non-JSON response %s has closed transport evidence',
  async (body, type, bodyType) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response(
        body,
        type,
        'https://api.map.baidu.com/place/v2/search?ak=SYNTHETIC_SECRET',
      ),
    );
    const report = await providerDoctor(keys, {
      live: true,
      only: ['baidu-place'],
      fetcher,
    });
    expect(report.capabilities[0]!.status).toBe('CONTRACT_MISMATCH');
    expect(report.capabilities[0]).toMatchObject({
      responseEvidence: {
        bodyType,
        target: 'EXPECTED_HTTPS_TARGET',
        source: 'PROVIDER_OR_INTERMEDIARY_UNVERIFIED',
      },
    });
    expect(report.requestCount).toBe(1);
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PRIVATE');
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_SECRET');
  },
);
it('SYNTHETIC Baidu walking keeps numerical business status separate from JSON and HTTP success', async () => {
  const report = await providerDoctor(keys, {
    live: true,
    only: ['baidu-walking'],
    fetcher: async () =>
      response(
        JSON.stringify({ status: 240, message: 'SYNTHETIC_PRIVATE' }),
        'application/json',
        'https://api.map.baidu.com/direction/v2/walking',
      ),
  });
  expect(report.capabilities[0]).toMatchObject({
    httpStatus: 200,
    businessStatus: 240,
    businessDiagnosis: 'API_NOT_ENABLED',
    status: 'API_NOT_ENABLED',
    responseEvidence: {
      contentType: 'JSON',
      bodyType: 'JSON',
      target: 'EXPECTED_HTTPS_TARGET',
      source: 'PROVIDER_OR_INTERMEDIARY_UNVERIFIED',
    },
  });
  expect(report.requestCount).toBe(1);
});

const request = 'https://api.map.baidu.com/place/v2/search?ak=SYNTHETIC_SECRET';
it('SYNTHETIC Baidu Place explicitly requests JSON and never retries or guesses JSONP/XML business status', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    response(
      '<?xml version="1.0"?><error>SYNTHETIC_PRIVATE</error>',
      'application/xml',
      request,
    ),
  );
  const report = await providerDoctor(keys, {
    live: true,
    only: ['baidu-place'],
    fetcher,
  });
  const url = new URL(String(fetcher.mock.calls[0]![0]));
  expect(url.protocol).toBe('https:');
  expect(url.hostname).toBe('api.map.baidu.com');
  expect(url.pathname).toBe('/place/v2/search');
  expect(url.searchParams.get('output')).toBe('json');
  expect(url.searchParams.has('callback')).toBe(false);
  expect(report.capabilities[0]).toMatchObject({
    status: 'CONTRACT_MISMATCH',
    responseEvidence: { contentType: 'XML', bodyType: 'XML' },
  });
  expect(report.capabilities[0]).not.toHaveProperty('businessStatus');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(report.requestCount).toBe(1);
});
it.each([
  ['application/json; charset=utf-8; private=SYNTHETIC_SECRET', 'JSON'],
  ['Application/Problem+JSON', 'JSON'],
  ['text/html; charset=utf-8', 'HTML'],
  ['application/xhtml+xml', 'HTML'],
  ['text/xml', 'XML'],
  ['application/xml', 'XML'],
  ['text/plain', 'TEXT'],
  ['SYNTHETIC_PRIVATE', 'OTHER'],
  ['', 'MISSING'],
] as const)(
  'SYNTHETIC content type is a category, never header value: %s',
  (type, expected) => {
    const result = providerResponseEvidence(
      'BAIDU',
      request,
      response('{}', type, request),
      '{}',
    );
    expect(result.contentType).toBe(expected);
    expect(result.bodyType).toBe('JSON');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  },
);
it.each([
  [request, 'EXPECTED_HTTPS_TARGET'],
  ['', 'UNVERIFIABLE'],
  ['http://api.map.baidu.com/place/v2/search', 'UNEXPECTED_TARGET'],
  ['https://SYNTHETIC.example.test/place/v2/search', 'UNEXPECTED_TARGET'],
  ['https://api.map.baidu.com/place/v2/search.other', 'UNEXPECTED_TARGET'],
  ['https://api.map.baidu.com/direction/v2/walking', 'UNEXPECTED_TARGET'],
  ['https://api.map.baidu.com:8443/place/v2/search', 'UNEXPECTED_TARGET'],
  [
    'https://user:SYNTHETIC_SECRET@api.map.baidu.com/place/v2/search',
    'UNEXPECTED_TARGET',
  ],
  ['SYNTHETIC_NOT_A_URL', 'UNVERIFIABLE'],
] as const)(
  'SYNTHETIC response URL supplies transport evidence only: %s',
  (url, expected) => {
    const r = providerResponseEvidence(
      'BAIDU',
      request,
      response('{}', 'application/json', url),
      '{}',
    );
    expect(r.target).toBe(expected);
    expect(r.source).toBe('PROVIDER_OR_INTERMEDIARY_UNVERIFIED');
    expect(JSON.stringify(r)).not.toContain('SYNTHETIC');
  },
);
it('SYNTHETIC redirects and wrong Google host/path pairs cannot become trusted targets', () => {
  const r = response('{}', 'application/json', request);
  Object.defineProperty(r, 'redirected', { value: true });
  expect(providerResponseEvidence('BAIDU', request, r, '{}').target).toBe(
    'UNEXPECTED_TARGET',
  );
  const url = 'https://places.googleapis.com/directions/v2:computeRoutes';
  expect(
    providerResponseEvidence(
      'GOOGLE',
      url,
      response('{}', 'application/json', url),
      '{}',
    ).target,
  ).toBe('UNEXPECTED_TARGET');
});
it.each([
  [403, 'domain forbidden SYNTHETIC_SECRET', 'PROXY_POLICY_DENIED'],
  [200, '<html>Bad Gateway SYNTHETIC_PRIVATE</html>', 'GATEWAY_ERROR_SIGNAL'],
  [
    200,
    '<?xml version="1.0"?><error>Gateway Timeout SYNTHETIC_PRIVATE</error>',
    'GATEWAY_ERROR_SIGNAL',
  ],
  [
    200,
    JSON.stringify({ message: 'proxy error SYNTHETIC_SECRET' }),
    'NO_FIXED_SIGNAL',
  ],
  [200, '<html>ordinary SYNTHETIC_PRIVATE</html>', 'NO_FIXED_SIGNAL'],
] as const)(
  'SYNTHETIC intermediary signals are fixed hints, not attribution or AK acceptance',
  (status, body, signal) => {
    const r = providerResponseEvidence(
      'BAIDU',
      request,
      response(body, 'text/html', request, status),
      body,
    );
    expect(r.intermediarySignal).toBe(signal);
    expect(r.source).toBe('PROVIDER_OR_INTERMEDIARY_UNVERIFIED');
    expect(JSON.stringify(r)).not.toContain('SYNTHETIC');
  },
);
it('SYNTHETIC only content-type and via presence are consulted, with no full header serialization', () => {
  const headers = new Headers({
    'content-type': 'text/html',
    via: 'SYNTHETIC_SECRET',
    'set-cookie': 'SYNTHETIC_SECRET',
    authorization: 'SYNTHETIC_SECRET',
    server: 'SYNTHETIC_SECRET',
  });
  const get = vi.spyOn(headers, 'get'),
    has = vi.spyOn(headers, 'has');
  const result = providerResponseEvidence(
    'BAIDU',
    request,
    { headers, status: 200, url: request, redirected: false },
    '<html>SYNTHETIC_PRIVATE</html>',
  );
  expect(get.mock.calls).toEqual([['content-type']]);
  expect(has.mock.calls).toEqual([['via']]);
  expect(result.intermediarySignal).toBe('INTERMEDIARY_HEADER_PRESENT');
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
});
it('SYNTHETIC output boundary strips extras and rejects any unapproved category', () => {
  const r = providerResponseEvidence(
    'BAIDU',
    request,
    response('{}', 'application/json', request),
    '{}',
  );
  expect(
    safeResponseEvidence({
      ...r,
      body: 'SYNTHETIC_SECRET',
      headers: { ak: 'SYNTHETIC_SECRET' },
      url: request,
    }),
  ).toEqual(r);
  for (const field of [
    'contentType',
    'bodyType',
    'target',
    'intermediarySignal',
    'source',
  ])
    expect(
      safeResponseEvidence({ ...r, [field]: 'SYNTHETIC_SECRET' }),
    ).toBeNull();
  expect(safeResponseEvidence(null)).toBeNull();
  expect(safeResponseEvidence([])).toBeNull();
});
it.each([
  '"SYNTHETIC_SECRET"',
  '["SYNTHETIC_SECRET"]',
  'null',
  '{}',
  '{bad json}',
  ' '.repeat(4),
  'SYNTHETIC_SECRET'.repeat(150000),
])(
  'SYNTHETIC JSON/empty/oversize inspection never emits body or prefix',
  (body) => {
    const r = providerResponseEvidence(
      'BAIDU',
      request,
      response(body, 'application/json', request),
      body,
    );
    expect(r.bodyType).toBe(
      body.length > 2_000_000
        ? 'OTHER'
        : body.trim() === ''
          ? 'EMPTY'
          : body === '{bad json}'
            ? 'OTHER'
            : 'JSON',
    );
    expect(JSON.stringify(r)).not.toContain('SYNTHETIC_SECRET');
  },
);
it('SYNTHETIC selected two-capability diagnosis spends only two attempts, not the whole route matrix', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    response('<html>Bad Gateway SYNTHETIC_SECRET</html>', 'text/html', request),
  );
  const report = await providerDoctor(keys, {
    live: true,
    only: ['baidu-place', 'baidu-walking'],
    fetcher,
  });
  expect(report.capabilities.map((c) => c.name)).toEqual([
    'Baidu Place',
    'Baidu Walking',
  ]);
  expect(report.requestCount).toBe(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    report.capabilities.every((c) => c.status !== 'LIVE_CONTRACT_PASS'),
  ).toBe(true);
  expect(JSON.stringify(report)).not.toContain('SYNTHETIC_SECRET');
});
