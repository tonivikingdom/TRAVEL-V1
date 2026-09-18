import type { AuthServiceConfig } from '@travel/application';

export interface AuthRuntimeConfig {
  readonly service: AuthServiceConfig;
  readonly appEnvironment: 'development' | 'test' | 'staging' | 'production';
  readonly mailProvider: 'capture' | 'unconfigured';
}

export function readAuthRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): AuthRuntimeConfig {
  const appEnvironment = parseEnvironment(environment.APP_ENV);
  const mailProvider = parseMailProvider(environment.MAIL_PROVIDER);
  if (
    mailProvider === 'capture' &&
    !['development', 'test'].includes(appEnvironment)
  ) {
    throw new Error(
      'The capture mail provider is allowed only in development or test',
    );
  }
  return {
    appEnvironment,
    mailProvider,
    service: {
      magicLinkLandingUrl: readMagicLinkLandingUrl(
        environment.AUTH_MAGIC_LINK_LANDING_URL,
        appEnvironment,
      ),
      magicLinkTtlSeconds: positiveInteger(
        environment.MAGIC_LINK_TTL_SECONDS,
        900,
      ),
      sessionTtlSeconds: positiveInteger(
        environment.SESSION_TTL_SECONDS,
        2_592_000,
      ),
      invitationTtlSeconds: positiveInteger(
        environment.INVITATION_TTL_SECONDS,
        604_800,
      ),
      rateLimitWindowSeconds: positiveInteger(
        environment.MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS,
        300,
      ),
      rateLimitMaxRequests: positiveInteger(
        environment.MAGIC_LINK_RATE_LIMIT_MAX_REQUESTS,
        5,
      ),
      defaultBaseCurrency: environment.DEFAULT_BASE_CURRENCY ?? 'CNY',
      defaultUiLanguage: environment.DEFAULT_UI_LANGUAGE ?? 'zh-CN',
      jobMaxAttempts: positiveInteger(environment.JOB_MAX_ATTEMPTS, 5),
    },
  };
}

function readMagicLinkLandingUrl(
  value: string | undefined,
  appEnvironment: AuthRuntimeConfig['appEnvironment'],
): string {
  const rawValue =
    value ??
    (appEnvironment === 'development' || appEnvironment === 'test'
      ? 'http://127.0.0.1:3000/login/magic'
      : undefined);
  if (rawValue === undefined || rawValue.trim() === '') {
    throw new Error(
      'AUTH_MAGIC_LINK_LANDING_URL is required in staging and production',
    );
  }

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error('AUTH_MAGIC_LINK_LANDING_URL must be an absolute URL');
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error('AUTH_MAGIC_LINK_LANDING_URL must not contain credentials');
  }

  if (url.protocol === 'https:') {
    return url.toString();
  }

  if (
    url.protocol === 'http:' &&
    (appEnvironment === 'development' || appEnvironment === 'test') &&
    isLoopbackHost(url.hostname)
  ) {
    return url.toString();
  }

  throw new Error(
    'AUTH_MAGIC_LINK_LANDING_URL must use HTTPS outside localhost development/test',
  );
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}

function parseEnvironment(
  value: string | undefined,
): AuthRuntimeConfig['appEnvironment'] {
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

function parseMailProvider(
  value: string | undefined,
): AuthRuntimeConfig['mailProvider'] {
  if (value === undefined || value === 'unconfigured') {
    return 'unconfigured';
  }
  if (value === 'capture') {
    return 'capture';
  }
  throw new Error('MAIL_PROVIDER is not supported by this P1A build');
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      'Authentication TTL and rate-limit values must be positive integers',
    );
  }
  return parsed;
}
