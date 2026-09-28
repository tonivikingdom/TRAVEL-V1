export interface FlightProviderRuntimeConfig {
  readonly provider: 'aerodatabox' | 'synthetic' | 'unconfigured';
  readonly liveApiEnabled: boolean;
  readonly apiKey: string | null;
  readonly host: string;
  readonly syntheticScheduledUtc: string | null;
  readonly syntheticObservedAt: string | null;
  readonly syntheticRefreshMode: 'baseline' | 'delayed';
  readonly syntheticFailFirst: boolean;
}

const DEFAULT_HOST = 'aerodatabox.p.rapidapi.com';

export function readFlightProviderConfig(
  environment: NodeJS.ProcessEnv,
): FlightProviderRuntimeConfig {
  const provider = environment.FLIGHT_PROVIDER?.trim() || 'unconfigured';
  if (
    provider !== 'aerodatabox' &&
    provider !== 'synthetic' &&
    provider !== 'unconfigured'
  ) {
    throw new Error(
      'FLIGHT_PROVIDER must be aerodatabox, synthetic or unconfigured',
    );
  }
  if (
    provider === 'synthetic' &&
    (!['development', 'test'].includes(environment.APP_ENV ?? '') ||
      environment.SYNTHETIC_CI_ONLY !== 'true')
  ) {
    throw new Error(
      'Synthetic flight provider is restricted to explicitly marked development/test',
    );
  }
  const syntheticScheduledUtc =
    environment.SYNTHETIC_FLIGHT_SCHEDULED_UTC ?? null;
  const syntheticObservedAt = environment.SYNTHETIC_FLIGHT_OBSERVED_AT ?? null;
  if (
    provider === 'synthetic' &&
    (!validAbsoluteUtc(syntheticScheduledUtc) ||
      !validAbsoluteUtc(syntheticObservedAt))
  ) {
    throw new Error(
      'Synthetic flight provider requires explicit UTC fixture instants',
    );
  }
  const syntheticRefreshMode =
    environment.SYNTHETIC_FLIGHT_REFRESH_MODE ?? 'baseline';
  if (
    syntheticRefreshMode !== 'baseline' &&
    syntheticRefreshMode !== 'delayed'
  ) {
    throw new Error(
      'SYNTHETIC_FLIGHT_REFRESH_MODE must be baseline or delayed',
    );
  }
  const syntheticFailFirst = parseBoolean(
    environment.SYNTHETIC_FLIGHT_FAIL_FIRST,
    false,
  );
  const enabled = parseBoolean(environment.FLIGHT_LIVE_API_ENABLED, false);
  const apiKey =
    environment.AERODATABOX_RAPIDAPI_KEY?.trim() ||
    environment.RAPIDAPI_KEY?.trim() ||
    null;
  const host = environment.AERODATABOX_RAPIDAPI_HOST?.trim() || DEFAULT_HOST;
  if (!/^[a-z0-9.-]+$/iu.test(host)) {
    throw new Error('AERODATABOX_RAPIDAPI_HOST must be a hostname');
  }
  return {
    provider,
    liveApiEnabled: enabled,
    apiKey,
    host,
    syntheticScheduledUtc,
    syntheticObservedAt,
    syntheticRefreshMode,
    syntheticFailFirst,
  };
}

function validAbsoluteUtc(value: string | null): boolean {
  return (
    value !== null &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(
    'Boolean flight provider configuration must be true or false',
  );
}
