export type ItineraryNodeKind = 'PLACE_VISIT' | 'FREE_ACTION';
export type ItineraryNodeSource = 'USER_PLANNED';
export type TransportMode =
  | 'WALKING'
  | 'DRIVING'
  | 'TAXI'
  | 'RAIL'
  | 'BUS'
  | 'FERRY'
  | 'FLIGHT'
  | 'OTHER';
export type TransportSource = 'MANUAL';
export type TransportInvalidationReason =
  | 'ADJACENCY_CHANGED'
  | 'ENDPOINT_REPLACED'
  | 'NODE_DELETED'
  | 'USER_REPLACED'
  | 'USER_CLEARED';
export type ConnectionState =
  'ACTIVE' | 'MISSING' | 'NOT_APPLICABLE' | 'RUNTIME_ORIGIN_REQUIRED';
export type TemporalLayer = 'PLANNED' | 'ESTIMATED' | 'ACTUAL';
export type TemporalPointKind = 'ARRIVAL' | 'DEPARTURE';
export type TemporalSourceKind =
  | 'USER_VALUE'
  | 'ADOPTED_TRANSPORT_FACT'
  | 'SYSTEM_SUGGESTION'
  | 'DERIVED'
  | 'PROVIDER_OBSERVATION';

export interface TemporalValueView {
  readonly id: string;
  readonly layer: TemporalLayer;
  readonly pointKind: TemporalPointKind;
  readonly instant: string;
  readonly timeZone: string;
  readonly sourceKind: TemporalSourceKind;
  readonly sourceRef: string | null;
  readonly observedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

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
  readonly dayOccurrenceId: string;
  readonly position: number;
  readonly place: PlaceView | null;
  readonly note: string | null;
  readonly source: ItineraryNodeSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timeValues: readonly TemporalValueView[];
}

export interface TransportEdgeView {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly mode: TransportMode;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
  readonly note: string | null;
  readonly source: TransportSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timeValues: readonly TemporalValueView[];
}

export interface TransportHistoryView {
  readonly id: string;
  readonly originalTransportEdgeId: string;
  readonly originalFromNodeId: string;
  readonly originalToNodeId: string;
  readonly mode: TransportMode;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
  readonly note: string | null;
  readonly source: TransportSource;
  readonly originalCreatedAt: string;
  readonly invalidatedAt: string;
  readonly invalidationReason: TransportInvalidationReason;
  readonly timeValues: readonly TemporalValueView[];
}

export interface ConnectionView {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly state: ConnectionState;
  readonly transport: TransportEdgeView | null;
}

export interface DayView {
  readonly dayOccurrenceId: string;
  readonly localDate: string;
  readonly sequence: number;
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
  readonly connections: readonly ConnectionView[];
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

export type DayOccurrenceTargetInput =
  | {
      readonly type: 'EXISTING';
      readonly dayOccurrenceId: string;
    }
  | {
      readonly type: 'NEW';
      readonly localDate: string;
      readonly sequence: number;
    };

export type TripCommandInput =
  | {
      readonly type: 'ADD_PLACE_VISIT';
      readonly targetDay: DayOccurrenceTargetInput;
      readonly position: number;
      readonly place: PlaceInput;
      readonly note?: string | null;
    }
  | {
      readonly type: 'ADD_FREE_ACTION';
      readonly targetDay: DayOccurrenceTargetInput;
      readonly position: number;
      readonly note?: string | null;
    }
  | { readonly type: 'DELETE_NODE'; readonly nodeId: string }
  | {
      readonly type: 'MOVE_NODE';
      readonly nodeId: string;
      readonly dayOccurrenceId: string;
      readonly position: number;
    }
  | {
      readonly type: 'REPLACE_PLACE';
      readonly nodeId: string;
      readonly place: PlaceInput;
    }
  | {
      readonly type: 'SET_MANUAL_TRANSPORT';
      readonly fromNodeId: string;
      readonly toNodeId: string;
      readonly mode: TransportMode;
      readonly fixedService: boolean;
      readonly serviceLabel?: string | null;
      readonly note?: string | null;
    }
  | {
      readonly type: 'CLEAR_TRANSPORT';
      readonly transportEdgeId: string;
    };

export type TemporalSubjectInput =
  | { readonly type: 'NODE'; readonly nodeId: string }
  | { readonly type: 'TRANSPORT'; readonly transportEdgeId: string };

export interface ResolvedTemporalValueInput {
  readonly layer: TemporalLayer;
  readonly pointKind: TemporalPointKind;
  readonly instant: string;
  readonly timeZone: string;
  readonly sourceKind: TemporalSourceKind;
  readonly sourceRef?: string | null;
  readonly observedAt?: string | null;
}
