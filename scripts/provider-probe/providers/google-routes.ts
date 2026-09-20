import type {
  ProbeFactMatrix,
  ProbeLeg,
  ProbeProviderStatus,
  ProbeRoute,
  ProbeScenario,
  ProviderCapabilityResult,
  ProviderHealthResult,
  ProviderProbeAdapter,
  ProviderProbeCapabilities,
  ProviderProbeResult,
  RouteProbeQuery,
} from '../types.js';

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.transitDetails.stopDetails.departureStop',
  'routes.legs.steps.transitDetails.stopDetails.arrivalStop',
  'routes.legs.steps.transitDetails.stopDetails.departureTime',
  'routes.legs.steps.transitDetails.stopDetails.arrivalTime',
  'routes.legs.steps.transitDetails.transitLine.name',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.agencies',
  'routes.legs.steps.transitDetails.transitLine.vehicle',
  'routes.legs.steps.transitDetails.headsign',
  'routes.legs.steps.transitDetails.stopCount',
  'routes.travelAdvisory.transitFare',
].join(',');

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class GoogleRoutesProbeAdapter implements ProviderProbeAdapter {
  readonly id = 'google';
  readonly displayName = 'Google Routes';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async healthCheck(): Promise<ProviderHealthResult> {
    return this.apiKey
      ? {
          status: 'PASS',
          httpStatus: null,
          message: 'API key configured; service is verified by route probes',
        }
      : {
          status: 'NOT_CONFIGURED',
          httpStatus: null,
          message: 'GOOGLE_MAPS_SERVER_KEY is not configured',
        };
  }

  async capabilities(): Promise<ProviderCapabilityResult> {
    return {
      status: this.apiKey ? 'SUCCESS' : 'AUTH_OR_SERVICE_CONFIGURATION_ERROR',
      httpStatus: null,
      capabilities: googleCapabilities(),
      notes: this.apiKey
        ? ['Capabilities reflect the official Routes API transit contract']
        : ['GOOGLE_MAPS_SERVER_KEY is not configured'],
      regions: [],
    };
  }

  async route(
    scenario: ProbeScenario,
    query: RouteProbeQuery,
    capabilities: ProviderProbeCapabilities,
  ): Promise<ProviderProbeResult> {
    if (!this.apiKey) {
      return emptyResult(
        scenario,
        query,
        capabilities,
        'AUTH_OR_SERVICE_CONFIGURATION_ERROR',
        null,
        ['GOOGLE_MAPS_SERVER_KEY is not configured'],
      );
    }
    const response = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(requestBody(query)),
    });
    const body = await readJson(response);
    if (!response.ok) {
      return emptyResult(
        scenario,
        query,
        capabilities,
        statusFromHttp(response.status),
        response.status,
        [googleErrorMessage(body)],
        evidence(response, body),
      );
    }
    try {
      const routes = normalizeGoogleRoutesResponse(body, query);
      if (routes.length === 0) {
        return emptyResult(
          scenario,
          query,
          capabilities,
          'NO_ROUTE',
          response.status,
          ['Provider returned routes=[]'],
          evidence(response, body),
        );
      }
      const facts = factsFor(routes);
      return {
        provider: this.id,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        request: requestView(query),
        providerStatus: 'SUCCESS',
        httpStatus: response.status,
        capabilities: observedCapabilities(capabilities, facts),
        routes,
        routeCount: routes.length,
        facts,
        notes: notesFor(facts, routes),
        rawEvidence: evidence(response, body),
      };
    } catch (error) {
      return emptyResult(
        scenario,
        query,
        capabilities,
        'MALFORMED_RESPONSE',
        response.status,
        [error instanceof Error ? error.message : 'Unknown malformed response'],
        evidence(response, body),
      );
    }
  }
}

export function normalizeGoogleRoutesResponse(
  value: unknown,
  query: RouteProbeQuery,
): readonly ProbeRoute[] {
  if (isRecord(value) && Object.keys(value).length === 0) return [];
  if (!isRecord(value) || !Array.isArray(value.routes)) {
    throw new Error('Google Routes response does not contain routes[]');
  }
  return value.routes.map((route) => normalizeRoute(route, query));
}

