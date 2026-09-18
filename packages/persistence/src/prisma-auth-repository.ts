import {
  ApplicationError,
  type AuthRepository,
  type AuthenticatedSession,
  type ConsumeMagicLinkResult,
  type CreatedInvitation,
  type PreparedMagicLink,
} from '@travel/application';
import type {
  AccountAdminUserView,
  UserStatus,
  UserView,
} from '@travel/contracts';
import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

interface RateLimitRow {
  readonly requestCount: number;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly client: PrismaClient) {}

  async prepareMagicLink(input: {
    readonly normalizedEmail: string;
    readonly email: string;
    readonly tokenDigest: string;
    readonly tokenExpiresAt: Date;
    readonly now: Date;
    readonly rateLimitWindowSeconds: number;
    readonly rateLimitMaxRequests: number;
  }): Promise<PreparedMagicLink | null> {
    return this.client.$transaction(
      async (transaction) => {
        const keyDigest = sha256ForRateLimit(input.normalizedEmail);
        const cutoff = new Date(
          input.now.getTime() - input.rateLimitWindowSeconds * 1_000,
        );
        const rows = await transaction.$queryRaw<RateLimitRow[]>(Prisma.sql`
          INSERT INTO "MagicLinkRequestBucket"
            ("keyDigest", "windowStartedAt", "requestCount", "updatedAt")
          VALUES (${keyDigest}, ${input.now}, 1, ${input.now})
          ON CONFLICT ("keyDigest") DO UPDATE SET
            "requestCount" = CASE
              WHEN "MagicLinkRequestBucket"."windowStartedAt" <= ${cutoff}
                THEN 1
              ELSE "MagicLinkRequestBucket"."requestCount" + 1
            END,
            "windowStartedAt" = CASE
              WHEN "MagicLinkRequestBucket"."windowStartedAt" <= ${cutoff}
                THEN ${input.now}
              ELSE "MagicLinkRequestBucket"."windowStartedAt"
            END,
            "updatedAt" = ${input.now}
          RETURNING "requestCount"
        `);
        if (
          rows[0] === undefined ||
          rows[0].requestCount > input.rateLimitMaxRequests
        ) {
          throw new ApplicationError(
            'RATE_LIMITED',
            '请求过于频繁，请稍后重试。',
            429,
            true,
          );
        }

        const user = await transaction.user.findUnique({
          where: { normalizedEmail: input.normalizedEmail },
          select: { id: true, email: true, status: true },
        });
        if (user !== null) {
          if (user.status !== 'ACTIVE') {
            return null;
          }
          await transaction.magicLinkToken.create({
            data: {
              userId: user.id,
              tokenDigest: input.tokenDigest,
              expiresAt: input.tokenExpiresAt,
            },
          });
          return { recipient: user.email };
        }

        const invitation = await transaction.invitation.findUnique({
          where: { normalizedEmail: input.normalizedEmail },
          select: {
            id: true,
            email: true,
            status: true,
            expiresAt: true,
            revokedAt: true,
          },
        });
        if (
          invitation === null ||
          invitation.status !== 'PENDING' ||
          invitation.revokedAt !== null ||
          invitation.expiresAt <= input.now
        ) {
          return null;
        }

        await transaction.magicLinkToken.create({
          data: {
            invitationId: invitation.id,
            tokenDigest: input.tokenDigest,
            expiresAt: input.tokenExpiresAt,
          },
        });
        return { recipient: invitation.email };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async consumeMagicLink(input: {
    readonly tokenDigest: string;
    readonly sessionDigest: string;
    readonly sessionExpiresAt: Date;
    readonly now: Date;
    readonly defaultBaseCurrency: string;
    readonly defaultUiLanguage: string;
  }): Promise<ConsumeMagicLinkResult> {
    try {
      return await this.client.$transaction(
        async (transaction) => {
          const claimed = await transaction.magicLinkToken.updateMany({
            where: {
              tokenDigest: input.tokenDigest,
              consumedAt: null,
              expiresAt: { gt: input.now },
            },
            data: { consumedAt: input.now },
          });
          if (claimed.count !== 1) {
            return { status: 'INVALID' };
          }

          const token = await transaction.magicLinkToken.findUnique({
            where: { tokenDigest: input.tokenDigest },
            include: {
              user: { include: { preference: true } },
              invitation: true,
            },
          });
          if (token === null) {
            return { status: 'INVALID' };
          }

          let user = token.user;
          if (user !== null && user.status !== 'ACTIVE') {
            return { status: 'ACCOUNT_DISABLED' };
          }

          if (user === null) {
            const invitation = token.invitation;
            if (
              invitation === null ||
              invitation.status !== 'PENDING' ||
              invitation.revokedAt !== null ||
              invitation.expiresAt <= input.now
            ) {
              return { status: 'INVALID' };
            }
            const consumed = await transaction.invitation.updateMany({
              where: {
                id: invitation.id,
                status: 'PENDING',
                revokedAt: null,
                expiresAt: { gt: input.now },
              },
              data: { status: 'CONSUMED', consumedAt: input.now },
            });
            if (consumed.count !== 1) {
              return { status: 'INVALID' };
            }
            user = await transaction.user.create({
              data: {
                email: invitation.email,
                normalizedEmail: invitation.normalizedEmail,
                role: 'USER',
                status: 'ACTIVE',
                preference: {
                  create: {
                    baseCurrency: input.defaultBaseCurrency,
                    uiLanguage: input.defaultUiLanguage,
                  },
                },
              },
              include: { preference: true },
            });
          } else if (user.preference === null) {
            const preference = await transaction.userPreference.create({
              data: {
                userId: user.id,
                baseCurrency: input.defaultBaseCurrency,
                uiLanguage: input.defaultUiLanguage,
              },
            });
            user = { ...user, preference };
          }

          await transaction.session.create({
            data: {
              userId: user.id,
              tokenDigest: input.sessionDigest,
              expiresAt: input.sessionExpiresAt,
            },
          });
          return { status: 'SUCCESS', user: toUserView(user) };
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (isPrismaConflict(error)) {
        return { status: 'INVALID' };
      }
      throw error;
    }
  }

  async authenticateSession(
    sessionDigest: string,
    now: Date,
  ): Promise<AuthenticatedSession | null> {
    const session = await this.client.session.findUnique({
      where: { tokenDigest: sessionDigest },
      include: { user: { include: { preference: true } } },
    });
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.user.status !== 'ACTIVE' ||
      session.user.preference === null
    ) {
      return null;
    }
    return {
      actor: {
        userId: session.user.id,
        email: session.user.email,
        role: session.user.role,
        status: session.user.status,
      },
      user: toUserView(session.user),
    };
  }

  async revokeSession(sessionDigest: string, now: Date): Promise<void> {
    await this.client.session.updateMany({
      where: { tokenDigest: sessionDigest, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  async createInvitation(input: {
    readonly actorUserId: string;
    readonly email: string;
    readonly normalizedEmail: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<CreatedInvitation> {
    return this.client.$transaction(
      async (transaction) => {
        const existingUser = await transaction.user.findUnique({
          where: { normalizedEmail: input.normalizedEmail },
          select: { id: true },
        });
        if (existingUser !== null) {
          throw new ApplicationError('CONFLICT', '该邮箱已有账号。', 409);
        }

        const existing = await transaction.invitation.findUnique({
          where: { normalizedEmail: input.normalizedEmail },
        });
        if (
          existing !== null &&
          existing.status === 'PENDING' &&
          existing.revokedAt === null &&
          existing.expiresAt > input.now
        ) {
          throw new ApplicationError('CONFLICT', '该邮箱已有有效邀请。', 409);
        }

        const invitation = await transaction.invitation.upsert({
          where: { normalizedEmail: input.normalizedEmail },
          create: {
            email: input.email,
            normalizedEmail: input.normalizedEmail,
            invitedByUserId: input.actorUserId,
            expiresAt: input.expiresAt,
          },
          update: {
            email: input.email,
            invitedByUserId: input.actorUserId,
            status: 'PENDING',
            expiresAt: input.expiresAt,
            consumedAt: null,
            revokedAt: null,
            createdAt: input.now,
          },
        });
        return {
          id: invitation.id,
          email: invitation.email,
          expiresAt: invitation.expiresAt,
        };
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async setUserStatus(input: {
    readonly userId: string;
    readonly status: UserStatus;
    readonly now: Date;
  }): Promise<boolean> {
    return this.client.$transaction(
      async (transaction) => {
        const updated = await transaction.user.updateMany({
          where: { id: input.userId },
          data: { status: input.status },
        });
        if (updated.count !== 1) {
          return false;
        }
        if (input.status === 'DISABLED') {
          await transaction.session.updateMany({
            where: { userId: input.userId, revokedAt: null },
            data: { revokedAt: input.now },
          });
          await transaction.magicLinkToken.updateMany({
            where: { userId: input.userId, consumedAt: null },
            data: { consumedAt: input.now },
          });
        }
        return true;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async listUsers(): Promise<readonly AccountAdminUserView[]> {
    const users = await this.client.user.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });
    return users.map((user) => ({
      ...user,
      createdAt: user.createdAt.toISOString(),
    }));
  }

  async revokeAllUserSessions(userId: string, now: Date): Promise<boolean> {
    return this.client.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (user === null) {
        return false;
      }
      await transaction.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return true;
    });
  }

  async bootstrapAdmin(input: {
    readonly email: string;
    readonly normalizedEmail: string;
    readonly defaultBaseCurrency: string;
    readonly defaultUiLanguage: string;
  }): Promise<{ readonly created: boolean; readonly userId: string }> {
    return this.client.$transaction(
      async (transaction) => {
        const existingByEmail = await transaction.user.findUnique({
          where: { normalizedEmail: input.normalizedEmail },
        });
        if (existingByEmail !== null) {
          if (
            existingByEmail.role === 'ADMIN' &&
            existingByEmail.status === 'ACTIVE'
          ) {
            return { created: false, userId: existingByEmail.id };
          }
          throw new ApplicationError(
            'CONFLICT',
            '该邮箱已被非活动管理员或普通账号占用。',
            409,
          );
        }

        const existingAdmin = await transaction.user.findFirst({
          where: { role: 'ADMIN' },
          select: { id: true },
        });
        if (existingAdmin !== null) {
          throw new ApplicationError(
            'CONFLICT',
            '管理员已经存在，拒绝创建另一个 bootstrap 管理员。',
            409,
          );
        }

        const admin = await transaction.user.create({
          data: {
            email: input.email,
            normalizedEmail: input.normalizedEmail,
            role: 'ADMIN',
            status: 'ACTIVE',
            preference: {
              create: {
                baseCurrency: input.defaultBaseCurrency,
                uiLanguage: input.defaultUiLanguage,
              },
            },
          },
        });
        return { created: true, userId: admin.id };
      },
      { isolationLevel: 'Serializable' },
    );
  }
}

function sha256ForRateLimit(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail, 'utf8').digest('hex');
}

function toUserView(user: {
  readonly id: string;
  readonly email: string;
  readonly role: 'ADMIN' | 'USER';
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly preference: {
    readonly baseCurrency: string;
    readonly uiLanguage: string;
  } | null;
}): UserView {
  if (user.preference === null) {
    throw new Error('User preference is required');
  }
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    preferences: {
      baseCurrency: user.preference.baseCurrency,
      uiLanguage: user.preference.uiLanguage,
    },
  };
}

function isPrismaConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034')
  );
}
