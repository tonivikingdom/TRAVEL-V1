import type { TransportMode, TripView } from './trips.js';

export type RouteQueryHint =
  | {
      readonly type: 'DEPART_AT';
      readonly instant: string;
      readonly timeZone: string;
    }
  | {
      readonly type: 'ARRIVE_BY';
      readonly instant: string;
      readonly timeZone: string;
    };

export interface RouteQueryRequest {
  readonly basisVersion: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly hint?: RouteQueryHint | null;
}

export interface RouteLocationView {
  readonly name: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly providerPlaceRef: string | null;
  readonly providerHubRef?: string | null;
}

export interface RouteTimePointView {
  readonly instant: string;
  readonly timeZone: string;
}

export interface RouteCandidateLegView {
  readonly mode: TransportMode;
  readonly from: RouteLocationView;
  readonly to: RouteLocationView;
  readonly departure: RouteTimePointView | null;
  readonly arrival: RouteTimePointView | null;
  readonly durationSeconds: number | null;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
  readonly providerRef: string | null;
}

export interface RouteFareView {
  readonly amount: string;
  readonly currency: string;
}

export interface RouteQueryTimeConditionView {
  readonly hardEarliestDeparture: string | null;
  readonly hardLatestArrival: string | null;
  readonly earliestDeparture: string | null;
  readonly latestArrival: string | null;
  readonly preference:
    | { readonly type: 'NONE' }
    | {
        readonly type: 'DEPART_AT' | 'ARRIVE_BY';
        readonly instant: string;
        readonly timeZone: string;
      };
  readonly hint: RouteQueryHint | null;
}

export interface RouteCandidateView {
  readonly candidateSnapshotId: string;
  readonly snapshotExpiresAt: string;
  readonly candidateId: string;
  readonly provider: string;
  readonly providerCandidateRef: string | null;
  readonly observedAt: string;
  readonly validUntil: string | null;
  readonly queryBasisVersion: number;
  readonly queryTimeCondition: RouteQueryTimeConditionView;
  readonly overall: {
    readonly departure: RouteTimePointView;
    readonly arrival: RouteTimePointView;
    readonly durationSeconds: number;
  };
  readonly legs: readonly RouteCandidateLegView[];
  readonly fare: RouteFareView | null;
}

export interface RouteQueryResponse {
  readonly tripId: string;
  readonly basisVersion: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly timeCondition: RouteQueryTimeConditionView;
  readonly candidates: readonly RouteCandidateView[];
}

export interface CreateRoutePreviewRequest {
  readonly basisVersion: number;
  readonly candidateSnapshotId: string;
  readonly sameHubWalkingLegIndexes?: readonly number[];
}

export type RoutePreviewStatus =
  'ACTIVE' | 'BLOCKED' | 'EXPIRED' | 'SUPERSEDED_POLICY';

export type RouteGroupingEvidence = 'SYSTEM_STRUCTURED' | 'USER_CONFIRMED';

export interface RoutePreviewLocationView extends RouteLocationView {
  readonly ref: string;
}

export interface RoutePreviewSegmentView {
  readonly legIndex?: number;
  readonly fromRef: string;
  readonly toRef: string;
  readonly mode: TransportMode;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
  readonly providerRef: string | null;
  readonly departure: RouteTimePointView | null;
  readonly arrival: RouteTimePointView | null;
  readonly durationSeconds: number | null;
}

export interface RoutePreviewGeneratedNodePlanView {
  readonly ref: string;
  readonly action: 'CREATE' | 'REUSE';
  readonly nodeId: string | null;
  readonly location: RoutePreviewLocationView;
  readonly localDate: string;
  readonly dayOccurrenceId: string | null;
  readonly provider: string;
  readonly providerPlaceRef: string | null;
  readonly providerHubRef: string | null;
  readonly evidence: RouteGroupingEvidence;
}

export interface RoutePreviewRemovedNodeView {
  readonly nodeId: string;
  readonly dayOccurrenceId: string;
  readonly protected: boolean;
  readonly protectionReasons: readonly string[];
}

export interface RoutePreviewInternalTransferView {
  readonly legIndex: number;
  readonly mode: 'WALKING';
  readonly from: RouteLocationView;
  readonly to: RouteLocationView;
  readonly durationSeconds: number | null;
  readonly evidence: RouteGroupingEvidence;
}

export interface RoutePreviewDayProjectionPlanView {
  readonly segmentIndex: number;
  readonly fromRef: string;
  readonly toRef: string;
  readonly roles: readonly ('SAME_DAY' | 'START' | 'OCCUPIED' | 'END')[];
}

