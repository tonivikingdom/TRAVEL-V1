import type {
  AdoptFlightRequest,
  AdoptFlightResponse,
  FlightChangeSummaryView,
  FlightChangeKind,
  FlightMovementView,
  FlightSearchResponse,
  FlightSnapshotView,
  RefreshFlightResponse,
} from '@travel/contracts';

import type { Actor } from './authorization.js';
import { authorize } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  FlightRepository,
  FlightSnapshotProvider,
} from './flight-ports.js';
import type { ExecutionRiskService } from './execution-risk-service.js';
import {
  parseAbsoluteInstantInput,
  validateIanaTimeZoneInput,
} from './time-input.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FLIGHT_NUMBER = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const FLIGHT_STATUSES = new Set([
  'SCHEDULED',
  'BOARDING',
  'DEPARTED',
  'EN_ROUTE',
  'LANDED',
  'ARRIVED',
  'DELAYED',
  'CANCELLED',
  'DIVERTED',
  'UNKNOWN',
]);

export class FlightService {
  constructor(
    private readonly provider: FlightSnapshotProvider,
    private readonly repository: FlightRepository,
    private readonly executionRiskService: ExecutionRiskService,
  ) {}

  async search(actor: Actor, input: unknown): Promise<FlightSearchResponse> {
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const parsed = parseLookup(input);
    const flights = await this.provider.search(parsed);
    if (flights.length === 0) throw flightNotFound();
    return { flights };
  }

  async adopt(
    actor: Actor,
    tripId: string,
    input: AdoptFlightRequest,
  ): Promise<AdoptFlightResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(input.transportEdgeId, 'transportEdgeId');
    requireVersion(input.baseTripVersion);
    validateSnapshot(input.flight, true);
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const result = await this.repository.adopt({
      ownerUserId: actor.userId,
      tripId,
      baseTripVersion: input.baseTripVersion,
      transportEdgeId: input.transportEdgeId,
      flight: input.flight,
    });
    if (result.status === 'NOT_FOUND') throw notFound();
    if (result.status === 'VERSION_CONFLICT') throw versionConflict();
    if (result.status === 'FACT_PROTECTED') {
      throw new ApplicationError(
        'FACT_PROTECTED',
        '该交通段已有 ACTUAL 事实，不能用普通航班绑定替换。',
        409,
      );
    }
    if (result.status === 'INVALID_TRANSPORT') {
      throw new ApplicationError(
        'FLIGHT_MISMATCH',
        '航班只能绑定到当前行程的 FLIGHT 交通段。',
        409,
      );
    }
    if (result.status !== 'SUCCESS') throw new Error('Unhandled adopt status');
    return {
      flightBinding: result.binding,
      resultingTripVersion: result.resultingTripVersion,
      idempotentReplay: result.idempotentReplay,
    };
  }

  async refresh(
    actor: Actor,
    tripId: string,
    flightBindingId: string,
  ): Promise<RefreshFlightResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(flightBindingId, 'flightBindingId');
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const current = await this.repository.findOwnedBinding({
      ownerUserId: actor.userId,
      tripId,
      flightBindingId,
    });
    if (current === null) throw notFound();

    // The provider call deliberately happens before the short database lock.
    const candidates = await this.provider.refresh({
      flightNumber: current.canonicalFlightNumber,
      date: current.serviceDate,
    });
    const flight = selectRefreshCandidate(current.selectedSnapshot, candidates);
    const changes = computeFlightChanges(current.latestSnapshot, flight);
    const result = await this.repository.refresh({
      ownerUserId: actor.userId,
      tripId,
      flightBindingId,
      flight,
    });
    if (result.status === 'NOT_FOUND') throw notFound();
    if (result.status === 'FLIGHT_MISMATCH') {
      throw new ApplicationError(
        'FLIGHT_MISMATCH',
        '航班绑定与当前行程交通段不一致。',
        409,
      );
    }
    if (result.status !== 'SUCCESS')
      throw new Error('Unhandled refresh status');
    const riskEvaluation = await this.executionRiskService.evaluateTripRisks(
      actor,
      tripId,
    );
    const requiresAttention =
      flight.status === 'CANCELLED' || flight.status === 'DIVERTED';
    return {
      flightBinding: result.binding,
      resultingTripVersion: result.resultingTripVersion,
      factsChanged: result.factsChanged,
      actualConflicts: result.actualConflicts,
      actualConflict: result.actualConflicts.length > 0,
      changes,
      requiresAttention,
      requiresRouteReevaluation: requiresAttention,
      riskEvaluation,
    };
  }
}

function parseLookup(value: unknown) {
  if (!isRecord(value)) throw validation('请求格式无效。');
  const flightNumber = normalizeFlightNumber(value.flightNumber);
  const date = typeof value.date === 'string' ? value.date : '';
  if (!FLIGHT_NUMBER.test(flightNumber)) throw validation('航班号格式无效。');
  if (!validDateOnly(date)) {
    throw validation('航班日期格式无效。');
  }
  return { flightNumber, date };
}

function validDateOnly(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export function normalizeFlightNumber(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/gu, '')
    : '';
}

