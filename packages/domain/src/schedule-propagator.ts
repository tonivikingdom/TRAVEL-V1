import type {
  ScheduleNodeInput,
  SchedulePointKind,
  ScheduleTemporalValue,
  ScheduleUserTimeIntent,
} from './schedule-evaluator.js';

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

export type ScheduleTransportAnchorKind =
  'TRANSPORT_ACTUAL' | 'FIXED_TRANSPORT_PLANNED';

export interface SchedulePropagationTransportAnchor {
  readonly transportEdgeId: string;
  readonly nodeId: string;
  readonly pointKind: SchedulePointKind;
  readonly anchorKind: ScheduleTransportAnchorKind;
  readonly value: ScheduleTemporalValue;
}

export interface ScheduleBoundBasis {
  readonly ruleId: SchedulePropagationRuleId;
  readonly sourceRefs: readonly string[];
  readonly explanation: string;
}

export interface SchedulePropagationWindow {
  readonly earliest: Date | null;
  readonly latest: Date | null;
  readonly status: SchedulePropagationWindowStatus;
  readonly earliestBasis: readonly ScheduleBoundBasis[];
  readonly latestBasis: readonly ScheduleBoundBasis[];
}

export interface ScheduleNodePropagation {
  readonly nodeId: string;
  readonly dayOccurrenceId: string;
  readonly arrival: SchedulePropagationWindow;
  readonly departure: SchedulePropagationWindow;
}

export interface SchedulePropagationConflict {
  readonly type: 'PROPAGATION_BOUND_CONFLICT';
  readonly nodeId: string;
  readonly pointKind: SchedulePointKind;
  readonly lower: Date;
  readonly upper: Date;
  readonly lowerBasis: readonly ScheduleBoundBasis[];
  readonly upperBasis: readonly ScheduleBoundBasis[];
  readonly sourceRefs: readonly string[];
  readonly explanation: string;
}

export interface SchedulePropagationInput {
  readonly nodes: readonly ScheduleNodeInput[];
  readonly transportAnchors: readonly SchedulePropagationTransportAnchor[];
}

export interface SchedulePropagationResult {
  readonly nodes: readonly ScheduleNodePropagation[];
  readonly conflicts: readonly SchedulePropagationConflict[];
  readonly relaxationCount: number;
}

interface MutableBound {
  instantMs: number | null;
  basis: ScheduleBoundBasis[];
}

interface MutableWindow {
  readonly lower: MutableBound;
  readonly upper: MutableBound;
}

interface DwellConstraint {
  readonly nodeId: string;
  readonly durationMs: number;
  readonly intent: Extract<ScheduleUserTimeIntent, { kind: 'MIN_DWELL' }>;
}

