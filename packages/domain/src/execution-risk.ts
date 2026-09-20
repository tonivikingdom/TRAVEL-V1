export type ExecutionRiskKind =
  | 'PROTECTED_TIME_AT_RISK'
  | 'PROTECTED_TIME_INFEASIBLE'
  | 'FIXED_SERVICE_MISSED'
  | 'BUFFER_BELOW_SYSTEM_MINIMUM'
  | 'UNKNOWN_EXECUTION_MARGIN';

export type ExecutionRiskSeverity =
  'EXECUTABLE_RISK' | 'INFEASIBLE' | 'UNKNOWN';

export type ExecutionRiskTemporalLayer = 'PLANNED' | 'ESTIMATED' | 'ACTUAL';

export type ExecutionRiskPointKind = 'ARRIVAL' | 'DEPARTURE';

export interface ExecutionRiskTemporalValue {
  readonly id: string;
  readonly layer: ExecutionRiskTemporalLayer;
  readonly pointKind: ExecutionRiskPointKind;
  readonly instant: Date;
}

export interface ExecutionRiskIntent {
  readonly id: string;
  readonly kind: 'POINT_TIME' | 'MIN_DWELL';
  readonly pointKind: ExecutionRiskPointKind | null;
  readonly operator: 'EXACT' | 'NOT_BEFORE' | 'NOT_AFTER' | 'MINIMUM';
  readonly instant: Date | null;
  readonly durationSeconds: number | null;
  readonly locked: boolean;
}

export interface ExecutionRiskNode {
  readonly id: string;
  readonly sequence: number;
  readonly position: number;
  readonly timeValues: readonly ExecutionRiskTemporalValue[];
  readonly intents: readonly ExecutionRiskIntent[];
  readonly systemDwellSuggestionSeconds?: number | null;
}

export interface ExecutionRiskTransport {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly fixedService: boolean;
  readonly timeValues: readonly ExecutionRiskTemporalValue[];
}

export type ExecutionBufferKind =
  | 'SYSTEM_SUGGESTED_BUFFER'
  | 'USER_PREFERRED_BUFFER'
  | 'SYSTEM_MINIMUM_CONNECTION';

export interface ExecutionBufferEvidence {
  readonly id: string;
  readonly kind: ExecutionBufferKind;
  readonly availableSeconds: number;
  readonly requiredSeconds: number | null;
  readonly sourceNodeId?: string | null;
  readonly sourceTransportEdgeId?: string | null;
  readonly protectedNodeId?: string | null;
  readonly protectedTransportEdgeId?: string | null;
}

export interface ExecutionRiskEvaluationInput {
  readonly nodes: readonly ExecutionRiskNode[];
  readonly transports: readonly ExecutionRiskTransport[];
  readonly buffers?: readonly ExecutionBufferEvidence[];
}

export interface EvaluatedExecutionRisk {
  readonly fingerprintParts: readonly string[];
  readonly kind: ExecutionRiskKind;
  readonly severity: ExecutionRiskSeverity;
  readonly sourceNodeId: string | null;
  readonly sourceTransportEdgeId: string | null;
  readonly protectedNodeId: string | null;
  readonly protectedTransportEdgeId: string | null;
  readonly evidenceRefs: readonly string[];
  readonly explanation: string;
  readonly requiresRouteReevaluation: boolean;
}

interface ProtectedTarget {
  readonly index: number;
  readonly kind: 'ACTUAL_TRANSPORT' | 'FIXED_SERVICE' | 'POINT_TIME';
  readonly nodeId: string;
  readonly transportEdgeId: string | null;
  readonly instant: Date;
  readonly pointKind: ExecutionRiskPointKind;
  readonly evidenceRefs: readonly string[];
}

const LAYER_PRIORITY: Readonly<Record<ExecutionRiskTemporalLayer, number>> = {
  PLANNED: 1,
  ESTIMATED: 2,
  ACTUAL: 3,
};

