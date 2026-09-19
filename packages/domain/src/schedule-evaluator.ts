export type ScheduleTemporalLayer = 'PLANNED' | 'ESTIMATED' | 'ACTUAL';
export type SchedulePointKind = 'ARRIVAL' | 'DEPARTURE';
export type ScheduleIntentOperator =
  'EXACT' | 'NOT_BEFORE' | 'NOT_AFTER' | 'MINIMUM';
export type ScheduleEvaluationStatus =
  'SATISFIED' | 'VIOLATED' | 'UNKNOWN' | 'CONFLICT';

export interface ScheduleTemporalValue {
  readonly id: string;
  readonly layer: ScheduleTemporalLayer;
  readonly pointKind: SchedulePointKind;
  readonly instant: Date;
  readonly timeZone: string;
  readonly sourceKind: string;
  readonly sourceRef: string | null;
  readonly observedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ScheduleUserTimeIntent =
  | {
      readonly id: string;
      readonly nodeId: string;
      readonly kind: 'POINT_TIME';
      readonly pointKind: SchedulePointKind;
      readonly operator: Exclude<ScheduleIntentOperator, 'MINIMUM'>;
      readonly instant: Date;
      readonly timeZone: string;
      readonly durationSeconds: null;
      readonly locked: boolean;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    }
  | {
      readonly id: string;
      readonly nodeId: string;
      readonly kind: 'MIN_DWELL';
      readonly pointKind: null;
      readonly operator: 'MINIMUM';
      readonly instant: null;
      readonly timeZone: null;
      readonly durationSeconds: number;
      readonly locked: boolean;
      readonly createdAt: Date;
      readonly updatedAt: Date;
    };

export interface FixedTransportScheduleAnchor {
  readonly transportEdgeId: string;
  readonly nodeId: string;
  readonly pointKind: SchedulePointKind;
  readonly value: ScheduleTemporalValue;
}

export interface ScheduleNodeInput {
  readonly nodeId: string;
  readonly dayOccurrenceId: string;
  readonly timeValues: readonly ScheduleTemporalValue[];
  readonly intents: readonly ScheduleUserTimeIntent[];
}

export interface ScheduleEvaluationInput {
  readonly nodes: readonly ScheduleNodeInput[];
  readonly fixedTransportAnchors: readonly FixedTransportScheduleAnchor[];
}

export interface EffectiveSchedulePoint {
  readonly value: ScheduleTemporalValue;
  readonly subjectType: 'NODE' | 'FIXED_TRANSPORT';
  readonly subjectId: string;
  readonly anchor: 'FIXED_TRANSPORT' | null;
}

export interface SchedulePointProjection {
  readonly planned: ScheduleTemporalValue | null;
  readonly estimated: ScheduleTemporalValue | null;
  readonly actual: ScheduleTemporalValue | null;
  readonly effective: EffectiveSchedulePoint | null;
}

export type ScheduleMeasure =
  | {
      readonly kind: 'INSTANT';
      readonly instant: Date;
      readonly timeZone: string;
    }
  | { readonly kind: 'DURATION'; readonly durationSeconds: number };

export interface ScheduleConstraintEvaluation {
  readonly intentIds: readonly string[];
  readonly nodeId: string;
  readonly status: ScheduleEvaluationStatus;
  readonly rule: ScheduleIntentOperator | 'USER_CONSTRAINT_CONFLICT';
  readonly expected: ScheduleMeasure | null;
  readonly current: ScheduleMeasure | null;
  readonly currentLayer: ScheduleTemporalLayer | null;
  readonly sourceRefs: readonly string[];
  readonly locked: boolean;
  readonly explanation: string;
}

export interface ScheduleNodeEvaluation {
  readonly nodeId: string;
  readonly dayOccurrenceId: string;
  readonly arrival: SchedulePointProjection;
  readonly departure: SchedulePointProjection;
  readonly intents: readonly ScheduleUserTimeIntent[];
  readonly anchors: readonly FixedTransportScheduleAnchor[];
  readonly dwellSeconds: number | null;
  readonly status: ScheduleEvaluationStatus;
  readonly evaluations: readonly ScheduleConstraintEvaluation[];
}

export interface ScheduleEvaluationResult {
  readonly nodes: readonly ScheduleNodeEvaluation[];
  readonly violations: readonly ScheduleConstraintEvaluation[];
  readonly conflicts: readonly ScheduleConstraintEvaluation[];
}

export function evaluateScheduleConstraints(
  input: ScheduleEvaluationInput,
): ScheduleEvaluationResult {
  const nodes = input.nodes.map((node) => evaluateNode(node, input));
  return {
    nodes,
    violations: nodes.flatMap((node) =>
      node.evaluations.filter((entry) => entry.status === 'VIOLATED'),
    ),
    conflicts: nodes.flatMap((node) =>
      node.evaluations.filter((entry) => entry.status === 'CONFLICT'),
    ),
  };
}

function evaluateNode(
  node: ScheduleNodeInput,
  input: ScheduleEvaluationInput,
): ScheduleNodeEvaluation {
  const anchors = input.fixedTransportAnchors.filter(
    (anchor) => anchor.nodeId === node.nodeId,
  );
  const arrival = projectPoint(node, anchors, 'ARRIVAL');
  const departure = projectPoint(node, anchors, 'DEPARTURE');
  const conflicts = findIntentConflicts(node);
  const conflictingIds = new Set(conflicts.flatMap((entry) => entry.intentIds));
  const evaluations = [
    ...conflicts,
    ...node.intents
      .filter((intent) => !conflictingIds.has(intent.id))
      .map((intent) =>
        evaluateIntent(
          intent,
          intent.kind === 'MIN_DWELL'
            ? { arrival, departure }
            : pointFor(intent.pointKind, arrival, departure),
        ),
      ),
  ];
  const dwellSeconds = calculateDwellSeconds(arrival, departure);
  return {
    nodeId: node.nodeId,
    dayOccurrenceId: node.dayOccurrenceId,
    arrival,
    departure,
    intents: node.intents,
    anchors,
    dwellSeconds,
    status: aggregateStatus(evaluations),
    evaluations,
  };
}

function projectPoint(
  node: ScheduleNodeInput,
  anchors: readonly FixedTransportScheduleAnchor[],
  pointKind: SchedulePointKind,
): SchedulePointProjection {
  const values = node.timeValues.filter(
    (value) => value.pointKind === pointKind,
  );
  const planned = valueForLayer(values, 'PLANNED');
  const estimated = valueForLayer(values, 'ESTIMATED');
  const actual = valueForLayer(values, 'ACTUAL');
  const fixedAnchor = anchors
    .filter((anchor) => anchor.pointKind === pointKind)
    .toSorted((left, right) =>
      left.transportEdgeId.localeCompare(right.transportEdgeId),
    )[0];
  const effective =
    actual === null
      ? estimated === null
        ? fixedAnchor === undefined
          ? planned === null
            ? null
            : effectiveNodeValue(node.nodeId, planned)
          : {
              value: fixedAnchor.value,
              subjectType: 'FIXED_TRANSPORT' as const,
              subjectId: fixedAnchor.transportEdgeId,
              anchor: 'FIXED_TRANSPORT' as const,
            }
        : effectiveNodeValue(node.nodeId, estimated)
      : effectiveNodeValue(node.nodeId, actual);
  return { planned, estimated, actual, effective };
}

function effectiveNodeValue(
  nodeId: string,
  value: ScheduleTemporalValue,
): EffectiveSchedulePoint {
  return {
    value,
    subjectType: 'NODE',
    subjectId: nodeId,
    anchor: null,
  };
}

function valueForLayer(
  values: readonly ScheduleTemporalValue[],
  layer: ScheduleTemporalLayer,
): ScheduleTemporalValue | null {
  return (
    values
      .filter((value) => value.layer === layer)
      .toSorted((left, right) => left.id.localeCompare(right.id))[0] ?? null
  );
}

function evaluateIntent(
  intent: ScheduleUserTimeIntent,
  point:
    | SchedulePointProjection
    | {
        readonly arrival: SchedulePointProjection;
        readonly departure: SchedulePointProjection;
      },
): ScheduleConstraintEvaluation {
  if (intent.kind === 'MIN_DWELL') {
    const points = point as {
      readonly arrival: SchedulePointProjection;
      readonly departure: SchedulePointProjection;
    };
    const dwellSeconds = calculateDwellSeconds(
      points.arrival,
      points.departure,
    );
    if (dwellSeconds === null) {
      return evaluationBase(intent, 'UNKNOWN', {
        expected: { kind: 'DURATION', durationSeconds: intent.durationSeconds },
        current: null,
        currentLayer: null,
        sourceRefs: effectiveSourceRefs(points.arrival, points.departure),
        explanation: '缺少明确的到达或离开时刻，当前无法判断最低停留要求。',
      });
    }
    const satisfied = dwellSeconds >= intent.durationSeconds;
    return evaluationBase(intent, satisfied ? 'SATISFIED' : 'VIOLATED', {
      expected: { kind: 'DURATION', durationSeconds: intent.durationSeconds },
      current: { kind: 'DURATION', durationSeconds: dwellSeconds },
      currentLayer: lowestEffectiveLayer(points.arrival, points.departure),
      sourceRefs: effectiveSourceRefs(points.arrival, points.departure),
      explanation: satisfied
        ? `当前停留 ${formatDuration(dwellSeconds)}，满足至少 ${formatDuration(intent.durationSeconds)} 的要求。`
        : `要求至少停留 ${formatDuration(intent.durationSeconds)}；当前仅 ${formatDuration(dwellSeconds)}。`,
    });
  }

  const projection = point as SchedulePointProjection;
  const effective = projection.effective;
  if (effective === null) {
    return evaluationBase(intent, 'UNKNOWN', {
      expected: intentMeasure(intent),
      current: null,
      currentLayer: null,
      sourceRefs: [],
      explanation: `缺少当前${pointLabel(intent.pointKind)}时刻，无法判断该要求。`,
    });
  }
  const current = effective.value.instant.getTime();
  const expected = intent.instant.getTime();
  const satisfied =
    intent.operator === 'EXACT'
      ? current === expected
      : intent.operator === 'NOT_BEFORE'
        ? current >= expected
        : current <= expected;
  return evaluationBase(intent, satisfied ? 'SATISFIED' : 'VIOLATED', {
    expected: intentMeasure(intent),
    current: {
      kind: 'INSTANT',
      instant: effective.value.instant,
      timeZone: effective.value.timeZone,
    },
    currentLayer: effective.value.layer,
    sourceRefs: sourceRefs(effective.value),
    explanation: explainPointResult(intent, effective.value, satisfied),
  });
}

function evaluationBase(
  intent: ScheduleUserTimeIntent,
  status: ScheduleEvaluationStatus,
  evidence: Omit<
    ScheduleConstraintEvaluation,
    'intentIds' | 'nodeId' | 'status' | 'rule' | 'locked'
  >,
): ScheduleConstraintEvaluation {
  return {
    intentIds: [intent.id],
    nodeId: intent.nodeId,
    status,
    rule: intent.operator,
    locked: intent.locked,
    ...evidence,
  };
}

function findIntentConflicts(
  node: ScheduleNodeInput,
): readonly ScheduleConstraintEvaluation[] {
  return (['ARRIVAL', 'DEPARTURE'] as const).flatMap((pointKind) => {
    const intents = node.intents.filter(
      (
        intent,
      ): intent is Extract<ScheduleUserTimeIntent, { kind: 'POINT_TIME' }> =>
        intent.kind === 'POINT_TIME' && intent.pointKind === pointKind,
    );
    const exact = intents.find((intent) => intent.operator === 'EXACT');
    const lower = intents.find((intent) => intent.operator === 'NOT_BEFORE');
    const upper = intents.find((intent) => intent.operator === 'NOT_AFTER');
    const conflicting = new Set<
      Extract<ScheduleUserTimeIntent, { kind: 'POINT_TIME' }>
    >();
    if (
      lower !== undefined &&
      upper !== undefined &&
      lower.instant.getTime() > upper.instant.getTime()
    ) {
      conflicting.add(lower);
      conflicting.add(upper);
    }
    if (
      exact !== undefined &&
      lower !== undefined &&
      exact.instant < lower.instant
    ) {
      conflicting.add(exact);
      conflicting.add(lower);
    }
    if (
      exact !== undefined &&
      upper !== undefined &&
      exact.instant > upper.instant
    ) {
      conflicting.add(exact);
      conflicting.add(upper);
    }
    if (conflicting.size === 0) {
      return [];
    }
    const entries = [...conflicting].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    );
    return [
      {
        intentIds: entries.map((intent) => intent.id),
        nodeId: node.nodeId,
        status: 'CONFLICT' as const,
        rule: 'USER_CONSTRAINT_CONFLICT' as const,
        expected: null,
        current: null,
        currentLayer: null,
        sourceRefs: entries.map((intent) => intent.id),
        locked: entries.some((intent) => intent.locked),
        explanation: `${pointLabel(pointKind)}的用户时间要求彼此冲突，当前没有可同时满足的时刻。`,
      },
    ];
  });
}