export function propagateScheduleBounds(
  input: SchedulePropagationInput,
): SchedulePropagationResult {
  assertValidInput(input);
  const windows = new Map<string, MutableWindow>();
  for (const node of input.nodes) {
    windows.set(pointKey(node.nodeId, 'ARRIVAL'), emptyWindow());
    windows.set(pointKey(node.nodeId, 'DEPARTURE'), emptyWindow());
  }

  const dwellConstraints: DwellConstraint[] = [];
  for (const node of input.nodes) {
    for (const intent of node.intents.toSorted(compareIntent)) {
      if (intent.kind === 'MIN_DWELL') {
        dwellConstraints.push({
          nodeId: node.nodeId,
          durationMs: intent.durationSeconds * 1_000,
          intent,
        });
        continue;
      }
      const window = requireWindow(windows, node.nodeId, intent.pointKind);
      const instantMs = intent.instant.getTime();
      if (intent.operator === 'EXACT') {
        const basis = directBasis(
          'USER_EXACT',
          [intent.id],
          `${pointLabel(intent.pointKind)}必须等于用户指定时刻。`,
        );
        tightenLower(window, instantMs, basis);
        tightenUpper(window, instantMs, basis);
      } else if (intent.operator === 'NOT_BEFORE') {
        tightenLower(
          window,
          instantMs,
          directBasis(
            'USER_NOT_BEFORE',
            [intent.id],
            `${pointLabel(intent.pointKind)}不得早于用户指定时刻。`,
          ),
        );
      } else {
        tightenUpper(
          window,
          instantMs,
          directBasis(
            'USER_NOT_AFTER',
            [intent.id],
            `${pointLabel(intent.pointKind)}不得晚于用户指定时刻。`,
          ),
        );
      }
    }

    for (const value of node.timeValues
      .filter((candidate) => candidate.layer === 'ACTUAL')
      .toSorted(compareTemporalValue)) {
      const window = requireWindow(windows, node.nodeId, value.pointKind);
      const basis = directBasis(
        'NODE_ACTUAL',
        temporalSourceRefs(value),
        `${pointLabel(value.pointKind)}已由 ACTUAL 事实固定。`,
      );
      tightenLower(window, value.instant.getTime(), basis);
      tightenUpper(window, value.instant.getTime(), basis);
    }
  }

  for (const anchor of input.transportAnchors.toSorted(compareAnchor)) {
    const window = requireWindow(windows, anchor.nodeId, anchor.pointKind);
    const basis = directBasis(
      anchor.anchorKind,
      [anchor.transportEdgeId, ...temporalSourceRefs(anchor.value)],
      anchor.anchorKind === 'TRANSPORT_ACTUAL'
        ? `交通 ${pointLabel(anchor.pointKind)} ACTUAL 事实固定相邻节点时刻。`
        : `固定班次的 ${pointLabel(anchor.pointKind)} PLANNED 时刻不可平移。`,
    );
    tightenLower(window, anchor.value.instant.getTime(), basis);
    tightenUpper(window, anchor.value.instant.getTime(), basis);
  }

  const orderedConstraints = dwellConstraints.toSorted((left, right) =>
    compareText(left.intent.id, right.intent.id),
  );
  const queue = [...orderedConstraints];
  const maximumRelaxations = Math.max(
    1,
    input.nodes.length * 4 + orderedConstraints.length * 4,
  );
  let relaxationCount = 0;
  while (queue.length > 0) {
    const constraint = queue.shift();
    if (constraint === undefined) break;
    const arrival = requireWindow(windows, constraint.nodeId, 'ARRIVAL');
    const departure = requireWindow(windows, constraint.nodeId, 'DEPARTURE');
    let changed = false;
    if (arrival.lower.instantMs !== null) {
      changed =
        tightenLower(
          departure,
          arrival.lower.instantMs + constraint.durationMs,
          derivedDwellBasis(
            'MIN_DWELL_FORWARD',
            constraint,
            arrival.lower.basis,
          ),
        ) || changed;
    }
    if (departure.upper.instantMs !== null) {
      changed =
        tightenUpper(
          arrival,
          departure.upper.instantMs - constraint.durationMs,
          derivedDwellBasis(
            'MIN_DWELL_BACKWARD',
            constraint,
            departure.upper.basis,
          ),
        ) || changed;
    }
    if (changed) {
      relaxationCount += 1;
      if (relaxationCount > maximumRelaxations) {
        throw new Error(
          'Schedule propagation did not reach a bounded fixed point',
        );
      }
      queue.push(constraint);
    }
  }

  const nodes = input.nodes.map((node) => ({
    nodeId: node.nodeId,
    dayOccurrenceId: node.dayOccurrenceId,
    arrival: freezeWindow(requireWindow(windows, node.nodeId, 'ARRIVAL')),
    departure: freezeWindow(requireWindow(windows, node.nodeId, 'DEPARTURE')),
  }));
  const conflicts = nodes.flatMap((node) =>
    (['ARRIVAL', 'DEPARTURE'] as const).flatMap((pointKind) => {
      const window = pointKind === 'ARRIVAL' ? node.arrival : node.departure;
      if (
        window.earliest === null ||
        window.latest === null ||
        window.earliest.getTime() <= window.latest.getTime()
      ) {
        return [];
      }
      return [
        {
          type: 'PROPAGATION_BOUND_CONFLICT' as const,
          nodeId: node.nodeId,
          pointKind,
          lower: window.earliest,
          upper: window.latest,
          lowerBasis: window.earliestBasis,
          upperBasis: window.latestBasis,
          sourceRefs: uniqueSorted([
            ...window.earliestBasis.flatMap((basis) => basis.sourceRefs),
            ...window.latestBasis.flatMap((basis) => basis.sourceRefs),
          ]),
          explanation: `${pointLabel(pointKind)}的最早可行时刻晚于最晚可行时刻，当前硬约束无法同时满足。`,
        },
      ];
    }),
  );

  return { nodes, conflicts, relaxationCount };
}