export function evaluateExecutionRisks(
  input: ExecutionRiskEvaluationInput,
): readonly EvaluatedExecutionRisk[] {
  const nodes = [...input.nodes].sort(compareNodeOrder);
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const targets = protectedTargets(nodes, input.transports, nodeIndex);
  const risks: EvaluatedExecutionRisk[] = [];

  const executionFrontier = findExecutionFrontier(
    nodes,
    input.transports,
    nodeIndex,
  );
  const nearestTarget = targets.find(
    (target) => executionFrontier === null || target.index >= executionFrontier,
  );
  if (nearestTarget !== undefined) {
    const risk = evaluateTarget(nearestTarget, nodes);
    if (risk !== null) risks.push(risk);
  }

  for (const buffer of [...(input.buffers ?? [])].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    const risk = evaluateBufferEvidence(buffer);
    if (risk !== null) risks.push(risk);
  }

  return risks.sort(compareRisk);
}

function protectedTargets(
  nodes: readonly ExecutionRiskNode[],
  transports: readonly ExecutionRiskTransport[],
  nodeIndex: ReadonlyMap<string, number>,
): readonly ProtectedTarget[] {
  const targets: ProtectedTarget[] = [];
  for (const edge of transports) {
    const index = nodeIndex.get(edge.fromNodeId);
    const actualDeparture = selectValue(edge.timeValues, 'DEPARTURE', [
      'ACTUAL',
    ]);
    const departure =
      actualDeparture ??
      (edge.fixedService
        ? selectValue(edge.timeValues, 'DEPARTURE', ['PLANNED'])
        : null);
    if (index === undefined || departure === null) continue;
    targets.push({
      index,
      kind: actualDeparture === null ? 'FIXED_SERVICE' : 'ACTUAL_TRANSPORT',
      nodeId: edge.fromNodeId,
      transportEdgeId: edge.id,
      instant: departure.instant,
      pointKind: 'DEPARTURE',
      evidenceRefs: [`temporal:${departure.id}`, `transport:${edge.id}`],
    });
  }

  for (const node of nodes) {
    const index = nodeIndex.get(node.id)!;
    for (const pointKind of ['ARRIVAL', 'DEPARTURE'] as const) {
      const protectedIntents = node.intents
        .filter(
          (intent) =>
            intent.kind === 'POINT_TIME' &&
            intent.pointKind === pointKind &&
            intent.instant !== null &&
            (intent.operator === 'EXACT' || intent.operator === 'NOT_AFTER'),
        )
        .sort(
          (left, right) =>
            left.instant!.getTime() - right.instant!.getTime() ||
            compareText(left.id, right.id),
        );
      const strongest = protectedIntents[0];
      if (strongest?.instant === null || strongest === undefined) continue;
      targets.push({
        index,
        kind: 'POINT_TIME',
        nodeId: node.id,
        transportEdgeId: null,
        instant: strongest.instant,
        pointKind,
        evidenceRefs: protectedIntents.map((intent) => `intent:${intent.id}`),
      });
    }
  }

  return targets.sort((left, right) =>
    left.index !== right.index
      ? left.index - right.index
      : left.instant.getTime() !== right.instant.getTime()
        ? left.instant.getTime() - right.instant.getTime()
        : compareText(targetKey(left), targetKey(right)),
  );
}

function findExecutionFrontier(
  nodes: readonly ExecutionRiskNode[],
  transports: readonly ExecutionRiskTransport[],
  nodeIndex: ReadonlyMap<string, number>,
): number | null {
  const actualIndexes: number[] = [];
  const estimatedIndexes: number[] = [];
  for (const [index, node] of nodes.entries()) {
    if (node.timeValues.some((value) => value.layer === 'ACTUAL')) {
      actualIndexes.push(index);
    } else if (node.timeValues.some((value) => value.layer === 'ESTIMATED')) {
      estimatedIndexes.push(index);
    }
  }
  for (const edge of transports) {
    for (const value of edge.timeValues) {
      if (!isExecutionEvidence(value)) continue;
      const index = nodeIndex.get(
        value.pointKind === 'DEPARTURE' ? edge.fromNodeId : edge.toNodeId,
      );
      if (index === undefined) continue;
      (value.layer === 'ACTUAL' ? actualIndexes : estimatedIndexes).push(index);
    }
  }
  if (actualIndexes.length > 0) return Math.max(...actualIndexes);
  return estimatedIndexes.length > 0 ? Math.min(...estimatedIndexes) : null;
}

