export type GroundTransitRouteReevaluationReadiness =
  'NOT_REQUIRED' | 'READY' | 'ORIGIN_UNRESOLVED';

export type GroundTransitRouteReevaluationReason =
  | 'ROUTE_REEVALUATION_NOT_REQUIRED'
  | 'CURRENT_PLAN_RECOVERED'
  | 'ROUTE_NOT_CURRENT'
  | 'CURRENT_ROUTE_REEVALUATION_REQUIRED'
  | 'PLANNED_ROUTE_ORIGIN_SAFE'
  | 'CURRENT_ROUTE_CORRIDOR_UNRESOLVED'
  | 'OPERATIONAL_ASSESSMENT_UNAVAILABLE'
  | 'EXECUTION_ALREADY_PROGRESSING'
  | 'CURRENT_POSITION_NOT_SAFE_FOR_ROUTE_ORIGIN'
  | 'LIVE_ORIGIN_REPLANNING_NOT_SUPPORTED'
  | 'QUERY_TIME_ZONE_UNRESOLVED';

export interface GroundTransitRouteReevaluationDecision {
  readonly readiness: GroundTransitRouteReevaluationReadiness;
  readonly reasonCodes: readonly GroundTransitRouteReevaluationReason[];
  readonly query: {
    readonly basisVersion: number;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly hint: {
      readonly type: 'DEPART_AT';
      readonly instant: Date;
      readonly timeZone: string;
    };
  } | null;
}

/** Pure handoff policy. Vehicle observations are deliberately not progress evidence. */
export function resolveGroundTransitRouteReevaluationHandoff(input: {
  readonly requiredAction: 'NONE' | 'ROUTE_REEVALUATION_REQUIRED';
  readonly routeCurrent: boolean;
  readonly operationalKnown: boolean;
  readonly corridorResolved: boolean;
  readonly legExecutionState:
    | 'PENDING'
    | 'IN_PROGRESS'
    | 'ARRIVED_PENDING_HANDOFF'
    | 'COMPLETED'
    | 'NO_LONGER_FEASIBLE'
    | 'UNKNOWN';
  readonly independentExecutionProgress: boolean;
  readonly basisVersion: number;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly timeZone: string | null;
  readonly now: Date;
}): GroundTransitRouteReevaluationDecision {
  if (!input.routeCurrent) {
    return {
      readiness: 'NOT_REQUIRED',
      reasonCodes: ['ROUTE_NOT_CURRENT'],
      query: null,
    };
  }
  if (!input.operationalKnown) {
    return {
      readiness: 'ORIGIN_UNRESOLVED',
      reasonCodes: ['OPERATIONAL_ASSESSMENT_UNAVAILABLE'],
      query: null,
    };
  }
  if (input.requiredAction === 'NONE') {
    return {
      readiness: 'NOT_REQUIRED',
      reasonCodes: [
        'ROUTE_REEVALUATION_NOT_REQUIRED',
        'CURRENT_PLAN_RECOVERED',
      ],
      query: null,
    };
  }
  const reasons: GroundTransitRouteReevaluationReason[] = [
    'CURRENT_ROUTE_REEVALUATION_REQUIRED',
  ];
  if (!input.corridorResolved)
    reasons.push('CURRENT_ROUTE_CORRIDOR_UNRESOLVED');
  if (
    input.independentExecutionProgress ||
    input.legExecutionState === 'IN_PROGRESS' ||
    input.legExecutionState === 'ARRIVED_PENDING_HANDOFF' ||
    input.legExecutionState === 'COMPLETED'
  ) {
    reasons.push(
      'EXECUTION_ALREADY_PROGRESSING',
      'CURRENT_POSITION_NOT_SAFE_FOR_ROUTE_ORIGIN',
      'LIVE_ORIGIN_REPLANNING_NOT_SUPPORTED',
    );
  }
  if (input.timeZone === null) reasons.push('QUERY_TIME_ZONE_UNRESOLVED');
  if (reasons.length > 1) {
    return {
      readiness: 'ORIGIN_UNRESOLVED',
      reasonCodes: reasons,
      query: null,
    };
  }
  return {
    readiness: 'READY',
    reasonCodes: [...reasons, 'PLANNED_ROUTE_ORIGIN_SAFE'],
    query: {
      basisVersion: input.basisVersion,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      hint: {
        type: 'DEPART_AT',
        instant: input.now,
        timeZone: input.timeZone!,
      },
    },
  };
}
