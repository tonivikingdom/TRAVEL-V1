export interface ExternalOriginCandidateView {
  readonly candidateRef: string;
  readonly provider: string;
  readonly providerHubRef: string;
  readonly canonicalHubRef: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timeZone: string;
  readonly sourceObservationIdentity: string;
  readonly sourceObservationFetchedAt: string;
}
export interface ExternalExecutionOriginView extends Omit<
  ExternalOriginCandidateView,
  'candidateRef'
> {
  readonly id: string;
  readonly tripId: string;
  readonly kind: 'TRANSIT_HUB';
  readonly confirmationSource: 'MANUAL';
  readonly sourceAdoptedRouteId: string;
  readonly sourceTransportEdgeId: string;
  readonly sourceGroundTransitLegExecutionId: string;
  readonly sourceGroundTransitObservationId: string;
  readonly sourceObservationFactsHash: string;
  readonly status: 'ARRIVED' | 'DEPARTED' | 'INVALIDATED';
  readonly currentness: 'CURRENT' | 'DEPARTED' | 'SUPERSEDED' | 'CONFLICT';
  readonly arrivedAt: string;
  readonly departedAt: string | null;
  readonly invalidatedAt: string | null;
}
export interface ExternalOriginResponse {
  readonly tripId: string;
  readonly sourceTransportEdgeId: string;
  readonly availability:
    'NOT_AVAILABLE' | 'CONFIRMATION_REQUIRED' | 'CONFIRMED' | 'UNRESOLVED';
  readonly reasonCodes: readonly string[];
  readonly candidate: ExternalOriginCandidateView | null;
  readonly currentOrigin: ExternalExecutionOriginView | null;
}
export interface ConfirmExternalOriginRequest {
  readonly baseTripVersion: number;
  readonly candidateRef: string;
  readonly idempotencyKey: string;
}
export interface DepartExternalOriginRequest {
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
}
export interface ExternalOriginMutationResponse {
  readonly origin: ExternalExecutionOriginView;
  readonly resultingTripVersion: number;
}
