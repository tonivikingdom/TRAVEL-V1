import {
  GoogleOrdinaryRouteProvider,
  BaiduOrdinaryRouteProvider,
} from '../../packages/providers/src/regional-route-adapters.js';
import {
  GooglePlaceSearchProvider,
  BaiduPlaceSearchProvider,
} from '../../packages/providers/src/regional-place-adapters.js';
import type { RouteProviderQueryInput } from '../../packages/application/src/index.js';
import { configuration } from './config.js';
export type Failure =
  | 'SECRET_UNSET'
  | 'NETWORK_BLOCKED'
  | 'API_NOT_ENABLED'
  | 'BILLING_OR_ENTITLEMENT'
  | 'AUTH_REJECTED'
  | 'CONTRACT_MISMATCH'
  | 'PROVIDER_ERROR';
/** Never expose upstream text: it may echo credentials or a keyed URL. */
export function classify(status: number, body: unknown): Failure | null {
  const r =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const e =
    r.error && typeof r.error === 'object'
      ? (r.error as Record<string, unknown>)
      : {};
  const details = JSON.stringify(e.details ?? []);
  if (/SERVICE_DISABLED/.test(details) || r.status === 101)
    return 'API_NOT_ENABLED';
  if (
    /BILLING_DISABLED|BILLING_NOT_ACTIVE|QUOTA_EXCEEDED/.test(details) ||
    status === 429 ||
    r.status === 4
  )
    return 'BILLING_OR_ENTITLEMENT';
  if (
    status === 401 ||
    status === 403 ||
    [2, 3, 5, 102, 200, 201, 202, 203, 210, 211, 220, 240].includes(
      Number(r.status),
    )
  )
    return 'AUTH_REJECTED';
  if (
    status < 200 ||
    status >= 300 ||
    r.error ||
    (r.status !== undefined && r.status !== 0)
  )
    return 'PROVIDER_ERROR';
  return null;
}
export async function doctor(
  env: NodeJS.ProcessEnv,
  live = false,
  fetcher: typeof fetch = fetch,
  now = new Date(),
) {
  const lines = configuration(env);
  let count = 0;
  for (const provider of ['GOOGLE', 'BAIDU'] as const) {
    for (const capability of ['Places', 'WALKING', 'DRIVING'] as const) {
      const label = `${provider} ${capability}`;
      const key = env[`${provider}_SERVER_API_KEY`]?.trim();
      if (!key) {
        lines.push(`${label}: SECRET_UNSET`);
        continue;
      }
      if (!live) {
        lines.push(`${label}: READY_FOR_LIVE_CHECK`);
        continue;
      }
      let calls = 0;
      let failure: Failure | null = null;
      const bounded: typeof fetch = async (url, init) => {
        if (calls++) throw new Error('REQUEST_LIMIT');
        count++;
        try {
          const response = await fetcher(url, init);
          const text = await response.text();
          if (text.length > 2_000_000) {
            failure = 'CONTRACT_MISMATCH';
            throw new Error('RESPONSE_LIMIT');
          }
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            failure = response.ok
              ? 'CONTRACT_MISMATCH'
              : response.status === 403
                ? 'NETWORK_BLOCKED'
                : 'PROVIDER_ERROR';
            throw new Error('INVALID_JSON');
          }
          failure = classify(response.status, body);
          return new Response(text, { status: response.status });
        } catch {
          failure ??= 'NETWORK_BLOCKED';
          throw new Error('SANITIZED_PROVIDER_FAILURE');
        }
      };
      const google = provider === 'GOOGLE';
      const from = google
        ? { latitude: 35.681236, longitude: 139.767125 }
        : { latitude: 39.9042, longitude: 116.4074 };
      const zone = google ? 'Asia/Tokyo' : 'Asia/Shanghai';
      try {
        if (capability === 'Places') {
          const adapter = google
            ? new GooglePlaceSearchProvider(key, bounded)
            : new BaiduPlaceSearchProvider(key, bounded);
          const results = await adapter.search(
            google ? 'Tokyo Station' : '北京站',
            'zh',
            from,
          );
          lines.push(
            `${label}: ${failure ?? (results.length ? 'LIVE_CHECK_PASS' : 'CONTRACT_MISMATCH')}`,
          );
        } else {
          const input: RouteProviderQueryInput = {
            origin: {
              ...from,
              placeId: 'doctor-origin',
              name: 'Doctor origin',
              timeZone: zone,
            },
            destination: {
              ...from,
              longitude: from.longitude + 0.01,
              placeId: 'doctor-destination',
              name: 'Doctor destination',
              timeZone: zone,
            },
            earliestDeparture: now,
            latestArrival: null,
            travelMode: capability,
            preference: { type: 'DEPART_AT', instant: now, timeZone: zone },
          };
          const adapter = google
            ? new GoogleOrdinaryRouteProvider(key, bounded, () => now)
            : new BaiduOrdinaryRouteProvider(key, bounded, () => now);
          const result = await adapter.queryRoutes(input);
          lines.push(
            `${label}: ${failure ?? (result.status === 'SUCCESS' ? 'LIVE_CHECK_PASS' : 'CONTRACT_MISMATCH')}`,
          );
        }
      } catch {
        lines.push(`${label}: ${failure ?? 'CONTRACT_MISMATCH'}`);
      }
    }
  }
  lines.push(
    `Provider request count: ${count}`,
    'Production approvals unchanged; live success is not production approval.',
  );
  return { lines, count };
}
