import type {
  AdoptRoutePreviewRequest,
  AdoptRoutePreviewResponse,
  OperationReceiptView,
} from '@travel/contracts';

import { authorize, type Actor } from './authorization.js';
import { compareCanonicalDwellAdjustments } from './canonical-order.js';
import { ApplicationError } from './errors.js';
import {
  systemClock,
  type Clock,
  type OperationReceiptRecord,
  type RoutePlanningRepository,
} from './route-planning-ports.js';
import { hashRouteAdoptionRequest } from './route-snapshot.js';
import { TripService } from './trip-service.js';

export class RouteAdoptionService {
  private readonly clock: Clock;
  private readonly undoWindowSeconds: number;

  constructor(
    private readonly planningRepository: RoutePlanningRepository,
    private readonly tripService: TripService,
    options: RouteAdoptionServiceOptions,
  ) {
    this.clock = options.clock ?? systemClock;
    this.undoWindowSeconds = requireUndoWindow(options.undoWindowSeconds);
  }

  async adoptPreview(
    actor: Actor,
    tripId: string,
    previewId: string,
    input: AdoptRoutePreviewRequest,
  ): Promise<AdoptRoutePreviewResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(previewId, 'previewId');
    const baseTripVersion = positiveInteger(
      input.baseTripVersion,
      'baseTripVersion',
    );
    const idempotencyKey = boundedKey(input.idempotencyKey);
    const acceptedUserAdjustments = normalizeAdjustments(
      input.acceptedUserAdjustments,
    );
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    if (this.planningRepository.adoptPreview === undefined) {
      throw new ApplicationError(
        'SERVICE_UNAVAILABLE',
        '路线采用持久化能力尚未配置。',
        503,
        true,
      );
    }
    const now = this.clock.now();
    const result = await this.planningRepository.adoptPreview({
      ownerUserId: actor.userId,
      tripId,
      previewId,
      baseTripVersion,
      idempotencyKey,
      requestHash: hashRouteAdoptionRequest({
        tripId,
        previewId,
        baseTripVersion,
        acceptedUserAdjustments,
      }),
      acceptedUserAdjustments,
      now,
      undoExpiresAt: new Date(now.getTime() + this.undoWindowSeconds * 1_000),
    });
    if (result.status !== 'SUCCESS') throw adoptionError(result.status);
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

export interface RouteAdoptionServiceOptions {
  readonly undoWindowSeconds: number;
  readonly clock?: Clock;
}

function requireUndoWindow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 604_800) {
    throw new Error('undoWindowSeconds must be an integer from 1 to 604800');
  }
  return value;
}

function adoptionError(
  status:
    | 'NOT_FOUND'
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_CONFLICT'
    | 'PREVIEW_STALE'
    | 'PREVIEW_BLOCKED'
    | 'USER_ADJUSTMENT_REQUIRED'
    | 'FACT_PROTECTED'
    | 'DATE_OWNED',
): ApplicationError {
  switch (status) {
    case 'NOT_FOUND':
      return new ApplicationError('NOT_FOUND', '路线预览资源不存在。', 404);
    case 'VERSION_CONFLICT':
      return new ApplicationError(
        'VERSION_CONFLICT',
        '行程已被其他设备更新，请重新生成路线预览。',
        409,
      );
    case 'IDEMPOTENCY_CONFLICT':
      return new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        '该幂等键已用于不同的路线采用请求。',
        409,
      );
    case 'PREVIEW_STALE':
      return new ApplicationError(
        'PREVIEW_STALE',
        '路线预览已过期或不再满足当前安全条件。',
        409,
      );
    case 'PREVIEW_BLOCKED':
      return new ApplicationError(
        'PREVIEW_BLOCKED',
        '路线预览包含不能自动移除的受保护节点。',
        409,
      );
    case 'USER_ADJUSTMENT_REQUIRED':
      return new ApplicationError(
        'USER_ADJUSTMENT_REQUIRED',
        '采用该路线需要明确确认并同步修改用户最低停留时间。',
        409,
      );
    case 'FACT_PROTECTED':
      return new ApplicationError(
        'FACT_PROTECTED',
        '已有实际事实，不能由新路线覆盖。',
        409,
      );
    case 'DATE_OWNED':
      return new ApplicationError('DATE_OWNED', '日期已属于另一趟行程。', 409);
  }
}

function normalizeAdjustments(
  values: AdoptRoutePreviewRequest['acceptedUserAdjustments'],
) {
  if (values === undefined) return [];
  const seen = new Set<string>();
  return values
    .map((value) => {
      requireUuid(value.intentId, 'acceptedUserAdjustments.intentId');
      requireUuid(value.nodeId, 'acceptedUserAdjustments.nodeId');
      const fromDurationSeconds = positiveInteger(
        value.fromDurationSeconds,
        'acceptedUserAdjustments.fromDurationSeconds',
      );
      const toDurationSeconds = positiveInteger(
        value.toDurationSeconds,
        'acceptedUserAdjustments.toDurationSeconds',
      );
      if (
        toDurationSeconds >= fromDurationSeconds ||
        seen.has(value.intentId)
      ) {
        throw new ApplicationError(
          'VALIDATION_ERROR',
          '用户停留时间调整无效。',
          400,
        );
      }
      seen.add(value.intentId);
      return {
        intentId: value.intentId,
        nodeId: value.nodeId,
        fromDurationSeconds,
        toDurationSeconds,
      };
    })
    .sort(compareCanonicalDwellAdjustments);
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
