import type {
  RouteProvider,
  RouteProviderQueryInput,
  RouteProviderResult,
} from '@travel/application';
import type {
  NormalizedRouteCandidate,
  RouteCandidateLeg,
  RouteLocation,
  RouteMode,
  RouteTimePoint,
} from '@travel/domain';

import { normalizeGoogleConsumerTransitBaseUrl } from './config.js';

const PROVIDER = 'GOOGLE_CONSUMER_EXPERIMENTAL';
const MAX_RESPONSE_CHARACTERS = 5_000_000;

export interface GoogleConsumerExperimentalRouteProviderOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly fetchImplementation?: typeof fetch;
}

interface SidecarQuery {
  readonly origin: SidecarLocationInput;
  readonly destination: SidecarLocationInput;
  readonly date: string;
  readonly time: string;
  readonly timezone: string;
  readonly timeMode: 'DEPART_AT' | 'ARRIVE_BY';
}

interface SidecarLocationInput {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
}

interface ParsedLeg {
  readonly mode: RouteMode;
  readonly from: RouteLocation | null;
  readonly to: RouteLocation | null;
  readonly departure: RouteTimePoint | null;
  readonly arrival: RouteTimePoint | null;
  readonly durationSeconds: number | null;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
}

class InvalidUpstreamResponse extends Error {}

