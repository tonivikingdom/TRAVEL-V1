import type {
  FlightActualConflictView,
  FlightBindingView,
  FlightObservationDisposition,
  FlightSnapshotView,
} from '@travel/contracts';

export interface FlightLookupInput {
  readonly flightNumber: string;
  readonly date: string;
}

export interface FlightSnapshotProvider {
  search(input: FlightLookupInput): Promise<readonly FlightSnapshotView[]>;
  refresh(input: FlightLookupInput): Promise<readonly FlightSnapshotView[]>;
}

export type FlightAdoptRepositoryResult =
  | {
      readonly status: 'SUCCESS';
      readonly binding: FlightBindingView;
      readonly resultingTripVersion: number;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly status:
        | 'NOT_FOUND'
        | 'VERSION_CONFLICT'
        | 'FACT_PROTECTED'
        | 'INVALID_TRANSPORT';
    };

export type FlightRefreshRepositoryResult =
  | {
      readonly status: 'SUCCESS';
      readonly binding: FlightBindingView;
      readonly resultingTripVersion: number;
      readonly factsChanged: boolean;
      readonly actualConflicts: readonly FlightActualConflictView[];
      readonly observationDisposition: FlightObservationDisposition;
      readonly previousSnapshot: FlightSnapshotView;
    }
  | { readonly status: 'NOT_FOUND' | 'FLIGHT_MISMATCH' };

export interface FlightRepository {
  adopt(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly transportEdgeId: string;
    readonly flight: FlightSnapshotView;
  }): Promise<FlightAdoptRepositoryResult>;
  findOwnedBinding(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
  }): Promise<FlightBindingView | null>;
  refresh(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly flightBindingId: string;
    readonly flight: FlightSnapshotView;
  }): Promise<FlightRefreshRepositoryResult>;
}