function calculateDwellSeconds(
  arrival: SchedulePointProjection,
  departure: SchedulePointProjection,
): number | null {
  if (arrival.effective === null || departure.effective === null) {
    return null;
  }
  return (
    (departure.effective.value.instant.getTime() -
      arrival.effective.value.instant.getTime()) /
    1_000
  );
}

function lowestEffectiveLayer(
  arrival: SchedulePointProjection,
  departure: SchedulePointProjection,
): ScheduleTemporalLayer | null {
  if (arrival.effective === null || departure.effective === null) {
    return null;
  }
  const rank: Record<ScheduleTemporalLayer, number> = {
    PLANNED: 0,
    ESTIMATED: 1,
    ACTUAL: 2,
  };
  return rank[arrival.effective.value.layer] <=
    rank[departure.effective.value.layer]
    ? arrival.effective.value.layer
    : departure.effective.value.layer;
}

function effectiveSourceRefs(
  ...points: readonly SchedulePointProjection[]
): readonly string[] {
  return points.flatMap((point) =>
    point.effective === null ? [] : sourceRefs(point.effective.value),
  );
}

function sourceRefs(value: ScheduleTemporalValue): readonly string[] {
  return value.sourceRef === null ? [value.id] : [value.id, value.sourceRef];
}

function intentMeasure(
  intent: Extract<ScheduleUserTimeIntent, { kind: 'POINT_TIME' }>,
): ScheduleMeasure {
  return {
    kind: 'INSTANT',
    instant: intent.instant,
    timeZone: intent.timeZone,
  };
}

