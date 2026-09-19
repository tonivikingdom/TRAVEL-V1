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
  | 'DATE_OWNED'
  | 'DAY_OCCURRENCE_REQUIRED'
  | 'FACT_PROTECTED'
  | 'FORBIDDEN'
  | 'INVALID_OR_EXPIRED_TOKEN'
  | 'NOT_FOUND'
  | 'OBJECT_NOT_READY'
  | 'PAYLOAD_TOO_LARGE'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'CONSTRAINT_CONFLICT'
  | 'NO_MATCHING_CANDIDATE'
  | 'PROVIDER_UNAVAILABLE'
  | 'PREVIEW_STALE'
  | 'PREVIEW_UNSUPPORTED'
  | 'ROUTE_PROVIDER_UNCONFIGURED'
  | 'ROUTE_QUERY_TIME_REQUIRED'
  | 'ROUTE_QUERY_UNSUPPORTED'
  | 'SERVICE_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'UNAUTHENTICATED'
  | 'UNSUPPORTED_SCENARIO'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VALIDATION_ERROR'
  | 'VERSION_CONFLICT';

export interface ApiErrorResponse {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
  };
}