function assertValidInput(input: SchedulePropagationInput): void {
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (nodeIds.has(node.nodeId)) {
      throw new Error(`Duplicate schedule node: ${node.nodeId}`);
    }
    nodeIds.add(node.nodeId);
    for (const value of node.timeValues) assertValidDate(value.instant);
    let minimumDwellCount = 0;
    for (const intent of node.intents) {
      if (intent.nodeId !== node.nodeId) {
        throw new Error(
          `Schedule intent ${intent.id} does not belong to node ${node.nodeId}`,
        );
      }
      if (intent.kind === 'POINT_TIME') {
        assertValidDate(intent.instant);
      } else {
        minimumDwellCount += 1;
        if (
          !Number.isSafeInteger(intent.durationSeconds) ||
          intent.durationSeconds <= 0 ||
          intent.durationSeconds > Number.MAX_SAFE_INTEGER / 1_000
        ) {
          throw new Error(`Invalid MIN_DWELL duration: ${intent.id}`);
        }
      }
    }
    if (minimumDwellCount > 1) {
      throw new Error(
        `Duplicate MIN_DWELL constraints for node ${node.nodeId}`,
      );
    }
  }
  for (const anchor of input.transportAnchors) {
    if (!nodeIds.has(anchor.nodeId)) {
      throw new Error(
        `Transport anchor references unknown node: ${anchor.nodeId}`,
      );
    }
    if (
      anchor.anchorKind === 'TRANSPORT_ACTUAL' &&
      anchor.value.layer !== 'ACTUAL'
    ) {
      throw new Error('TRANSPORT_ACTUAL anchor must carry an ACTUAL value');
    }
    if (
      anchor.anchorKind === 'FIXED_TRANSPORT_PLANNED' &&
      anchor.value.layer !== 'PLANNED'
    ) {
      throw new Error(
        'FIXED_TRANSPORT_PLANNED anchor must carry a PLANNED value',
      );
    }
    assertValidDate(anchor.value.instant);
  }
}

function emptyWindow(): MutableWindow {
  return {
    lower: { instantMs: null, basis: [] },
    upper: { instantMs: null, basis: [] },
  };
}

function requireWindow(
  windows: ReadonlyMap<string, MutableWindow>,
  nodeId: string,
  pointKind: SchedulePointKind,
): MutableWindow {
  const window = windows.get(pointKey(nodeId, pointKind));
  if (window === undefined) {
    throw new Error(`Schedule point does not exist: ${nodeId}:${pointKind}`);
  }
  return window;
}

function pointKey(nodeId: string, pointKind: SchedulePointKind): string {
  return `${nodeId}:${pointKind}`;
}

function tightenLower(
  window: MutableWindow,
  instantMs: number,
  basis: ScheduleBoundBasis,
): boolean {
  if (window.lower.instantMs === null || instantMs > window.lower.instantMs) {
    window.lower.instantMs = instantMs;
    window.lower.basis = [basis];
    return true;
  }
  if (instantMs === window.lower.instantMs) {
    const merged = mergeBasis(window.lower.basis, basis);
    const changed = merged.length !== window.lower.basis.length;
    window.lower.basis = merged;
    return changed;
  }
  return false;
}

function tightenUpper(
  window: MutableWindow,
  instantMs: number,
  basis: ScheduleBoundBasis,
): boolean {
  if (window.upper.instantMs === null || instantMs < window.upper.instantMs) {
    window.upper.instantMs = instantMs;
    window.upper.basis = [basis];
    return true;
  }
  if (instantMs === window.upper.instantMs) {
    const merged = mergeBasis(window.upper.basis, basis);
    const changed = merged.length !== window.upper.basis.length;
    window.upper.basis = merged;
    return changed;
  }
  return false;
}

