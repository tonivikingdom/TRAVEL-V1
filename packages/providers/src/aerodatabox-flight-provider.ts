import {
  ApplicationError,
  type FlightLookupInput,
  type FlightSnapshotProvider,
} from '@travel/application';
import type {
  FlightDelayBasis,
  FlightMovementView,
  FlightSnapshotView,
  FlightStatus,
} from '@travel/contracts';

type JsonRecord = Record<string, unknown>;
type FetchImplementation = typeof fetch;

export interface AeroDataBoxFlightProviderOptions {
  readonly host?: string;
  readonly fetchImpl?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly cacheTtlMs?: number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly snapshots: readonly FlightSnapshotView[];
}

const STATUS_MAP: Readonly<Record<string, FlightStatus>> = {
  scheduled: 'SCHEDULED',
  expected: 'SCHEDULED',
  checkin: 'SCHEDULED',
  boarding: 'BOARDING',
  gateclosed: 'BOARDING',
  departed: 'DEPARTED',
  enroute: 'EN_ROUTE',
  inair: 'EN_ROUTE',
  approaching: 'EN_ROUTE',
  landed: 'LANDED',
  arrived: 'ARRIVED',
  delayed: 'DELAYED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
  diverted: 'DIVERTED',
};

export class AeroDataBoxFlightProvider implements FlightSnapshotProvider {
  private readonly host: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly apiKey: string,
    options: AeroDataBoxFlightProviderOptions = {},
  ) {
    if (apiKey.trim() === '') throw providerNotConfigured();
    this.host = options.host ?? 'aerodatabox.p.rapidapi.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? 120_000;
  }

  search(input: FlightLookupInput): Promise<readonly FlightSnapshotView[]> {
    return this.request(input, false);
  }

  refresh(input: FlightLookupInput): Promise<readonly FlightSnapshotView[]> {
    return this.request(input, true);
  }

  private async request(
    input: FlightLookupInput,
    bypassCache: boolean,
  ): Promise<readonly FlightSnapshotView[]> {
    const flightNumber = normalizeFlightNumber(input.flightNumber);
    if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/u.test(flightNumber)) {
      throw new ApplicationError('VALIDATION_ERROR', '航班号格式无效。', 400);
    }
    if (!validDateOnly(input.date)) {
      throw new ApplicationError('VALIDATION_ERROR', '航班日期格式无效。', 400);
    }
    const key = `${flightNumber}:${input.date}`;
    const now = this.now();
    if (!bypassCache) {
      const hit = this.cache.get(key);
      if (hit !== undefined && hit.expiresAt > now.getTime()) {
        return hit.snapshots;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://${this.host}/flights/number/${encodeURIComponent(flightNumber)}/${input.date}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'X-RapidAPI-Key': this.apiKey,
            'X-RapidAPI-Host': this.host,
          },
          cache: 'no-store',
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ApplicationError(
          'FLIGHT_PROVIDER_TIMEOUT',
          '航班数据源请求超时。',
          504,
          true,
        );
      }
      throw new ApplicationError(
        'FLIGHT_PROVIDER_UNAVAILABLE',
        '航班数据源暂时不可用。',
        502,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApplicationError(
        'FLIGHT_PROVIDER_AUTH_ERROR',
        '航班数据源认证失败。',
        502,
      );
    }
    if (response.status === 429) {
      throw new ApplicationError(
        'FLIGHT_PROVIDER_RATE_LIMIT',
        '航班数据源请求频率受限。',
        429,
        true,
      );
    }
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new ApplicationError(
        response.status >= 500
          ? 'FLIGHT_PROVIDER_UNAVAILABLE'
          : 'FLIGHT_PROVIDER_BAD_RESPONSE',
        '航班数据源返回异常。',
        502,
        response.status >= 500,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw badResponse();
    }
    const records = payloadRecords(payload);
    if (records === null) throw badResponse();
    const seen = new Map<string, number>();
    const snapshots = records.map((record, index) => {
      const snapshot = normalizeSnapshot(
        record,
        flightNumber,
        input.date,
        now.toISOString(),
        index,
      );
      const count = (seen.get(snapshot.candidateId) ?? 0) + 1;
      seen.set(snapshot.candidateId, count);
      return count === 1
        ? snapshot
        : { ...snapshot, candidateId: `${snapshot.candidateId}:${count}` };
    });
    if (!bypassCache) {
      this.cache.set(key, {
        expiresAt: now.getTime() + this.cacheTtlMs,
        snapshots,
      });
    }
    return snapshots;
  }
}

function normalizeSnapshot(
  value: unknown,
  canonicalFlightNumber: string,
  serviceDate: string,
  fetchedAt: string,
  index: number,
): FlightSnapshotView {
  const source = record(value);
  if (source === null) throw badResponse();
  const departure = movement(source.departure);
  const arrival = movement(source.arrival);
  const airline = record(source.airline);
  const aircraft = record(source.aircraft);
  const rawStatus = text(source.status);
  const normalizedStatus = normalizeStatus(rawStatus);
  const fallback = `${canonicalFlightNumber}:${serviceDate}:${departure.airportIata ?? ''}:${arrival.airportIata ?? ''}:${departure.scheduledUtc ?? index}`;
  const candidateId = `aerodatabox:${firstText(source.id, source.flightId, source.flightID) ?? fallback}`;
  const departureDelay = delay(departure);
  const arrivalDelay = delay(arrival);
  return {
    provider: 'aerodatabox',
    candidateId,
    canonicalFlightNumber,
    displayFlightNumber:
      firstText(source.number, source.flightNumber) ?? canonicalFlightNumber,
    serviceDate,
    status: normalizedStatus,
    rawStatus,
    airline: {
      name: firstText(airline?.name),
      iata: firstText(airline?.iata),
      icao: firstText(airline?.icao),
    },
    departure,
    arrival,
    aircraft:
      aircraft === null && firstText(source.callSign, source.callsign) === null
        ? null
        : {
            model: firstText(aircraft?.model, aircraft?.name),
            registration: firstText(aircraft?.reg, aircraft?.registration),
            icao24: firstText(aircraft?.modeS, aircraft?.icao24),
            callSign: firstText(source.callSign, source.callsign),
          },
    departureDelayMinutes: departureDelay.minutes,
    arrivalDelayMinutes: arrivalDelay.minutes,
    departureDelayBasis: departureDelay.basis,
    arrivalDelayBasis: arrivalDelay.basis,
    fetchedAt,
  };
}

