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

export type ExecutionEventType = 'ARRIVAL' | 'DEPARTURE' | 'SKIP_CONFIRMED';
export type ExecutionEventSource = 'LOCATION' | 'MANUAL';
export type NodeExecutionStatus = 'POSSIBLY_SKIPPED' | 'SKIPPED';
export type ExecutionCurrentState =
  'NOT_STARTED' | 'AT_NODE' | 'EN_ROUTE' | 'COMPLETED' | 'INCONSISTENT';
export interface ExecutionFrontierConflictView {
  readonly code: 'MULTIPLE_OPEN_NODES' | 'OPEN_NODE_PRECEDES_LATER_EXECUTION';
  readonly openNodeIds: readonly string[];
  readonly laterExecutedNodeIds: readonly string[];
}
export type ExecutionLocationStatus =
  'NO_SAMPLE' | 'RELIABLE' | 'INDETERMINATE';

export interface ExecutionLocationSampleRequest {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number;
  readonly observedAt: string;
  readonly speedMetersPerSecond?: number;
  readonly headingDegrees?: number;
}

export interface ManualExecutionEventRequest {
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
  readonly type: 'MANUAL_ARRIVAL' | 'MANUAL_DEPARTURE' | 'CONFIRM_SKIP';
  readonly nodeId: string;
  readonly occurredAt: string;
}

export interface UndoExecutionEventRequest {
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
}

export interface ExecutionEventView {
  readonly id: string;
  readonly tripId: string;
  readonly nodeId: string;
  readonly type: ExecutionEventType;
  readonly source: ExecutionEventSource;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export interface ExecutionLocationResponse {
  readonly status:
    | 'CONFIRMED_ARRIVAL'
    | 'CONFIRMED_DEPARTURE'
    | 'ARRIVAL_DETECTED'
    | 'DEPARTURE_DETECTED'
    | 'NO_CHANGE'
    | 'INDETERMINATE_LOCATION'
    | 'MANUAL_CONFIRMATION_AVAILABLE';
  readonly event: ExecutionEventView | null;
  readonly resultingTripVersion: number;
  readonly confirmationRecommended: boolean;
  readonly airportTriggerAttempted: boolean;
}

export interface ExecutionMutationResponse {
  readonly event: ExecutionEventView;
  readonly resultingTripVersion: number;
  readonly idempotentReplay: boolean;
  readonly airportTriggerAttempted: boolean;
}

export interface ExecutionUndoResponse {
  readonly event: ExecutionEventView;
  readonly resultingTripVersion: number;
  readonly idempotentReplay: boolean;
}

export interface ExecutionContextResponse {
  readonly tripId: string;
  readonly tripVersion: number;
  readonly currentNodeId: string | null;
  readonly targetNodeId: string | null;
  readonly currentState: ExecutionCurrentState;
  readonly frontierConflict: ExecutionFrontierConflictView | null;
  readonly latestArrival: {
    readonly nodeId: string;
    readonly instant: string;
  } | null;
  readonly latestDeparture: {
    readonly nodeId: string;
    readonly instant: string;
  } | null;
  readonly possibleSkippedNodeIds: readonly string[];
  readonly confirmedSkippedNodeIds: readonly string[];
  readonly locationStatus: ExecutionLocationStatus;
  readonly activeRisks: readonly ExecutionRiskView[];
}
