import type {
  ProbeFactMatrix,
  ProbeLeg,
  ProbeRegionEvidence,
  ProbeRoute,
  ProbeScenario,
  ProbeProviderStatus,
  ProviderCapabilityResult,
  ProviderHealthResult,
  ProviderProbeAdapter,
  ProviderProbeCapabilities,
  ProviderProbeResult,
  RouteProbeQuery,
} from '../types.js';

const BASE_URL = 'https://api.tripgo.com/v1/';
const HOKKAIDO_POINT = { lat: 42.7752, lng: 141.6923 };

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class TripGoProbeAdapter implements ProviderProbeAdapter {
  readonly id = 'tripgo';
  readonly displayName = 'TripGo';

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async healthCheck(): Promise<ProviderHealthResult> {
    if (!this.apiKey) {
      return {
        status: 'NOT_CONFIGURED',
        httpStatus: null,
        message: 'TRIPGO_API_KEY is not configured',
      };
    }
    const response = await this.fetchImpl(new URL('regions.json', BASE_URL), {
      method: 'POST',
      headers: this.headers({ 'X-TripGo-HealthCheck': 'true' }),
    });
    const body = await readJson(response);
    const passed =
      response.status === 200 &&
      isRecord(body) &&
      body.healthCheckPassed === true;
    return {
      status: passed ? 'PASS' : 'FAIL',
      httpStatus: response.status,
      message: passed ? 'healthCheckPassed=true' : providerMessage(body),
      rawEvidence: evidence(response, body),
    };
  }

  async capabilities(): Promise<ProviderCapabilityResult> {
    const empty = unknownCapabilities();
    if (!this.apiKey) {
      return {
        status: 'AUTH_ERROR',
        httpStatus: null,
        capabilities: empty,
        notes: ['TRIPGO_API_KEY is not configured'],
        regions: [],
      };
    }
    const response = await this.fetchImpl(new URL('regions.json', BASE_URL), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ v: 2 }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      return {
        status: statusFromHttp(response.status),
        httpStatus: response.status,
        capabilities: empty,
        notes: [providerMessage(body)],
        regions: [],
        rawEvidence: evidence(response, body),
      };
    }
    if (!isRecord(body) || !Array.isArray(body.regions)) {
      return {
        status: 'MALFORMED_RESPONSE',
        httpStatus: response.status,
        capabilities: empty,
        notes: ['regions response does not contain regions[]'],
        regions: [],
        rawEvidence: evidence(response, body),
      };
    }
    const regions = body.regions
      .map(toRegionEvidence)
      .filter((region): region is ProbeRegionEvidence => region !== null);
    const relevantModes = new Set(
      regions
        .filter((region) => region.japanRelated || region.containsHokkaido)
        .flatMap((region) => region.modes),
    );
    const has = (pattern: RegExp): boolean =>
      [...relevantModes].some((mode) => pattern.test(mode));
    const capabilities: ProviderProbeCapabilities = {
      publicTransit: has(/^pt_pub(?:_|$)/u),
      rail: has(/(?:rail|train)/iu),
      bus: has(/bus/iu),
      subway: has(/subway|metro/iu),
      ferry: has(/ferry|water/iu),
      walking: has(/^wa_/u),
      departAt: true,
      arriveBy: true,
      fare: null,
      realtime: null,
      lineNames: null,
    };
    return {
      status: 'SUCCESS',
      httpStatus: response.status,
      capabilities,
      notes: capabilityNotes(regions, relevantModes),
      regions,
      rawEvidence: evidence(response, body),
    };
  }

  async route(
    scenario: ProbeScenario,
    query: RouteProbeQuery,
    capabilities: ProviderProbeCapabilities,
  ): Promise<ProviderProbeResult> {
    if (!this.apiKey) {
      return emptyResult(scenario, query, capabilities, 'AUTH_ERROR', null, [
        'TRIPGO_API_KEY is not configured',
      ]);
    }
    const url = new URL('routing.json', BASE_URL);
    url.searchParams.set('from', coordinate(query.origin));
    url.searchParams.set('to', coordinate(query.destination));
    url.searchParams.set('modes', 'pt_pub');
    url.searchParams.set('v', '11');
    url.searchParams.set('locale', 'en');
    url.searchParams.set(
      query.mode === 'DEPART_AT' ? 'departAfter' : 'arriveBefore',
      String(Math.floor(new Date(query.instant).getTime() / 1_000)),
    );
    const response = await this.fetchImpl(url, {
      headers: this.headers({ Accept: 'application/json' }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      return emptyResult(
        scenario,
        query,
        capabilities,
        statusFromHttp(response.status),
        response.status,
        [providerMessage(body)],
        evidence(response, body),
      );
    }
    try {
      const routes = normalizeTripGoRoutingResponse(body, query);
      if (routes.length === 0) {
        return emptyResult(
          scenario,
          query,
          capabilities,
          'NO_ROUTE',
          response.status,
          ['Provider returned no route'],
          evidence(response, body),
        );
      }
      const facts = factsFor(routes);
      const notes = notesFor(facts, routes);
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
        notes,
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

  private headers(additional: Record<string, string>): HeadersInit {
    return { ...additional, 'X-TripGo-Key': this.apiKey! };
  }
}

export function normalizeTripGoRoutingResponse(
  value: unknown,
  query: RouteProbeQuery,
): readonly ProbeRoute[] {
  if (!isRecord(value) || !Array.isArray(value.groups)) {
    throw new Error('routing response does not contain groups[]');
  }
  const templates = templateMap(value.segmentTemplates);
  const trips = value.groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.trips)) {
      throw new Error('routing group does not contain trips[]');
    }
    return group.trips;
  });
  return trips.map((trip) => normalizeTrip(trip, templates, query));
}

