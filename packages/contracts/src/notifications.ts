export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly dismissedAt: string | null;
  readonly tripId: string | null;
  readonly flightBindingId: string | null;
  readonly flightNumber: string | null;
  readonly priority: 'NORMAL' | 'STRONG';
  readonly summary: string | null;
  readonly changeKinds: readonly string[];
  readonly hasDownstreamImpact: boolean;
  readonly viewedAt: string | null;
}

export interface NotificationListResponse {
  readonly notifications: readonly NotificationView[];
  readonly nextCursor: string | null;
}
