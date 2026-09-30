import type {
  ExecutionRiskKind,
  ExecutionRiskSeverity,
  ExecutionRiskStatus,
} from '@travel/contracts';

import type { NotificationRecord } from './ports.js';

export interface ExecutionRiskRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly fingerprint: string;
  readonly lifecycleGeneration: number;
  readonly kind: ExecutionRiskKind;
  readonly severity: ExecutionRiskSeverity;
  readonly status: ExecutionRiskStatus;
  readonly sourceNodeId: string | null;
  readonly sourceTransportEdgeId: string | null;
  readonly protectedNodeId: string | null;
  readonly protectedTransportEdgeId: string | null;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly acknowledgedAt: Date | null;
  readonly snoozedUntil: Date | null;
  readonly resolvedAt: Date | null;
  readonly evaluationBasisTripVersion: number;
  readonly lastEvidenceHash: string;
  readonly evidenceRefs: readonly string[];
  readonly requiresRouteReevaluation: boolean;
  readonly notificationGeneration: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DesiredExecutionRisk {
  readonly fingerprint: string;
  readonly kind: ExecutionRiskKind;
  readonly severity: ExecutionRiskSeverity;
  readonly sourceNodeId: string | null;
  readonly sourceTransportEdgeId: string | null;
  readonly protectedNodeId: string | null;
  readonly protectedTransportEdgeId: string | null;
  readonly evidenceHash: string;
  readonly evidenceRefs: readonly string[];
  readonly requiresRouteReevaluation: boolean;
  readonly notificationTitle: string;
  readonly notificationBody: string;
}

export type ReconcileExecutionRisksResult =
  | {
      readonly status: 'SUCCESS';
      readonly activeRisks: readonly ExecutionRiskRecord[];
      readonly resolvedRisks: readonly ExecutionRiskRecord[];
      readonly notificationsCreated: readonly NotificationRecord[];
    }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'VERSION_CONFLICT' }
  | { readonly status: 'OBSERVATION_OBSOLETE' }
  | { readonly status: 'CAPABILITY_CHANGED' };

export interface ExecutionRiskRepository {
  reconcile(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly basisTripVersion: number;
    readonly now: Date;
    readonly desiredRisks: readonly DesiredExecutionRisk[];
    readonly correlationGroupKey?: string;
    readonly correlationSourceTransportEdgeId?: string;
    readonly correlationRequireSourceMatch?: boolean;
    readonly expectedGroundTransitCapabilityRevision?: number;
    readonly expectedGroundTransitObservation?: {
      readonly transportEdgeId: string;
      readonly identity: string;
      readonly fetchedAt: Date;
    };
  }): Promise<ReconcileExecutionRisksResult>;
  listActiveOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<readonly ExecutionRiskRecord[] | null>;
  acknowledgeOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly riskId: string;
    readonly now: Date;
  }): Promise<ExecutionRiskRecord | null>;
  snoozeOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly riskId: string;
    readonly now: Date;
    readonly snoozedUntil: Date;
  }): Promise<ExecutionRiskRecord | null>;
}
