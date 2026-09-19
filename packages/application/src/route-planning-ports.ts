import type {
  OperationReceiptView,
  RouteCandidateView,
  RoutePreviewView,
  RouteQueryTimeConditionView,
} from '@travel/contracts';

export interface Clock {
  now(): Date;
}

export type RouteCandidatePayload = Omit<
  RouteCandidateView,
  'candidateSnapshotId' | 'snapshotExpiresAt'
>;

export type StoredRoutePreviewPayload = Omit<
  RoutePreviewView,
  'previewId' | 'createdAt' | 'expiresAt' | 'adoptable' | 'status'
>;

export interface RouteCandidateSnapshotDraft {
  readonly provider: string;
  readonly providerCandidateRef: string | null;
  readonly observedAt: Date;
  readonly providerValidUntil: Date | null;
  readonly candidatePayload: RouteCandidatePayload;
  readonly candidateHash: string;
  readonly queryTimeCondition: RouteQueryTimeConditionView;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface RouteCandidateSnapshotRecord extends RouteCandidateSnapshotDraft {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly basisVersion: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
}

export interface RoutePreviewRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly basisVersion: number;
  readonly candidateSnapshotId: string;
  readonly candidateHash: string;
  readonly policyVersion: string;
  readonly previewPayload: StoredRoutePreviewPayload;
  readonly previewHash?: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type SaveRouteCandidateSnapshotsResult =
  | {
      readonly status: 'SUCCESS';
      readonly snapshots: readonly RouteCandidateSnapshotRecord[];
    }
  | {
      readonly status: 'NOT_FOUND' | 'VERSION_CONFLICT' | 'NOT_ADJACENT';
    };

export type CreateRoutePreviewResult =
  | { readonly status: 'SUCCESS'; readonly preview: RoutePreviewRecord }
  | {
      readonly status:
        'NOT_FOUND' | 'VERSION_CONFLICT' | 'PREVIEW_STALE' | 'NOT_ADJACENT';
    };

export interface OperationReceiptRecord extends Omit<
  OperationReceiptView,
  'createdAt' | 'undoExpiresAt'
> {
  readonly ownerUserId: string;
  readonly tripId: string;
  readonly createdAt: Date;
  readonly undoExpiresAt: Date | null;
}

export type AdoptRoutePreviewResult =
  | {
      readonly status: 'SUCCESS';
      readonly receipt: OperationReceiptRecord;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly status:
        | 'NOT_FOUND'
        | 'VERSION_CONFLICT'
        | 'IDEMPOTENCY_CONFLICT'
        | 'PREVIEW_STALE'
        | 'PREVIEW_BLOCKED'
        | 'FACT_PROTECTED'
        | 'DATE_OWNED';
    };

export type UndoRouteAdoptionResult =
  | {
      readonly status: 'SUCCESS';
      readonly receipt: OperationReceiptRecord;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly status:
        | 'NOT_FOUND'
        | 'IDEMPOTENCY_CONFLICT'
        | 'UNDO_CONFLICT'
        | 'UNDO_EXPIRED'
        | 'UNDO_UNAVAILABLE';
    };

export interface RoutePlanningRepository {
  saveCandidateSnapshots(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly basisVersion: number;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly snapshots: readonly RouteCandidateSnapshotDraft[];
  }): Promise<SaveRouteCandidateSnapshotsResult>;
  findSnapshotOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly snapshotId: string;
  }): Promise<RouteCandidateSnapshotRecord | null>;
  createPreview(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly basisVersion: number;
    readonly snapshotId: string;
    readonly expectedCandidateHash: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly policyVersion: string;
    readonly previewPayload: StoredRoutePreviewPayload;
    readonly previewHash: string;
    readonly now: Date;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<CreateRoutePreviewResult>;
  findPreviewOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly previewId: string;
  }): Promise<RoutePreviewRecord | null>;
  adoptPreview?(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly previewId: string;
    readonly baseTripVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: Date;
    readonly undoExpiresAt: Date;
  }): Promise<AdoptRoutePreviewResult>;
  undoAdoption?(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly targetOperationReceiptId: string;
    readonly baseTripVersion: number;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<UndoRouteAdoptionResult>;
}

export const systemClock: Clock = { now: () => new Date() };
