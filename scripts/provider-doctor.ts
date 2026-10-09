import type { RouteProviderQueryInput } from '../packages/application/src/route-ports.js';
import {
  validateRouteCandidate,
  validateExternalRouteCandidateEndpoints,
} from '../packages/domain/src/index.js';
import {
  GooglePlaceSearchProvider,
  BaiduPlaceSearchProvider,
} from '../packages/providers/src/regional-place-adapters.js';
import {
  GoogleOrdinaryRouteProvider,
  BaiduOrdinaryRouteProvider,
} from '../packages/providers/src/regional-route-adapters.js';
import {
  safeDiagnostic,
  type ProviderDiagnostic,
} from '../packages/providers/src/contract-diagnostics.js';
import {
  providerResponseEvidence,
  safeResponseEvidence,
  type ProviderResponseEvidence,
} from './provider-response-diagnostics.js';

export const CAPABILITY_IDS = [
  'google-places',
  'google-walking',
  'google-driving',
  'baidu-place',
  'baidu-walking',
  'baidu-driving',
  'baidu-transit',
  'baidu-cycling',
  'baidu-future-driving',
] as const;
export type ProviderCapabilityId = (typeof CAPABILITY_IDS)[number];

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
export type BaiduBusinessDiagnosis =
  | 'API_NOT_ENABLED'
  | 'KEY_PERMISSION_REQUIRED'
  | 'ADVANCED_PERMISSION_REQUIRED'
  | 'INVALID_REQUEST_OR_VERSION'
  | 'SERVICE_RETIRED'
  | 'AUTH_REJECTED'
  | 'QUOTA_LIMIT'
  | 'NO_ROUTE'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN_BUSINESS_STATUS'
  | 'SUCCESS';
