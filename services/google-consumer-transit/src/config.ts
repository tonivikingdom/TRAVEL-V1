import type { TimeMode } from './contract.js';
export interface Config {
  enabled: boolean;
  token: string;
  port: number;
  timeoutMs: number;
  executablePath: string;
  headless: boolean;
  supportedModes: readonly TimeMode[];
}
function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error('Invalid Google Transit numeric configuration');
  return number;
}
function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Invalid Google Transit boolean configuration');
}
export function readConfig(env: NodeJS.ProcessEnv): Config {
  if (!['development', 'test'].includes(env.APP_ENV ?? 'development'))
    throw new Error('Google Transit service requires development or test');
  if ((env.GOOGLE_TRANSIT_HOST ?? '127.0.0.1') !== '127.0.0.1')
    throw new Error('Google Transit must bind 127.0.0.1');
  if ((env.MAX_CONCURRENT_SEARCHES ?? '1') !== '1')
    throw new Error('Google Transit concurrency must be 1');
  const enabled = boolean(env.ENABLE_GOOGLE_CONSUMER_TRANSIT, false);
  const token = env.LOCAL_TRANSIT_API_TOKEN?.trim() ?? '';
  if (token.length < 32)
    throw new Error(
      'A dedicated local bearer token of at least 32 characters is required',
    );
  return {
    enabled,
    token,
    port: integer(env.GOOGLE_TRANSIT_PORT, 8787, 1024, 65535),
    timeoutMs: integer(env.GOOGLE_TRANSIT_TIMEOUT_MS, 45000, 1000, 120000),
    executablePath: env.GOOGLE_TRANSIT_EXECUTABLE_PATH ?? '/usr/bin/chromium',
    headless: boolean(env.GOOGLE_TRANSIT_HEADLESS, true),
    supportedModes: ['DEPART_AT', 'ARRIVE_BY'],
  };
}