export interface RoutePreviewView {
  readonly previewId: string;
  readonly tripId: string;
  readonly basisVersion: number;
  readonly candidateSnapshotId: string;
  readonly candidateHash: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly adoptable: boolean;
  readonly status: RoutePreviewStatus;
  readonly currentConnection: {
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly state: 'ACTIVE' | 'MISSING';
    readonly transport: {
      readonly id: string;
      readonly mode: TransportMode;
      readonly fixedService: boolean;
      readonly serviceLabel: string | null;
    } | null;
  };
  readonly candidate: RouteCandidateView;
  readonly changeSummary: {
    readonly transportAction: 'CREATE' | 'REPLACE';
    readonly willReplaceTransportEdgeId: string | null;
    readonly willReplaceTransportEdgeIds?: readonly string[];
    readonly requiresGeneratedNodes: boolean;
    readonly generatedTransferPoints: readonly RoutePreviewLocationView[];
    readonly proposedSegments: readonly RoutePreviewSegmentView[];
    readonly routeCorridor?: {
      readonly anchorFromNodeId: string;
      readonly anchorToNodeId: string;
      readonly currentNodeIds: readonly string[];
      readonly currentAdoptedRouteId: string | null;
    };
    readonly nodesToCreate?: readonly RoutePreviewGeneratedNodePlanView[];
    readonly nodesToReuse?: readonly RoutePreviewGeneratedNodePlanView[];
    readonly nodesToRemove?: readonly RoutePreviewRemovedNodeView[];
    readonly protectedBlockingNodes?: readonly RoutePreviewRemovedNodeView[];
    readonly internalTransferDetails?: readonly RoutePreviewInternalTransferView[];
    readonly proposedDayAssignments?: readonly {
      readonly nodeRef: string;
      readonly localDate: string;
      readonly dayOccurrenceId: string | null;
    }[];
    readonly proposedTransportDayProjections?: readonly RoutePreviewDayProjectionPlanView[];
    readonly temporalLayer: 'PLANNED';
    readonly temporalSourceKind: 'ADOPTED_TRANSPORT_FACT';
  };
}

export interface AdoptRoutePreviewRequest {
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
}

export interface RouteAdoptDayOccurrenceSnapshot {
  readonly id: string;
  readonly localDate: string;
  readonly sequence: number;
}

export interface RouteAdoptNodePlacementSnapshot {
  readonly nodeId: string;
  readonly dayOccurrenceId: string;
  readonly position: number;
}

export interface RouteAdoptGeneratedNodeSnapshot {
  readonly id: string;
  readonly tripId: string;
  readonly dayOccurrenceId: string;
  readonly kind: 'PLACE_VISIT';
  readonly position: number;
  readonly placeId: string;
  readonly note: string | null;
  readonly source: 'ROUTE_GENERATED';
  readonly adoptedRouteId: string;
  readonly provider: string;
  readonly providerPlaceRef: string | null;
  readonly providerHubRef: string | null;
  readonly sourceOperationId: string;
  readonly autoReplaceable: boolean;
  readonly userModifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RouteAdoptDayProjectionSnapshot {
  readonly transportEdgeId: string;
  readonly dayOccurrenceId: string;
  readonly role: 'SAME_DAY' | 'START' | 'OCCUPIED' | 'END';
}

export interface RouteAdoptDeltaV2 {
  readonly schemaVersion: 'route-adopt-delta-v2';
  readonly createdNodeIds: readonly string[];
  readonly reusedNodeIds: readonly string[];
  readonly removedGeneratedNodes: readonly RouteAdoptGeneratedNodeSnapshot[];
  readonly createdTransportEdgeIds: readonly string[];
  readonly archivedTransportHistoryIds: readonly string[];
  readonly createdDayProjections: readonly RouteAdoptDayProjectionSnapshot[];
  readonly removedDayProjections: readonly RouteAdoptDayProjectionSnapshot[];
  readonly affectedDayOccurrenceIds: readonly string[];
  readonly beforeCorridorNodeIds: readonly string[];
  readonly afterCorridorNodeIds: readonly string[];
  readonly beforeDayOccurrences: readonly RouteAdoptDayOccurrenceSnapshot[];
  readonly beforeNodePlacements: readonly RouteAdoptNodePlacementSnapshot[];
  readonly beforeGeneratedNodes: readonly RouteAdoptGeneratedNodeSnapshot[];
  readonly beforeOwnedDates: readonly string[];
  readonly beforeEffectiveStartDate: string | null;
  readonly beforeEffectiveEndDate: string | null;
  readonly previousActiveAdoptedRouteId: string | null;
  readonly createdPlaceIds: readonly string[];
  readonly createdDayOccurrenceIds: readonly string[];
}

export interface RouteUndoDeltaV1 {
  readonly schemaVersion: 'route-undo-delta-v1';
  readonly targetOperationReceiptId: string;
  readonly undoneAdoptedRouteId: string;
  readonly restoredAdoptedRouteId: string | null;
  readonly removedCreatedNodeIds: readonly string[];
  readonly restoredNodeIds: readonly string[];
  readonly removedCreatedTransportEdgeIds: readonly string[];
  readonly restoredTransportEdgeIds: readonly string[];
  readonly restoredDayOccurrenceIds: readonly string[];
  readonly removedAdoptCreatedDayOccurrenceIds: readonly string[];
  readonly restoredOwnedDates: readonly string[];
}

export interface UndoRouteAdoptionRequest {
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
}

export interface OperationReceiptView {
  readonly id: string;
  readonly operationType: 'ROUTE_ADOPT' | 'ROUTE_UNDO';
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly baseTripVersion: number;
  readonly resultingTripVersion: number;
  readonly previewId: string;
  readonly adoptedRouteId: string;
  readonly targetOperationReceiptId: string | null;
  readonly undoExpiresAt: string | null;
  readonly delta:
    RouteAdoptDeltaV2 | RouteUndoDeltaV1 | Record<string, unknown>;
  readonly createdAt: string;
}

export interface AdoptRoutePreviewResponse {
  readonly operationReceipt: OperationReceiptView;
  readonly trip: TripView;
}

export interface UndoRouteAdoptionResponse {
  readonly operationReceipt: OperationReceiptView;
  readonly trip: TripView;
}