export class GoogleConsumerExperimentalRouteProvider implements RouteProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: GoogleConsumerExperimentalRouteProviderOptions) {
    this.baseUrl = normalizeGoogleConsumerTransitBaseUrl(options.baseUrl);
    this.token = options.token.trim();
    if (this.token === '') {
      throw new Error('Google Consumer Transit token is required');
    }
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 120_000
    ) {
      throw new Error('Google Consumer Transit timeout is invalid');
    }
    this.timeoutMs = options.timeoutMs;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async queryRoutes(
    input: RouteProviderQueryInput,
  ): Promise<RouteProviderResult> {
    if (input.preference.type === 'NONE') {
      return { status: 'UNSUPPORTED_QUERY' };
    }
    const query = toSidecarQuery(input);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(
        new URL('/v1/transit/search', this.baseUrl),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(query),
          signal: controller.signal,
        },
      );
      const body = await readResponseBody(response);
      if (!response.ok) return mapSidecarError(body);
      if (isSidecarError(body)) return mapSidecarError(body);
      return {
        status: 'SUCCESS',
        candidates: parseSearchResponse(body, query, input),
      };
    } catch {
      return {
        status: 'PROVIDER_UNAVAILABLE',
        reason: 'UPSTREAM_UNAVAILABLE',
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toSidecarQuery(input: RouteProviderQueryInput): SidecarQuery {
  if (input.preference.type === 'NONE') {
    throw new Error('An explicit route time preference is required');
  }
  const local = localDateAndTime(
    input.preference.instant,
    input.preference.timeZone,
  );
  return {
    origin: {
      label: input.origin.name,
      latitude: input.origin.latitude,
      longitude: input.origin.longitude,
    },
    destination: {
      label: input.destination.name,
      latitude: input.destination.latitude,
      longitude: input.destination.longitude,
    },
    date: local.date,
    time: local.time,
    timezone: input.preference.timeZone,
    timeMode: input.preference.type,
  };
}

export function localDateAndTime(
  instant: Date,
  timeZone: string,
): { readonly date: string; readonly time: string } {
  if (!Number.isFinite(instant.getTime())) {
    throw new Error('Route preference instant is invalid');
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((entry) => entry.type === type)?.value;
    if (part === undefined) throw new Error('Route preference timezone failed');
    return part;
  };
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_CHARACTERS
  ) {
    throw new InvalidUpstreamResponse('Sidecar response is too large');
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARACTERS) {
    throw new InvalidUpstreamResponse('Sidecar response is too large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidUpstreamResponse('Sidecar response is not JSON');
  }
}

function mapSidecarError(value: unknown): RouteProviderResult {
  const code = sidecarErrorCode(value);
  if (code === 'NO_ROUTES') return { status: 'NO_MATCHING_CANDIDATE' };
  if (code === 'UNSUPPORTED_MODE') return { status: 'UNSUPPORTED_QUERY' };
  return {
    status: 'PROVIDER_UNAVAILABLE',
    reason: 'UPSTREAM_UNAVAILABLE',
  };
}

function isSidecarError(value: unknown): boolean {
  return record(value)?.status === 'ERROR';
}

function sidecarErrorCode(value: unknown): string | null {
  const root = record(value);
  const error = record(root?.error);
  return root?.status === 'ERROR' && typeof error?.code === 'string'
    ? error.code
    : null;
}

function parseSearchResponse(
  value: unknown,
  query: SidecarQuery,
  input: RouteProviderQueryInput,
): readonly NormalizedRouteCandidate[] {
  const root = requireRecord(value, 'root');
  if (
    root.status !== 'OK' ||
    root.provider !== PROVIDER ||
    root.queryVerified !== true
  ) {
    throw new InvalidUpstreamResponse('Sidecar success envelope is invalid');
  }
  assertRequestedQuery(root.requestedQuery, query);
  const observedAt = requireInstant(root.fetchedAt, 'fetchedAt');
  const candidates = requireArray(root.candidates, 'candidates');
  const candidateCount = requireNonNegativeInteger(
    root.candidateCount,
    'candidateCount',
  );
  if (candidateCount !== candidates.length || candidateCount === 0) {
    throw new InvalidUpstreamResponse('candidateCount is inconsistent');
  }
  const seenIds = new Set<string>();
  return candidates.map((candidate, index) => {
    const normalized = parseCandidate(candidate, index, observedAt, input);
    if (seenIds.has(normalized.candidateId)) {
      throw new InvalidUpstreamResponse('Candidate IDs are not unique');
    }
    seenIds.add(normalized.candidateId);
    return normalized;
  });
}

function assertRequestedQuery(value: unknown, expected: SidecarQuery): void {
  const actual = requireRecord(value, 'requestedQuery');
  const origin = requireRecord(actual.origin, 'requestedQuery.origin');
  const destination = requireRecord(
    actual.destination,
    'requestedQuery.destination',
  );
  if (
    origin.label !== expected.origin.label ||
    origin.latitude !== expected.origin.latitude ||
    origin.longitude !== expected.origin.longitude ||
    destination.label !== expected.destination.label ||
    destination.latitude !== expected.destination.latitude ||
    destination.longitude !== expected.destination.longitude ||
    actual.date !== expected.date ||
    actual.time !== expected.time ||
    actual.timezone !== expected.timezone ||
    actual.timeMode !== expected.timeMode
  ) {
    throw new InvalidUpstreamResponse('Sidecar echoed a different query');
  }
}

function parseCandidate(
  value: unknown,
  index: number,
  observedAt: Date,
  input: RouteProviderQueryInput,
): NormalizedRouteCandidate {
  const raw = requireRecord(value, `candidates[${index}]`);
  const rawId = requireNonEmptyString(raw.id, `candidates[${index}].id`);
  requireNonNegativeInteger(
    raw.sourceIndex,
    `candidates[${index}].sourceIndex`,
  );
  const departure = requireZonedTime(
    raw.departureTime,
    `candidates[${index}].departureTime`,
  );
  const arrival = requireZonedTime(
    raw.arrivalTime,
    `candidates[${index}].arrivalTime`,
  );
  const durationSeconds = requireNonNegativeInteger(
    raw.durationSeconds,
    `candidates[${index}].durationSeconds`,
  );
  if (
    arrival.instant.getTime() - departure.instant.getTime() !==
    durationSeconds * 1_000
  ) {
    throw new InvalidUpstreamResponse('Candidate duration is inconsistent');
  }
  const rawLegs = requireArray(raw.legs, `candidates[${index}].legs`);
  if (rawLegs.length === 0) {
    throw new InvalidUpstreamResponse('Candidate has no legs');
  }
  const parsedLegs = rawLegs.map((leg, legIndex) =>
    parseLeg(leg, `candidates[${index}].legs[${legIndex}]`),
  );
  assertLegTimingWithinCandidate(parsedLegs, departure, arrival);
  const boundaries = resolveBoundaries(parsedLegs, input);
  const legs: RouteCandidateLeg[] = parsedLegs.map((leg, legIndex) => ({
    mode: leg.mode,
    from: boundaries[legIndex]!,
    to: boundaries[legIndex + 1]!,
    departure: leg.departure,
    arrival: leg.arrival,
    durationSeconds: leg.durationSeconds,
    fixedService: leg.fixedService,
    serviceLabel: leg.serviceLabel,
    providerRef: `${rawId}:leg:${legIndex}`,
  }));
  return {
    candidateId: `${PROVIDER}:${rawId}`,
    provider: PROVIDER,
    providerCandidateRef: rawId,
    observedAt,
    validUntil: null,
    departure,
    arrival,
    durationSeconds,
    legs,
    fare: parseFare(raw.fare),
  };
}

function assertLegTimingWithinCandidate(
  legs: readonly ParsedLeg[],
  departure: RouteTimePoint,
  arrival: RouteTimePoint,
): void {
  let previousInstant = departure.instant.getTime();
  for (const leg of legs) {
    for (const point of [leg.departure, leg.arrival]) {
      if (point === null) continue;
      const instant = point.instant.getTime();
      if (
        instant < departure.instant.getTime() ||
        instant > arrival.instant.getTime() ||
        instant < previousInstant
      ) {
        throw new InvalidUpstreamResponse(
          'Candidate leg timing is outside the overall itinerary',
        );
      }
      previousInstant = instant;
    }
  }
}

function parseLeg(value: unknown, field: string): ParsedLeg {
  const raw = requireRecord(value, field);
  const mode = mapMode(raw.mode, `${field}.mode`);
  const departure = optionalZonedTime(
    raw.departureTime,
    `${field}.departureTime`,
  );
  const arrival = optionalZonedTime(raw.arrivalTime, `${field}.arrivalTime`);
  const durationSeconds = optionalNonNegativeInteger(
    raw.durationSeconds,
    `${field}.durationSeconds`,
  );
  if (
    departure !== null &&
    arrival !== null &&
    (arrival.instant < departure.instant ||
      (durationSeconds !== null &&
        arrival.instant.getTime() - departure.instant.getTime() !==
          durationSeconds * 1_000))
  ) {
    throw new InvalidUpstreamResponse(`${field} timing is inconsistent`);
  }
  const from = optionalLocation(raw.from, `${field}.from`);
  const to = optionalLocation(raw.to, `${field}.to`);
  const serviceName = optionalString(raw.serviceName, `${field}.serviceName`);
  const lineName = optionalString(raw.lineName, `${field}.lineName`);
  return {
    mode,
    from,
    to,
    departure,
    arrival,
    durationSeconds,
    fixedService:
      (mode === 'BUS' || mode === 'RAIL' || mode === 'FERRY') &&
      departure !== null &&
      arrival !== null,
    serviceLabel: serviceName ?? lineName,
  };
}

function resolveBoundaries(
  legs: readonly ParsedLeg[],
  input: RouteProviderQueryInput,
): readonly RouteLocation[] {
  const result: RouteLocation[] = [
    legs[0]!.from ?? providerLocation(input.origin),
  ];
  for (let index = 0; index + 1 < legs.length; index += 1) {
    const left = legs[index]!.to;
    const right = legs[index + 1]!.from;
    const boundary = resolveInteriorBoundary(left, right);
    if (boundary.latitude === null || boundary.longitude === null) {
      throw new InvalidUpstreamResponse(
        'An interior leg boundary has no canonical coordinates',
      );
    }
    result.push(boundary);
  }
  result.push(legs.at(-1)!.to ?? providerLocation(input.destination));
  return result;
}

function resolveInteriorBoundary(
  left: RouteLocation | null,
  right: RouteLocation | null,
): RouteLocation {
  if (left === null && right === null) {
    throw new InvalidUpstreamResponse('An interior leg boundary is missing');
  }
  if (left === null) return right!;
  if (right === null) return left;
  if (
    left.latitude === null ||
    left.longitude === null ||
    right.latitude === null ||
    right.longitude === null ||
    left.latitude !== right.latitude ||
    left.longitude !== right.longitude
  ) {
    throw new InvalidUpstreamResponse('Adjacent legs are not continuous');
  }
  return left;
}

function providerLocation(
  input: RouteProviderQueryInput['origin'],
): RouteLocation {
  return {
    name: input.name,
    latitude: input.latitude,
    longitude: input.longitude,
    providerPlaceRef: null,
    providerHubRef: null,
  };
}

function optionalLocation(value: unknown, field: string): RouteLocation | null {
  if (value === null) return null;
  const raw = requireRecord(value, field);
  const name = requireNonEmptyString(raw.name, `${field}.name`);
  const latitude = nullableCoordinate(
    raw.latitude,
    `${field}.latitude`,
    -90,
    90,
  );
  const longitude = nullableCoordinate(
    raw.longitude,
    `${field}.longitude`,
    -180,
    180,
  );
  if ((latitude === null) !== (longitude === null)) {
    throw new InvalidUpstreamResponse(`${field} has partial coordinates`);
  }
  return {
    name,
    latitude,
    longitude,
    providerPlaceRef: null,
    providerHubRef: null,
  };
}

function requireZonedTime(value: unknown, field: string): RouteTimePoint {
  const point = optionalZonedTime(value, field);
  if (point === null) throw new InvalidUpstreamResponse(`${field} is missing`);
  return point;
}

function optionalZonedTime(
  value: unknown,
  field: string,
): RouteTimePoint | null {
  if (value === null) return null;
  const raw = requireRecord(value, field);
  const localDateTime = requireNonEmptyString(
    raw.localDateTime,
    `${field}.localDateTime`,
  );
  const timeZone = requireNonEmptyString(raw.timezone, `${field}.timezone`);
  const instant = requireInstant(raw.utc, `${field}.utc`);
  if (formatLocalDateTime(instant, timeZone) !== localDateTime) {
    throw new InvalidUpstreamResponse(`${field} local and UTC values disagree`);
  }
  return { instant, timeZone };
}

function formatLocalDateTime(instant: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
  } catch {
    throw new InvalidUpstreamResponse('Sidecar timezone is invalid');
  }
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
}

function mapMode(value: unknown, field: string): RouteMode {
  switch (value) {
    case 'WALK':
      return 'WALKING';
    case 'BUS':
      return 'BUS';
    case 'TRAIN':
    case 'SUBWAY':
    case 'TRAM':
      return 'RAIL';
    case 'FERRY':
      return 'FERRY';
    case 'OTHER':
      return 'OTHER';
    default:
      throw new InvalidUpstreamResponse(`${field} is unsupported`);
  }
}

function parseFare(
  value: unknown,
): { amount: string; currency: string } | null {
  if (value === null) return null;
  const raw = requireRecord(value, 'fare');
  if (
    typeof raw.amount !== 'number' ||
    !Number.isFinite(raw.amount) ||
    raw.amount < 0 ||
    typeof raw.currency !== 'string' ||
    !/^[A-Z]{3}$/u.test(raw.currency)
  ) {
    return null;
  }
  const amount = String(raw.amount);
  return /^(0|[1-9]\d*)(?:\.\d+)?$/u.test(amount)
    ? { amount, currency: raw.currency }
    : null;
}

function requireInstant(value: unknown, field: string): Date {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new InvalidUpstreamResponse(`${field} is not a UTC instant`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new InvalidUpstreamResponse(`${field} is invalid`);
  }
  return instant;
}

function nullableCoordinate(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidUpstreamResponse(`${field} is invalid`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new InvalidUpstreamResponse(`${field} is invalid`);
  }
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidUpstreamResponse(`${field} is invalid`);
  }
  return value.trim();
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidUpstreamResponse(`${field} is invalid`);
  }
  return value as number;
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  return value === null ? null : requireNonNegativeInteger(value, field);
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new InvalidUpstreamResponse(`${field} is invalid`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const result = record(value);
  if (result === null) {
    throw new InvalidUpstreamResponse(`${field} is invalid`);
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
