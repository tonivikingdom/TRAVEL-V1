export type TripNodeKind = 'PLACE_VISIT' | 'FREE_ACTION';
export type TripNodeSource = 'USER_PLANNED';

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
  readonly kind: TripNodeKind;
  readonly localDate: Date;
  readonly position: number;
  readonly place: PlaceRecord | null;
  readonly note: string | null;
  readonly source: TripNodeSource;
  readonly createdAt: Date;
  readonly updatedAt: Date;
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
  readonly nodes: readonly ItineraryNodeRecord[];
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
      readonly localDate: Date;
      readonly position: number;
      readonly place: RepositoryPlaceInput;
      readonly note: string | null;
    }
  | {
      readonly type: 'ADD_FREE_ACTION';
      readonly localDate: Date;
      readonly position: number;
      readonly note: string | null;
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
      readonly place: RepositoryPlaceInput;
    };

export type TripMutationResult =
  | { readonly status: 'SUCCESS'; readonly trip: TripAggregateRecord }
  | {
      readonly status:
        | 'NOT_FOUND'
        | 'VERSION_CONFLICT'
        | 'DATE_OWNED'
        | 'INVALID_POSITION'
        | 'INVALID_COMMAND';
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
}
