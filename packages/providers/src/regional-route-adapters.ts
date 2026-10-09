import { randomUUID } from 'node:crypto';
import type {
  RouteProvider,
  RouteProviderQueryInput,
  RouteProviderResult,
} from '@travel/application';
import type { NormalizedRouteCandidate } from '@travel/domain';
import { baiduToWgs84 } from './baidu-coordinates.js';
import { bindProviderEndpoints } from './endpoint-binding.js';
import { coordinate, json, record } from './regional-http.js';
import {
  contractStep,
  ProviderContractError,
  type DiagnosticObserver,
} from './contract-diagnostics.js';
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
function departure(input: RouteProviderQueryInput, now: Date): Date | null {
  if (input.preference.type === 'ARRIVE_BY') return null;
  if (
    ![
      now,
      input.earliestDeparture,
      input.latestArrival,
      input.preference.type === 'DEPART_AT' ? input.preference.instant : null,
    ].every(
      (d) => d === null || (d instanceof Date && Number.isFinite(d.getTime())),
    )
  )
    return null;
  if (input.preference.type === 'DEPART_AT') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.preference.timeZone });
    } catch {
      return null;
    }
    if (
      input.preference.instant.getTime() < now.getTime() ||
      input.preference.instant.getTime() <
        (input.earliestDeparture?.getTime() ?? -Infinity)
    )
      return null;
    return input.preference.instant;
  }
  const at = input.earliestDeparture ?? now;
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
  binding: ReturnType<typeof bindProviderEndpoints>,
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
    providerCandidateRef: null,
    observedAt,
    validUntil: null,
    departure: start,
    arrival: end,
    durationSeconds: seconds,
    legs: [
      {
        mode: input.travelMode ?? 'WALKING',
        from: { ...location(input.origin), ...binding.from },
        to: { ...location(input.destination), ...binding.to },
        departure: start,
        arrival: end,
        durationSeconds: seconds,
        fixedService: false,
        serviceLabel: null,
        providerRef: binding.evidenceRef,
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
    private readonly diagnostics?: DiagnosticObserver,
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
                  ...(input.preference.type === 'DEPART_AT' ||
                  at.getTime() > observedAt.getTime()
                    ? { departureTime: at.toISOString() }
                    : {}),
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
      contractStep(
        this.diagnostics,
        'RESPONSE_SHAPE',
        'response.routes',
        () => {
          if (!Array.isArray(body.routes) || body.routes.length > 5)
            throw new Error('INVALID_PROVIDER_RESPONSE');
        },
      );
      if (!Array.isArray(body.routes))
        throw new Error('INVALID_PROVIDER_RESPONSE');
      const candidates = body.routes.map((raw) => {
        const r = record(raw);
        contractStep(
          this.diagnostics,
          'RESPONSE_SHAPE',
          'response.routes[].legs',
          () => {
            if (!Array.isArray(r.legs) || r.legs.length !== 1)
              throw new Error('INVALID_PROVIDER_RESPONSE');
          },
        );
        if (!Array.isArray(r.legs))
          throw new Error('INVALID_PROVIDER_RESPONSE');
        const leg = record(r.legs[0]);
        const from = contractStep(
          this.diagnostics,
          'COORDINATE_PARSE',
          'response.routes[].legs.startLocation/endLocation',
          () => {
            const a = record(leg.startLocation).latLng;
            const b = record(leg.endLocation).latLng;
            return { a: coordinate(a), b: coordinate(b) };
          },
          'INVALID_COORDINATES',
        );
        const binding = contractStep(
          this.diagnostics,
          'ENDPOINT_BINDING',
          'response.routes[].legs.startLocation/endLocation',
          () =>
            bindProviderEndpoints(
              'GOOGLE',
              input.origin,
              input.destination,
              from.a,
              from.b,
            ),
        );
        const seconds = contractStep(
          this.diagnostics,
          'RESPONSE_SHAPE',
          'response.routes[].duration',
          () => {
            if (
              typeof r.duration !== 'string' ||
              !/^\d+(\.\d{1,9})?s$/.test(r.duration)
            )
              throw new Error('INVALID_PROVIDER_RESPONSE');
            return Math.ceil(Number(r.duration.slice(0, -1)));
          },
          'INVALID_DURATION',
        );
        return contractStep(
          this.diagnostics,
          'DOMAIN_VALIDATION',
          'candidate',
          () => candidate('google', input, at, seconds, observedAt, binding),
          'DOMAIN_VALIDATION_FAILED',
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
    private readonly futureDrivingApproved = false,
    private readonly diagnostics?: DiagnosticObserver,
  ) {}
  async queryRoutes(
    input: RouteProviderQueryInput,
  ): Promise<RouteProviderResult> {
    const observedAt = this.now();
    let at = departure(input, observedAt);
    const mode = input.travelMode;
    if (
      !at ||
      !knownZones(input) ||
      !mode ||
      !['WALKING', 'DRIVING', 'CYCLING', 'TRANSIT'].includes(mode)
    )
      return { status: 'UNSUPPORTED_QUERY' };
    if (mode === 'TRANSIT') {
      if (input.preference.type === 'DEPART_AT' && at.getTime() % 60000 !== 0)
        return { status: 'UNSUPPORTED_QUERY' };
      if (input.preference.type === 'NONE')
        at = new Date(Math.ceil(at.getTime() / 60000) * 60000);
    }
    if (
      mode === 'DRIVING' &&
      at.getTime() > observedAt.getTime() &&
      at.getTime() % 1000 !== 0
    )
      return { status: 'UNSUPPORTED_QUERY' };
    const future = at.getTime() > observedAt.getTime();
    // Past/over-seven-day dates must never silently become current traffic.
    if (
      input.preference.type === 'DEPART_AT' &&
      input.preference.instant.getTime() < observedAt.getTime()
    )
      return { status: 'UNSUPPORTED_QUERY' };
    if (
      mode === 'DRIVING' &&
      future &&
      (!this.futureDrivingApproved ||
        at.getTime() > observedAt.getTime() + 7 * 86400000)
    )
      return { status: 'UNSUPPORTED_QUERY' };
    // Transit service timezone/date semantics are confined to the verified V1 scope.
    if (
      mode === 'TRANSIT' &&
      (input.origin.timeZone !== 'Asia/Shanghai' ||
        input.destination.timeZone !== 'Asia/Shanghai')
    )
      return { status: 'UNSUPPORTED_QUERY' };
    try {
      const endpoint = {
        WALKING: 'walking',
        DRIVING: 'driving',
        CYCLING: 'riding',
        TRANSIT: 'transit',
      }[mode];
      const url = new URL(`https://api.map.baidu.com/direction/v2/${endpoint}`);
      const params = new URLSearchParams({
        origin: `${input.origin.latitude},${input.origin.longitude}`,
        destination: `${input.destination.latitude},${input.destination.longitude}`,
        coord_type: 'wgs84',
        ret_coordtype: 'bd09ll',
        output: 'json',
        ak: this.key,
      });
      if (mode === 'DRIVING') {
        params.set('alternatives', '0');
        if (future)
          params.set('departure_time', String(Math.floor(at.getTime() / 1000)));
      }
      if (mode === 'CYCLING') params.set('riding_type', '0');
      if (mode === 'TRANSIT') {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
          })
            .formatToParts(at)
            .map((p) => [p.type, p.value]),
        );
        params.set(
          'departure_date',
          `${parts.year}-${parts.month}-${parts.day}`,
        );
        params.set('departure_time', `${parts.hour}:${parts.minute}`);
        params.set('page_size', '1');
      }
      url.search = params.toString();
      const body = await json(this.fetcher, url),
        result = record(body.result);
      if (mode === 'TRANSIT' && body.status === 1002)
        return { status: 'UNSUPPORTED_QUERY' };
      if (body.status === 7 || (mode === 'TRANSIT' && body.status === 1001))
        return { status: 'NO_MATCHING_CANDIDATE' };
      if (body.status !== 0) throw new Error('INVALID_PROVIDER_RESPONSE');
      contractStep(
        this.diagnostics,
        'RESPONSE_SHAPE',
        'response.result.routes',
        () => {
          if (!Array.isArray(result.routes) || result.routes.length > 5)
            throw new Error('INVALID_PROVIDER_RESPONSE');
        },
      );
      if (!Array.isArray(result.routes))
        throw new Error('INVALID_PROVIDER_RESPONSE');
      if (result.routes.length === 0)
        return { status: 'NO_MATCHING_CANDIDATE' };
      const from = record(result.origin),
        to = record(result.destination);
      if (mode === 'TRANSIT') {
        if (
          typeof from.city_id !== 'string' ||
          !from.city_id ||
          from.city_id !== to.city_id
        )
          return { status: 'UNSUPPORTED_QUERY' }; // Cross-city contracts require separate acceptance.
      }
      // No coordinate-system assertion is present in the response schema. The
      // existing request explicitly asks for BD09; parsing does not prove that
      // the upstream honored it. Strict binding remains the independent fence.
      const endpointField =
        mode === 'WALKING' || mode === 'CYCLING'
          ? ('response.result.origin.originPt/destination.destinationPt' as const)
          : ('response.result.origin/destination' as const);
      const endpoints = contractStep(
        this.diagnostics,
        'RESPONSE_SHAPE',
        'response.result.origin/destination',
        () => {
          const start =
            mode === 'TRANSIT'
              ? from.location
              : mode === 'DRIVING'
                ? result.origin
                : from.originPt;
          const end =
            mode === 'TRANSIT'
              ? to.location
              : mode === 'DRIVING'
                ? result.destination
                : to.destinationPt;
          for (const point of [start, end]) {
            if (!point || typeof point !== 'object' || Array.isArray(point))
              throw new Error('INVALID_PROVIDER_RESPONSE');
          }
          return { start, end };
        },
      );
      contractStep(
        this.diagnostics,
        'COORDINATE_PARSE',
        endpointField,
        () => {
          for (const point of [endpoints.start, endpoints.end]) {
            const parsed = coordinate(point);
            // Use the same existing inverse as binding, without changing precision
            // or introducing an accuracy/equivalence claim.
            coordinate(baiduToWgs84(parsed.latitude, parsed.longitude));
          }
        },
        'INVALID_COORDINATES',
      );
      const binding = contractStep(
        this.diagnostics,
        'ENDPOINT_BINDING',
        endpointField,
        () => {
          try {
            return bindProviderEndpoints(
              'BAIDU',
              input.origin,
              input.destination,
              endpoints.start,
              endpoints.end,
            );
          } catch (error) {
            // Remap only the fixed diagnostic field; preserve every guard and code.
            if (error instanceof ProviderContractError)
              throw new ProviderContractError({
                ...error.diagnostic,
                field: endpointField,
              });
            throw error;
          }
        },
      );
      const plannedAt = at;
      return {
        status: 'SUCCESS',
        candidates: result.routes.map((raw) => {
          const seconds = contractStep(
            this.diagnostics,
            'RESPONSE_SHAPE',
            'response.result.routes[].duration',
            () => {
              const duration = record(raw).duration;
              // The same limits already enforced by candidate(), now separately
              // observable rather than mislabeled as a generic route failure.
              if (
                typeof duration !== 'number' ||
                !Number.isSafeInteger(duration) ||
                duration <= 0 ||
                duration > 604800
              )
                throw new Error('INVALID_PROVIDER_RESPONSE');
              return duration;
            },
            'INVALID_DURATION',
          );
          return contractStep(
            this.diagnostics,
            'DOMAIN_VALIDATION',
            'candidate',
            () =>
              candidate(
                'baidu',
                input,
                plannedAt,
                seconds,
                observedAt,
                binding,
              ),
            'DOMAIN_VALIDATION_FAILED',
          );
        }),
      };
      // TRANSIT is an aggregate estimated journey, not fabricated BUS/RAIL legs,
      // station identities, timetable facts or monitoring capability.
    } catch {
      return { status: 'PROVIDER_UNAVAILABLE', reason: 'UPSTREAM_UNAVAILABLE' };
    }
  }
}