function normalizeRoute(value: unknown, query: RouteProbeQuery): ProbeRoute {
  if (!isRecord(value) || !Array.isArray(value.legs)) {
    throw new Error('Google route does not contain legs[]');
  }
  const legs = value.legs.flatMap((leg) => {
    if (!isRecord(leg) || !Array.isArray(leg.steps)) {
      throw new Error('Google route leg does not contain steps[]');
    }
    return leg.steps.map(normalizeStep);
  });
  const transitLegs = legs.filter((leg) => leg.mode !== 'WALK');
  const departure =
    transitLegs.find((leg) => leg.departure !== null)?.departure ?? null;
  const arrival =
    [...transitLegs].reverse().find((leg) => leg.arrival !== null)?.arrival ??
    null;
  const requested = Date.parse(query.instant);
  const actual = query.mode === 'DEPART_AT' ? departure : arrival;
  const satisfied =
    actual === null
      ? null
      : query.mode === 'DEPART_AT'
        ? Date.parse(actual) >= requested
        : Date.parse(actual) <= requested;
  return {
    providerRef: null,
    departure,
    arrival,
    totalDurationSeconds: durationSeconds(value.duration, 'route.duration'),
    fare: normalizeFare(nestedRecord(value, 'travelAdvisory')?.transitFare),
    legs,
    transferCount: Math.max(0, transitLegs.length - 1),
    walkingSeconds: legs
      .filter((leg) => leg.mode === 'WALK')
      .reduce((sum, leg) => sum + (leg.durationSeconds ?? 0), 0),
    timeConstraintSatisfied: satisfied,
  };
}

function normalizeStep(value: unknown): ProbeLeg {
  if (!isRecord(value) || typeof value.travelMode !== 'string') {
    throw new Error('Google route step is missing travelMode');
  }
  const details = nestedRecord(value, 'transitDetails');
  const stops = details === null ? null : nestedRecord(details, 'stopDetails');
  const line = details === null ? null : nestedRecord(details, 'transitLine');
  const agencies = Array.isArray(line?.agencies) ? line.agencies : [];
  const agencyNames = agencies
    .map((agency) => (isRecord(agency) ? stringOrNull(agency.name) : null))
    .filter((name): name is string => name !== null);
  const vehicleType = nestedString(line, 'vehicle', 'type');
  return {
    mode:
      value.travelMode === 'WALK' ? 'WALK' : normalizedTransitMode(vehicleType),
    from: nestedString(stops, 'departureStop', 'name'),
    to: nestedString(stops, 'arrivalStop', 'name'),
    departure: timestampOrNull(stops?.departureTime, 'departureTime'),
    arrival: timestampOrNull(stops?.arrivalTime, 'arrivalTime'),
    durationSeconds:
      typeof value.staticDuration === 'string'
        ? durationSeconds(value.staticDuration, 'step.staticDuration')
        : null,
    lineName: stringOrNull(line?.name) ?? stringOrNull(line?.nameShort),
    operatorName: agencyNames.length > 0 ? agencyNames.join(' / ') : null,
    providerRef: null,
    timing: null,
  };
}

function requestBody(query: RouteProbeQuery): Record<string, unknown> {
  return {
    origin: waypoint(query.origin.lat, query.origin.lng),
    destination: waypoint(query.destination.lat, query.destination.lng),
    travelMode: 'TRANSIT',
    computeAlternativeRoutes: true,
    languageCode: 'ja',
    regionCode: 'jp',
    [query.mode === 'DEPART_AT' ? 'departureTime' : 'arrivalTime']:
      query.instant,
  };
}

function waypoint(latitude: number, longitude: number): unknown {
  return { location: { latLng: { latitude, longitude } } };
}

function googleCapabilities(): ProviderProbeCapabilities {
  return {
    publicTransit: true,
    rail: true,
    bus: true,
    subway: true,
    ferry: true,
    walking: true,
    departAt: true,
    arriveBy: true,
    fare: null,
    realtime: null,
    lineNames: null,
  };
}

function factsFor(routes: readonly ProbeRoute[]): ProbeFactMatrix {
  const legs = routes.flatMap((route) => route.legs);
  const timeConstraintSatisfied = routes.some(
    (route) => route.timeConstraintSatisfied === false,
  )
    ? false
    : routes.some((route) => route.timeConstraintSatisfied === null)
      ? null
      : true;
  return {
    routeFound: routes.length > 0,
    railPresent: legs.some((leg) => leg.mode === 'RAIL'),
    busPresent: legs.some((leg) => leg.mode === 'BUS'),
    walkingPresent: legs.some((leg) => leg.mode === 'WALK'),
    lineNamesPresent: legs.some((leg) => leg.lineName !== null),
    departureTimesPresent: routes.every((route) => route.departure !== null),
    arrivalTimesPresent: routes.every((route) => route.arrival !== null),
    farePresent: routes.some((route) => route.fare !== null),
    realtimePresent: false,
    timeConstraintSatisfied,
  };
}

