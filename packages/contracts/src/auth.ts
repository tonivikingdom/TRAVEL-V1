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
  | 'ACTUAL_CONFLICT'
  | 'FLIGHT_AMBIGUOUS'
  | 'FLIGHT_MISMATCH'
  | 'FLIGHT_NOT_FOUND'
  | 'FLIGHT_PROVIDER_AUTH_ERROR'
  | 'FLIGHT_PROVIDER_BAD_RESPONSE'
  | 'FLIGHT_PROVIDER_NOT_CONFIGURED'
  | 'FLIGHT_PROVIDER_RATE_LIMIT'
  | 'FLIGHT_PROVIDER_TIMEOUT'
  | 'FLIGHT_PROVIDER_UNAVAILABLE'
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
  | 'PREVIEW_BLOCKED'
  | 'USER_ADJUSTMENT_REQUIRED'
  | 'PREVIEW_UNSUPPORTED'
  | 'ROUTE_PROVIDER_UNCONFIGURED'
  | 'ROUTE_QUERY_TIME_REQUIRED'
  | 'ROUTE_QUERY_UNSUPPORTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TRANSPORT_OCCUPIED_DAY'
  | 'UNDO_CONFLICT'
  | 'UNDO_EXPIRED'
  | 'UNDO_UNAVAILABLE'
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
