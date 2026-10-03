import {
  localDateTime,
  queryInstant,
  TransitError,
  type Candidate,
  type Leg,
  type Query,
  type Stop,
  type TimePoint,
} from './contract.js';

export function slot(value: unknown, path: readonly number[]): unknown {
  return path.reduce<unknown>(
    (node, index) => (Array.isArray(node) ? node[index] : undefined),
    value,
  );
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TransitError('SCHEMA_CHANGED');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TransitError('SCHEMA_CHANGED');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TransitError('SCHEMA_CHANGED');
  return value as number;
}
function coordinate(value: unknown, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > max
  )
    throw new TransitError('SCHEMA_CHANGED');
  return value;
}
function point(value: unknown): TimePoint {
  const v = array(value);
  const instant = new Date(integer(v[0]) * 1000);
  const timezone = text(v[1]);
  try {
    return {
      utc: instant.toISOString(),
      timezone,
      localDateTime: localDateTime(instant, timezone),
    };
  } catch {
    throw new TransitError('SCHEMA_CHANGED');
  }
}
function stop(value: unknown): Stop {
  const v = array(value);
  return {
    name: text(v[0]),
    latitude: coordinate(slot(v, [4, 2]), 90),
    longitude: coordinate(slot(v, [4, 3]), 180),
  };
}
function tag(summary: unknown[], key: number): string | null {
  const tags = array(summary[14]);
  const entry = tags.find((t) => slot(t, [0]) === key);
  const value = slot(entry, [1, 0]);
  return typeof value === 'string' && value.trim() ? value : null;
}
function leg(value: unknown): Leg {
  const v = array(value);
  const summary = array(v[0]);
  const label = text(slot(summary, [14, 0, 2, 3]));
  const modes: Record<string, Leg['mode']> = {
    Walk: 'WALK',
    Bus: 'BUS',
    Train: 'TRAIN',
    Subway: 'SUBWAY',
    Tram: 'TRAM',
    Ferry: 'FERRY',
  };
  const mode = modes[label];
  if (!mode) throw new TransitError('SCHEMA_CHANGED');
  const durationSeconds = integer(slot(summary, [3, 0]));
  if (mode === 'WALK')
    return {
      mode,
      from: null,
      to: null,
      departureTime: null,
      arrivalTime: null,
      durationSeconds,
      lineName: null,
      serviceName: null,
    };
  const transit = array(v[5]);
  const departureTime = point(slot(transit, [0, 3]));
  const arrivalTime = point(slot(transit, [1, 2]));
  if (
    Date.parse(arrivalTime.utc) - Date.parse(departureTime.utc) !==
    durationSeconds * 1000
  )
    throw new TransitError('SCHEMA_CHANGED');
  return {
    mode,
    from: stop(transit[0]),
    to: stop(transit[1]),
    departureTime,
    arrivalTime,
    durationSeconds,
    lineName: tag(summary, 5),
    serviceName: tag(summary, 6),
  };
}
function fare(value: unknown): Candidate['fare'] {
  if (value === null || value === undefined) return null;
  const v = array(value);
  if (
    typeof v[0] !== 'number' ||
    !Number.isFinite(v[0]) ||
    v[0] < 0 ||
    typeof v[1] !== 'string' ||
    typeof v[2] !== 'string' ||
    !/^[A-Z]{3}$/.test(v[2])
  )
    return null;
  return { amount: v[0], displayText: v[1], currency: v[2] };
}
export interface ParsedResponse {
  candidates: Candidate[];
  markers: { departure: string; arrival: string; line: string | null }[];
  endpoints: [Stop, Stop];
}
export function parseResponse(raw: string): ParsedResponse {
  if (raw.length > 5_000_000) throw new TransitError('SCHEMA_CHANGED');
  let root: unknown;
  try {
    root = JSON.parse(raw.replace(/^\)\]\}'\s*\n?/u, ''));
  } catch {
    throw new TransitError('SCHEMA_CHANGED');
  }
  const endpoints = [0, 1].map((i) => ({
    name: 'Query endpoint',
    latitude: coordinate(slot(root, [0, 0, i, 0, 0, 2, 2]), 90),
    longitude: coordinate(slot(root, [0, 0, i, 0, 0, 2, 3]), 180),
  })) as [Stop, Stop];
  const routes = array(slot(root, [0, 1]));
  if (routes.length > 30) throw new TransitError('SCHEMA_CHANGED');
  const markers: ParsedResponse['markers'] = [];
  const candidates = routes.map((r, sourceIndex): Candidate => {
    const summary = array(slot(r, [0]));
    const departureTime = point(slot(summary, [5, 0]));
    const arrivalTime = point(slot(summary, [5, 1]));
    const durationSeconds = integer(slot(summary, [3, 0]));
    if (
      !durationSeconds ||
      Date.parse(arrivalTime.utc) - Date.parse(departureTime.utc) !==
        durationSeconds * 1000
    )
      throw new TransitError('SCHEMA_CHANGED');
    const rawLegs = array(slot(r, [1, 0, 1]));
    if (!rawLegs.length || rawLegs.length > 100)
      throw new TransitError('SCHEMA_CHANGED');
    const legs = rawLegs.map(leg);
    if (!legs.some((l) => l.mode !== 'WALK'))
      throw new TransitError('SCHEMA_CHANGED');
    // Null walking endpoints stay unknown. Two directly adjacent transit legs must agree exactly.
    for (let i = 1; i < legs.length; i++) {
      const left = legs[i - 1]!.to,
        right = legs[i]!.from;
      if (
        left &&
        right &&
        (left.latitude !== right.latitude || left.longitude !== right.longitude)
      )
        throw new TransitError('SCHEMA_CHANGED');
      if (legs[i - 1]!.mode === 'WALK' && legs[i]!.mode === 'WALK')
        throw new TransitError('SCHEMA_CHANGED');
    }
    let cursor = Date.parse(departureTime.utc);
    for (const l of legs) {
      if (l.departureTime && l.arrivalTime) {
        if (
          Date.parse(l.departureTime.utc) < cursor ||
          Date.parse(l.arrivalTime.utc) > Date.parse(arrivalTime.utc)
        )
          throw new TransitError('SCHEMA_CHANGED');
        cursor = Date.parse(l.arrivalTime.utc);
      } else {
        cursor += l.durationSeconds! * 1000;
      }
    }
    if (
      cursor > Date.parse(arrivalTime.utc) ||
      legs.reduce((sum, l) => sum + l.durationSeconds!, 0) > durationSeconds
    )
      throw new TransitError('SCHEMA_CHANGED');
    markers.push({
      departure: text(slot(summary, [5, 0, 2])),
      arrival: text(slot(summary, [5, 1, 2])),
      line: legs.find((l) => l.lineName)?.lineName ?? null,
    });
    return {
      id: `google-${sourceIndex}-${Date.parse(departureTime.utc) / 1000}-${Date.parse(arrivalTime.utc) / 1000}`,
      sourceIndex,
      departureTime,
      arrivalTime,
      durationSeconds,
      fare: fare(summary[11]),
      legs,
    };
  });
  return { candidates, markers, endpoints };
}
export interface PageEvidence {
  modeVisible: boolean;
  dateVisible: boolean;
  timeVisible: boolean;
  pageStateMatches: boolean;
  timezoneMatches: boolean;
  text: string;
  noRoutesVisible: boolean;
}
function compact(value: string): string {
  return value.replace(/\s/gu, '').toLowerCase();
}
export function verifyResponse(
  parsed: ParsedResponse,
  query: Query,
  page: PageEvidence,
): void {
  if (
    !page.modeVisible ||
    !page.dateVisible ||
    !page.timeVisible ||
    !page.pageStateMatches ||
    !page.timezoneMatches
  )
    throw new TransitError('REQUEST_MISMATCH');
  for (const [index, location] of [query.origin, query.destination].entries()) {
    const actual = parsed.endpoints[index]!;
    if (
      Math.abs(actual.latitude - location.latitude) > 0.000001 ||
      Math.abs(actual.longitude - location.longitude) > 0.000001
    )
      throw new TransitError('REQUEST_MISMATCH');
  }
  if (!parsed.candidates.length) {
    if (page.noRoutesVisible) throw new TransitError('NO_ROUTES');
    throw new TransitError('REQUEST_MISMATCH');
  }
  const requested = queryInstant(query);
  for (const c of parsed.candidates) {
    const times = [
      c.departureTime,
      c.arrivalTime,
      ...c.legs
        .flatMap((l) => [l.departureTime, l.arrivalTime])
        .filter((t) => t !== null),
    ];
    if (times.some((t) => t.timezone !== query.timezone))
      throw new TransitError('REQUEST_MISMATCH');
    if (
      query.timeMode === 'DEPART_AT'
        ? Date.parse(c.departureTime.utc) < requested
        : Date.parse(c.arrivalTime.utc) > requested
    )
      throw new TransitError('REQUEST_MISMATCH');
  }
  const rendered = compact(page.text);
  // At least one entire candidate must be represented in the rendered page; no ordinal assumption.
  if (
    !parsed.markers.some(
      (m) =>
        rendered.includes(compact(m.departure)) &&
        rendered.includes(compact(m.arrival)) &&
        (m.line === null || rendered.includes(compact(m.line))),
    )
  )
    throw new TransitError('REQUEST_MISMATCH');
}
export function selectResponse(
  raws: readonly string[],
  query: Query,
  page: PageEvidence,
): { parsed: ParsedResponse; index: number } {
  let parsedAny = false;
  let confirmedEmpty = false;
  for (const [index, raw] of raws.entries()) {
    try {
      const parsed = parseResponse(raw);
      parsedAny = true;
      verifyResponse(parsed, query, page);
      return { parsed, index };
    } catch (e) {
      if (e instanceof TransitError && e.code === 'NO_ROUTES')
        confirmedEmpty = true;
      else if (!(e instanceof TransitError))
        throw new TransitError('SCHEMA_CHANGED');
    }
  }
  if (confirmedEmpty) throw new TransitError('NO_ROUTES');
  throw new TransitError(parsedAny ? 'REQUEST_MISMATCH' : 'SCHEMA_CHANGED');
}
