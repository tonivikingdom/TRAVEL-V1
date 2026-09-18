import { randomUUID } from 'node:crypto';

import type { JobRunnerConfig } from './job-runner.js';

const SYNTHETIC_TOKEN_KEY =
  'SYNTHETIC_DEVELOPMENT_TEST_ONLY_MAGIC_LINK_TOKEN_KEY_v1';

export interface WorkerConfig {
  readonly appEnvironment: 'development' | 'test' | 'staging' | 'production';
  readonly databaseUrl: string;
  readonly heartbeatFile: string;
  readonly heartbeatIntervalMs: number;
  readonly magicLinkLandingUrl: string;
  readonly magicLinkTokenKey: string;
  readonly magicLinkTtlSeconds: number;
  readonly mailProvider: 'capture' | 'unconfigured';
  readonly mailCaptureFile: string;
  readonly runner: JobRunnerConfig;
  readonly workerId: string;
}

export function readWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const appEnvironment = parseEnvironment(environment.APP_ENV);
  const databaseUrl = required(environment.DATABASE_URL, 'DATABASE_URL');
  const tokenKey = readTokenKey(
    environment.MAGIC_LINK_TOKEN_KEY,
    appEnvironment,
  );
  const mailProvider = parseMailProvider(environment.MAIL_PROVIDER);
  if (
    mailProvider === 'capture' &&
    !['development', 'test'].includes(appEnvironment)
  ) {
    throw new Error(
      'The capture mail provider is allowed only in development or test',
    );
  }
  const runner: JobRunnerConfig = {
    leaseDurationMs: integer(
      environment.JOB_LEASE_DURATION_MS,
      30_000,
      1_000,
      3_600_000,
    ),
    pollingIntervalMs: integer(
      environment.JOB_POLL_INTERVAL_MS,
      1_000,
      50,
      60_000,
    ),
    retryBaseDelayMs: integer(
      environment.JOB_RETRY_BASE_DELAY_MS,
      1_000,
      100,
      3_600_000,
    ),
    retryMaxDelayMs: integer(
      environment.JOB_RETRY_MAX_DELAY_MS,
      300_000,
      100,
      86_400_000,
    ),
    executionTimeoutMs: integer(
      environment.JOB_EXECUTION_TIMEOUT_MS,
      15_000,
      100,
      3_600_000,
    ),
    shutdownTimeoutMs: integer(
      environment.WORKER_SHUTDOWN_TIMEOUT_MS,
      10_000,
      100,
      3_600_000,
    ),
  };
  if (runner.executionTimeoutMs >= runner.leaseDurationMs) {
    throw new Error(
      'JOB_EXECUTION_TIMEOUT_MS must be shorter than JOB_LEASE_DURATION_MS',
    );
  }
  if (runner.retryBaseDelayMs > runner.retryMaxDelayMs) {
    throw new Error(
      'JOB_RETRY_BASE_DELAY_MS must not exceed JOB_RETRY_MAX_DELAY_MS',
    );
  }

  return {
    appEnvironment,
    databaseUrl,
    heartbeatFile:
      environment.WORKER_HEARTBEAT_FILE ?? '/tmp/travel-worker-heartbeat.json',
    heartbeatIntervalMs: integer(
      environment.WORKER_HEARTBEAT_INTERVAL_MS,
      10_000,
      100,
      3_600_000,
    ),
    magicLinkLandingUrl: readLandingUrl(
      environment.AUTH_MAGIC_LINK_LANDING_URL,
      appEnvironment,
    ),
    magicLinkTokenKey: tokenKey,
    magicLinkTtlSeconds: integer(
      environment.MAGIC_LINK_TTL_SECONDS,
      900,
      60,
      86_400,
    ),
    mailProvider,
    mailCaptureFile:
      environment.MAIL_CAPTURE_FILE ??
      '/tmp/travel-mail-capture/messages.ndjson',
    runner,
    workerId: environment.WORKER_ID ?? `worker-${process.pid}-${randomUUID()}`,
  };
}

function readTokenKey(
  value: string | undefined,
  appEnvironment: WorkerConfig['appEnvironment'],
): string {
  if (value === undefined && ['development', 'test'].includes(appEnvironment)) {
    return SYNTHETIC_TOKEN_KEY;
  }
  const key = required(value, 'MAGIC_LINK_TOKEN_KEY');
  if (key.length < 32) {
    throw new Error('MAGIC_LINK_TOKEN_KEY must contain at least 32 characters');
  }
  if (
    ['staging', 'production'].includes(appEnvironment) &&
    key.toUpperCase().includes('SYNTHETIC')
  ) {
    throw new Error(
      'Staging/production MAGIC_LINK_TOKEN_KEY must not be synthetic',
    );
  }
  return key;
}

function readLandingUrl(
  value: string | undefined,
  appEnvironment: WorkerConfig['appEnvironment'],
): string {
  const raw =
    value ??
    (['development', 'test'].includes(appEnvironment)
      ? 'http://127.0.0.1:3000/login/magic'
      : undefined);
  const url = new URL(required(raw, 'AUTH_MAGIC_LINK_LANDING_URL'));
  if (url.username !== '' || url.password !== '') {
    throw new Error('AUTH_MAGIC_LINK_LANDING_URL must not contain credentials');
  }
  if (url.protocol === 'https:') {
    return url.toString();
  }
  if (
    url.protocol === 'http:' &&
    ['development', 'test'].includes(appEnvironment) &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    return url.toString();
  }
  throw new Error('AUTH_MAGIC_LINK_LANDING_URL must use secure HTTPS');
}

function parseEnvironment(
  value: string | undefined,
): WorkerConfig['appEnvironment'] {
  if (value === undefined || value === 'development') return 'development';
  if (value === 'test' || value === 'staging' || value === 'production')
    return value;
  throw new Error('APP_ENV must be development, test, staging, or production');
}

function parseMailProvider(
  value: string | undefined,
): WorkerConfig['mailProvider'] {
  if (value === 'capture') return 'capture';
  if (value === undefined || value === 'unconfigured') return 'unconfigured';
  throw new Error('MAIL_PROVIDER is not supported by this P1B1 build');
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required`);
  return value;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Worker duration must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}
