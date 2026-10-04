import type { GroundTransitRouteReevaluationHandoffView } from './ground-transit.js';
import type { ScheduleEvaluationStatus } from './trips.js';

/** Presentation of existing domain assessments; not a second risk state machine. */
export interface TripImpactItemView {
  readonly nodeId: string | null;
  readonly transportEdgeId: string | null;
  readonly status: ScheduleEvaluationStatus;
  readonly changed: boolean;
  readonly title: string;
  readonly explanation: string;
}
export interface TripImpactView {
  readonly tripId: string;
  readonly basisVersion: number;
  readonly evaluatedAt: string;
  readonly items: readonly TripImpactItemView[];
  readonly handoffs: readonly GroundTransitRouteReevaluationHandoffView[];
}
