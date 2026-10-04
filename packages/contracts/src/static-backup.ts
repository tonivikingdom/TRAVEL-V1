import type { FlightMovementView, FlightSnapshotView } from './flights.js';
import type { TripView, TransportMode, UserTimeIntentView } from './trips.js';
import type { RouteTimePointView } from './routes.js';

export interface BackupLocation {
  readonly name: string;
  readonly address: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}
export interface BackupLeg {
  readonly mode: TransportMode;
  readonly from: BackupLocation;
  readonly to: BackupLocation;
  readonly departure: RouteTimePointView | null;
  readonly arrival: RouteTimePointView | null;
  readonly durationSeconds: number | null;
  readonly serviceLabel: string | null;
  readonly fixedService: boolean;
}
export interface BackupFlight {
  readonly flightNumber: string;
  readonly serviceDate: string;
  readonly fetchedAt: string;
  readonly departure: FlightMovementView;
  readonly arrival: FlightMovementView;
}
/** Personal read-only artifact, distinct from TripView and never a live source. */
export interface StaticBackupView {
  readonly schema: 'travel-static-backup-v1';
  readonly id: string;
  readonly tripId: string;
  readonly tripVersion: number;
  readonly generatedAt: string;
  readonly name: string;
  readonly peopleCount: number;
  readonly effectiveStartDate: string | null;
  readonly effectiveEndDate: string | null;
  readonly days: readonly {
    readonly dayOccurrenceId: string;
    readonly sequence: number;
    readonly localDate: string;
    readonly transportProjections: TripView['days'][number]['transportProjections'];
    readonly nodes: readonly {
      readonly id: string;
      readonly kind: 'PLACE_VISIT' | 'FREE_ACTION';
      readonly position: number;
      readonly place: BackupLocation | null;
      readonly note: string | null;
      readonly requirements: readonly Pick<
        UserTimeIntentView,
        | 'kind'
        | 'pointKind'
        | 'operator'
        | 'instant'
        | 'timeZone'
        | 'durationSeconds'
        | 'locked'
      >[];
      readonly plannedTimes: readonly (RouteTimePointView & {
        readonly pointKind: 'ARRIVAL' | 'DEPARTURE';
      })[];
    }[];
  }[];
  readonly transports: readonly {
    readonly id: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly mode: TransportMode;
    readonly serviceLabel: string | null;
    readonly note: string | null;
    readonly plannedTimes: StaticBackupView['days'][number]['nodes'][number]['plannedTimes'];
  }[];
  readonly routes: readonly {
    readonly transportEdgeIds: readonly string[];
    readonly legs: readonly BackupLeg[];
  }[];
  readonly flights: readonly {
    readonly transportEdgeId: string;
    readonly selectedSnapshot: BackupFlight;
    readonly savedSnapshot: BackupFlight;
  }[];
}
export interface GenerateStaticBackupRequest {
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
}
export interface LatestStaticBackupResponse {
  readonly backup: StaticBackupView | null;
}
export type SavedBackupFlightInput = {
  readonly transportEdgeId: string;
  readonly selectedSnapshot: FlightSnapshotView;
  readonly savedSnapshot: FlightSnapshotView;
};
