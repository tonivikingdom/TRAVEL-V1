import type {
  AccountAdminUserView,
  InvitationResponse,
  MagicLinkRequestResponse,
  SessionResponse,
  UserView,
} from '@travel/contracts';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type { AuthRepository } from './ports.js';
import { createOpaqueToken, digestOpaqueToken } from './tokens.js';

const GENERIC_MAGIC_LINK_RESPONSE: MagicLinkRequestResponse = {
  accepted: true,
  message: '如果该邮箱可以登录，我们会发送一封登录邮件。',
};

export interface AuthServiceConfig {
  readonly magicLinkLandingUrl: string;
  readonly magicLinkTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly invitationTtlSeconds: number;
  readonly rateLimitWindowSeconds: number;
  readonly rateLimitMaxRequests: number;
  readonly defaultBaseCurrency: string;
  readonly defaultUiLanguage: string;
  readonly jobMaxAttempts: number;
}

export interface AuthServiceOptions {
  readonly now?: () => Date;
}

export class AuthService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: AuthRepository,
    private readonly config: AuthServiceConfig,
    options: AuthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async requestMagicLink(
    emailInput: string,
  ): Promise<MagicLinkRequestResponse> {
    const email = validateAndNormalizeEmail(emailInput);
    const now = this.now();

    try {
      await this.repository.enqueueMagicLinkRequest({
        email: email.original,
        normalizedEmail: email.normalized,
        now,
        rateLimitWindowSeconds: this.config.rateLimitWindowSeconds,
        rateLimitMaxRequests: this.config.rateLimitMaxRequests,
        jobMaxAttempts: this.config.jobMaxAttempts,
      });
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'RATE_LIMITED') {
        throw error;
      }
      throw new ApplicationError(
        'SERVICE_UNAVAILABLE',
        '登录服务暂时不可用，请稍后重试。',
        503,
        true,
      );
    }

    return GENERIC_MAGIC_LINK_RESPONSE;
  }

  async consumeMagicLink(rawToken: string): Promise<SessionResponse> {
    validateOpaqueToken(rawToken);
    const now = this.now();
    const session = createOpaqueToken();
    const expiresAt = addSeconds(now, this.config.sessionTtlSeconds);
    const result = await this.repository.consumeMagicLink({
      tokenDigest: digestOpaqueToken(rawToken),
      sessionDigest: session.digest,
      sessionExpiresAt: expiresAt,
      now,
      defaultBaseCurrency: this.config.defaultBaseCurrency,
      defaultUiLanguage: this.config.defaultUiLanguage,
    });

    if (result.status === 'ACCOUNT_DISABLED') {
      throw new ApplicationError('ACCOUNT_DISABLED', '账号已被禁用。', 403);
    }
    if (result.status === 'INVALID') {
      throw new ApplicationError(
        'INVALID_OR_EXPIRED_TOKEN',
        '登录链接无效或已过期。',
        401,
      );
    }

    return {
      credential: session.raw,
      expiresAt: expiresAt.toISOString(),
      tokenType: 'Bearer',
      user: result.user,
    };
  }

  async authenticate(rawCredential: string | undefined): Promise<{
    readonly actor: Actor;
    readonly user: UserView;
    readonly sessionDigest: string;
  }> {
    if (rawCredential === undefined || rawCredential === '') {
      throw new ApplicationError(
        'UNAUTHENTICATED',
        '需要有效的登录会话。',
        401,
      );
    }
    const sessionDigest = digestOpaqueToken(rawCredential);
    const authenticated = await this.repository.authenticateSession(
      sessionDigest,
      this.now(),
    );
    if (authenticated === null) {
      throw new ApplicationError(
        'UNAUTHENTICATED',
        '需要有效的登录会话。',
        401,
      );
    }
    return { ...authenticated, sessionDigest };
  }

  async logout(sessionDigest: string): Promise<void> {
    await this.repository.revokeSession(sessionDigest, this.now());
  }

  async createInvitation(
    actor: Actor,
    emailInput: string,
  ): Promise<InvitationResponse> {
    authorize(actor, 'CREATE_INVITATION', { kind: 'ACCOUNT_ADMINISTRATION' });
    const email = validateAndNormalizeEmail(emailInput);
    const now = this.now();
    try {
      const invitation = await this.repository.createInvitation({
        actorUserId: actor.userId,
        email: email.original,
        normalizedEmail: email.normalized,
        expiresAt: addSeconds(now, this.config.invitationTtlSeconds),
        now,
      });
      return {
        id: invitation.id,
        email: invitation.email,
        expiresAt: invitation.expiresAt.toISOString(),
        status: 'PENDING',
      };
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError(
        'SERVICE_UNAVAILABLE',
        '账号管理服务暂时不可用，请稍后重试。',
        503,
        true,
      );
    }
  }

  async listUsers(actor: Actor): Promise<readonly AccountAdminUserView[]> {
    authorize(actor, 'LIST_USERS', { kind: 'ACCOUNT_ADMINISTRATION' });
    return this.repository.listUsers();
  }

  async disableUser(actor: Actor, userId: string): Promise<void> {
    authorize(actor, 'DISABLE_USER', { kind: 'ACCOUNT_ADMINISTRATION' });
    if (actor.userId === userId) {
      throw new ApplicationError('CONFLICT', '不能禁用当前管理员账号。', 409);
    }
    const found = await this.repository.setUserStatus({
      userId,
      status: 'DISABLED',
      now: this.now(),
    });
    if (!found) {
      throw new ApplicationError('CONFLICT', '账号状态无法更新。', 409);
    }
  }

  async enableUser(actor: Actor, userId: string): Promise<void> {
    authorize(actor, 'ENABLE_USER', { kind: 'ACCOUNT_ADMINISTRATION' });
    const found = await this.repository.setUserStatus({
      userId,
      status: 'ACTIVE',
      now: this.now(),
    });
    if (!found) {
      throw new ApplicationError('CONFLICT', '账号状态无法更新。', 409);
    }
  }

  async revokeUserSessions(actor: Actor, userId: string): Promise<void> {
    authorize(actor, 'REVOKE_USER_SESSIONS', {
      kind: 'ACCOUNT_ADMINISTRATION',
    });
    const found = await this.repository.revokeAllUserSessions(
      userId,
      this.now(),
    );
    if (!found) {
      throw new ApplicationError('CONFLICT', '账号不存在。', 409);
    }
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

function validateAndNormalizeEmail(input: string): {
  readonly original: string;
  readonly normalized: string;
} {
  const original = input.trim();
  const normalized = original.toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
  ) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      '请输入有效的邮箱地址。',
      400,
    );
  }
  return { original, normalized };
}

function validateOpaqueToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{40,100}$/u.test(token)) {
    throw new ApplicationError(
      'INVALID_OR_EXPIRED_TOKEN',
      '登录链接无效或已过期。',
      401,
    );
  }
}
