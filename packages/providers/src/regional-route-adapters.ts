import { randomUUID } from 'node:crypto';
import type {
  RouteProvider,
  RouteProviderQueryInput,
  RouteProviderResult,
} from '@travel/application';
import type { NormalizedRouteCandidate } from '@travel/domain';
import { endpointWithinBinding } from './route-endpoint-binding.js';
import { json, record, coordinate } from './regional-http.js';
import { baiduToWgs84 } from './baidu-coordinates.js';
function knownZones(input: RouteProviderQueryInput): boolean {
  try {
    if (!input.origin.timeZone || !input.destination.timeZone) return false;
    for (const timeZone of [input.origin.timeZone, input.destination.timeZone])
      new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}
function bindEndpoints(
  input: RouteProviderQueryInput,
  from: unknown,
  to: unknown,
  baidu = false,
) {
  const normalize = (p: unknown) => {
    const c = coordinate(p);
    return baidu ? baiduToWgs84(c.latitude, c.longitude) : c;
  };
  const a = normalize(from),
    b = normalize(to);
  if (
    !endpointWithinBinding(input.origin, a, baidu ? 'BAIDU' : 'GOOGLE') ||
    !endpointWithinBinding(input.destination, b, baidu ? 'BAIDU' : 'GOOGLE')
  )
    throw new Error('INVALID_PROVIDER_ENDPOINTS');
}
function departure(input: RouteProviderQueryInput, now: Date): Date | null {
  if (input.preference.type === 'ARRIVE_BY') return null;
  const at =
    input.preference.type === 'DEPART_AT'
      ? input.preference.instant
      : (input.earliestDeparture ?? now);
  return new Date(
    Math.max(
      at.getTime(),
      input.earliestDeparture?.getTime() ?? -Infinity,
      now.getTime(),
    ),
  );
}
function candidate(
  provider: string,
  input: RouteProviderQueryInput,
  at: Date,
  seconds: number,
  observedAt: Date,
  ref: string | null,
): NormalizedRouteCandidate {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > 604800 ||
    !input.origin.timeZone ||
    !input.destination.timeZone
  )
    throw new Error('INVALID_PROVIDER_RESPONSE');
  for (const tz of [input.origin.timeZone, input.destination.timeZone])
    new Intl.DateTimeFormat('en', { timeZone: tz }).format(observedAt);
  const start = { instant: at, timeZone: input.origin.timeZone },
    end = {
      instant: new Date(at.getTime() + seconds * 1000),
      timeZone: input.destination.timeZone,
    };
  // Ordinary non-fixed-service planned times derived from Provider duration.
  // These are never vehicle ACTUAL or a booked/scheduled service.
  const location = (p: RouteProviderQueryInput['origin']) => ({
    name: p.name,
    latitude: p.latitude,
    longitude: p.longitude,
    providerPlaceRef: null,
  });
  return {
    candidateId: randomUUID(),
    provider,
    providerCandidateRef: ref,
    observedAt,
    validUntil: null,
    departure: start,
    arrival: end,
    durationSeconds: seconds,
    legs: [
      {
        mode: input.travelMode === 'DRIVING' ? 'DRIVING' : 'WALKING',
        from: location(input.origin),
        to: location(input.destination),
        departure: start,
        arrival: end,
        durationSeconds: seconds,
        fixedService: false,
        serviceLabel: null,
        providerRef: ref,
      },
    ],
    fare: null,
  };
}
export class GoogleOrdinaryRouteProvider implements RouteProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async queryRoutes(
    input: RouteProviderQueryInput,
  ): Promise<RouteProviderResult> {
    const observedAt = this.now(),
      at = departure(input, observedAt);
    if (
      !at ||
      !knownZones(input) ||
      !['WALKING', 'DRIVING'].includes(input.travelMode ?? '')
    )
      return { status: 'UNSUPPORTED_QUERY' };
    try {
      const waypoint = (p: RouteProviderQueryInput['origin']) => ({
        location: { latLng: { latitude: p.latitude, longitude: p.longitude } },
      });
      const body = await json(
        this.fetcher,
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': this.key,
            'X-Goog-FieldMask':
              'routes.duration,routes.legs.startLocation,routes.legs.endLocation',
          },
          body: JSON.stringify({
            origin: waypoint(input.origin),
            destination: waypoint(input.destination),
            travelMode: input.travelMode === 'DRIVING' ? 'DRIVE' : 'WALK',
            ...(input.travelMode === 'DRIVING'
              ? {
                  departureTime: at.toISOString(),
                  routingPreference: 'TRAFFIC_AWARE',
                }
              : {}),
            computeAlternativeRoutes: false,
          }),
        },
      );
      if (body.error) throw new Error('UPSTREAM_UNAVAILABLE');
      if (
        body.routes === undefined ||
        (Array.isArray(body.routes) && body.routes.length === 0)
      )
        return { status: 'NO_MATCHING_CANDIDATE' };
      if (!Array.isArray(body.routes) || body.routes.length > 5)
        throw new Error('INVALID_PROVIDER_RESPONSE');
      const candidates = body.routes.map((raw) => {
        const r = record(raw);
        if (!Array.isArray(r.legs) || r.legs.length !== 1)
          throw new Error('INVALID_PROVIDER_RESPONSE');
        const leg = record(r.legs[0]);
        bindEndpoints(
          input,
          record(leg.startLocation).latLng,
          record(leg.endLocation).latLng,
        );
        if (
          typeof r.duration !== 'string' ||
          !/^\d+(\.\d{1,9})?s$/.test(r.duration)
        )
          throw new Error('INVALID_PROVIDER_RESPONSE');
        return candidate(
          'google',
          input,
          at,
          Math.ceil(Number(r.duration.slice(0, -1))),
          observedAt,
          null,
        );
      });
      return { status: 'SUCCESS', candidates };
    } catch {
      return { status: 'PROVIDER_UNAVAILABLE', reason: 'UPSTREAM_UNAVAILABLE' };
    }
  }
}
export class BaiduOrdinaryRouteProvider implements RouteProvider {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async queryRoutes(
    input: RouteProviderQueryInput,
  ): Promise<RouteProviderResult> {
    const observedAt = this.now(),
      at = departure(input, observedAt);
    if (
      !at ||
      !knownZones(input) ||
      !['WALKING', 'DRIVING'].includes(input.travelMode ?? '')
    )
      return { status: 'UNSUPPORTED_QUERY' };
    // Direction Lite has no verified future-driving/arrive-by contract.
    if (
      input.travelMode === 'DRIVING' &&
      at.getTime() > observedAt.getTime() + 30000
    )
      return { status: 'UNSUPPORTED_QUERY' };
    try {
      const url = new URL(
        `https://api.map.baidu.com/directionlite/v1/${input.travelMode === 'DRIVING' ? 'driving' : 'walking'}`,
      );
      url.search = new URLSearchParams({
        origin: `${input.origin.latitude},${input.origin.longitude}`,
        destination: `${input.destination.latitude},${input.destination.longitude}`,
        coord_type: 'wgs84',
        ak: this.key,
      }).toString();
      const body = await json(this.fetcher, url),
        result = record(body.result);
      if (
        body.status !== 0 ||
        !Array.isArray(result.routes) ||
        result.routes.length > 5
      )
        throw new Error('INVALID_PROVIDER_RESPONSE');
      if (result.routes.length === 0)
        return { status: 'NO_MATCHING_CANDIDATE' };
      bindEndpoints(input, result.origin, result.destination, true);
      return {
        status: 'SUCCESS',
        candidates: result.routes.map((raw) =>
          candidate(
            'baidu',
            input,
            at,
            Number(record(raw).duration),
            observedAt,
            null,
          ),
        ),
      };
    } catch {
      return { status: 'PROVIDER_UNAVAILABLE', reason: 'UPSTREAM_UNAVAILABLE' };
    }
  }
}
