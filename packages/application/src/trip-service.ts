import type {
  ConnectionView,
  DayView,
  ItineraryNodeView,
  PlaceInput,
  PlaceView,
  ResolvedTemporalValueInput,
  TemporalSubjectInput,
  TemporalValueView,
  TransportEdgeView,
  TransportHistoryView,
  TransportMode,
  TripCommandInput,
  TripView,
} from '@travel/contracts';
import { AbsoluteInstantError, parseAbsoluteIsoInstant } from '@travel/domain';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  ItineraryNodeRecord,
  PlaceRecord,
  RepositoryPlaceInput,
  RepositoryTemporalSubject,
  RepositoryTemporalValueInput,
  RepositoryTripCommand,
  TemporalValueRecord,
  TransportEdgeRecord,
  TransportHistoryRecord,
  TripAggregateRecord,
  TripMutationResult,
  TripRepository,
} from './trip-ports.js';

export class TripService {
  constructor(private readonly repository: TripRepository) {}

  async createTrip(
    actor: Actor,
    input: {
      readonly name: string;
      readonly planningAnchorDate: string;
      readonly defaultPeopleCount: number;
    },
  ): Promise<TripView> {
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    const trip = await this.repository.create({
      ownerUserId: actor.userId,
      name: boundedText(input.name, 'name', 1, 200),
      planningAnchorDate: parseLocalDate(input.planningAnchorDate),
      defaultPeopleCount: positiveInteger(
        input.defaultPeopleCount,
        'defaultPeopleCount',
      ),
    });
    return toTripView(trip);
  }

  async listTrips(actor: Actor): Promise<readonly TripView[]> {
    authorizeSelf(actor, 'READ_PRIVATE_RESOURCE');
    return (await this.repository.listOwned(actor.userId)).map(toTripView);
  }

  async getTrip(actor: Actor, tripId: string): Promise<TripView> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'READ_PRIVATE_RESOURCE');
    const trip = await this.repository.findOwnedById({
      ownerUserId: actor.userId,
      tripId,
    });
    if (trip === null) {
      throw new ApplicationError('NOT_FOUND', '行程不存在。', 404);
    }
    return toTripView(trip);
  }

  async updateTrip(
    actor: Actor,
    tripId: string,
    input: {
      readonly baseTripVersion: number;
      readonly name?: string;
      readonly planningAnchorDate?: string;
      readonly defaultPeopleCount?: number;
    },
  ): Promise<TripView> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    const baseTripVersion = positiveInteger(
      input.baseTripVersion,
      'baseTripVersion',
    );
    const update = {
      ...(input.name === undefined
        ? {}
        : { name: boundedText(input.name, 'name', 1, 200) }),
      ...(input.planningAnchorDate === undefined
        ? {}
        : {
            planningAnchorDate: parseLocalDate(input.planningAnchorDate),
          }),
      ...(input.defaultPeopleCount === undefined
        ? {}
        : {
            defaultPeopleCount: positiveInteger(
              input.defaultPeopleCount,
              'defaultPeopleCount',
            ),
          }),
    };
    if (Object.keys(update).length === 0) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '至少需要提供一个可修改字段。',
        400,
      );
    }
    return mutationResultToView(
      await this.repository.updateMetadata({
        ownerUserId: actor.userId,
        tripId,
        baseTripVersion,
        ...update,
      }),
    );
  }

  async executeCommand(
    actor: Actor,
    tripId: string,
    baseTripVersion: number,
    command: TripCommandInput,
  ): Promise<TripView> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    return mutationResultToView(
      await this.repository.executeCommand({
        ownerUserId: actor.userId,
        tripId,
        baseTripVersion: positiveInteger(baseTripVersion, 'baseTripVersion'),
        command: validateCommand(command),
      }),
    );
  }

  async setResolvedTemporalValue(
    actor: Actor,
    tripId: string,
    baseTripVersion: number,
    subject: TemporalSubjectInput,
    value: ResolvedTemporalValueInput,
  ): Promise<TripView> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    return mutationResultToView(
      await this.repository.setTemporalValue({
        ownerUserId: actor.userId,
        tripId,
        baseTripVersion: positiveInteger(baseTripVersion, 'baseTripVersion'),
        subject: validateTemporalSubject(subject),
        value: validateTemporalValue(value),
      }),
    );
  }

  async listTransportHistory(
    actor: Actor,
    tripId: string,
  ): Promise<readonly TransportHistoryView[]> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'READ_PRIVATE_RESOURCE');
    const records = await this.repository.listTransportHistoryOwned({
      ownerUserId: actor.userId,
      tripId,
    });
    if (records === null) {
      throw new ApplicationError('NOT_FOUND', '行程不存在。', 404);
    }
    return records.map(toTransportHistoryView);
  }
}

