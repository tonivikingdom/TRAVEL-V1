import type { RouteProvider } from '@travel/application';
import {
  RegionalPlaceSearchProvider,
  RegionalRouteProvider,
  type RegionalProviderSlots,
} from './regional-router.js';
import {
  GooglePlaceSearchProvider,
  BaiduPlaceSearchProvider,
} from './regional-place-adapters.js';
import {
  GoogleOrdinaryRouteProvider,
  BaiduOrdinaryRouteProvider,
} from './regional-route-adapters.js';
/** No secret is serialized or logged. A provider's missing gate never disables another region. */
export function createRegionalProviders(
  env: NodeJS.ProcessEnv,
  options: { japanTransit?: RouteProvider; fetcher?: typeof fetch } = {},
) {
  if (
    !['development', 'test', 'staging', 'production'].includes(
      env.APP_ENV ?? 'development',
    )
  )
    throw new Error('Invalid APP_ENV');
  const slots: RegionalProviderSlots = {
    ...(options.japanTransit ? { japanTransit: options.japanTransit } : {}),
  };
  const key = (provider: 'BAIDU' | 'GOOGLE') =>
    env[`${provider}_LIVE_API_ENABLED`] === 'true' &&
    env[`${provider}_ENTITLEMENT_APPROVED`] === 'true' &&
    env[`${provider}_STORAGE_APPROVED`] === 'true' &&
    env[`${provider}_ATTRIBUTION_APPROVED`] === 'true'
      ? env[`${provider}_SERVER_API_KEY`]?.trim()
      : undefined;
  const baidu = key('BAIDU'),
    google = key('GOOGLE'),
    fetcher = options.fetcher ?? fetch;
  const configured: RegionalProviderSlots = {
    ...slots,
    ...(baidu && env.BAIDU_COORDINATES_APPROVED === 'true'
      ? { baiduPlace: new BaiduPlaceSearchProvider(baidu, fetcher) }
      : {}),
    ...(baidu && env.BAIDU_COORDINATES_APPROVED === 'true'
      ? { baiduRoute: new BaiduOrdinaryRouteProvider(baidu, fetcher) }
      : {}),
    ...(google
      ? {
          googlePlace: new GooglePlaceSearchProvider(google, fetcher),
          googleRoute: new GoogleOrdinaryRouteProvider(google, fetcher),
        }
      : {}),
  };
  return {
    routes: new RegionalRouteProvider(configured),
    places: new RegionalPlaceSearchProvider(configured),
  };
}
