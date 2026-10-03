export const PROVIDER = 'GOOGLE_CONSUMER_EXPERIMENTAL';
export type TimeMode = 'DEPART_AT' | 'ARRIVE_BY';
export interface LocationInput {
  label: string;
  latitude: number;
  longitude: number;
}
export interface Query {
  origin: LocationInput;
  destination: LocationInput;
  date: string;
  time: string;
  timezone: string;
  timeMode: TimeMode;
}
export interface TimePoint {
  localDateTime: string;
  timezone: string;
  utc: string;
}
export interface Stop {
  name: string;
  latitude: number;
  longitude: number;
}
export interface Leg {
  mode: 'WALK' | 'BUS' | 'TRAIN' | 'SUBWAY' | 'TRAM' | 'FERRY';
  from: Stop | null;
  to: Stop | null;
  departureTime: TimePoint | null;
  arrivalTime: TimePoint | null;
  durationSeconds: number | null;
  lineName: string | null;
  serviceName: string | null;
}
export interface Candidate {
  id: string;
  sourceIndex: number;
  departureTime: TimePoint;
  arrivalTime: TimePoint;
  durationSeconds: number;
  fare: { amount: number; currency: string; displayText: string } | null;
  legs: Leg[];
}
export interface SearchResult {
  status: 'OK';
  provider: typeof PROVIDER;
  queryVerified: true;
  requestedQuery: Query;
  fetchedAt: string;
  candidateCount: number;
  candidates: Candidate[];
  cacheHit: false;
  evidence: {
    modeVisible: true;
    dateVisible: true;
    timeVisible: true;
    pageStateMatches: true;
    timezoneMatches: true;
    selectedResponseIndex: number;
    responseCount: number;
  };
}
export const errorStatuses = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  UNSUPPORTED_MODE: 422,
  UNSUPPORTED_QUERY: 422,
  BUSY: 429,
  PROVIDER_DISABLED: 503,
  BROWSER_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_BLOCKED: 502,
  UPSTREAM_ERROR: 502,
  REQUEST_CANCELLED: 499,
  REQUEST_MISMATCH: 502,
  SCHEMA_CHANGED: 502,
  NO_ROUTES: 404,
} as const;
export type ErrorCode = keyof typeof errorStatuses;
export class TransitError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly stage: string | undefined = undefined,
  ) {
    super(code);
  }
  get statusCode(): number {
    return errorStatuses[this.code];
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TransitError('VALIDATION_ERROR');
  return value as Record<string, unknown>;
}
function location(value: unknown): LocationInput {
  const v = record(value);
  if (
    typeof v.label !== 'string' ||
    !v.label.trim() ||
    v.label.length > 300 ||
    typeof v.latitude !== 'number' ||
    !Number.isFinite(v.latitude) ||
    Math.abs(v.latitude) > 90 ||
    typeof v.longitude !== 'number' ||
    !Number.isFinite(v.longitude) ||
    Math.abs(v.longitude) > 180
  )
    throw new TransitError('VALIDATION_ERROR');
  return { label: v.label, latitude: v.latitude, longitude: v.longitude };
}
export function localDateTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (key: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === key)!.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}
export function parseQuery(value: unknown): Query {
  const v = record(value);
  if (
    typeof v.date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v.date) ||
    !Number.isFinite(Date.parse(v.date)) ||
    new Date(v.date).toISOString().slice(0, 10) !== v.date ||
    typeof v.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time) ||
    typeof v.timezone !== 'string'
  )
    throw new TransitError('VALIDATION_ERROR');
  try {
    new Intl.DateTimeFormat('en', { timeZone: v.timezone });
  } catch {
    throw new TransitError('VALIDATION_ERROR');
  }
  if (v.timeMode === 'NOW' || v.timeMode === 'LAST_TRANSIT')
    throw new TransitError('UNSUPPORTED_MODE');
  if (v.timeMode !== 'DEPART_AT' && v.timeMode !== 'ARRIVE_BY')
    throw new TransitError('VALIDATION_ERROR');
  const query: Query = {
    origin: location(v.origin),
    destination: location(v.destination),
    date: v.date,
    time: v.time,
    timezone: v.timezone,
    timeMode: v.timeMode,
  };
  queryInstant(query); // rejects nonexistent or ambiguous local clocks; never uses host timezone
  return query;
}
export function wallClock(query: Query): number {
  return Date.parse(`${query.date}T${query.time}:00Z`) / 1000;
}
export function queryInstant(query: Query): number {
  const target = `${query.date}T${query.time}:00`;
  const wall = wallClock(query) * 1000;
  const offsets = new Set<number>();
  // Sampling both sides of DST finds the applicable offsets, then validates exact round trips.
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = wall + delta;
    offsets.add(
      Date.parse(localDateTime(new Date(sample), query.timezone) + 'Z') -
        sample,
    );
  }
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter(
      (instant) => localDateTime(new Date(instant), query.timezone) === target,
    );
  if (matches.length !== 1) throw new TransitError('VALIDATION_ERROR');
  return matches[0]!;
}
