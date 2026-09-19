import type {
  TemporalLayer,
  TemporalPointKind,
  TemporalSourceKind,
  TransportMode,
  UserTimeIntentOperator,
} from '@travel/contracts';

export type TripNodeKind = 'PLACE_VISIT' | 'FREE_ACTION';
export type TripNodeSource = 'USER_PLANNED' | 'ROUTE_GENERATED';
export type TransportInvalidationReason =
  | 'ADJACENCY_CHANGED'
  | 'ENDPOINT_REPLACED'
  | 'NODE_DELETED'
  | 'USER_REPLACED'
  | 'USER_CLEARED';

export interface TemporalValueRecord {
  readonly id: string;
  readonly layer: TemporalLayer;
  readonly pointKind: TemporalPointKind;
  readonly instant: Date;
  readonly timeZone: string;
  readonly sourceKind: TemporalSourceKind;
  readonly sourceRef: string | null;
  readonly observedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PlaceRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly address: string | null;
  readonly createdAt: Date;
}

export interface ItineraryNodeRecord {
  readonly id: string;
  readonly tripId: string;
  readonly dayOccurrenceId: string;
  readonly kind: TripNodeKind;
  readonly position: number;
  readonly place: PlaceRecord | null;
  readonly note: string | null;
  readonly source: TripNodeSource;
  readonly adoptedRouteId?: string | null;
  readonly provider?: string | null;
  readonly providerPlaceRef?: string | null;
  readonly providerHubRef?: string | null;
  readonly sourceOperationId?: string | null;
  readonly autoReplaceable?: boolean;
  readonly userModifiedAt?: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly timeValues: readonly TemporalValueRecord[];
  readonly timeIntents: readonly UserTimeIntentRecord[];
  readonly systemDwellSuggestion?: SystemDwellSuggestionRecord | null;
}

