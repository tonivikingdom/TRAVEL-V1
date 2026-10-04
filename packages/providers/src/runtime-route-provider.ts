import type { RouteProvider } from '@travel/application';
import { readRouteProviderConfig } from './config.js';
import { GoogleConsumerExperimentalRouteProvider } from './google-consumer-transit-route-provider.js';
import { createRegionalProviders } from './regional-config.js';
import { RegionalRouteProvider } from './regional-router.js';
import {
  createDevelopmentSyntheticRouteProvider,
  createDevelopmentSyntheticGroundTransitRouteProvider,
} from './synthetic-route-provider.js';

/** Composition only: Region Policy and ordinary Place/Route slots stay owned by A. */
export function createRuntimeRouteProvider(
  env: NodeJS.ProcessEnv,
  options: { fetcher?: typeof fetch } = {},
): RouteProvider {
  const legacy = env.ROUTE_PROVIDER?.trim() === 'google_consumer_experimental';
  const config = readRouteProviderConfig({
    ...env,
    ROUTE_PROVIDER: legacy ? 'regional' : (env.ROUTE_PROVIDER ?? 'regional'),
  });
  if (config.provider === 'synthetic') {
    if (env.SYNTHETIC_GROUND_TRANSIT_ROUTE !== 'true')
      return createDevelopmentSyntheticRouteProvider();
    if (
      !['development', 'test'].includes(env.APP_ENV ?? '') ||
      env.SYNTHETIC_CI_ONLY !== 'true'
    )
      throw new Error(
        'Synthetic ground transit route requires Dev/Test and SYNTHETIC_CI_ONLY=true',
      );
    return createDevelopmentSyntheticGroundTransitRouteProvider();
  }
  if (config.provider === 'unconfigured') return new RegionalRouteProvider({});
  const enabled = env.GOOGLE_CONSUMER_TRANSIT_ENABLED;
  if (enabled !== undefined && !['true', 'false'].includes(enabled))
    throw new Error('GOOGLE_CONSUMER_TRANSIT_ENABLED must be true or false');
  let japanTransit: RouteProvider | undefined;
  if (legacy || enabled === 'true') {
    if (!['development', 'test'].includes(env.APP_ENV ?? 'development'))
      throw new Error(
        'Japan Consumer Transit is allowed only in development or test',
      );
    // Missing credentials disable only this slot; they cannot disable the Trip
    // backend or cause an ordinary/synthetic/no-routes fallback.
    if (env.GOOGLE_CONSUMER_TRANSIT_TOKEN?.trim()) {
      const slot = readRouteProviderConfig({
        ...env,
        ROUTE_PROVIDER: 'google_consumer_experimental',
      });
      if (slot.provider !== 'google_consumer_experimental')
        throw new Error('Invalid Japan Transit configuration');
      japanTransit = new GoogleConsumerExperimentalRouteProvider({
        baseUrl: slot.baseUrl,
        token: slot.token,
        timeoutMs: slot.timeoutMs,
        ...(options.fetcher ? { fetchImplementation: options.fetcher } : {}),
      });
    }
  }
  return createRegionalProviders(env, {
    ...(japanTransit ? { japanTransit } : {}),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  }).routes;
}