function validateCommand(command: TripCommandInput): RepositoryTripCommand {
  switch (command.type) {
    case 'ADD_PLACE_VISIT':
      return {
        type: command.type,
        localDate: parseLocalDate(command.localDate),
        position: nonnegativeInteger(command.position, 'position'),
        place: validatePlace(command.place),
        note: optionalText(command.note, 'note', 2_000),
      };
    case 'ADD_FREE_ACTION':
      return {
        type: command.type,
        localDate: parseLocalDate(command.localDate),
        position: nonnegativeInteger(command.position, 'position'),
        note: optionalText(command.note, 'note', 2_000),
      };
    case 'DELETE_NODE':
      requireUuid(command.nodeId, 'nodeId');
      return command;
    case 'MOVE_NODE_WITHIN_DAY':
      requireUuid(command.nodeId, 'nodeId');
      return {
        ...command,
        position: nonnegativeInteger(command.position, 'position'),
      };
    case 'REPLACE_PLACE':
      requireUuid(command.nodeId, 'nodeId');
      return {
        ...command,
        place: validatePlace(command.place),
      };
    case 'SET_MANUAL_TRANSPORT':
      requireUuid(command.fromNodeId, 'fromNodeId');
      requireUuid(command.toNodeId, 'toNodeId');
      if (command.fromNodeId === command.toNodeId) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          '交通起点和终点不能相同。',
          400,
        );
      }
      if (typeof command.fixedService !== 'boolean') {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'fixedService 无效。',
          400,
        );
      }
      return {
        ...command,
        mode: validateTransportMode(command.mode),
        serviceLabel: optionalText(command.serviceLabel, 'serviceLabel', 200),
        note: optionalText(command.note, 'note', 2_000),
      };
    case 'CLEAR_TRANSPORT':
      requireUuid(command.transportEdgeId, 'transportEdgeId');
      return command;
  }
}

function validatePlace(place: PlaceInput): RepositoryPlaceInput {
  if (place.type === 'EXISTING') {
    requireUuid(place.placeId, 'placeId');
    return place;
  }
  return {
    type: 'CUSTOM',
    name: boundedText(place.name, 'place.name', 1, 200),
    latitude: coordinate(place.latitude, 'place.latitude', -90, 90),
    longitude: coordinate(place.longitude, 'place.longitude', -180, 180),
    address: optionalText(place.address, 'place.address', 500),
  };
}

function mutationResultToView(result: TripMutationResult): TripView {
  switch (result.status) {
    case 'SUCCESS':
      return toTripView(result.trip);
    case 'NOT_FOUND':
      throw new ApplicationError('NOT_FOUND', '行程或关联资源不存在。', 404);
    case 'VERSION_CONFLICT':
      throw new ApplicationError(
        'VERSION_CONFLICT',
        '行程已被其他设备更新，请刷新后重试。',
        409,
      );
    case 'DATE_OWNED':
      throw new ApplicationError('DATE_OWNED', '该日期已属于另一趟行程。', 409);
    case 'FACT_PROTECTED':
      throw new ApplicationError(
        'FACT_PROTECTED',
        '已有实际时间事实，必须通过未来的显式纠错流程修改。',
        409,
      );
    case 'INVALID_POSITION':
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '节点位置超出当前日期范围。',
        400,
      );
    case 'INVALID_COMMAND':
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '该命令不适用于目标节点。',
        400,
      );
    case 'NOT_ADJACENT':
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '交通只能连接当前相邻节点。',
        400,
      );
    case 'TRANSPORT_NOT_APPLICABLE':
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '自由行动节点不能绑定手工交通。',
        400,
      );
  }
}

function toTripView(record: TripAggregateRecord): TripView {
  const days = projectDays(record);
  return {
    id: record.id,
    name: record.name,
    planningAnchorDate: formatLocalDate(record.planningAnchorDate),
    defaultPeopleCount: record.defaultPeopleCount,
    version: record.version,
    effectiveStartDate:
      record.effectiveStartDate === null
        ? null
        : formatLocalDate(record.effectiveStartDate),
    effectiveEndDate:
      record.effectiveEndDate === null
        ? null
        : formatLocalDate(record.effectiveEndDate),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    days,
    connections: projectConnections(record),
  };
}

