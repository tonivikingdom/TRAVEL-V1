import type { FlightSnapshotView } from './flights.js';
import type { ExecutionCurrentState } from './execution.js';

/** Stored, owner-scoped evidence only. Reading never refreshes a Provider. */
export interface InTripView {
  readonly tripId: string;
  readonly tripVersion: number;
  readonly execution: {
    readonly state: ExecutionCurrentState;
    readonly currentNodeId: string | null;
    readonly targetNodeId: string | null;
    readonly recordedAt: string | null;
  };
  readonly flights: readonly {
    readonly transportEdgeId: string;
    readonly selectedSnapshot: FlightSnapshotView;
    readonly latestSnapshot: FlightSnapshotView;
    readonly providerUnavailable: boolean;
  }[];
}
