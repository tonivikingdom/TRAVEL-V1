import type { TransportMode } from './trips.js';

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
}

export interface RoutePreviewLocationView extends RouteLocationView {
  readonly ref: string;
}

export interface RoutePreviewSegmentView {
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
  readonly status: 'ACTIVE' | 'EXPIRED';
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
    readonly requiresGeneratedNodes: boolean;
    readonly generatedTransferPoints: readonly RoutePreviewLocationView[];
    readonly proposedSegments: readonly RoutePreviewSegmentView[];
    readonly temporalLayer: 'PLANNED';
    readonly temporalSourceKind: 'ADOPTED_TRANSPORT_FACT';
  };
}
