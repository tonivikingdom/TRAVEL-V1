import type { DayOccurrenceTargetInput } from './trips.js';
export interface PlaceSearchRequest {
  readonly query: string;
  readonly language?: 'ja' | 'en' | 'zh';
  /** Existing owner/Trip-scoped location, never a client-supplied region. */
  readonly contextNodeId?: string;
}
export interface PlaceSearchCandidate {
  readonly providerPlaceRef?: string | null;
  readonly timeZone?: string | null;
  readonly coordinateSystem?: 'WGS84';
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
