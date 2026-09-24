export type AssistanceState = 'NOT_ENABLED' | 'ENABLED' | 'PAUSED' | 'STOPPED';

export type AssistanceStopReason = 'USER' | 'NATURAL_END';
export type AssistanceAction = 'ENABLE' | 'PAUSE' | 'RESUME' | 'STOP';
export type TripAssistanceKind = 'LOCATION_ASSISTANCE' | 'AUTO_RECORD';

export interface AssistanceCapabilityView {
  readonly kind: TripAssistanceKind | 'FLIGHT_MONITORING';
  readonly scope: 'TRIP' | 'FLIGHT_BINDING';
  readonly scopeId: string;
  readonly state: AssistanceState;
  readonly revision: number;
  readonly enabledAt: string | null;
  readonly resumedAt: string | null;
  readonly pausedAt: string | null;
  readonly stoppedAt: string | null;
  readonly stopReason: AssistanceStopReason | null;
  readonly effectiveEnabled: boolean;
  readonly effectiveReason:
    | 'ENABLED'
    | 'NOT_ENABLED'
    | 'PAUSED'
    | 'STOPPED'
    | 'LOCATION_ASSISTANCE_INACTIVE'
    | 'NOT_CURRENTLY_ELIGIBLE';
}

export interface TripAssistanceResponse {
  readonly tripId: string;
  readonly capabilities: readonly AssistanceCapabilityView[];
}

export interface AssistanceMutationRequest {
  readonly action: AssistanceAction;
  readonly baseCapabilityRevision: number;
  readonly idempotencyKey: string;
}

export interface AssistanceMutationResponse {
  readonly capability: AssistanceCapabilityView;
  readonly idempotentReplay: boolean;
}