function movement(value: unknown): FlightMovementView {
  const source = record(value) ?? {};
  const airport = record(source.airport) ?? {};
  const timeZone = firstText(
    airport.timeZone,
    airport.timezone,
    airport.timeZoneId,
  );
  const scheduled = normalizeTime(source.scheduledTime, timeZone);
  const revised = normalizeTime(source.revisedTime, timeZone);
  const predicted = normalizeTime(source.predictedTime, timeZone);
  const runway = normalizeTime(source.runwayTime, timeZone);
  return {
    airportName: firstText(airport.name, airport.shortName),
    airportIata: firstText(airport.iata, airport.iataCode),
    airportIcao: firstText(airport.icao, airport.icaoCode),
    timeZone,
    scheduledLocal: scheduled.local,
    scheduledUtc: scheduled.utc,
    revisedLocal: revised.local,
    revisedUtc: revised.utc,
    predictedLocal: predicted.local,
    predictedUtc: predicted.utc,
    runwayLocal: runway.local,
    runwayUtc: runway.utc,
    terminal: text(source.terminal),
    gate: text(source.gate),
    checkInDesk: text(source.checkInDesk),
    baggageBelt: text(source.baggageBelt),
  };
}

function normalizeTime(
  value: unknown,
  timeZone: string | null,
): { local: string | null; utc: string | null } {
  const source = record(value);
  const local = source === null ? text(value) : text(source.local);
  const utc = source === null ? null : text(source.utc);
  const instant = parseTime(utc, 'UTC') ?? parseTime(local, timeZone);
  if (instant === null) return { local: null, utc: null };
  return {
    local: localWithOffset(local, instant, timeZone),
    utc: new Date(instant).toISOString(),
  };
}

function parseTime(
  value: string | null,
  timeZone: string | null,
): number | null {
  if (value === null) return null;
  const normalized = value.includes(' ') ? value.replace(' ', 'T') : value;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(normalized)) {
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const match = normalized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u,
  );
  if (match === null || timeZone === null) return null;
  const [, year, month, day, hour, minute, second = '00', fraction = ''] =
    match;
  const wall = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0')),
  );
  let instant = wall;
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(instant));
      const part = (name: string) =>
        Number(parts.find((item) => item.type === name)?.value ?? '0');
      const represented = Date.UTC(
        part('year'),
        part('month') - 1,
        part('day'),
        part('hour'),
        part('minute'),
        part('second'),
      );
      instant -= represented - wall;
    }
    return instant;
  } catch {
    return null;
  }
}

function localWithOffset(
  original: string | null,
  instant: number,
  timeZone: string | null,
): string {
  if (original !== null && /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(original)) {
    return original.replace(' ', 'T');
  }
  if (timeZone === null) return new Date(instant).toISOString();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }).formatToParts(new Date(instant));
    const get = (name: string) =>
      parts.find((part) => part.type === name)?.value ?? '00';
    const zone =
      parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${zone === 'GMT' ? 'Z' : zone.replace(/^GMT/u, '')}`;
  } catch {
    return new Date(instant).toISOString();
  }
}

function delay(movement: FlightMovementView): {
  minutes: number | null;
  basis: FlightDelayBasis | null;
} {
  const scheduled = epoch(movement.scheduledUtc);
  const runway = epoch(movement.runwayUtc);
  const revised = epoch(movement.revisedUtc);
  const observed = runway ?? revised;
  if (scheduled === null || observed === null) {
    return { minutes: null, basis: null };
  }
  return {
    minutes: Math.round((observed - scheduled) / 60_000),
    basis: runway === null ? 'REVISED_TIME' : 'RUNWAY_TIME',
  };
}

function epoch(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeStatus(value: string | null): FlightStatus {
  const key = (value ?? '').toLowerCase().replace(/[_\s-]+/gu, '');
  return STATUS_MAP[key] ?? 'UNKNOWN';
}

function payloadRecords(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  const source = record(value);
  if (source === null) return null;
  if (Array.isArray(source.flights)) return source.flights;
  if (Array.isArray(source.data)) return source.data;
  return null;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function firstText(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const result = text(value);
    if (result !== null) return result;
  }
  return null;
}

function badResponse() {
  return new ApplicationError(
    'FLIGHT_PROVIDER_BAD_RESPONSE',
    '航班数据源返回的数据无法解析。',
    502,
  );
}

function providerNotConfigured() {
  return new ApplicationError(
    'FLIGHT_PROVIDER_NOT_CONFIGURED',
    '航班数据源尚未配置。',
    503,
    true,
  );
}

function normalizeFlightNumber(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/gu, '');
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}
