import type { RouteProviderQueryInput } from '../packages/application/src/route-ports.js';
import {
  GooglePlaceSearchProvider,
  BaiduPlaceSearchProvider,
} from '../packages/providers/src/regional-place-adapters.js';
import {
  GoogleOrdinaryRouteProvider,
  BaiduOrdinaryRouteProvider,
} from '../packages/providers/src/regional-route-adapters.js';

export const PROVIDER_KEYS = [
  'GOOGLE_SERVER_API_KEY',
  'VITE_GOOGLE_MAPS_BROWSER_KEY',
  'BAIDU_SERVER_API_KEY',
  'VITE_BAIDU_MAPS_BROWSER_KEY',
] as const;
export const PROVIDER_GATES = [
  ...['GOOGLE', 'BAIDU'].flatMap((p) =>
    [
      'LIVE_API_ENABLED',
      'ENTITLEMENT_APPROVED',
      'STORAGE_APPROVED',
      'ATTRIBUTION_APPROVED',
    ].map((g) => `${p}_${g}`),
  ),
  'BAIDU_COORDINATES_APPROVED',
  'BAIDU_FUTURE_DRIVING_APPROVED',
  ...['GOOGLE', 'BAIDU'].flatMap((p) =>
    [
      'EMBED_ENABLED',
      'ENTITLEMENT_APPROVED',
      'STORAGE_APPROVED',
      'ATTRIBUTION_APPROVED',
    ].map((g) => `VITE_${p}_MAPS_${g}`),
  ),
  'VITE_BAIDU_MAPS_COORDINATES_APPROVED',
] as const;
export const PROVIDER_HOSTS = [
  'places.googleapis.com',
  'routes.googleapis.com',
  'api.map.baidu.com',
  'maps.googleapis.com',
  '*.gstatic.com',
  '*.bdimg.com',
  '*.bdstatic.com',
] as const;
export type DoctorStatus =
  | 'SECRET_UNSET'
  | 'NETWORK_BLOCKED'
  | 'API_NOT_ENABLED'
  | 'BILLING_OR_ENTITLEMENT'
  | 'AUTH_REJECTED'
  | 'CONTRACT_MISMATCH'
  | 'PROVIDER_ERROR'
  | 'READY_FOR_LIVE_CHECK'
  | 'LIVE_CONTRACT_PASS'
  | 'NO_MATCHING_CANDIDATE'
  | 'UNSUPPORTED'
  | 'LIVE_CHECK_REQUIRES_DEV_OR_TEST';
