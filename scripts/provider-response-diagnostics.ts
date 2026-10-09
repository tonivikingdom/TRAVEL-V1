/** Doctor-only, closed transport evidence. Never expose headers, URLs or body fragments. */
const CONTENT_TYPES = [
  'JSON',
  'HTML',
  'XML',
  'TEXT',
  'OTHER',
  'MISSING',
] as const;
const BODY_TYPES = ['JSON', 'HTML', 'XML', 'EMPTY', 'OTHER'] as const;
const TARGETS = [
  'EXPECTED_HTTPS_TARGET',
  'UNEXPECTED_TARGET',
  'UNVERIFIABLE',
] as const;
const SIGNALS = [
  'PROXY_POLICY_DENIED',
  'GATEWAY_ERROR_SIGNAL',
  'INTERMEDIARY_HEADER_PRESENT',
  'NO_FIXED_SIGNAL',
] as const;
const SOURCE = 'PROVIDER_OR_INTERMEDIARY_UNVERIFIED' as const;
export interface ProviderResponseEvidence {
  readonly contentType: (typeof CONTENT_TYPES)[number];
  readonly bodyType: (typeof BODY_TYPES)[number];
  /** URL/redirect evidence for the transport target, not proof of the body's author. */
  readonly target: (typeof TARGETS)[number];
  readonly intermediarySignal: (typeof SIGNALS)[number];
  readonly source: typeof SOURCE;
}
const paths: Record<'GOOGLE' | 'BAIDU', Record<string, readonly string[]>> = {
  GOOGLE: {
    'places.googleapis.com': ['/v1/places:searchText'],
    'routes.googleapis.com': ['/directions/v2:computeRoutes'],
  },
  BAIDU: {
    'api.map.baidu.com': [
      '/place/v2/search',
      '/direction/v2/walking',
      '/direction/v2/driving',
      '/direction/v2/transit',
      '/direction/v2/riding',
    ],
  },
};
function target(
  provider: 'GOOGLE' | 'BAIDU',
  request: string,
  response: Pick<Response, 'url' | 'redirected'>,
): ProviderResponseEvidence['target'] {
  try {
    const a = new URL(request);
    if (
      a.protocol !== 'https:' ||
      a.username ||
      a.password ||
      (a.port && a.port !== '443') ||
      !paths[provider][a.hostname]?.includes(a.pathname)
    )
      return 'UNEXPECTED_TARGET';
    if (response.redirected) return 'UNEXPECTED_TARGET';
    if (!response.url) return 'UNVERIFIABLE';
    const b = new URL(response.url);
    return b.protocol === 'https:' &&
      !b.username &&
      !b.password &&
      b.origin === a.origin &&
      b.pathname === a.pathname
      ? 'EXPECTED_HTTPS_TARGET'
      : 'UNEXPECTED_TARGET';
  } catch {
    return 'UNVERIFIABLE';
  }
}
function contentType(
  value: string | null,
): ProviderResponseEvidence['contentType'] {
  if (!value?.trim()) return 'MISSING';
  const media = value.split(';')[0]!.trim().toLowerCase();
  if (
    ['application/json', 'text/json', 'application/problem+json'].includes(
      media,
    )
  )
    return 'JSON';
  if (['text/html', 'application/xhtml+xml'].includes(media)) return 'HTML';
  if (['application/xml', 'text/xml'].includes(media)) return 'XML';
  if (media === 'text/plain') return 'TEXT';
  return 'OTHER';
}
function bodyType(text: string): ProviderResponseEvidence['bodyType'] {
  if (!text.trim()) return 'EMPTY';
  if (text.length > 2_000_000) return 'OTHER';
  try {
    JSON.parse(text);
    return 'JSON';
  } catch {
    /* Only a closed signature category follows. */
  }
  if (/^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/iu.test(text))
    return 'HTML';
  if (/^\s*<\?xml\b/iu.test(text)) return 'XML';
  return 'OTHER';
}
export function providerResponseEvidence(
  provider: 'GOOGLE' | 'BAIDU',
  request: string,
  response: Pick<Response, 'status' | 'headers' | 'url' | 'redirected'>,
  text: string,
): ProviderResponseEvidence {
  const kind = bodyType(text);
  // A fixed signal is only an observation. Even a gateway-like body does not
  // establish which intermediary generated it or whether a Provider AK was valid.
  const signal =
    response.status === 403 &&
    /domain forbidden|connect tunnel failed/iu.test(text)
      ? 'PROXY_POLICY_DENIED'
      : kind !== 'JSON' &&
          /\bbad gateway\b|\bgateway timeout\b|\bproxy error\b/iu.test(text)
        ? 'GATEWAY_ERROR_SIGNAL'
        : response.headers.has('via')
          ? 'INTERMEDIARY_HEADER_PRESENT'
          : 'NO_FIXED_SIGNAL';
  return {
    contentType: contentType(response.headers.get('content-type')),
    bodyType: kind,
    target: target(provider, request, response),
    intermediarySignal: signal,
    source: SOURCE,
  };
}
/** Defense at serialization: strip extra properties and reject non-whitelisted values. */
export function safeResponseEvidence(
  value: unknown,
): ProviderResponseEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as ProviderResponseEvidence;
  if (
    !CONTENT_TYPES.includes(r.contentType) ||
    !BODY_TYPES.includes(r.bodyType) ||
    !TARGETS.includes(r.target) ||
    !SIGNALS.includes(r.intermediarySignal) ||
    r.source !== SOURCE
  )
    return null;
  return {
    contentType: r.contentType,
    bodyType: r.bodyType,
    target: r.target,
    intermediarySignal: r.intermediarySignal,
    source: SOURCE,
  };
}