export function baiduBusinessDiagnosis(code: unknown): BaiduBusinessDiagnosis {
  if (code === 0) return 'SUCCESS';
  if (code === 240) return 'API_NOT_ENABLED';
  if (code === 3) return 'KEY_PERMISSION_REQUIRED';
  if (code === 9) return 'ADVANCED_PERMISSION_REQUIRED';
  if ([2, 8, 260].includes(code as number)) return 'INVALID_REQUEST_OR_VERSION';
  if (code === 261) return 'SERVICE_RETIRED';
  if (
    [5, 101, 200, 201, 202, 203, 210, 211, 250, 251, 252].includes(
      code as number,
    )
  )
    return 'AUTH_REJECTED';
  if ([4, 302, 401].includes(code as number)) return 'QUOTA_LIMIT';
  if ([7, 1001].includes(code as number)) return 'NO_ROUTE';
  if ([1, 1002, 1003].includes(code as number)) return 'PROVIDER_ERROR';
  return 'UNKNOWN_BUSINESS_STATUS';
}
const BAIDU_PUBLIC_CODES = [
  0, 1, 2, 3, 4, 5, 7, 8, 9, 101, 200, 201, 202, 203, 210, 211, 240, 250, 251,
  252, 260, 261, 302, 401, 1001, 1002, 1003,
];
export interface DoctorCapability {
  name: string;
  status: DoctorStatus;
  requestCount: number;
  httpStatus?: number;
  diagnostics: ProviderDiagnostic[];
  responseEvidence?: ProviderResponseEvidence;
  businessStatus?: number;
  businessDiagnosis?: BaiduBusinessDiagnosis;
  commercialAuthorization?: 'REVIEW_REQUIRED' | 'NOT_INDICATED' | 'UNKNOWN';
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
    status === 200 &&
    typeof data.status === 'number' &&
    data.status !== 0
  ) {
    if (status === 200 && mode === 'TRANSIT' && data.status === 1002)
      return 'UNSUPPORTED';
    if ([4, 9, 302, 401].includes(data.status)) return 'BILLING_OR_ENTITLEMENT';
    if (data.status === 240) return 'API_NOT_ENABLED';
    if ([2, 8, 260, 261].includes(data.status)) return 'PROVIDER_ERROR';
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
      latitude: Number((latitude + 0.01).toFixed(6)),
      longitude: Number((longitude + 0.01).toFixed(6)),
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
  options: {
    live?: boolean;
    fetcher?: typeof fetch;
    now?: () => Date;
    only?: readonly ProviderCapabilityId[];
  } = {},
) {
  const clock = options.now ?? (() => new Date());
  if (
    options.only &&
    (options.only.length === 0 ||
      new Set(options.only).size !== options.only.length ||
      options.only.some((id) => !CAPABILITY_IDS.includes(id)))
  )
    throw new Error('INVALID_CAPABILITY_SELECTION');
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
  for (const [index, check] of checks.entries()) {
    if (options.only && !options.only.includes(CAPABILITY_IDS[index]!))
      continue;
    const entry: DoctorCapability = {
      name: check.name,
      status: 'SECRET_UNSET',
      requestCount: 0,
      diagnostics: [],
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
    const diagnostics = (d: ProviderDiagnostic) => {
      const safe = safeDiagnostic(d);
      if (safe) entry.diagnostics.push(safe);
    };
    const fetcher: typeof fetch = async (url, init) => {
      if (entry.requestCount !== 0)
        throw new Error('Doctor request budget exceeded');
      entry.requestCount++;
      try {
        const response = await (options.fetcher ?? fetch)(url, init);
        entry.httpStatus = response.status;
        diagnostics({
          stage: 'HTTP_STATUS',
          field: 'response',
          code: response.ok ? 'PASSED' : 'REQUEST_REJECTED',
        });
        const text = await response.clone().text();
        const evidence = safeResponseEvidence(
          providerResponseEvidence(
            check.provider,
            url instanceof Request ? url.url : String(url),
            response,
            text,
          ),
        );
        if (evidence) entry.responseEvidence = evidence;
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
          if (check.provider === 'BAIDU' && !malformed) {
            const code = object(parsed).status;
            if (typeof code === 'number' && BAIDU_PUBLIC_CODES.includes(code))
              entry.businessStatus = code;
            entry.businessDiagnosis = baiduBusinessDiagnosis(code);
            entry.commercialAuthorization =
              entry.businessDiagnosis === 'ADVANCED_PERMISSION_REQUIRED'
                ? 'REVIEW_REQUIRED'
                : [
                      'KEY_PERMISSION_REQUIRED',
                      'UNKNOWN_BUSINESS_STATUS',
                    ].includes(entry.businessDiagnosis)
                  ? 'UNKNOWN'
                  : 'NOT_INDICATED';
            const codeLabel = {
              SUCCESS: 'PASSED',
              API_NOT_ENABLED: 'API_NOT_ENABLED',
              KEY_PERMISSION_REQUIRED: 'KEY_PERMISSION_REQUIRED',
              ADVANCED_PERMISSION_REQUIRED: 'ADVANCED_PERMISSION_REQUIRED',
              INVALID_REQUEST_OR_VERSION: 'INVALID_REQUEST_OR_VERSION',
              AUTH_REJECTED: 'AUTH_REJECTED',
              NO_ROUTE: 'NO_ROUTE',
            } as const;
            diagnostics({
              stage: 'PROVIDER_BUSINESS_STATUS',
              field: 'response.status',
              code:
                codeLabel[entry.businessDiagnosis as keyof typeof codeLabel] ??
                'UNKNOWN_BUSINESS_STATUS',
            });
          }
          diagnostics({
            stage: 'RESPONSE_SHAPE',
            field: 'response',
            code: malformed ? 'INVALID_SHAPE' : 'PASSED',
          });
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
        diagnostics({
          stage: 'HTTP_STATUS',
          field: 'response',
          code: 'NETWORK_BLOCKED',
        });
        throw new Error('Provider network unavailable');
      }
    };
    const requestStarted = clock();
    const input = routeInput(
      check.provider,
      check.mode,
      requestStarted,
      check.future ?? false,
    );
    try {
      if (!check.mode) {
        const places = await (
          check.provider === 'GOOGLE'
            ? new GooglePlaceSearchProvider(key, fetcher, diagnostics)
            : new BaiduPlaceSearchProvider(key, fetcher, diagnostics)
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
            ? new GoogleOrdinaryRouteProvider(key, fetcher, clock, diagnostics)
            : new BaiduOrdinaryRouteProvider(
                key,
                fetcher,
                clock,
                Boolean(check.future),
                diagnostics,
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
        if (result.status === 'SUCCESS') {
          const accepted = result.candidates.every(
            (c) =>
              validateRouteCandidate(c, {
                earliestDeparture: input.earliestDeparture ?? requestStarted,
                latestArrival: input.latestArrival,
              }).accepted &&
              validateExternalRouteCandidateEndpoints(
                c,
                { ...input.origin, providerPlaceRef: null },
                { ...input.destination, providerPlaceRef: null },
              ),
          );
          diagnostics({
            stage: 'DOMAIN_VALIDATION',
            field: 'candidate',
            code: accepted ? 'PASSED' : 'DOMAIN_VALIDATION_FAILED',
          });
          if (!accepted) entry.status = 'CONTRACT_MISMATCH';
        }
      }
    } catch {
      entry.status = 'CONTRACT_MISMATCH';
    }
    if (failure) entry.status = failure;
  }
  return {
    mode: options.live ? 'LIVE' : 'CONFIG_ONLY',
    productionAuthorization: 'NOT_REVIEWED',
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
