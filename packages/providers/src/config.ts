export type RouteProviderEnvironment =
  'development' | 'test' | 'staging' | 'production';

export type RouteProviderRuntimeConfig =
  | { readonly provider: 'synthetic'; readonly synthetic: true }
  | {
      readonly provider: 'google_consumer_experimental';
      readonly synthetic: false;
      readonly baseUrl: string;
      readonly token: string;
      readonly timeoutMs: number;
    }
  | {
      readonly provider: 'unconfigured';
      readonly synthetic: false;
      readonly reason: 'ROUTE_PROVIDER_UNCONFIGURED';
    };

export function readRouteProviderConfig(
  environment: NodeJS.ProcessEnv,
): RouteProviderRuntimeConfig {
  const appEnvironment = parseEnvironment(environment.APP_ENV);
  const provider = environment.ROUTE_PROVIDER?.trim() || 'unconfigured';
  if (provider === 'synthetic') {
    if (appEnvironment === 'staging' || appEnvironment === 'production') {
      throw new Error(
        'The synthetic route provider is allowed only in development or test',
      );
    }
    return { provider: 'synthetic', synthetic: true };
  }
  if (provider === 'unconfigured') {
    return {
      provider: 'unconfigured',
      synthetic: false,
      reason: 'ROUTE_PROVIDER_UNCONFIGURED',
    };
  }
  if (provider === 'google_consumer_experimental') {
    if (appEnvironment === 'staging' || appEnvironment === 'production') {
      throw new Error(
        'The Google Consumer experimental route provider is allowed only in development or test',
      );
    }
    const token = environment.GOOGLE_CONSUMER_TRANSIT_TOKEN?.trim();
    if (token === undefined || token === '') {
      throw new Error(
        'GOOGLE_CONSUMER_TRANSIT_TOKEN is required when the Google Consumer experimental route provider is selected',
      );
    }
    return {
      provider,
      synthetic: false,
      baseUrl: normalizeGoogleConsumerTransitBaseUrl(
        environment.GOOGLE_CONSUMER_TRANSIT_BASE_URL ?? 'http://127.0.0.1:8787',
      ),
      token,
      timeoutMs: boundedInteger(
        environment.GOOGLE_CONSUMER_TRANSIT_TIMEOUT_MS,
        30_000,
        1_000,
        120_000,
        'GOOGLE_CONSUMER_TRANSIT_TIMEOUT_MS',
      ),
    };
  }
  throw new Error(
    'ROUTE_PROVIDER must be synthetic, google_consumer_experimental, or unconfigured',
  );
}

export function normalizeGoogleConsumerTransitBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GOOGLE_CONSUMER_TRANSIT_BASE_URL must be a valid URL');
  }
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    url.protocol !== 'http:' ||
    !loopbackHosts.has(url.hostname.toLowerCase()) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(
      'GOOGLE_CONSUMER_TRANSIT_BASE_URL must be an HTTP loopback origin without credentials, path, query, or fragment',
    );
  }
  return url.origin;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function parseEnvironment(value: string | undefined): RouteProviderEnvironment {
  switch (value) {
    case undefined:
    case 'development':
      return 'development';
    case 'test':
    case 'staging':
    case 'production':
      return value;
    default:
      throw new Error(
        'APP_ENV must be development, test, staging, or production',
      );
  }
}
