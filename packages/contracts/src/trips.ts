export type ItineraryNodeKind = 'PLACE_VISIT' | 'FREE_ACTION';
export type ItineraryNodeSource = 'USER_PLANNED' | 'ROUTE_GENERATED';
export type TransportMode =
  | 'WALKING'
  | 'DRIVING'
  | 'TAXI'
  | 'RAIL'
  | 'BUS'
  | 'FERRY'
  | 'FLIGHT'
  | 'OTHER';
export type TransportSource = 'MANUAL' | 'ADOPTED_ROUTE';
export type TransportDayProjectionRole =
  'SAME_DAY' | 'START' | 'OCCUPIED' | 'END';
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
  | 'PROVIDER_OBSERVATION'
  | 'EXECUTION_OBSERVATION';
export type UserTimeIntentKind = 'POINT_TIME' | 'MIN_DWELL';
export type UserTimeIntentOperator =
  'EXACT' | 'NOT_BEFORE' | 'NOT_AFTER' | 'MINIMUM';
export type ScheduleEvaluationStatus =
  'SATISFIED' | 'VIOLATED' | 'UNKNOWN' | 'CONFLICT';

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
  readonly adoptedRouteId: string | null;
  readonly provider: string | null;
  readonly providerPlaceRef: string | null;
  readonly providerHubRef: string | null;
  readonly sourceOperationId: string | null;
  readonly autoReplaceable: boolean;
  readonly userModifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly timeValues: readonly TemporalValueView[];
  readonly timeIntents: readonly UserTimeIntentView[];
  readonly systemDwellSuggestion?: SystemDwellSuggestionView | null;
}

export interface SystemDwellSuggestionView {
  readonly id: string;
  readonly durationSeconds: number;
  readonly source: 'SYSTEM_SUGGESTION';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UserTimeIntentView {
  readonly id: string;
  readonly kind: UserTimeIntentKind;
  readonly pointKind: TemporalPointKind | null;
  readonly operator: UserTimeIntentOperator;
  readonly instant: string | null;
  readonly timeZone: string | null;
  readonly durationSeconds: number | null;
  readonly locked: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  readonly adoptedRouteId: string | null;
  readonly provider: string | null;
  readonly providerRef: string | null;
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
  readonly adoptedRouteId: string | null;
  readonly provider: string | null;
  readonly providerRef: string | null;
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
  readonly transportProjections: readonly TransportDayProjectionView[];
}

export interface TransportDayProjectionView {
  readonly transportEdgeId: string;
  readonly dayOccurrenceId: string;
  readonly role: TransportDayProjectionRole;
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
    }
  | {
      readonly type: 'SET_TIME_INTENT';
      readonly nodeId: string;
      readonly pointKind: TemporalPointKind;
      readonly operator: Exclude<UserTimeIntentOperator, 'MINIMUM'>;
      readonly instant: string;
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

export interface SetResolvedTemporalValueRequest {
  readonly baseTripVersion: number;
  readonly subject: TemporalSubjectInput;
  readonly value: ResolvedTemporalValueInput;
}

export interface TransportHistoryResponse {
  readonly history: readonly TransportHistoryView[];
}

export interface ScheduleEffectivePointView {
  readonly value: TemporalValueView;
  readonly subjectType: 'NODE' | 'TRANSPORT' | 'FIXED_TRANSPORT';
  readonly subjectId: string;
  readonly anchor: 'TRANSPORT_ACTUAL' | 'FIXED_TRANSPORT' | null;
}

export interface SchedulePointProjectionView {
  readonly planned: TemporalValueView | null;
  readonly estimated: TemporalValueView | null;
  readonly actual: TemporalValueView | null;
  readonly effective: ScheduleEffectivePointView | null;
  readonly requirementWindow: SchedulePropagationWindowView;
}

export type SchedulePropagationWindowStatus =
  | 'UNBOUNDED'
  | 'LOWER_BOUNDED'
  | 'UPPER_BOUNDED'
  | 'BOUNDED'
  | 'EXACT'
  | 'CONFLICT';

export type SchedulePropagationRuleId =
  | 'USER_EXACT'
  | 'USER_NOT_BEFORE'
  | 'USER_NOT_AFTER'
  | 'NODE_ACTUAL'
  | 'TRANSPORT_ACTUAL'
  | 'FIXED_TRANSPORT_PLANNED'
  | 'MIN_DWELL_FORWARD'
  | 'MIN_DWELL_BACKWARD';

export interface ScheduleBoundBasisView {
  readonly ruleId: SchedulePropagationRuleId;
  readonly sourceRefs: readonly string[];
  readonly explanation: string;
}

export interface SchedulePropagationWindowView {
  readonly earliest: string | null;
  readonly latest: string | null;
  readonly status: SchedulePropagationWindowStatus;
  readonly earliestBasis: readonly ScheduleBoundBasisView[];
  readonly latestBasis: readonly ScheduleBoundBasisView[];
}

export interface FixedTransportAnchorView {
  readonly type: 'FIXED_TRANSPORT';
  readonly transportEdgeId: string;
  readonly nodeId: string;
  readonly pointKind: TemporalPointKind;
  readonly value: TemporalValueView;
}

export type ScheduleMeasureView =
  | {
      readonly kind: 'INSTANT';
      readonly instant: string;
      readonly timeZone: string;
    }
  | { readonly kind: 'DURATION'; readonly durationSeconds: number };

export interface ScheduleConstraintEvaluationView {
  readonly intentIds: readonly string[];
  readonly nodeId: string;
  readonly status: ScheduleEvaluationStatus;
  readonly rule: UserTimeIntentOperator | 'USER_CONSTRAINT_CONFLICT';
  readonly expected: ScheduleMeasureView | null;
  readonly current: ScheduleMeasureView | null;
  readonly currentLayer: TemporalLayer | null;
  readonly sourceRefs: readonly string[];
  readonly locked: boolean;
  readonly explanation: string;
}

export interface ScheduleUserConstraintConflictView extends ScheduleConstraintEvaluationView {
  readonly type: 'USER_CONSTRAINT_CONFLICT';
}

export interface SchedulePropagationConflictView {
  readonly type: 'PROPAGATION_BOUND_CONFLICT';
  readonly nodeId: string;
  readonly pointKind: TemporalPointKind;
  readonly lower: string;
  readonly upper: string;
  readonly lowerBasis: readonly ScheduleBoundBasisView[];
  readonly upperBasis: readonly ScheduleBoundBasisView[];
  readonly sourceRefs: readonly string[];
  readonly explanation: string;
}

export type ScheduleConflictView =
  ScheduleUserConstraintConflictView | SchedulePropagationConflictView;

export interface ScheduleNodeProjectionView {
  readonly nodeId: string;
  readonly dayOccurrenceId: string;
  readonly arrival: SchedulePointProjectionView;
  readonly departure: SchedulePointProjectionView;
  readonly activeUserTimeIntents: readonly UserTimeIntentView[];
  readonly anchors: readonly FixedTransportAnchorView[];
  readonly dwellSeconds: number | null;
  readonly status: ScheduleEvaluationStatus;
  readonly evaluations: readonly ScheduleConstraintEvaluationView[];
}

export interface ScheduleProjectionView {
  readonly tripId: string;
  readonly basisVersion: number;
  readonly nodes: readonly ScheduleNodeProjectionView[];
  readonly violations: readonly ScheduleConstraintEvaluationView[];
  readonly conflicts: readonly ScheduleConflictView[];
}
