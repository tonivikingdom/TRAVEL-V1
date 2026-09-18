export type ItineraryNodeKind = 'PLACE_VISIT' | 'FREE_ACTION';
export type ItineraryNodeSource = 'USER_PLANNED';

export interface PlaceView {
  readonly id: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string | null;
  readonly createdAt: string;
}

export interface ItineraryNodeView {
  readonly id: string;
  readonly kind: ItineraryNodeKind;
  readonly localDate: string;
  readonly position: number;
  readonly place: PlaceView | null;
  readonly note: string | null;
  readonly source: ItineraryNodeSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DayView {
  readonly localDate: string;
  readonly nodes: readonly ItineraryNodeView[];
}

export interface TripView {
  readonly id: string;
  readonly name: string;
  readonly planningAnchorDate: string;
  readonly defaultPeopleCount: number;
  readonly version: number;
  readonly effectiveStartDate: string | null;
  readonly effectiveEndDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly days: readonly DayView[];
}

export interface TripListResponse {
  readonly trips: readonly TripView[];
}

export interface ExistingPlaceInput {
  readonly type: 'EXISTING';
  readonly placeId: string;
}

export interface CustomPlaceInput {
  readonly type: 'CUSTOM';
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address?: string | null;
}

export type PlaceInput = ExistingPlaceInput | CustomPlaceInput;

export type TripCommandInput =
  | {
      readonly type: 'ADD_PLACE_VISIT';
      readonly localDate: string;
      readonly position: number;
      readonly place: PlaceInput;
      readonly note?: string | null;
    }
  | {
      readonly type: 'ADD_FREE_ACTION';
      readonly localDate: string;
      readonly position: number;
      readonly note?: string | null;
    }
  | { readonly type: 'DELETE_NODE'; readonly nodeId: string }
  | {
      readonly type: 'MOVE_NODE_WITHIN_DAY';
      readonly nodeId: string;
      readonly position: number;
    }
  | {
      readonly type: 'REPLACE_PLACE';
      readonly nodeId: string;
      readonly place: PlaceInput;
    };