export function selectRefreshCandidate(
  selected: FlightSnapshotView,
  candidates: readonly FlightSnapshotView[],
): FlightSnapshotView {
  const exact = candidates.find(
    (candidate) => candidate.candidateId === selected.candidateId,
  );
  if (exact !== undefined) return exact;
  const matches = candidates.filter(
    (candidate) =>
      candidate.canonicalFlightNumber === selected.canonicalFlightNumber &&
      candidate.serviceDate === selected.serviceDate &&
      candidate.departure.airportIata === selected.departure.airportIata &&
      candidate.arrival.airportIata === selected.arrival.airportIata &&
      candidate.departure.scheduledUtc === selected.departure.scheduledUtc,
  );
  if (matches.length === 0) throw flightNotFound();
  if (matches.length !== 1) {
    throw new ApplicationError(
      'FLIGHT_AMBIGUOUS',
      '航班刷新返回了多个无法唯一匹配的班次。',
      409,
    );
  }
  return matches[0]!;
}

export function computeFlightChanges(
  previous: FlightSnapshotView,
  next: FlightSnapshotView,
): FlightChangeSummaryView {
  const diff = (from: string | null, to: string | null) =>
    from === to ? null : { from, to };
  const status = diff(previous.status, next.status);
  const departureTime = diff(
    operationalTime(previous.departure),
    operationalTime(next.departure),
  );
  const arrivalTime = diff(
    operationalTime(previous.arrival),
    operationalTime(next.arrival),
  );
  const departureGate = diff(previous.departure.gate, next.departure.gate);
  const arrivalGate = diff(previous.arrival.gate, next.arrival.gate);
  const departureTerminal = diff(
    previous.departure.terminal,
    next.departure.terminal,
  );
  const arrivalTerminal = diff(
    previous.arrival.terminal,
    next.arrival.terminal,
  );
  const baggage = diff(previous.arrival.baggageBelt, next.arrival.baggageBelt);
  const aircraft = diff(
    previous.aircraft?.registration ?? previous.aircraft?.model ?? null,
    next.aircraft?.registration ?? next.aircraft?.model ?? null,
  );
  return {
    changeTypes: (
      [
        status === null ? null : 'STATUS_CHANGED',
        departureTime === null ? null : 'DEPARTURE_TIME_CHANGED',
        arrivalTime === null ? null : 'ARRIVAL_TIME_CHANGED',
        departureGate === null && arrivalGate === null ? null : 'GATE_CHANGED',
        departureTerminal === null && arrivalTerminal === null
          ? null
          : 'TERMINAL_CHANGED',
        baggage === null ? null : 'BAGGAGE_CHANGED',
        aircraft === null ? null : 'AIRCRAFT_CHANGED',
      ] as const
    ).filter((value): value is FlightChangeKind => value !== null),
    status,
    departureTime,
    arrivalTime,
    departureGate,
    arrivalGate,
    departureTerminal,
    arrivalTerminal,
    baggage,
    aircraft,
  };
}

function operationalTime(movement: FlightMovementView): string | null {
  return (
    movement.runwayUtc ?? movement.revisedUtc ?? movement.scheduledUtc ?? null
  );
}

function validateSnapshot(
  snapshot: unknown,
  requireSchedule: boolean,
): asserts snapshot is FlightSnapshotView {
  if (
    !isRecord(snapshot) ||
    snapshot.provider !== 'aerodatabox' ||
    typeof snapshot.canonicalFlightNumber !== 'string' ||
    !FLIGHT_NUMBER.test(snapshot.canonicalFlightNumber) ||
    typeof snapshot.serviceDate !== 'string' ||
    !validDateOnly(snapshot.serviceDate) ||
    typeof snapshot.candidateId !== 'string' ||
    snapshot.candidateId.trim() === '' ||
    typeof snapshot.status !== 'string' ||
    !FLIGHT_STATUSES.has(snapshot.status) ||
    typeof snapshot.fetchedAt !== 'string' ||
    !isRecord(snapshot.departure) ||
    !isRecord(snapshot.arrival)
  ) {
    throw validation('航班候选数据无效。');
  }

  validateMovement(snapshot.departure, 'departure', requireSchedule);
  validateMovement(snapshot.arrival, 'arrival', requireSchedule);
  parseAbsoluteInstantInput(snapshot.fetchedAt, 'flight.fetchedAt');
}

function validateMovement(
  movement: Record<string, unknown>,
  field: 'departure' | 'arrival',
  requireSchedule: boolean,
) {
  const scheduledUtc = nullableString(movement.scheduledUtc, field);
  const timeZone = nullableString(movement.timeZone, field);
  if (requireSchedule && (scheduledUtc === null || timeZone === null)) {
    throw validation('航班计划起降时间或机场时区缺失。');
  }
  if (timeZone !== null) validateIanaTimeZoneInput(timeZone);
  for (const key of [
    'scheduledUtc',
    'revisedUtc',
    'predictedUtc',
    'runwayUtc',
  ] as const) {
    const value = nullableString(movement[key], `${field}.${key}`);
    if (value !== null) parseAbsoluteInstantInput(value, `${field}.${key}`);
  }
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw validation(`${field} 无效。`);
  return value;
}

function requireUuid(value: string, label: string) {
  if (!UUID.test(value)) throw validation(`${label} 无效。`);
}

function requireVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validation('baseTripVersion 无效。');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validation(message: string) {
  return new ApplicationError('VALIDATION_ERROR', message, 400);
}

function notFound() {
  return new ApplicationError('NOT_FOUND', '找不到该资源。', 404);
}

function flightNotFound() {
  return new ApplicationError('FLIGHT_NOT_FOUND', '未找到匹配航班。', 404);
}

function versionConflict() {
  return new ApplicationError(
    'VERSION_CONFLICT',
    '行程已被其他请求更新，请刷新后重试。',
    409,
  );
}