export interface SystemDwellSuggestionRecord {
  readonly id: string;
  readonly tripId: string;
  readonly nodeId: string;
  readonly durationSeconds: number;
  readonly source: 'SYSTEM_SUGGESTION';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserTimeIntentRecord {
  readonly id: string;
  readonly tripId: string;
  readonly nodeId: string;
  readonly kind: 'POINT_TIME' | 'MIN_DWELL';
  readonly pointKind: TemporalPointKind | null;
  readonly operator: UserTimeIntentOperator;
  readonly instant: Date | null;
  readonly timeZone: string | null;
  readonly durationSeconds: number | null;
  readonly locked: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DayOccurrenceRecord {
  readonly id: string;
  readonly tripId: string;
  readonly localDate: Date;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly nodes: readonly ItineraryNodeRecord[];
  readonly transportProjections?: readonly TransportDayProjectionRecord[];
}

export interface TransportDayProjectionRecord {
  readonly transportEdgeId: string;
  readonly dayOccurrenceId: string;
  readonly role: 'SAME_DAY' | 'START' | 'OCCUPIED' | 'END';
}

export interface TransportEdgeRecord {
  readonly id: string;
  readonly tripId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly mode: TransportMode;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
  readonly note: string | null;
  readonly source: 'MANUAL' | 'ADOPTED_ROUTE';
  readonly adoptedRouteId?: string | null;
  readonly provider?: string | null;
  readonly providerRef?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly timeValues: readonly TemporalValueRecord[];
}

export interface TransportHistoryRecord {
  readonly id: string;
  readonly originalTransportEdgeId: string;
  readonly tripId: string;
  readonly originalFromNodeId: string;
  readonly originalToNodeId: string;
  readonly mode: TransportMode;
  readonly fixedService: boolean;
  readonly serviceLabel: string | null;
  readonly note: string | null;
  readonly source: 'MANUAL' | 'ADOPTED_ROUTE';
  readonly adoptedRouteId?: string | null;
  readonly provider?: string | null;
  readonly providerRef?: string | null;
  readonly originalCreatedAt: Date;
  readonly invalidatedAt: Date;
  readonly invalidationReason: TransportInvalidationReason;
  readonly timeValues: readonly TemporalValueRecord[];
}

export interface TripAggregateRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly planningAnchorDate: Date;
  readonly defaultPeopleCount: number;
  readonly version: number;
  readonly effectiveStartDate: Date | null;
  readonly effectiveEndDate: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly ownedDates: readonly Date[];
  readonly dayOccurrences: readonly DayOccurrenceRecord[];
  readonly transportEdges: readonly TransportEdgeRecord[];
  readonly adoptedRoutes?: readonly AdoptedRouteRecord[];
}

export interface AdoptedRouteRecord {
  readonly id: string;
  readonly tripId: string;
  readonly anchorFromNodeId: string;
  readonly anchorToNodeId: string;
  readonly sourcePreviewId: string;
  readonly candidateSnapshotId: string;
  readonly candidateHash: string;
  readonly policyVersion: string;
  readonly status: 'ACTIVE' | 'REPLACED' | 'UNDONE';
  readonly createdAt: Date;
  readonly replacedAt: Date | null;
  readonly undoneAt: Date | null;
}

export type RepositoryPlaceInput =
  | { readonly type: 'EXISTING'; readonly placeId: string }
  | {
      readonly type: 'CUSTOM';
      readonly name: string;
      readonly latitude: number;
      readonly longitude: number;
      readonly address: string | null;
    };

export type RepositoryTripCommand =
  | {
      readonly type: 'ADD_PLACE_VISIT';
      readonly targetDay: RepositoryDayOccurrenceTarget;
      readonly position: number;
      readonly place: RepositoryPlaceInput;
      readonly note: string | null;
    }
  | {
      readonly type: 'ADD_FREE_ACTION';
      readonly targetDay: RepositoryDayOccurrenceTarget;
      readonly position: number;
      readonly note: string | null;
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
      readonly place: RepositoryPlaceInput;
    }
  | {
      readonly type: 'SET_MANUAL_TRANSPORT';
      readonly fromNodeId: string;
      readonly toNodeId: string;
      readonly mode: TransportMode;
      readonly fixedService: boolean;
      readonly serviceLabel: string | null;
      readonly note: string | null;
    }
  | {
      readonly type: 'CLEAR_TRANSPORT';
      readonly transportEdgeId: string;
    }
  | {
      readonly type: 'SET_TIME_INTENT';
      readonly nodeId: string;
      readonly pointKind: TemporalPointKind;
      readonly operator: Exclude<UserTimeIntentOperator, 'MINIMUM'>;
      readonly instant: Date;
      readonly timeZone: string;
      readonly locked: boolean;
    }
  | {
      readonly type: 'REMOVE_TIME_INTENT';
      readonly nodeId: string;
      readonly pointKind: TemporalPointKind;
      readonly operator: Exclude<UserTimeIntentOperator, 'MINIMUM'>;
    }
  | {
      readonly type: 'SET_MIN_DWELL';
      readonly nodeId: string;
      readonly durationSeconds: number;
      readonly locked: boolean;
    }
  | {
      readonly type: 'REMOVE_MIN_DWELL';
      readonly nodeId: string;
    }
  | {
      readonly type: 'SET_TIME_INTENT_LOCK';
      readonly intentId: string;
      readonly locked: boolean;
    };

export type RepositoryDayOccurrenceTarget =
  | { readonly type: 'EXISTING'; readonly dayOccurrenceId: string }
  | {
      readonly type: 'NEW';
      readonly localDate: Date;
      readonly sequence: number;
    };

export type RepositoryTemporalSubject =
  | { readonly type: 'NODE'; readonly nodeId: string }
  | { readonly type: 'TRANSPORT'; readonly transportEdgeId: string };

export interface RepositoryTemporalValueInput {
  readonly layer: TemporalLayer;
  readonly pointKind: TemporalPointKind;
  readonly instant: Date;
  readonly timeZone: string;
  readonly sourceKind: TemporalSourceKind;
  readonly sourceRef: string | null;
  readonly observedAt: Date | null;
}

export type TripMutationResult =
  | { readonly status: 'SUCCESS'; readonly trip: TripAggregateRecord }
  | {
      readonly status:
        | 'NOT_FOUND'
        | 'VERSION_CONFLICT'
        | 'DATE_OWNED'
        | 'FACT_PROTECTED'
        | 'INVALID_POSITION'
        | 'INVALID_COMMAND'
        | 'NOT_ADJACENT'
        | 'TRANSPORT_NOT_APPLICABLE'
        | 'TRANSPORT_OCCUPIED_DAY';
    };

export interface TripRepository {
  create(input: {
    readonly ownerUserId: string;
    readonly name: string;
    readonly planningAnchorDate: Date;
    readonly defaultPeopleCount: number;
  }): Promise<TripAggregateRecord>;
  listOwned(ownerUserId: string): Promise<readonly TripAggregateRecord[]>;
  findOwnedById(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<TripAggregateRecord | null>;
  updateMetadata(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly name?: string;
    readonly planningAnchorDate?: Date;
    readonly defaultPeopleCount?: number;
  }): Promise<TripMutationResult>;
  executeCommand(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly command: RepositoryTripCommand;
  }): Promise<TripMutationResult>;
  setTemporalValue(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly subject: RepositoryTemporalSubject;
    readonly value: RepositoryTemporalValueInput;
  }): Promise<TripMutationResult>;
  setSystemDwellSuggestion?(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly baseTripVersion: number;
    readonly nodeId: string;
    readonly durationSeconds: number;
  }): Promise<TripMutationResult>;
  listTransportHistoryOwned(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
  }): Promise<readonly TransportHistoryRecord[] | null>;
}
