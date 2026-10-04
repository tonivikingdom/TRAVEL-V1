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

export interface ExternalOriginRouteQueryRequest {
  readonly basisVersion: number;
  readonly toNodeId: string;
  readonly hint?: RouteQueryHint | null;
}
export interface ExternalOriginRouteQueryResponse {
  readonly tripId: string;
  readonly basisVersion: number;
  readonly externalOriginId: string;
  readonly toNodeId: string;
  readonly timeCondition: RouteQueryTimeConditionView;
  readonly candidates: readonly RouteCandidateView[];
}

/** Immutable planning evidence, not a new execution fact. */
export interface ExternalRouteOriginSnapshot {
  readonly schema: 'external-route-origin-v1';
  readonly externalOriginId: string;
  readonly provider: string;
  readonly providerHubRef: string;
  readonly canonicalHubRef: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeZone: string;
  readonly arrivedAt: string;
  readonly sourceAdoptedRouteId: string;
  readonly sourceTransportEdgeId: string;
  readonly sourceGroundTransitLegExecutionId: string;
  readonly sourceGroundTransitObservationId: string;
  readonly sourceObservationIdentity: string;
  readonly sourceObservationFetchedAt: string;
  readonly sourceObservationFactsHash: string;
}

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

/** Provider-neutral facts fixed when a rail/bus leg is adopted. Optional for legacy snapshots. */
export interface GroundTransitLegMetadataView {
  readonly serviceClass: 'FIXED_SERVICE' | 'HIGH_FREQUENCY';
  readonly serviceIdentityKey: string | null;
  readonly lineRef: string | null;
  readonly lineName: string | null;
  readonly directionRef: string | null;
  readonly directionLabel: string | null;
  readonly boardingHubRef: string | null;
  readonly alightingHubRef: string | null;
  readonly headwayMinSeconds: number | null;
  readonly headwayMaxSeconds: number | null;
  /** Complete onward transfer after alighting this leg, not pre-boarding access. */
  readonly minimumTransferSeconds: number | null;
  /** Access before this leg's boarding boundary, never transfer to the next leg. */
  readonly boardingAccessMinimumSeconds?: number | null;
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
  readonly groundTransit?: GroundTransitLegMetadataView | null;
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
  readonly planningEarliestDeparture?: string | null;
  readonly lookbackSeconds?: number;
  readonly preference:
    | { readonly type: 'NONE' }
    | {
        readonly type: 'DEPART_AT' | 'ARRIVE_BY';
        readonly instant: string;
        readonly timeZone: string;
      };
  readonly hint: RouteQueryHint | null;
}

export interface RouteUserDwellAdjustmentView {
  readonly intentId: string;
  readonly nodeId: string;
  readonly fromDurationSeconds: number;
  readonly toDurationSeconds: number;
}

