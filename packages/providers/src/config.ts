export type RouteProviderEnvironment =
  'development' | 'test' | 'staging' | 'production';

export type RouteProviderRuntimeConfig =
  | { readonly provider: 'synthetic'; readonly synthetic: true }
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
  throw new Error('ROUTE_PROVIDER must be synthetic or unconfigured');
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