function observedCapabilities(
  declared: ProviderProbeCapabilities,
  facts: ProbeFactMatrix,
): ProviderProbeCapabilities {
  return {
    ...declared,
    fare: facts.farePresent,
    realtime: facts.realtimePresent,
    lineNames: facts.lineNamesPresent,
  };
}

function notesFor(
  facts: ProbeFactMatrix,
  routes: readonly ProbeRoute[],
): readonly string[] {
  const notes: string[] = [];
  if (!facts.railPresent) notes.push('Route returned but no rail leg');
  if (!facts.busPresent) notes.push('Route returned but no bus leg');
  if (!facts.lineNamesPresent) notes.push('Line names not returned');
  if (!facts.farePresent) notes.push('Fare not returned');
  const unknown = routes.filter(
    (route) => route.timeConstraintSatisfied === null,
  ).length;
  const failed = routes.filter(
    (route) => route.timeConstraintSatisfied === false,
  ).length;
  if (unknown > 0)
    notes.push(`${unknown} route(s) have unknown time compliance`);
  if (failed > 0) notes.push(`${failed} route(s) violate the requested time`);
  return notes;
}

function normalizeFare(value: unknown): ProbeRoute['fare'] {
  if (!isRecord(value) || typeof value.currencyCode !== 'string') return null;
  const units =
    typeof value.units === 'string'
      ? Number(value.units)
      : typeof value.units === 'number'
        ? value.units
        : 0;
  const nanos = typeof value.nanos === 'number' ? value.nanos : 0;
  if (!Number.isSafeInteger(units) || !Number.isInteger(nanos)) return null;
  const amount = units + nanos / 1_000_000_000;
  return { amount: String(amount), currency: value.currencyCode };
}

function normalizedTransitMode(value: string | null): string {
  if (value === null) return 'PUBLIC_TRANSIT';
  if (/BUS|TROLLEYBUS/iu.test(value)) return 'BUS';
  if (/SUBWAY/iu.test(value)) return 'SUBWAY';
  if (/FERRY/iu.test(value)) return 'FERRY';
  if (/RAIL|TRAIN|TRAM|MONORAIL/iu.test(value)) return 'RAIL';
  return 'PUBLIC_TRANSIT';
}

function statusFromHttp(status: number): ProbeProviderStatus {
  if (status === 403) return 'AUTH_OR_SERVICE_CONFIGURATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400) return 'MALFORMED_REQUEST';
  return 'PROVIDER_ERROR';
}

function emptyResult(
  scenario: ProbeScenario,
  query: RouteProbeQuery,
  capabilities: ProviderProbeCapabilities,
  providerStatus: ProbeProviderStatus,
  httpStatus: number | null,
  notes: readonly string[],
  rawEvidence?: unknown,
): ProviderProbeResult {
  return {
    provider: 'google',
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    request: requestView(query),
    providerStatus,
    httpStatus,
    capabilities,
    routes: [],
    routeCount: 0,
    facts: {
      routeFound: false,
      railPresent: false,
      busPresent: false,
      walkingPresent: false,
      lineNamesPresent: false,
      departureTimesPresent: false,
      arrivalTimesPresent: false,
      farePresent: false,
      realtimePresent: false,
      timeConstraintSatisfied: null,
    },
    notes,
    ...(rawEvidence === undefined ? {} : { rawEvidence }),
  };
}

function requestView(query: RouteProbeQuery): ProviderProbeResult['request'] {
  return {
    origin: query.origin,
    destination: query.destination,
    mode: query.mode,
    requestedInstant: query.instant,
    timeZone: query.timeZone,
  };
}

function durationSeconds(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,9})?s$/u.test(value)) {
    throw new Error(`${field} is not a valid protobuf duration`);
  }
  return Math.round(Number(value.slice(0, -1)));
}

function timestampOrNull(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} is not a valid timestamp`);
  }
  return new Date(value).toISOString();
}

function nestedRecord(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (value === null) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function nestedString(
  value: Record<string, unknown> | null,
  objectKey: string,
  propertyKey: string,
): string | null {
  return stringOrNull(nestedRecord(value, objectKey)?.[propertyKey]);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { parseError: 'Response was not valid JSON' };
  }
}

function googleErrorMessage(value: unknown): string {
  if (!isRecord(value)) return 'Google Routes request failed';
  const error = isRecord(value.error) ? value.error : value;
  return stringOrNull(error.message) ?? 'Google Routes request failed';
}

function evidence(response: Response, body: unknown): unknown {
  return { httpStatus: response.status, body };
}