function evaluateTarget(
  target: ProtectedTarget,
  nodes: readonly ExecutionRiskNode[],
): EvaluatedExecutionRisk | null {
  const node = nodes.find((candidate) => candidate.id === target.nodeId);
  if (node === undefined) return null;

  if (target.kind === 'POINT_TIME') {
    const current = selectValue(node.timeValues, target.pointKind, [
      'ACTUAL',
      'ESTIMATED',
    ]);
    if (current === null) {
      return unknownRisk(target, null, null);
    }
    if (current.instant.getTime() <= target.instant.getTime()) return null;
    return {
      fingerprintParts: protectedTargetFingerprint(target),
      kind: 'PROTECTED_TIME_INFEASIBLE',
      severity: 'INFEASIBLE',
      sourceNodeId: target.nodeId,
      sourceTransportEdgeId: null,
      protectedNodeId: target.nodeId,
      protectedTransportEdgeId: null,
      evidenceRefs: sortedUnique([
        ...target.evidenceRefs,
        `temporal:${current.id}`,
      ]),
      explanation: '当前可靠时间已经晚于受保护的用户时间要求。',
      requiresRouteReevaluation: true,
    };
  }

  const arrival = selectValue(node.timeValues, 'ARRIVAL', [
    'ACTUAL',
    'ESTIMATED',
  ]);
  if (arrival === null) {
    return unknownRisk(target, target.nodeId, null);
  }
  const marginSeconds = Math.floor(
    (target.instant.getTime() - arrival.instant.getTime()) / 1_000,
  );
  if (marginSeconds < 0) {
    return {
      fingerprintParts: protectedTargetFingerprint(target),
      kind:
        target.kind === 'FIXED_SERVICE'
          ? 'FIXED_SERVICE_MISSED'
          : 'PROTECTED_TIME_INFEASIBLE',
      severity: 'INFEASIBLE',
      sourceNodeId: target.nodeId,
      sourceTransportEdgeId: null,
      protectedNodeId: target.nodeId,
      protectedTransportEdgeId: target.transportEdgeId,
      evidenceRefs: sortedUnique([
        ...target.evidenceRefs,
        `temporal:${arrival.id}`,
      ]),
      explanation: '当前可靠到达时间已经晚于固定班次出发时间。',
      requiresRouteReevaluation: true,
    };
  }

  const minimum = node.intents.find(
    (intent) =>
      intent.kind === 'MIN_DWELL' &&
      intent.operator === 'MINIMUM' &&
      intent.durationSeconds !== null,
  );
  if (
    minimum?.durationSeconds !== undefined &&
    minimum.durationSeconds !== null &&
    marginSeconds < minimum.durationSeconds
  ) {
    return {
      fingerprintParts: protectedTargetFingerprint(target),
      kind:
        target.kind === 'ACTUAL_TRANSPORT'
          ? 'PROTECTED_TIME_INFEASIBLE'
          : 'PROTECTED_TIME_AT_RISK',
      severity:
        target.kind === 'ACTUAL_TRANSPORT' ? 'INFEASIBLE' : 'EXECUTABLE_RISK',
      sourceNodeId: target.nodeId,
      sourceTransportEdgeId: null,
      protectedNodeId: target.nodeId,
      protectedTransportEdgeId: target.transportEdgeId,
      evidenceRefs: sortedUnique([
        ...target.evidenceRefs,
        `intent:${minimum.id}`,
        `temporal:${arrival.id}`,
      ]),
      explanation: `当前只剩 ${marginSeconds} 秒，少于用户要求的 ${minimum.durationSeconds} 秒停留；需要用户决定。`,
      requiresRouteReevaluation: target.kind === 'ACTUAL_TRANSPORT',
    };
  }

  const suggestion = node.systemDwellSuggestionSeconds;
  if (
    suggestion !== null &&
    suggestion !== undefined &&
    marginSeconds < suggestion
  ) {
    return {
      fingerprintParts: protectedTargetFingerprint(target),
      kind: 'PROTECTED_TIME_AT_RISK',
      severity: 'EXECUTABLE_RISK',
      sourceNodeId: target.nodeId,
      sourceTransportEdgeId: null,
      protectedNodeId: target.nodeId,
      protectedTransportEdgeId: target.transportEdgeId,
      evidenceRefs: sortedUnique([
        ...target.evidenceRefs,
        `temporal:${arrival.id}`,
        `suggestion:${target.nodeId}`,
      ]),
      explanation: `当前只剩 ${marginSeconds} 秒，低于系统建议的 ${suggestion} 秒停留。`,
      requiresRouteReevaluation: false,
    };
  }
  return null;
}

