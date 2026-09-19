import type {
  OperationReceiptView,
  UndoRouteAdoptionRequest,
  UndoRouteAdoptionResponse,
} from '@travel/contracts';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import {
  systemClock,
  type Clock,
  type OperationReceiptRecord,
  type RoutePlanningRepository,
  type UndoRouteAdoptionResult,
} from './route-planning-ports.js';
import { hashRouteUndoRequest } from './route-snapshot.js';
import { TripService } from './trip-service.js';

export class RouteUndoService {
  constructor(
    private readonly planningRepository: RoutePlanningRepository,
    private readonly tripService: TripService,
    private readonly clock: Clock = systemClock,
  ) {}

  async undoAdoption(
    actor: Actor,
    tripId: string,
    operationReceiptId: string,
    input: UndoRouteAdoptionRequest,
  ): Promise<UndoRouteAdoptionResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(operationReceiptId, 'operationReceiptId');
    const baseTripVersion = positiveInteger(
      input.baseTripVersion,
      'baseTripVersion',
    );
    const idempotencyKey = boundedKey(input.idempotencyKey);
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    if (this.planningRepository.undoAdoption === undefined) {
      throw new ApplicationError(
        'SERVICE_UNAVAILABLE',
        '路线撤销持久化能力尚未配置。',
        503,
        true,
      );
    }
    const result = await this.planningRepository.undoAdoption({
      ownerUserId: actor.userId,
      tripId,
      targetOperationReceiptId: operationReceiptId,
      baseTripVersion,
      idempotencyKey,
      requestHash: hashRouteUndoRequest({
        tripId,
        targetOperationReceiptId: operationReceiptId,
        baseTripVersion,
      }),
      now: this.clock.now(),
    });
    if (result.status !== 'SUCCESS') throw undoError(result.status);
    return {
      operationReceipt: toReceiptView(result.receipt),
      trip: await this.tripService.getTrip(actor, tripId),
    };
  }
}

function toReceiptView(record: OperationReceiptRecord): OperationReceiptView {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    undoExpiresAt: record.undoExpiresAt?.toISOString() ?? null,
  };
}

function undoError(
  status: Exclude<UndoRouteAdoptionResult['status'], 'SUCCESS'>,
): ApplicationError {
  switch (status) {
    case 'NOT_FOUND':
      return new ApplicationError('NOT_FOUND', '路线操作记录不存在。', 404);
    case 'IDEMPOTENCY_CONFLICT':
      return new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        '该幂等键已用于不同的路线撤销请求。',
        409,
      );
    case 'UNDO_CONFLICT':
      return new ApplicationError(
        'UNDO_CONFLICT',
        '路线采用后已有新修改或事实，无法安全撤销。',
        409,
      );
    case 'UNDO_EXPIRED':
      return new ApplicationError(
        'UNDO_EXPIRED',
        '路线撤销窗口已经过期。',
        409,
      );
    case 'UNDO_UNAVAILABLE':
      return new ApplicationError(
        'UNDO_UNAVAILABLE',
        '该路线操作没有可安全使用的撤销依据。',
        409,
      );
  }
}

function boundedKey(value: string): string {
  if (typeof value !== 'string') {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'idempotencyKey 无效。',
      400,
    );
  }
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'idempotencyKey 长度无效。',
      400,
    );
  }
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}

function requireUuid(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
}