function pointFor(
  pointKind: SchedulePointKind,
  arrival: SchedulePointProjection,
  departure: SchedulePointProjection,
): SchedulePointProjection {
  return pointKind === 'ARRIVAL' ? arrival : departure;
}

function aggregateStatus(
  evaluations: readonly ScheduleConstraintEvaluation[],
): ScheduleEvaluationStatus {
  if (evaluations.some((entry) => entry.status === 'CONFLICT'))
    return 'CONFLICT';
  if (evaluations.some((entry) => entry.status === 'VIOLATED'))
    return 'VIOLATED';
  if (
    evaluations.length === 0 ||
    evaluations.some((entry) => entry.status === 'UNKNOWN')
  ) {
    return 'UNKNOWN';
  }
  return 'SATISFIED';
}

function explainPointResult(
  intent: Extract<ScheduleUserTimeIntent, { kind: 'POINT_TIME' }>,
  current: ScheduleTemporalValue,
  satisfied: boolean,
): string {
  const label = pointLabel(intent.pointKind);
  const rule =
    intent.operator === 'EXACT'
      ? '精确'
      : intent.operator === 'NOT_BEFORE'
        ? '不早于'
        : '不晚于';
  return satisfied
    ? `${label}${rule}要求已由当前 ${current.layer} 时刻满足。`
    : `${label}${rule}要求与当前 ${current.layer} 时刻冲突。`;
}

function pointLabel(pointKind: SchedulePointKind): string {
  return pointKind === 'ARRIVAL' ? '到达' : '离开';
}

function formatDuration(seconds: number): string {
  if (Number.isInteger(seconds) && seconds % 60 === 0) {
    return `${seconds / 60} 分钟`;
  }
  return `${seconds} 秒`;
}
