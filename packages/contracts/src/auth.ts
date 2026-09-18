export type UserRole = 'ADMIN' | 'USER';
export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface UserPreferenceView {
  readonly baseCurrency: string;
  readonly uiLanguage: string;
}

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly preferences: UserPreferenceView;
}

export interface MagicLinkRequestResponse {
  readonly accepted: true;
  readonly message: string;
}

export interface SessionResponse {
  readonly credential: string;
  readonly expiresAt: string;
  readonly tokenType: 'Bearer';
  readonly user: UserView;
}

export interface InvitationResponse {
  readonly id: string;
  readonly email: string;
  readonly status: 'PENDING';
  readonly expiresAt: string;
}

export interface AccountAdminUserView {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly createdAt: string;
}

export type ApiErrorCode =
  | 'ACCOUNT_DISABLED'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INVALID_OR_EXPIRED_TOKEN'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'UNAUTHENTICATED'
  | 'VALIDATION_ERROR';

export interface ApiErrorResponse {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}