function normalizeTrip(
  value: unknown,
  templates: ReadonlyMap<number, Record<string, unknown>>,
  query: RouteProbeQuery,
): ProbeRoute {
  if (!isRecord(value)) throw new Error('trip is not an object');
  const depart = epoch(value.depart, 'trip.depart');
  const arrive = epoch(value.arrive, 'trip.arrive');
  if (!Array.isArray(value.segments)) {
    throw new Error('trip does not contain segments[]');
  }
  const legs = value.segments.map((segment) =>
    normalizeSegment(segment, templates),
  );
  const transitLegs = legs.filter((leg) =>
    ['RAIL', 'BUS', 'SUBWAY', 'FERRY', 'PUBLIC_TRANSIT'].includes(leg.mode),
  ).length;
  const walkingSeconds = legs
    .filter((leg) => leg.mode === 'WALK')
    .reduce((total, leg) => total + (leg.durationSeconds ?? 0), 0);
  const requested = new Date(query.instant).getTime();
  const satisfied =
    query.mode === 'DEPART_AT'
      ? depart.getTime() >= requested
      : arrive.getTime() <= requested;
  return {
    providerRef: stringOrNull(value.id),
    departure: depart.toISOString(),
    arrival: arrive.toISOString(),
    totalDurationSeconds: Math.max(
      0,
      Math.floor((arrive.getTime() - depart.getTime()) / 1_000),
    ),
    fare:
      typeof value.moneyCost === 'number' && typeof value.currency === 'string'
        ? { amount: String(value.moneyCost), currency: value.currency }
        : null,
    legs,
    transferCount: Math.max(0, transitLegs - 1),
    walkingSeconds,
    timeConstraintSatisfied: satisfied,
  };
}