function unknownRisk(
  target: ProtectedTarget,
  sourceNodeId: string | null,
  sourceTransportEdgeId: string | null,
): EvaluatedExecutionRisk {
  return {
    fingerprintParts: protectedTargetFingerprint(target),
    kind: 'UNKNOWN_EXECUTION_MARGIN',
    severity: 'UNKNOWN',
    sourceNodeId,
    sourceTransportEdgeId,
    protectedNodeId: target.nodeId,
    protectedTransportEdgeId: target.transportEdgeId,
    evidenceRefs: sortedUnique(target.evidenceRefs),
    explanation: '缺少可靠的当前执行时间，无法判断受保护安排是否安全。',
    requiresRouteReevaluation: false,
  };
}

function protectedTargetFingerprint(
  target: ProtectedTarget,
): readonly string[] {
  return ['protected-target', targetKey(target)];
}

function evaluateBufferEvidence(
  buffer: ExecutionBufferEvidence,
): EvaluatedExecutionRisk | null {
  if (buffer.requiredSeconds === null) return null;
  if (buffer.availableSeconds >= buffer.requiredSeconds) return null;
  const minimum = buffer.kind === 'SYSTEM_MINIMUM_CONNECTION';
  return {
    fingerprintParts: ['buffer', buffer.kind, buffer.id],
    kind: minimum ? 'BUFFER_BELOW_SYSTEM_MINIMUM' : 'PROTECTED_TIME_AT_RISK',
    severity: 'EXECUTABLE_RISK',
    sourceNodeId: buffer.sourceNodeId ?? null,
    sourceTransportEdgeId: buffer.sourceTransportEdgeId ?? null,
    protectedNodeId: buffer.protectedNodeId ?? null,
    protectedTransportEdgeId: buffer.protectedTransportEdgeId ?? null,
    evidenceRefs: [`buffer:${buffer.id}`],
    explanation: minimum
      ? '当前连接余量低于可靠的系统最低换乘要求；确认风险不会改变该最低要求。'
      : '当前余量低于建议或用户偏好值，可由用户确认后保持安静。',
    requiresRouteReevaluation: false,
  };
}

function selectValue(
  values: readonly ExecutionRiskTemporalValue[],
  pointKind: ExecutionRiskPointKind,
  allowedLayers: readonly ExecutionRiskTemporalLayer[],
): ExecutionRiskTemporalValue | null {
  return (
    values
      .filter(
        (value) =>
          value.pointKind === pointKind && allowedLayers.includes(value.layer),
      )
      .sort(
        (left, right) =>
          LAYER_PRIORITY[right.layer] - LAYER_PRIORITY[left.layer] ||
          compareText(left.id, right.id),
      )[0] ?? null
  );
}

function isExecutionEvidence(value: ExecutionRiskTemporalValue): boolean {
  return value.layer === 'ACTUAL' || value.layer === 'ESTIMATED';
}

function compareNodeOrder(
  left: ExecutionRiskNode,
  right: ExecutionRiskNode,
): number {
  return (
    left.sequence - right.sequence ||
    left.position - right.position ||
    compareText(left.id, right.id)
  );
}

function targetKey(target: ProtectedTarget): string {
  return target.transportEdgeId === null
    ? ['NODE', target.nodeId, target.pointKind].join(':')
    : [
        'TRANSPORT',
        target.transportEdgeId,
        target.nodeId,
        target.pointKind,
      ].join(':');
}

function compareRisk(
  left: EvaluatedExecutionRisk,
  right: EvaluatedExecutionRisk,
): number {
  return compareText(
    left.fingerprintParts.join('\u0000'),
    right.fingerprintParts.join('\u0000'),
  );
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