export interface RouteCandidatePlanningAssessmentView {
  readonly effectiveTotalTimeSeconds: number;
  readonly requiresUserAdjustment: boolean;
  readonly requiredUserAdjustments: readonly RouteUserDwellAdjustmentView[];
  readonly softDeviations: readonly 'SYSTEM_SUGGESTED_DWELL'[];
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
  readonly planningAssessment?: RouteCandidatePlanningAssessmentView;
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
  'ACTIVE' | 'BLOCKED' | 'EXPIRED' | 'SUPERSEDED_POLICY' | 'ADOPT_UNSUPPORTED';

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
  readonly groundTransit?: GroundTransitLegMetadataView | null;
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

/** A future plan only; no node, place, execution fact or transport is created. */
export interface ExternalOriginReplacementView {
  readonly replacementScope: 'EXTERNAL_ORIGIN';
  readonly externalOriginId: string;
  readonly sourceAdoptedRouteId: string;
  readonly sourceTransportEdgeId: string;
  readonly sourceGroundTransitLegExecutionId: string;
  readonly sourceRouteAnchorFromNodeId: string;
  readonly sourceRouteAnchorToNodeId: string;
  readonly sourceDivergenceNodeId: string;
  readonly destinationNodeId: string;
  readonly preservedPrefixNodeIds: readonly string[];
  readonly preservedPrefixTransportEdgeIds: readonly string[];
  readonly replacementNodeIds: readonly string[];
  readonly replacementTransportEdgeIds: readonly string[];
  readonly materializedOrigin: RoutePreviewGeneratedNodePlanView & {
    readonly ref: 'EXTERNAL_ORIGIN';
    readonly action: 'CREATE';
    readonly nodeId: null;
    readonly kind: 'PLACE_VISIT';
    readonly source: 'ROUTE_GENERATED';
    readonly providerPlaceRef: null;
    readonly autoReplaceable: true;
    readonly userModifiedAt: null;
    readonly evidence: 'USER_CONFIRMED';
    readonly temporalValues: readonly never[];
    readonly executionEvents: readonly never[];
  };
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
      readonly replacementScope?: 'FULL_CORRIDOR' | 'SUFFIX';
      readonly sourceAdoptedRouteId?: string | null;
      readonly sourceRouteAnchorFromNodeId?: string;
      readonly sourceRouteAnchorToNodeId?: string;
      readonly replacementAnchorFromNodeId?: string;
      readonly replacementAnchorToNodeId?: string;
      readonly preservedPrefixNodeIds?: readonly string[];
      readonly preservedPrefixTransportEdgeIds?: readonly string[];
      readonly anchorFromNodeId: string;
      readonly anchorToNodeId: string;
      readonly currentNodeIds: readonly string[];
      readonly currentAdoptedRouteId: string | null;
    };
    readonly externalOriginReplacement?: ExternalOriginReplacementView;
    readonly archivableProviderActualTransportEdgeIds?: readonly string[];
    readonly nodesToCreate?: readonly RoutePreviewGeneratedNodePlanView[];
    readonly nodesToReuse?: readonly RoutePreviewGeneratedNodePlanView[];
    readonly nodesToRemove?: readonly RoutePreviewRemovedNodeView[];
    readonly protectedBlockingTransportEdgeIds?: readonly string[];
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
    readonly requiredUserAdjustments?: readonly RouteUserDwellAdjustmentView[];
    readonly downstreamImpact?: {
      readonly nodeId: string;
      readonly arrival: string;
      readonly departure: string | null;
      readonly projectedDwellSeconds: number | null;
      readonly systemSuggestedDwellSeconds: number | null;
      readonly userMinimumDwellSeconds: number | null;
      readonly status:
        | 'NORMAL'
        | 'SOFT_DEVIATION'
        | 'USER_REQUIREMENT_VIOLATION'
        | 'INFEASIBLE'
        | 'UNKNOWN';
      readonly requiredUserAdjustments: readonly RouteUserDwellAdjustmentView[];
    };
  };
}

