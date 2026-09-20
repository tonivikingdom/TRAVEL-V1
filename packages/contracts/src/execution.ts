import type { NotificationView } from './notifications.js';

export type ExecutionRiskKind =
  | 'PROTECTED_TIME_AT_RISK'
  | 'PROTECTED_TIME_INFEASIBLE'
  | 'FIXED_SERVICE_MISSED'
  | 'BUFFER_BELOW_SYSTEM_MINIMUM'
  | 'UNKNOWN_EXECUTION_MARGIN';

export type ExecutionRiskSeverity =
  'EXECUTABLE_RISK' | 'INFEASIBLE' | 'UNKNOWN';

export type ExecutionRiskStatus =
  'OPEN' | 'ACKNOWLEDGED' | 'SNOOZED' | 'RESOLVED';

export interface ExecutionRiskView {
  readonly id: string;
  readonly tripId: string;
  readonly kind: ExecutionRiskKind;
  readonly severity: ExecutionRiskSeverity;
  readonly status: ExecutionRiskStatus;
  readonly sourceNodeId: string | null;
  readonly sourceTransportEdgeId: string | null;
  readonly protectedNodeId: string | null;
  readonly protectedTransportEdgeId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly acknowledgedAt: string | null;
  readonly snoozedUntil: string | null;
  readonly resolvedAt: string | null;
  readonly evaluationBasisTripVersion: number;
  readonly evidenceRefs: readonly string[];
  readonly requiresRouteReevaluation: boolean;
}

export interface ExecutionRiskListResponse {
  readonly risks: readonly ExecutionRiskView[];
}

export interface ExecutionRiskEvaluationResponse {
  readonly tripId: string;
  readonly evaluationBasisTripVersion: number;
  readonly risks: readonly ExecutionRiskView[];
  readonly resolvedRisks: readonly ExecutionRiskView[];
  readonly notificationsCreated: readonly NotificationView[];
}
