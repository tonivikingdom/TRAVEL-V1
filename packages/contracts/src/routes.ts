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
