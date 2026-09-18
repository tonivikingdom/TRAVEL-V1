import type {
  AccountAdminUserView,
  UserRole,
  UserStatus,
  UserView,
} from '@travel/contracts';

import type { Actor } from './authorization.js';

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
  enqueueMagicLinkRequest(input: {
    readonly normalizedEmail: string;
    readonly email: string;
    readonly now: Date;
    readonly rateLimitWindowSeconds: number;
    readonly rateLimitMaxRequests: number;
    readonly jobMaxAttempts: number;
  }): Promise<void>;
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

export type JobType = 'MAGIC_LINK_EMAIL';
export type JobStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface ClaimedJob {
  readonly id: string;
  readonly type: JobType;
  readonly payloadRef: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseUntil: Date;
}

export interface JobRepository {
  claimNext(input: {
    readonly workerId: string;
    readonly now: Date;
    readonly leaseDurationMs: number;
  }): Promise<ClaimedJob | null>;
  markSucceeded(jobId: string, workerId: string, now: Date): Promise<boolean>;
  markFailed(input: {
    readonly job: ClaimedJob;
    readonly workerId: string;
    readonly now: Date;
    readonly errorCode: string;
    readonly retryAt: Date;
  }): Promise<'RETRY_SCHEDULED' | 'FAILED' | 'LEASE_LOST'>;
  cancel(
    jobId: string,
    now: Date,
  ): Promise<'CANCELLED' | 'REQUESTED' | 'TERMINAL' | 'NOT_FOUND'>;
  isCancellationRequested(jobId: string, workerId: string): Promise<boolean>;
  markCancelled(jobId: string, workerId: string, now: Date): Promise<boolean>;
}

export type PreparedMagicLinkDelivery =
  | {
      readonly status: 'SEND';
      readonly recipient: string;
      readonly expiresAt: Date;
      readonly tokenGeneration: number;
    }
  | { readonly status: 'NOOP' | 'DELIVERED' };

export interface MagicLinkDeliveryRepository {
  prepareDelivery(input: {
    readonly deliveryRequestId: string;
    readonly deriveTokenDigest: (generation: number) => string;
    readonly proposedExpiresAt: Date;
    readonly now: Date;
  }): Promise<PreparedMagicLinkDelivery>;
  markDelivered(deliveryRequestId: string, now: Date): Promise<void>;
}

export interface MagicLinkMail {
  readonly recipient: string;
  readonly magicLink: string;
  readonly expiresAt: Date;
  readonly signal?: AbortSignal;
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
