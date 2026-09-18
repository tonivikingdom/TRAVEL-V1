import type {
  MagicLinkDeliveryRepository,
  PreparedMagicLinkDelivery,
} from '@travel/application';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

export class PrismaMagicLinkDeliveryRepository implements MagicLinkDeliveryRepository {
  constructor(private readonly client: PrismaClient) {}

  async prepareDelivery(input: {
    readonly deliveryRequestId: string;
    readonly deriveTokenDigest: (generation: number) => string;
    readonly proposedExpiresAt: Date;
    readonly now: Date;
  }): Promise<PreparedMagicLinkDelivery> {
    return this.client.$transaction(
      async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "MagicLinkDeliveryRequest"
          WHERE "id" = ${input.deliveryRequestId}::uuid
          FOR UPDATE
        `);
        const delivery = await transaction.magicLinkDeliveryRequest.findUnique({
          where: { id: input.deliveryRequestId },
          include: { magicLinkToken: true },
        });
        if (delivery === null) {
          throw new Error('MAGIC_LINK_DELIVERY_NOT_FOUND');
        }
        if (delivery.status === 'DELIVERED') {
          return { status: 'DELIVERED' };
        }
        if (delivery.status === 'NOOP') {
          return { status: 'NOOP' };
        }

        const user = await transaction.user.findUnique({
          where: { normalizedEmail: delivery.normalizedEmail },
          select: { id: true, email: true, status: true },
        });
        const invitation =
          user === null
            ? await transaction.invitation.findUnique({
                where: { normalizedEmail: delivery.normalizedEmail },
                select: {
                  id: true,
                  email: true,
                  status: true,
                  expiresAt: true,
                  revokedAt: true,
                },
              })
            : null;
        const activeUser = user !== null && user.status === 'ACTIVE';
        const activeInvitation =
          invitation !== null &&
          invitation.status === 'PENDING' &&
          invitation.revokedAt === null &&
          invitation.expiresAt > input.now;

        if (!activeUser && !activeInvitation) {
          if (
            delivery.magicLinkToken !== null &&
            delivery.magicLinkToken.consumedAt === null
          ) {
            await transaction.magicLinkToken.update({
              where: { id: delivery.magicLinkToken.id },
              data: { consumedAt: input.now },
            });
          }
          await transaction.magicLinkDeliveryRequest.update({
            where: { id: delivery.id },
            data: { status: 'NOOP', processedAt: input.now },
          });
          return { status: 'NOOP' };
        }

        if (
          delivery.magicLinkToken !== null &&
          delivery.magicLinkToken.consumedAt !== null
        ) {
          await transaction.magicLinkDeliveryRequest.update({
            where: { id: delivery.id },
            data: { status: 'DELIVERED', processedAt: input.now },
          });
          return { status: 'DELIVERED' };
        }

        let expiresAt: Date;
        let tokenGeneration: number;
        if (delivery.magicLinkToken === null) {
          tokenGeneration = delivery.tokenGeneration + 1;
          expiresAt = input.proposedExpiresAt;
          await transaction.magicLinkToken.create({
            data: {
              deliveryRequestId: delivery.id,
              tokenDigest: input.deriveTokenDigest(tokenGeneration),
              expiresAt,
              ...(activeUser
                ? { userId: user.id }
                : { invitationId: invitation!.id }),
            },
          });
        } else {
          tokenGeneration = delivery.tokenGeneration;
          expiresAt = delivery.magicLinkToken.expiresAt;
          if (expiresAt <= input.now) {
            tokenGeneration += 1;
            expiresAt = input.proposedExpiresAt;
            await transaction.magicLinkToken.update({
              where: { id: delivery.magicLinkToken.id },
              data: {
                tokenDigest: input.deriveTokenDigest(tokenGeneration),
                expiresAt,
              },
            });
          }
        }

        await transaction.magicLinkDeliveryRequest.update({
          where: { id: delivery.id },
          data: {
            status: 'TOKEN_READY',
            tokenGeneration,
            tokenExpiresAt: expiresAt,
          },
        });
        return {
          status: 'SEND',
          recipient: activeUser ? user.email : invitation!.email,
          expiresAt,
          tokenGeneration,
        };
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  async markDelivered(deliveryRequestId: string, now: Date): Promise<void> {
    await this.client.magicLinkDeliveryRequest.updateMany({
      where: {
        id: deliveryRequestId,
        status: { in: ['PENDING', 'TOKEN_READY'] },
      },
      data: { status: 'DELIVERED', processedAt: now },
    });
  }
}