function projectDays(record: TripAggregateRecord): readonly DayView[] {
  if (record.effectiveStartDate === null || record.effectiveEndDate === null) {
    if (
      record.effectiveStartDate !== record.effectiveEndDate ||
      record.ownedDates.length !== 0 ||
      record.nodes.length !== 0
    ) {
      throw new Error('Trip effective range invariant is broken');
    }
    return [];
  }

  const nodesByDate = new Map<string, ItineraryNodeView[]>();
  for (const node of record.nodes) {
    const localDate = formatLocalDate(node.localDate);
    const nodes = nodesByDate.get(localDate) ?? [];
    nodes.push(toNodeView(node));
    nodesByDate.set(localDate, nodes);
  }

  const expectedStart = formatLocalDate(record.effectiveStartDate);
  const expectedEnd = formatLocalDate(record.effectiveEndDate);
  const ownedDates = record.ownedDates.map(formatLocalDate);
  if (
    ownedDates[0] !== expectedStart ||
    ownedDates.at(-1) !== expectedEnd ||
    !isContinuous(ownedDates)
  ) {
    throw new Error('DateOwnership does not match the effective Trip range');
  }
  return ownedDates.map((localDate) => ({
    localDate,
    nodes: nodesByDate.get(localDate) ?? [],
  }));
}

function toNodeView(record: ItineraryNodeRecord): ItineraryNodeView {
  return {
    id: record.id,
    kind: record.kind,
    localDate: formatLocalDate(record.localDate),
    position: record.position,
    place: record.place === null ? null : toPlaceView(record.place),
    note: record.note,
    source: record.source,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    timeValues: record.timeValues.map(toTemporalValueView),
  };
}

function projectConnections(
  record: TripAggregateRecord,
): readonly ConnectionView[] {
  const adjacencyKeys = new Set<string>();
  const edgesByAdjacency = new Map<string, TransportEdgeRecord>();
  for (const edge of record.transportEdges) {
    const key = adjacencyKey(edge.fromNodeId, edge.toNodeId);
    if (edgesByAdjacency.has(key)) {
      throw new Error('Trip has duplicate current transport adjacency');
    }
    edgesByAdjacency.set(key, edge);
  }

  const connections: ConnectionView[] = [];
  for (let index = 0; index + 1 < record.nodes.length; index += 1) {
    const from = record.nodes[index];
    const to = record.nodes[index + 1];
    if (from === undefined || to === undefined) {
      throw new Error('Trip timeline projection is incomplete');
    }
    const key = adjacencyKey(from.id, to.id);
    adjacencyKeys.add(key);
    const transport = edgesByAdjacency.get(key);
    if (transport !== undefined) {
      if (from.kind !== 'PLACE_VISIT' || to.kind !== 'PLACE_VISIT') {
        throw new Error('Current transport cannot connect a FreeAction');
      }
      connections.push({
        fromNodeId: from.id,
        toNodeId: to.id,
        state: 'ACTIVE',
        transport: toTransportEdgeView(transport),
      });
      continue;
    }
    connections.push({
      fromNodeId: from.id,
      toNodeId: to.id,
      state: connectionState(from.kind, to.kind),
      transport: null,
    });
  }
  for (const key of edgesByAdjacency.keys()) {
    if (!adjacencyKeys.has(key)) {
      throw new Error('Current transport does not match Trip adjacency');
    }
  }
  return connections;
}

function connectionState(
  fromKind: ItineraryNodeRecord['kind'],
  toKind: ItineraryNodeRecord['kind'],
): Exclude<ConnectionView['state'], 'ACTIVE'> {
  if (fromKind === 'FREE_ACTION' && toKind === 'PLACE_VISIT') {
    return 'RUNTIME_ORIGIN_REQUIRED';
  }
  if (fromKind === 'FREE_ACTION' || toKind === 'FREE_ACTION') {
    return 'NOT_APPLICABLE';
  }
  return 'MISSING';
}

function toTransportEdgeView(record: TransportEdgeRecord): TransportEdgeView {
  return {
    id: record.id,
    fromNodeId: record.fromNodeId,
    toNodeId: record.toNodeId,
    mode: record.mode,
    fixedService: record.fixedService,
    serviceLabel: record.serviceLabel,
    note: record.note,
    source: record.source,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    timeValues: record.timeValues.map(toTemporalValueView),
  };
}

function toTransportHistoryView(
  record: TransportHistoryRecord,
): TransportHistoryView {
  return {
    id: record.id,
    originalTransportEdgeId: record.originalTransportEdgeId,
    originalFromNodeId: record.originalFromNodeId,
    originalToNodeId: record.originalToNodeId,
    mode: record.mode,
    fixedService: record.fixedService,
    serviceLabel: record.serviceLabel,
    note: record.note,
    source: record.source,
    originalCreatedAt: record.originalCreatedAt.toISOString(),
    invalidatedAt: record.invalidatedAt.toISOString(),
    invalidationReason: record.invalidationReason,
    timeValues: record.timeValues.map(toTemporalValueView),
  };
}

