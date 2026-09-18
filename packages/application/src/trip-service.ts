import type {
  DayView,
  ItineraryNodeView,
  PlaceInput,
  PlaceView,
  TripCommandInput,
  TripView,
} from '@travel/contracts';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  ItineraryNodeRecord,
  PlaceRecord,
  RepositoryPlaceInput,
  RepositoryTripCommand,
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
  };
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