function normalizeSegment(
  value: unknown,
  templates: ReadonlyMap<number, Record<string, unknown>>,
): ProbeLeg {
  if (!isRecord(value)) throw new Error('segment reference is not an object');
  const hash = number(value.segmentTemplateHashCode, 'segmentTemplateHashCode');
  const template = templates.get(hash);
  if (!template) throw new Error(`segment template ${hash} is missing`);
  const start = epoch(value.startTime, 'segment.startTime');
  const end = epoch(value.endTime, 'segment.endTime');
  const modeIdentifier =
    nestedString(template, 'modeInfo', 'identifier') ??
    stringOrNull(template.modeIdentifier) ??
    'unknown';
  const from = locationName(template.from ?? template.location);
  const to = locationName(template.to ?? template.location);
  const lineName =
    stringOrNull(value.serviceName) ??
    stringOrNull(value.serviceNumber) ??
    nestedString(template, 'modeInfo', 'description');
  return {
    mode: normalizedMode(modeIdentifier),
    from,
    to,
    departure: start.toISOString(),
    arrival: end.toISOString(),
    durationSeconds: Math.max(
      0,
      Math.floor((end.getTime() - start.getTime()) / 1_000),
    ),
    lineName,
    operatorName: stringOrNull(template.operator),
    providerRef:
      stringOrNull(value.id) ??
      stringOrNull(value.serviceTripID) ??
      String(hash),
    timing:
      value.realTime === true
        ? 'REALTIME'
        : template.type === 'scheduled'
          ? 'SCHEDULED'
          : null,
  };
}

function templateMap(
  value: unknown,
): ReadonlyMap<number, Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error('routing response does not contain segmentTemplates[]');
  }
  const result = new Map<number, Record<string, unknown>>();
  for (const template of value) {
    if (!isRecord(template))
      throw new Error('segment template is not an object');
    result.set(number(template.hashCode, 'segmentTemplate.hashCode'), template);
  }
  return result;
}

function factsFor(routes: readonly ProbeRoute[]): ProbeFactMatrix {
  const legs = routes.flatMap((route) => route.legs);
  return {
    routeFound: routes.length > 0,
    railPresent: legs.some((leg) => leg.mode === 'RAIL'),
    busPresent: legs.some((leg) => leg.mode === 'BUS'),
    walkingPresent: legs.some((leg) => leg.mode === 'WALK'),
    lineNamesPresent: legs.some((leg) => leg.lineName !== null),
    departureTimesPresent: legs.every((leg) => leg.departure !== null),
    arrivalTimesPresent: legs.every((leg) => leg.arrival !== null),
    farePresent: routes.some((route) => route.fare !== null),
    realtimePresent: legs.some((leg) => leg.timing === 'REALTIME'),
    timeConstraintSatisfied: routes.every(
      (route) => route.timeConstraintSatisfied,
    ),
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
  if (facts.timeConstraintSatisfied === false) {
    notes.push(
      `${routes.filter((route) => !route.timeConstraintSatisfied).length} route(s) did not respect the requested time constraint`,
    );
  }
  return notes;
}

function observedCapabilities(
  declared: ProviderProbeCapabilities,
  facts: ProbeFactMatrix,
): ProviderProbeCapabilities {
  return {
    ...declared,
    rail: declared.rail || facts.railPresent,
    bus: declared.bus || facts.busPresent,
    walking: declared.walking || facts.walkingPresent,
    fare: facts.farePresent,
    realtime: facts.realtimePresent,
    lineNames: facts.lineNamesPresent,
  };
}

function toRegionEvidence(value: unknown): ProbeRegionEvidence | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const modes = Array.isArray(value.modes)
    ? value.modes.filter((mode): mode is string => typeof mode === 'string')
    : [];
  const cities = Array.isArray(value.cities) ? value.cities : [];
  const japanRelated =
    /(?:^JP_|japan|sapporo|hokkaido|osaka|wakayama)/iu.test(value.name) ||
    cities.some(
      (city) =>
        isRecord(city) &&
        typeof city.timezone === 'string' &&
        city.timezone.startsWith('Asia/Tokyo'),
    );
  return {
    code: value.name,
    modes,
    containsHokkaido:
      typeof value.polygon === 'string' &&
      pointInPolygon(HOKKAIDO_POINT, decodePolyline(value.polygon)),
    japanRelated,
  };
}