function mergeBasis(
  current: readonly ScheduleBoundBasis[],
  candidate: ScheduleBoundBasis,
): ScheduleBoundBasis[] {
  const key = basisKey(candidate);
  if (current.some((basis) => basisKey(basis) === key)) return [...current];
  return [...current, candidate].toSorted(compareBasis);
}

function freezeWindow(window: MutableWindow): SchedulePropagationWindow {
  const earliest =
    window.lower.instantMs === null ? null : new Date(window.lower.instantMs);
  const latest =
    window.upper.instantMs === null ? null : new Date(window.upper.instantMs);
  return {
    earliest,
    latest,
    status: windowStatus(earliest, latest),
    earliestBasis: [...window.lower.basis].toSorted(compareBasis),
    latestBasis: [...window.upper.basis].toSorted(compareBasis),
  };
}

function windowStatus(
  earliest: Date | null,
  latest: Date | null,
): SchedulePropagationWindowStatus {
  if (earliest === null && latest === null) return 'UNBOUNDED';
  if (earliest === null) return 'UPPER_BOUNDED';
  if (latest === null) return 'LOWER_BOUNDED';
  if (earliest.getTime() > latest.getTime()) return 'CONFLICT';
  return earliest.getTime() === latest.getTime() ? 'EXACT' : 'BOUNDED';
}

function directBasis(
  ruleId: SchedulePropagationRuleId,
  sourceRefs: readonly string[],
  explanation: string,
): ScheduleBoundBasis {
  return { ruleId, sourceRefs: uniqueSorted(sourceRefs), explanation };
}

function derivedDwellBasis(
  ruleId: 'MIN_DWELL_FORWARD' | 'MIN_DWELL_BACKWARD',
  constraint: DwellConstraint,
  upstream: readonly ScheduleBoundBasis[],
): ScheduleBoundBasis {
  const duration = formatDuration(constraint.intent.durationSeconds);
  return {
    ruleId,
    sourceRefs: uniqueSorted([
      constraint.intent.id,
      ...upstream.flatMap((basis) => basis.sourceRefs),
    ]),
    explanation:
      ruleId === 'MIN_DWELL_FORWARD'
        ? `根据到达下界和至少停留 ${duration}，收紧离开最早时刻。`
        : `根据离开上界和至少停留 ${duration}，收紧到达最晚时刻。`,
  };
}

function temporalSourceRefs(value: ScheduleTemporalValue): readonly string[] {
  return value.sourceRef === null ? [value.id] : [value.id, value.sourceRef];
}

function compareIntent(
  left: ScheduleUserTimeIntent,
  right: ScheduleUserTimeIntent,
): number {
  return compareText(left.id, right.id);
}

function compareTemporalValue(
  left: ScheduleTemporalValue,
  right: ScheduleTemporalValue,
): number {
  return compareText(left.id, right.id);
}

function compareAnchor(
  left: SchedulePropagationTransportAnchor,
  right: SchedulePropagationTransportAnchor,
): number {
  return (
    compareText(left.nodeId, right.nodeId) ||
    compareText(left.pointKind, right.pointKind) ||
    compareText(left.anchorKind, right.anchorKind) ||
    compareText(left.transportEdgeId, right.transportEdgeId) ||
    compareText(left.value.id, right.value.id)
  );
}

function compareBasis(
  left: ScheduleBoundBasis,
  right: ScheduleBoundBasis,
): number {
  return compareText(basisKey(left), basisKey(right));
}

function basisKey(basis: ScheduleBoundBasis): string {
  return `${basis.ruleId}:${basis.sourceRefs.join(',')}`;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].toSorted(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pointLabel(pointKind: SchedulePointKind): string {
  return pointKind === 'ARRIVAL' ? '到达' : '离开';
}

function formatDuration(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('Schedule propagation received an invalid instant');
  }
}
