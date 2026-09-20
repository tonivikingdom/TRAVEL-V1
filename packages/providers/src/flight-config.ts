export interface FlightProviderRuntimeConfig {
  readonly provider: 'aerodatabox' | 'unconfigured';
  readonly liveApiEnabled: boolean;
  readonly apiKey: string | null;
  readonly host: string;
}

const DEFAULT_HOST = 'aerodatabox.p.rapidapi.com';

export function readFlightProviderConfig(
  environment: NodeJS.ProcessEnv,
): FlightProviderRuntimeConfig {
  const provider = environment.FLIGHT_PROVIDER?.trim() || 'unconfigured';
  if (provider !== 'aerodatabox' && provider !== 'unconfigured') {
    throw new Error('FLIGHT_PROVIDER must be aerodatabox or unconfigured');
  }
  const enabled = parseBoolean(environment.FLIGHT_LIVE_API_ENABLED, false);
  const apiKey =
    environment.AERODATABOX_RAPIDAPI_KEY?.trim() ||
    environment.RAPIDAPI_KEY?.trim() ||
    null;
  const host = environment.AERODATABOX_RAPIDAPI_HOST?.trim() || DEFAULT_HOST;
  if (!/^[a-z0-9.-]+$/iu.test(host)) {
    throw new Error('AERODATABOX_RAPIDAPI_HOST must be a hostname');
  }
  return { provider, liveApiEnabled: enabled, apiKey, host };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('FLIGHT_LIVE_API_ENABLED must be true or false');
}
