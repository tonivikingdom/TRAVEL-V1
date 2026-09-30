import type {
  ExternalOriginCandidateView,
  ExternalOriginMutationResponse,
} from '@travel/contracts';
import type {
  ExternalOriginFact,
  GroundTransitHubMetadata,
} from '@travel/domain';
import type { GroundTransitLegRecord } from './ground-transit-ports.js';
export interface GroundTransitHubResolver {
  resolveHub(input: {
    provider: string;
    providerHubRef: string;
    labelHint: string | null;
  }): Promise<
    | { status: 'RESOLVED'; hub: GroundTransitHubMetadata }
    | { status: 'NOT_FOUND' | 'AMBIGUOUS' | 'UNAVAILABLE' }
  >;
}
export interface ExternalOriginRecord
  extends ExternalOriginFact, GroundTransitHubMetadata {
  readonly tripId: string;
  readonly kind: 'TRANSIT_HUB';
  readonly sourceAdoptedRouteId: string;
  readonly sourceTransportEdgeId: string;
  readonly sourceGroundTransitLegExecutionId: string;
  readonly sourceGroundTransitObservationId: string;
  readonly sourceObservationIdentity: string;
  readonly sourceObservationFetchedAt: Date;
  readonly sourceObservationFactsHash: string;
}
export interface ExternalOriginContext {
  readonly tripId: string;
  readonly tripVersion: number;
  readonly leg: GroundTransitLegRecord | null;
  readonly evidence: {
    id: string;
    identity: string;
    fetchedAt: Date;
    factsHash: string;
  } | null;
  readonly itineraryHubs: readonly {
    provider: string | null;
    providerHubRef: string | null;
  }[];
  readonly origins: readonly ExternalOriginRecord[];
  readonly executionEvents: readonly {
    occurredAt: Date;
    undoneAt: Date | null;
  }[];
  readonly frontierState: string;
}
export interface ExternalOriginCandidate extends ExternalOriginCandidateView {
  readonly sourceAdoptedRouteId: string;
  readonly sourceTransportEdgeId: string;
  readonly sourceGroundTransitLegExecutionId: string;
  readonly sourceGroundTransitObservationId: string;
  readonly sourceObservationFactsHash: string;
}
export interface ExternalExecutionOriginRepository {
  read(input: {
    ownerUserId: string;
    tripId: string;
    transportEdgeId: string;
  }): Promise<ExternalOriginContext | null>;
  mutate(input: {
    ownerUserId: string;
    tripId: string;
    transportEdgeId: string | null;
    originId: string | null;
    action: 'ARRIVAL' | 'DEPARTURE';
    baseTripVersion: number;
    idempotencyKey: string;
    requestHash: string;
    now: Date;
    revalidate: (
      context: ExternalOriginContext,
    ) => Promise<ExternalOriginCandidate>;
  }): Promise<ExternalOriginMutationResponse>;
}