export interface DoctorCapability {
  name: string;
  status: DoctorStatus;
  requestCount: number;
  httpStatus?: number;
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
/** Only fixed labels/codes escape this classifier; provider messages/URLs never do. */
export function classifyProviderFailure(
  provider: 'GOOGLE' | 'BAIDU',
  status: number,
  body: unknown,
  mode?: RouteProviderQueryInput['travelMode'],
): DoctorStatus | null {
  const data = object(body),
    error = object(data.error);
  if (
    provider === 'BAIDU' &&
    typeof data.status === 'number' &&
    data.status !== 0
  ) {
    if (status === 200 && mode === 'TRANSIT' && data.status === 1002)
      return 'UNSUPPORTED';
    if ([4, 9, 302, 401].includes(data.status)) return 'BILLING_OR_ENTITLEMENT';
    if ([240, 260, 261].includes(data.status)) return 'API_NOT_ENABLED';
    if ([3, 5, 101, 200, 201, 202, 203, 210, 211].includes(data.status))
      return 'AUTH_REJECTED';
    if ([7, 1001].includes(data.status)) return null;
    return 'PROVIDER_ERROR';
  }
  const reasons = Array.isArray(error.details)
    ? error.details.map((d) => object(d).reason)
    : [];
  if (
    reasons.some((r) =>
      ['SERVICE_DISABLED', 'API_NOT_ACTIVATED'].includes(String(r)),
    )
  )
    return 'API_NOT_ENABLED';
  if (
    reasons.some((r) =>
      [
        'BILLING_DISABLED',
        'BILLING_NOT_ACTIVE',
        'RATE_LIMIT_EXCEEDED',
        'QUOTA_EXCEEDED',
      ].includes(String(r)),
    ) ||
    status === 429
  )
    return 'BILLING_OR_ENTITLEMENT';
  if (
    status === 401 ||
    status === 403 ||
    reasons.some((r) =>
      [
        'API_KEY_INVALID',
        'API_KEY_SERVICE_BLOCKED',
        'API_KEY_IP_ADDRESS_BLOCKED',
      ].includes(String(r)),
    )
  )
    return 'AUTH_REJECTED';
  if (status >= 400 || data.error) return 'PROVIDER_ERROR';
  return null;
}
const present = (env: NodeJS.ProcessEnv, name: string) =>
  Boolean(env[name]?.trim());
function routeInput(
  provider: 'GOOGLE' | 'BAIDU',
  mode: RouteProviderQueryInput['travelMode'],
  now: Date,
  future: boolean,
): RouteProviderQueryInput {
  const china = provider === 'BAIDU',
    latitude = china ? 39.90725 : 35.681236,
    longitude = china ? 116.39138 : 139.767125;
  const timeZone = china ? 'Asia/Shanghai' : 'Asia/Tokyo',
    at = new Date(
      future
        ? Math.ceil((now.getTime() + 86400000) / 1000) * 1000
        : now.getTime(),
    );
  return {
    ...(mode ? { travelMode: mode } : {}),
    origin: {
      placeId: 'doctor:origin',
      name: 'Provider acceptance origin',
      latitude,
      longitude,
      timeZone,
    },
    destination: {
      placeId: 'doctor:destination',
      name: 'Provider acceptance destination',
      latitude: latitude + 0.01,
      longitude: longitude + 0.01,
      timeZone,
    },
    earliestDeparture: null,
    latestArrival: null,
    preference: future
      ? { type: 'DEPART_AT', instant: at, timeZone }
      : { type: 'NONE' },
  };
}
export async function providerDoctor(
  env: NodeJS.ProcessEnv,
  options: { live?: boolean; fetcher?: typeof fetch; now?: () => Date } = {},
) {
  const now = (options.now ?? (() => new Date()))();
  const checks: {
    name: string;
    provider: 'GOOGLE' | 'BAIDU';
    mode?: RouteProviderQueryInput['travelMode'];
    future?: boolean;
  }[] = [
    { name: 'Google Places', provider: 'GOOGLE' },
    { name: 'Google Walking', provider: 'GOOGLE', mode: 'WALKING' },
    { name: 'Google Driving', provider: 'GOOGLE', mode: 'DRIVING' },
    { name: 'Baidu Place', provider: 'BAIDU' },
    { name: 'Baidu Walking', provider: 'BAIDU', mode: 'WALKING' },
    { name: 'Baidu Driving', provider: 'BAIDU', mode: 'DRIVING' },
    { name: 'Baidu Transit', provider: 'BAIDU', mode: 'TRANSIT' },
    { name: 'Baidu Cycling', provider: 'BAIDU', mode: 'CYCLING' },
    {
      name: 'Baidu Future Driving',
      provider: 'BAIDU',
      mode: 'DRIVING',
      future: true,
    },
  ];
  const capabilities: DoctorCapability[] = [];
  for (const check of checks) {
    const entry: DoctorCapability = {
      name: check.name,
      status: 'SECRET_UNSET',
      requestCount: 0,
    };
    capabilities.push(entry);
    const key = env[`${check.provider}_SERVER_API_KEY`]?.trim();
    if (!key) continue;
    entry.status = 'READY_FOR_LIVE_CHECK';
    if (!options.live) continue;
    if (!['development', 'test'].includes(env.APP_ENV ?? 'development')) {
      entry.status = 'LIVE_CHECK_REQUIRES_DEV_OR_TEST';
      continue;
    }
    let failure: DoctorStatus | null = null;
    const fetcher: typeof fetch = async (url, init) => {
      if (entry.requestCount !== 0)
        throw new Error('Doctor request budget exceeded');
      entry.requestCount++;
      try {
        const response = await (options.fetcher ?? fetch)(url, init);
        entry.httpStatus = response.status;
        const text = await response.clone().text();
        if (
          response.status === 403 &&
          /domain forbidden|connect tunnel failed/iu.test(text)
        )
          failure = 'NETWORK_BLOCKED';
        else {
          let parsed: unknown;
          let malformed = false;
          try {
            parsed = JSON.parse(text);
          } catch {
            malformed = true;
          }
          failure ??= classifyProviderFailure(
            check.provider,
            response.status,
            parsed,
            check.mode,
          );
          if (!failure && malformed) failure = 'CONTRACT_MISMATCH';
        }
        return response;
      } catch {
        failure = 'NETWORK_BLOCKED';
        throw new Error('Provider network unavailable');
      }
    };
    const input = routeInput(
      check.provider,
      check.mode,
      now,
      check.future ?? false,
    );
    try {
      if (!check.mode) {
        const places = await (
          check.provider === 'GOOGLE'
            ? new GooglePlaceSearchProvider(key, fetcher)
            : new BaiduPlaceSearchProvider(key, fetcher)
        ).search(
          check.provider === 'GOOGLE' ? 'Tokyo Station' : '天安门',
          'zh-CN',
          input.origin,
        );
        entry.status = places.length
          ? 'LIVE_CONTRACT_PASS'
          : 'NO_MATCHING_CANDIDATE';
      } else {
        // Isolated acceptance adapter only. --live never changes production gates.
        const result = await (
          check.provider === 'GOOGLE'
            ? new GoogleOrdinaryRouteProvider(key, fetcher, () => now)
            : new BaiduOrdinaryRouteProvider(
                key,
                fetcher,
                () => now,
                Boolean(check.future),
              )
        ).queryRoutes(input);
        entry.status =
          result.status === 'SUCCESS'
            ? 'LIVE_CONTRACT_PASS'
            : result.status === 'NO_MATCHING_CANDIDATE'
              ? 'NO_MATCHING_CANDIDATE'
              : result.status === 'UNSUPPORTED_QUERY'
                ? 'UNSUPPORTED'
                : 'CONTRACT_MISMATCH';
      }
    } catch {
      entry.status = 'CONTRACT_MISMATCH';
    }
    if (failure) entry.status = failure;
  }
  return {
    mode: options.live ? 'LIVE' : 'CONFIG_ONLY',
    keys: Object.fromEntries(
      PROVIDER_KEYS.map((name) => [name, present(env, name) ? 'SET' : 'UNSET']),
    ),
    gates: Object.fromEntries(
      PROVIDER_GATES.map((name) => [
        name,
        env[name] === 'true'
          ? 'TRUE'
          : env[name] === undefined || env[name] === '' || env[name] === 'false'
            ? 'FALSE'
            : 'INVALID',
      ]),
    ),
    requiredHosts: PROVIDER_HOSTS,
    network: 'REQUIRED_HOSTS_ONLY_NOT_PROBED',
    browser: {
      google: present(env, 'VITE_GOOGLE_MAPS_BROWSER_KEY')
        ? 'WIRED_BROWSER_ACCEPTANCE_REQUIRED'
        : 'SECRET_UNSET',
      baidu: present(env, 'VITE_BAIDU_MAPS_BROWSER_KEY')
        ? 'WIRED_BROWSER_ACCEPTANCE_REQUIRED'
        : 'SECRET_UNSET',
      baiduCoordinates: 'WIRED_OFFICIAL_JSAPI4_WGS84_TO_BD09',
      browserRequests: 0,
    },
    capabilities,
    requestCount: capabilities.reduce((sum, c) => sum + c.requestCount, 0),
    notes: [
      'Request count counts dispatched fetch attempts; blocked requests may never reach Provider.',
      'No retry. No browser SDK load. No approvals changed. Contract PASS does not prove billing, entitlement, retention, attribution or production approval.',
      'Baidu future driving uses a specified departure 24 hours ahead; advanced account entitlement requires separate review.',
      'Baidu TRANSIT is same-city aggregate duration; cross-city and ARRIVE_BY are unsupported. BD09 inverse is approximate/non-authoritative.',
    ],
  };
}
