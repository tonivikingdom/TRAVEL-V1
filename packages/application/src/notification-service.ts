import type {
  NotificationListResponse,
  NotificationView,
} from '@travel/contracts';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type { NotificationRecord, NotificationRepository } from './ports.js';

export interface NotificationServiceOptions {
  readonly now?: () => Date;
}

export class NotificationService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: NotificationRepository,
    options: NotificationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async createNotification(input: {
    readonly ownerUserId: string;
    readonly kind: string;
    readonly dedupeKey: string;
    readonly title: string;
    readonly body: string;
    readonly occurredAt: Date;
  }): Promise<NotificationView> {
    requireUuid(input.ownerUserId, 'ownerUserId');
    const record = await this.repository.create({
      ownerUserId: input.ownerUserId,
      kind: boundedText(input.kind, 'kind', 1, 100),
      dedupeKey: boundedText(input.dedupeKey, 'dedupeKey', 1, 200),
      title: boundedText(input.title, 'title', 1, 200),
      body: boundedText(input.body, 'body', 1, 4_000),
      occurredAt: validDate(input.occurredAt, 'occurredAt'),
    });
    return toNotificationView(record);
  }

  async listNotifications(
    actor: Actor,
    input: { readonly limit?: number; readonly cursor?: string },
  ): Promise<NotificationListResponse> {
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '分页大小必须在 1 至 100 之间。',
        400,
      );
    }
    const before =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const records = await this.repository.list({
      ownerUserId: actor.userId,
      limit: limit + 1,
      ...(before === undefined ? {} : { before }),
    });
    const page = records.slice(0, limit);
    return {
      notifications: page.map(toNotificationView),
      nextCursor:
        records.length > limit && page.at(-1) !== undefined
          ? encodeCursor(page.at(-1)!)
          : null,
    };
  }

  async dismissNotification(
    actor: Actor,
    notificationId: string,
  ): Promise<NotificationView> {
    requireUuid(notificationId, 'notificationId');
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const notification = await this.repository.dismissOwned({
      ownerUserId: actor.userId,
      notificationId,
      now: this.now(),
    });
    if (notification === null) {
      throw new ApplicationError('NOT_FOUND', '通知不存在。', 404);
    }
    return toNotificationView(notification);
  }
}

function toNotificationView(record: NotificationRecord): NotificationView {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    body: record.body,
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    dismissedAt: record.dismissedAt?.toISOString() ?? null,
  };
}

function encodeCursor(record: NotificationRecord): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: record.createdAt.toISOString(),
      id: record.id,
    }),
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor: string): {
  readonly createdAt: Date;
  readonly id: string;
} {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('createdAt' in decoded) ||
      !('id' in decoded) ||
      typeof decoded.createdAt !== 'string' ||
      typeof decoded.id !== 'string'
    ) {
      throw new Error('invalid cursor shape');
    }
    requireUuid(decoded.id, 'cursor.id');
    const createdAt = new Date(decoded.createdAt);
    validDate(createdAt, 'cursor.createdAt');
    return { createdAt, id: decoded.id };
  } catch {
    throw new ApplicationError('VALIDATION_ERROR', '分页游标无效。', 400);
  }
}

function boundedText(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 长度无效。`, 400);
  }
  return normalized;
}

function requireUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
}

function validDate(value: Date, field: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}
