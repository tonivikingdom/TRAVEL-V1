export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly dismissedAt: string | null;
}

export interface NotificationListResponse {
  readonly notifications: readonly NotificationView[];
  readonly nextCursor: string | null;
}
