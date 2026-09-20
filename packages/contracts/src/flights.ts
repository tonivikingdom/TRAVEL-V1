import type { ExecutionRiskEvaluationResponse } from './execution.js';
import type { TemporalPointKind } from './trips.js';

export type FlightStatus =
  | 'SCHEDULED'
  | 'BOARDING'
  | 'DEPARTED'
  | 'EN_ROUTE'
  | 'LANDED'
  | 'ARRIVED'
  | 'DELAYED'
  | 'CANCELLED'
  | 'DIVERTED'
  | 'UNKNOWN';

export type FlightDelayBasis = 'REVISED_TIME' | 'RUNWAY_TIME';

export interface FlightMovementView {
  readonly airportName: string | null;
  readonly airportIata: string | null;
  readonly airportIcao: string | null;
  readonly timeZone: string | null;
  readonly scheduledLocal: string | null;
  readonly scheduledUtc: string | null;
  readonly revisedLocal: string | null;
  readonly revisedUtc: string | null;
  readonly predictedLocal: string | null;
  readonly predictedUtc: string | null;
  readonly runwayLocal: string | null;
  readonly runwayUtc: string | null;
  readonly terminal: string | null;
  readonly gate: string | null;
  readonly checkInDesk: string | null;
  readonly baggageBelt: string | null;
}

export interface FlightSnapshotView {
  readonly provider: 'aerodatabox';
  readonly candidateId: string;
  readonly canonicalFlightNumber: string;
  readonly displayFlightNumber: string;
  readonly serviceDate: string;
  readonly status: FlightStatus;
  readonly rawStatus: string | null;
  readonly airline: {
    readonly name: string | null;
    readonly iata: string | null;
    readonly icao: string | null;
  };
  readonly departure: FlightMovementView;
  readonly arrival: FlightMovementView;
  readonly aircraft: {
    readonly model: string | null;
    readonly registration: string | null;
    readonly icao24: string | null;
    readonly callSign: string | null;
  } | null;
  readonly departureDelayMinutes: number | null;
  readonly arrivalDelayMinutes: number | null;
  readonly departureDelayBasis: FlightDelayBasis | null;
  readonly arrivalDelayBasis: FlightDelayBasis | null;
  readonly fetchedAt: string;
}

export interface FlightSearchRequest {
  readonly flightNumber: string;
  readonly date: string;
}

export interface FlightSearchResponse {
  readonly flights: readonly FlightSnapshotView[];
}

export interface FlightBindingView {
  readonly id: string;
  readonly tripId: string;
  readonly transportEdgeId: string;
  readonly provider: 'aerodatabox';
  readonly providerFlightRef: string;
  readonly canonicalFlightNumber: string;
  readonly displayFlightNumber: string;
  readonly serviceDate: string;
  readonly selectedSnapshot: FlightSnapshotView;
  readonly latestSnapshot: FlightSnapshotView;
  readonly status: FlightStatus;
  readonly lastRefreshedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdoptFlightRequest {
  readonly baseTripVersion: number;
  readonly transportEdgeId: string;
  readonly flight: FlightSnapshotView;
}

export interface AdoptFlightResponse {
  readonly flightBinding: FlightBindingView;
  readonly resultingTripVersion: number;
  readonly idempotentReplay: boolean;
}

export type FlightChangeKind =
  | 'STATUS_CHANGED'
  | 'DEPARTURE_TIME_CHANGED'
  | 'ARRIVAL_TIME_CHANGED'
  | 'GATE_CHANGED'
  | 'TERMINAL_CHANGED'
  | 'BAGGAGE_CHANGED'
  | 'AIRCRAFT_CHANGED';

export interface FlightFieldChange {
  readonly from: string | null;
  readonly to: string | null;
}

export interface FlightChangeSummaryView {
  readonly changeTypes: readonly FlightChangeKind[];
  readonly status: FlightFieldChange | null;
  readonly departureTime: FlightFieldChange | null;
  readonly arrivalTime: FlightFieldChange | null;
  readonly departureGate: FlightFieldChange | null;
  readonly arrivalGate: FlightFieldChange | null;
  readonly departureTerminal: FlightFieldChange | null;
  readonly arrivalTerminal: FlightFieldChange | null;
  readonly baggage: FlightFieldChange | null;
  readonly aircraft: FlightFieldChange | null;
}

export interface FlightActualConflictView {
  readonly pointKind: TemporalPointKind;
  readonly existingInstant: string;
  readonly providerObservedInstant: string;
  readonly observedAt: string;
}

export interface RefreshFlightResponse {
  readonly flightBinding: FlightBindingView;
  readonly resultingTripVersion: number;
  readonly factsChanged: boolean;
  readonly actualConflicts: readonly FlightActualConflictView[];
  readonly actualConflict: boolean;
  readonly changes: FlightChangeSummaryView;
  readonly requiresAttention: boolean;
  readonly requiresRouteReevaluation: boolean;
  readonly riskEvaluation: ExecutionRiskEvaluationResponse;
}
