import type {
  AccountAdminUserView,
  UserRole,
  UserStatus,
  UserView,
} from '@travel/contracts';

import type { Actor } from './authorization.js';

export interface PreparedMagicLink {
  readonly recipient: string;
}

export interface AuthenticatedSession {
  readonly actor: Actor;
  readonly user: UserView;
}

export type ConsumeMagicLinkResult =
  | { readonly status: 'SUCCESS'; readonly user: UserView }
  | { readonly status: 'INVALID' }
  | { readonly status: 'ACCOUNT_DISABLED' };

export interface CreatedInvitation {
  readonly id: string;
  readonly email: string;
  readonly expiresAt: Date;
}

export interface AuthRepository {
  prepareMagicLink(input: {
    readonly normalizedEmail: string;
    readonly email: string;
    readonly tokenDigest: string;
    readonly tokenExpiresAt: Date;
    readonly now: Date;
    readonly rateLimitWindowSeconds: number;
    readonly rateLimitMaxRequests: number;
  }): Promise<PreparedMagicLink | null>;
  consumeMagicLink(input: {
    readonly tokenDigest: string;
    readonly sessionDigest: string;
    readonly sessionExpiresAt: Date;
    readonly now: Date;
    readonly defaultBaseCurrency: string;
    readonly defaultUiLanguage: string;
  }): Promise<ConsumeMagicLinkResult>;
  authenticateSession(
    sessionDigest: string,
    now: Date,
  ): Promise<AuthenticatedSession | null>;
  revokeSession(sessionDigest: string, now: Date): Promise<void>;
  createInvitation(input: {
    readonly actorUserId: string;
    readonly email: string;
    readonly normalizedEmail: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<CreatedInvitation>;
  listUsers(): Promise<readonly AccountAdminUserView[]>;
  setUserStatus(input: {
    readonly userId: string;
    readonly status: UserStatus;
    readonly now: Date;
  }): Promise<boolean>;
  revokeAllUserSessions(userId: string, now: Date): Promise<boolean>;
  bootstrapAdmin(input: {
    readonly email: string;
    readonly normalizedEmail: string;
    readonly defaultBaseCurrency: string;
    readonly defaultUiLanguage: string;
  }): Promise<{ readonly created: boolean; readonly userId: string }>;
}

export interface MagicLinkMail {
  readonly recipient: string;
  readonly magicLink: string;
  readonly expiresAt: Date;
}

export interface MailSender {
  sendMagicLink(mail: MagicLinkMail): Promise<void>;
}

export interface CapturedMail extends MagicLinkMail {
  readonly kind: 'SYNTHETIC_MAGIC_LINK';
}

export class CapturedMailSender implements MailSender {
  readonly messages: CapturedMail[] = [];

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
    this.messages.push({ ...mail, kind: 'SYNTHETIC_MAGIC_LINK' });
  }
}

export class UnconfiguredMailSender implements MailSender {
  async sendMagicLink(): Promise<void> {
    throw new Error('Mail provider is not configured');
  }
}

export interface BootstrapAdminView {
  readonly created: boolean;
  readonly userId: string;
  readonly role: Extract<UserRole, 'ADMIN'>;
}
