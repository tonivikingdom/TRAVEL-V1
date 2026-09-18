import type { AuthServiceConfig, MailSender } from '@travel/application';
import {
  CapturedMailSender,
  UnconfiguredMailSender,
} from '@travel/application';

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
      publicBaseUrl:
        environment.AUTH_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000',
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
    },
  };
}

export function createMailSender(config: AuthRuntimeConfig): MailSender {
  return config.mailProvider === 'capture'
    ? new CapturedMailSender()
    : new UnconfiguredMailSender();
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
