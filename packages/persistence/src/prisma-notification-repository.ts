import type {
  NotificationRecord,
  NotificationRepository,
} from '@travel/application';

import { type PrismaClient } from './generated/prisma/client.js';

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly client: PrismaClient) {}

  async create(input: {
    readonly ownerUserId: string;
    readonly kind: string;
    readonly dedupeKey: string;
    readonly title: string;
    readonly body: string;
    readonly occurredAt: Date;
    readonly tripId?: string | null;
    readonly flightBindingId?: string | null;
    readonly flightNumber?: string | null;
    readonly priority?: 'NORMAL' | 'STRONG';
    readonly summary?: string | null;
    readonly changeKinds?: readonly string[];
    readonly hasDownstreamImpact?: boolean;
  }): Promise<NotificationRecord> {
    return this.client.notificationEvent.upsert({
      where: {
        ownerUserId_dedupeKey: {
          ownerUserId: input.ownerUserId,
          dedupeKey: input.dedupeKey,
        },
      },
      create: {
        ...input,
        ...(input.changeKinds === undefined
          ? {}
          : { changeKinds: input.changeKinds }),
      },
      update: {},
    });
  }

  async list(input: {
    readonly ownerUserId: string;
    readonly limit: number;
    readonly before?: { readonly createdAt: Date; readonly id: string };
  }): Promise<readonly NotificationRecord[]> {
    return this.client.notificationEvent.findMany({
      where: {
        ownerUserId: input.ownerUserId,
        ...(input.before === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.before.createdAt } },
                {
                  createdAt: input.before.createdAt,
                  id: { lt: input.before.id },
                },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    });
  }

  async dismissOwned(input: {
    readonly ownerUserId: string;
    readonly notificationId: string;
    readonly now: Date;
  }): Promise<NotificationRecord | null> {
    return this.client.$transaction(async (transaction) => {
      await transaction.notificationEvent.updateMany({
        where: {
          id: input.notificationId,
          ownerUserId: input.ownerUserId,
          dismissedAt: null,
        },
        data: { dismissedAt: input.now },
      });
      return transaction.notificationEvent.findFirst({
        where: { id: input.notificationId, ownerUserId: input.ownerUserId },
      });
    });
  }

  async viewOwned(input: {
    readonly ownerUserId: string;
    readonly notificationId: string;
    readonly now: Date;
  }): Promise<NotificationRecord | null> {
    return this.client.$transaction(async (transaction) => {
      await transaction.notificationEvent.updateMany({
        where: {
          id: input.notificationId,
          ownerUserId: input.ownerUserId,
          viewedAt: null,
        },
        data: { viewedAt: input.now },
      });
      return transaction.notificationEvent.findFirst({
        where: { id: input.notificationId, ownerUserId: input.ownerUserId },
      });
    });
  }
}