export function decodePolyline(encoded: string): readonly {
  readonly lat: number;
  readonly lng: number;
}[] {
  const points: { lat: number; lng: number }[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    const latitude = decodePolylineValue(encoded, index);
    index = latitude.next;
    const longitude = decodePolylineValue(encoded, index);
    index = longitude.next;
    lat += latitude.value;
    lng += longitude.value;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

function decodePolylineValue(
  encoded: string,
  start: number,
): { readonly value: number; readonly next: number } {
  let result = 0;
  let shift = 0;
  let index = start;
  while (true) {
    const code = encoded.charCodeAt(index++) - 63;
    if (!Number.isFinite(code) || code < 0) {
      throw new Error('invalid encoded polyline');
    }
    result |= (code & 0x1f) << shift;
    shift += 5;
    if (code < 0x20) break;
    if (shift > 30) throw new Error('invalid encoded polyline');
  }
  return { value: result & 1 ? ~(result >> 1) : result >> 1, next: index };
}

function pointInPolygon(
  point: { readonly lat: number; readonly lng: number },
  polygon: readonly { readonly lat: number; readonly lng: number }[],
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    if (
      a.lng > point.lng !== b.lng > point.lng &&
      point.lat <
        ((b.lat - a.lat) * (point.lng - a.lng)) / (b.lng - a.lng) + a.lat
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function capabilityNotes(
  regions: readonly ProbeRegionEvidence[],
  modes: ReadonlySet<string>,
): readonly string[] {
  const japan = regions.filter((region) => region.japanRelated);
  const hokkaido = regions.filter((region) => region.containsHokkaido);
  return [
    `Japan-related regions: ${japan.map((region) => region.code).join(', ') || 'none'}`,
    `Hokkaido coordinate regions: ${hokkaido.map((region) => region.code).join(', ') || 'none'}`,
    `Relevant modes: ${[...modes].sort(codePointCompare).join(', ') || 'none'}`,
  ];
}

function unknownCapabilities(): ProviderProbeCapabilities {
  return {
    publicTransit: null,
    rail: null,
    bus: null,
    subway: null,
    ferry: null,
    walking: null,
    departAt: true,
    arriveBy: true,
    fare: null,
    realtime: null,
    lineNames: null,
  };
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
    provider: 'tripgo',
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

function normalizedMode(identifier: string): string {
  if (/^wa_/u.test(identifier)) return 'WALK';
  if (/rail|train/iu.test(identifier)) return 'RAIL';
  if (/bus/iu.test(identifier)) return 'BUS';
  if (/subway|metro/iu.test(identifier)) return 'SUBWAY';
  if (/ferry|water/iu.test(identifier)) return 'FERRY';
  if (/^pt_/u.test(identifier)) return 'PUBLIC_TRANSIT';
  if (/^stationary_transfer/u.test(identifier)) return 'TRANSFER';
  if (/^stationary_/u.test(identifier)) return 'STATIONARY';
  return identifier.toUpperCase();
}

function locationName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return stringOrNull(value.name) ?? stringOrNull(value.address);
}

function nestedString(
  value: Record<string, unknown>,
  objectKey: string,
  propertyKey: string,
): string | null {
  const nested = value[objectKey];
  return isRecord(nested) ? stringOrNull(nested[propertyKey]) : null;
}

function coordinate(location: {
  readonly lat: number;
  readonly lng: number;
}): string {
  return `(${location.lat},${location.lng})`;
}

function statusFromHttp(status: number): ProbeProviderStatus {
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  return 'PROVIDER_ERROR';
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

function providerMessage(value: unknown): string {
  if (!isRecord(value)) return 'Provider request failed';
  return (
    stringOrNull(value.error) ??
    stringOrNull(value.message) ??
    stringOrNull(value.parseError) ??
    'Provider request failed'
  );
}

function evidence(response: Response, body: unknown): unknown {
  return { httpStatus: response.status, body };
}

function epoch(value: unknown, field: string): Date {
  const seconds = number(value, field);
  const result = new Date(seconds * 1_000);
  if (!Number.isFinite(result.getTime()))
    throw new Error(`${field} is invalid`);
  return result;
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} is not a finite number`);
  }
  return value;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