export interface AdoptRoutePreviewRequest {
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
  readonly acceptedUserAdjustments?: readonly RouteUserDwellAdjustmentView[];
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

export interface RouteAdoptDeltaV3 extends Omit<
  RouteAdoptDeltaV2,
  'schemaVersion'
> {
  readonly schemaVersion: 'route-adopt-delta-v3';
  readonly userDwellAdjustments: readonly {
    readonly intentId: string;
    readonly nodeId: string;
    readonly beforeDurationSeconds: number;
    readonly afterDurationSeconds: number;
    readonly beforeLocked: boolean;
  }[];
}

export interface RouteAdoptDeltaV4 extends Omit<
  RouteAdoptDeltaV3,
  'schemaVersion'
> {
  readonly schemaVersion: 'route-adopt-delta-v4';
  readonly replacementScope: 'FULL_CORRIDOR' | 'SUFFIX';
  readonly sourceRouteAnchorFromNodeId: string;
  readonly sourceRouteAnchorToNodeId: string;
  readonly replacementAnchorFromNodeId: string;
  readonly replacementAnchorToNodeId: string;
  readonly preservedPrefixNodeIds: readonly string[];
  readonly preservedPrefixTransportEdgeIds: readonly string[];
  readonly preservedPrefixHash: string;
  readonly archivedTransportEdgeIds: readonly string[];
}

export interface ExternalAdoptedRouteAnchorSnapshot {
  readonly schemaVersion: 'external-adopted-route-anchor-v1';
  readonly externalOrigin: ExternalRouteOriginSnapshot;
  readonly materializedNodeId: string;
  readonly materializedPlaceId: string;
  readonly materializedDayOccurrenceId: string;
  readonly localDate: string;
}

export interface RouteAdoptDeltaV5 extends Omit<
  RouteAdoptDeltaV3,
  'schemaVersion'
> {
  readonly schemaVersion: 'route-adopt-delta-v5';
  readonly replacementScope: 'EXTERNAL_ORIGIN';
  readonly externalOriginId: string;
  readonly sourceGroundTransitLegExecutionId: string;
  readonly sourceAdoptedRouteId: string;
  readonly sourceTransportEdgeId: string;
  readonly sourceRouteAnchorFromNodeId: string;
  readonly sourceRouteAnchorToNodeId: string;
  readonly sourceDivergenceNodeId: string;
  readonly destinationNodeId: string;
  readonly materializedOriginNodeId: string;
  readonly materializedOriginPlaceId: string;
  readonly materializedOriginDayOccurrenceId: string;
  readonly materializedOriginAnchorSnapshot: ExternalAdoptedRouteAnchorSnapshot;
  readonly preservedPrefixNodeIds: readonly string[];
  readonly preservedPrefixTransportEdgeIds: readonly string[];
  readonly preservedPrefixHash: string;
  readonly replacementNodeIds: readonly string[];
  readonly archivedTransportEdgeIds: readonly string[];
  readonly archivableProviderActualTransportEdgeIds: readonly string[];
  /** Exact adopted generated-node/Place/placement facts for defensive Undo. */
  readonly afterGeneratedNodeFacts: readonly Record<string, unknown>[];
  /** Adopt-created RAIL/BUS edge coverage and their exact execution baseline. */
  readonly createdGroundTransitTransportEdgeIds: readonly string[];
  readonly afterGroundTransitLegFacts: readonly Record<string, unknown>[];
  readonly archivedSuffixHash: string;
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

export interface RouteUndoDeltaV2 extends Omit<
  RouteUndoDeltaV1,
  'schemaVersion'
> {
  readonly schemaVersion: 'route-undo-delta-v2';
  readonly restoredUserTimeIntentIds: readonly string[];
}

export interface RouteUndoDeltaV3 extends Omit<
  RouteUndoDeltaV2,
  'schemaVersion'
> {
  readonly schemaVersion: 'route-undo-delta-v3';
  readonly dematerializedExternalOriginNodeId: string;
  readonly dematerializedExternalOriginPlaceId: string;
  readonly retainedExternalOriginId: string;
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
    | RouteAdoptDeltaV2
    | RouteAdoptDeltaV3
    | RouteAdoptDeltaV4
    | RouteAdoptDeltaV5
    | RouteUndoDeltaV1
    | RouteUndoDeltaV2
    | RouteUndoDeltaV3
    | Record<string, unknown>;
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

/** Explicit search only; the server revalidates the supplied READY handoff. */
export interface ControlledAlternativeSearchRequest {
  readonly handoff: import('./ground-transit.js').GroundTransitRouteReevaluationHandoffView;
}
export interface ControlledAlternativeSearchResponse {
  readonly handoff: import('./ground-transit.js').GroundTransitRouteReevaluationHandoffView;
  readonly result: RouteQueryResponse | ExternalOriginRouteQueryResponse;
}
