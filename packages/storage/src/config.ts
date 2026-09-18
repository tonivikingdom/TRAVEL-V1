import { join } from 'node:path';
import { tmpdir } from 'node:os';

export type StorageAppEnvironment =
  'development' | 'test' | 'staging' | 'production';

export interface EnabledLocalStorageConfig {
  readonly enabled: true;
  readonly provider: 'local-filesystem';
  readonly root: string;
  readonly maxFileBytes: number;
  readonly maxUserTotalBytes: number;
  readonly allowedMediaTypes: ReadonlySet<string>;
}

export interface UnconfiguredStorageConfig {
  readonly enabled: false;
  readonly provider: 'unconfigured';
  readonly reason: 'OBJECT_STORAGE_PROVIDER_UNCONFIGURED';
}

export type ObjectStorageRuntimeConfig =
  EnabledLocalStorageConfig | UnconfiguredStorageConfig;

const SYNTHETIC_MAX_FILE_BYTES = 10 * 1024 * 1024;
const SYNTHETIC_MAX_USER_TOTAL_BYTES = 100 * 1024 * 1024;
const SYNTHETIC_ALLOWED_MEDIA_TYPES =
  'application/pdf,image/jpeg,image/png,text/plain';

export function readObjectStorageConfig(
  environment: NodeJS.ProcessEnv,
): ObjectStorageRuntimeConfig {
  const appEnvironment = parseEnvironment(environment.APP_ENV);
  if (appEnvironment === 'staging' || appEnvironment === 'production') {
    return {
      enabled: false,
      provider: 'unconfigured',
      reason: 'OBJECT_STORAGE_PROVIDER_UNCONFIGURED',
    };
  }

  const root =
    nonEmpty(environment.OBJECT_STORAGE_ROOT) ??
    join(tmpdir(), `travel-v1-${appEnvironment}-synthetic-objects`);
  return {
    enabled: true,
    provider: 'local-filesystem',
    root,
    maxFileBytes: positiveInteger(
      environment.OBJECT_MAX_FILE_BYTES,
      SYNTHETIC_MAX_FILE_BYTES,
    ),
    maxUserTotalBytes: positiveInteger(
      environment.OBJECT_MAX_USER_TOTAL_BYTES,
      SYNTHETIC_MAX_USER_TOTAL_BYTES,
    ),
    allowedMediaTypes: parseMediaTypes(
      environment.OBJECT_ALLOWED_MEDIA_TYPES ?? SYNTHETIC_ALLOWED_MEDIA_TYPES,
    ),
  };
}

function parseEnvironment(value: string | undefined): StorageAppEnvironment {
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

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error('Object storage limits must be positive integers');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Object storage limits must be safe positive integers');
  }
  return parsed;
}

function parseMediaTypes(value: string): ReadonlySet<string> {
  const values = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  if (
    values.length === 0 ||
    values.some(
      (entry) =>
        !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
          entry,
        ),
    )
  ) {
    throw new Error('OBJECT_ALLOWED_MEDIA_TYPES must be a MIME allowlist');
  }
  return new Set(values);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