function toTemporalValueView(record: TemporalValueRecord): TemporalValueView {
  return {
    id: record.id,
    layer: record.layer,
    pointKind: record.pointKind,
    instant: record.instant.toISOString(),
    timeZone: record.timeZone,
    sourceKind: record.sourceKind,
    sourceRef: record.sourceRef,
    observedAt: record.observedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function adjacencyKey(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}:${toNodeId}`;
}

function toPlaceView(record: PlaceRecord): PlaceView {
  return {
    id: record.id,
    name: record.name,
    latitude: record.latitude,
    longitude: record.longitude,
    address: record.address,
    createdAt: record.createdAt.toISOString(),
  };
}

function isContinuous(dates: readonly string[]): boolean {
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (
      previous === undefined ||
      current === undefined ||
      formatLocalDate(addUtcDays(parseLocalDate(previous), 1)) !== current
    ) {
      return false;
    }
  }
  return true;
}

function authorizeSelf(
  actor: Actor,
  action: 'READ_PRIVATE_RESOURCE' | 'WRITE_PRIVATE_RESOURCE',
): void {
  authorize(actor, action, {
    kind: 'PRIVATE_RESOURCE',
    ownerUserId: actor.userId,
  });
}

function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      '日期必须使用 YYYY-MM-DD 格式。',
      400,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ApplicationError('VALIDATION_ERROR', '自然日无效。', 400);
  }
  return date;
}

function formatLocalDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function validateTemporalSubject(
  subject: TemporalSubjectInput,
): RepositoryTemporalSubject {
  if (subject.type === 'NODE') {
    requireUuid(subject.nodeId, 'nodeId');
    return subject;
  }
  requireUuid(subject.transportEdgeId, 'transportEdgeId');
  return subject;
}

function validateTemporalValue(
  value: ResolvedTemporalValueInput,
): RepositoryTemporalValueInput {
  if (!['PLANNED', 'ESTIMATED', 'ACTUAL'].includes(value.layer)) {
    throw new ApplicationError('VALIDATION_ERROR', '时间层无效。', 400);
  }
  if (!['ARRIVAL', 'DEPARTURE'].includes(value.pointKind)) {
    throw new ApplicationError('VALIDATION_ERROR', '时间点类型无效。', 400);
  }
  if (
    ![
      'USER_VALUE',
      'ADOPTED_TRANSPORT_FACT',
      'SYSTEM_SUGGESTION',
      'DERIVED',
      'PROVIDER_OBSERVATION',
    ].includes(value.sourceKind)
  ) {
    throw new ApplicationError('VALIDATION_ERROR', '时间来源无效。', 400);
  }
  if (
    value.layer === 'ACTUAL' &&
    (value.sourceKind === 'DERIVED' || value.sourceKind === 'SYSTEM_SUGGESTION')
  ) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'ACTUAL 不能来自推导或系统建议。',
      400,
    );
  }
  return {
    layer: value.layer,
    pointKind: value.pointKind,
    instant: parseAbsoluteInstant(value.instant, 'instant'),
    timeZone: validateIanaTimeZone(value.timeZone),
    sourceKind: value.sourceKind,
    sourceRef: optionalText(value.sourceRef, 'sourceRef', 300),
    observedAt:
      value.observedAt === undefined || value.observedAt === null
        ? null
        : parseAbsoluteInstant(value.observedAt, 'observedAt'),
  };
}

function parseAbsoluteInstant(value: string, field: string): Date {
  if (typeof value !== 'string') {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  try {
    return parseAbsoluteIsoInstant(value, field);
  } catch (error) {
    if (error instanceof AbsoluteInstantError && error.reason === 'FORMAT') {
      throw new ApplicationError(
        'UNSUPPORTED_SCENARIO',
        `${field} 必须是带 Z 或明确 UTC offset 的绝对时刻。`,
        400,
      );
    }
    if (error instanceof AbsoluteInstantError) {
      throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
    }
    throw error;
  }
}

function validateIanaTimeZone(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 100 ||
    (value !== 'UTC' && !SUPPORTED_IANA_TIME_ZONES.has(value))
  ) {
    throw new ApplicationError('VALIDATION_ERROR', 'timeZone 无效。', 400);
  }
  return value;
}

const SUPPORTED_IANA_TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

function validateTransportMode(value: TransportMode): TransportMode {
  if (
    ![
      'WALKING',
      'DRIVING',
      'TAXI',
      'RAIL',
      'BUS',
      'FERRY',
      'FLIGHT',
      'OTHER',
    ].includes(value)
  ) {
    throw new ApplicationError('VALIDATION_ERROR', '交通方式无效。', 400);
  }
  return value;
}

function boundedText(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 长度无效。`, 400);
  }
  return normalized;
}

function optionalText(
  value: string | null | undefined,
  field: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 长度无效。`, 400);
  }
  return normalized === '' ? null : normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}

function coordinate(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}

function requireUuid(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
}
