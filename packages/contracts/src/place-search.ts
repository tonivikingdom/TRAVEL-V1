import type { DayOccurrenceTargetInput } from './trips.js';
export interface PlaceSearchCandidate {
  readonly externalId: string;
  readonly provider: string;
  readonly name: string;
  readonly formattedAddress: string | null;
  readonly coordinates: {
    readonly latitude: number;
    readonly longitude: number;
  } | null;
  readonly attribution: string;
  readonly synthetic: boolean;
}
export interface PlaceSearchResult extends PlaceSearchCandidate {
  readonly selectionToken: string;
}
export interface PlaceSearchResponse {
  readonly candidates: readonly PlaceSearchResult[];
  readonly expiresAt: string;
}
export interface PlaceSelectionRequest {
  readonly selectionToken: string;
  readonly baseTripVersion: number;
  readonly idempotencyKey: string;
  readonly targetDay: DayOccurrenceTargetInput;
  readonly position: number;
  readonly note?: string | null;
}
