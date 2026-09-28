export type ExecutionTargetKind = 'PLACE' | 'TRANSIT_HUB' | 'AIRPORT';

export interface ExecutionLocationPolicy {
  readonly version: string;
  readonly maxReliableAccuracyMeters: number;
  readonly placeArrivalRadiusMeters: number;
  readonly transitHubArrivalRadiusMeters: number;
  readonly airportArrivalRadiusMeters: number;
  readonly exitHysteresisMeters: number;
  readonly minimumDepartureSamples: number;
  readonly maxFutureSkewSeconds: number;
  readonly maxSampleAgeSeconds: number;
  readonly clearPassThroughSpeedMetersPerSecond: number;
  readonly clearPassThroughHeadingAwayDegrees: number;
}

export const DEFAULT_EXECUTION_LOCATION_POLICY: ExecutionLocationPolicy = {
  version: 'execution-location-v2',
  maxReliableAccuracyMeters: 100,
  placeArrivalRadiusMeters: 75,
  transitHubArrivalRadiusMeters: 150,
  airportArrivalRadiusMeters: 300,
  exitHysteresisMeters: 50,
  minimumDepartureSamples: 2,
  maxFutureSkewSeconds: 120,
  maxSampleAgeSeconds: 300,
  // A fast, directed movement away from a nearby target is positive
  // pass-through evidence. Missing motion data never lowers reliability.
  clearPassThroughSpeedMetersPerSecond: 12,
  clearPassThroughHeadingAwayDegrees: 120,
};

export interface ExecutionTimelineNode {
  readonly id: string;
  readonly sequence: number;
  readonly position: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly targetKind: ExecutionTargetKind;
  readonly hasActualArrival: boolean;
  readonly hasActualDeparture: boolean;
  readonly executionStatus: 'POSSIBLY_SKIPPED' | 'SKIPPED' | null;
}

export interface ExecutionFrontier {
  readonly orderedNodes: readonly ExecutionTimelineNode[];
  readonly currentNode: ExecutionTimelineNode | null;
  readonly targetNode: ExecutionTimelineNode | null;
  readonly state:
    'NOT_STARTED' | 'AT_NODE' | 'EN_ROUTE' | 'COMPLETED' | 'INCONSISTENT';
  readonly conflict: ExecutionFrontierConflict | null;
}

export type ExecutionFrontierConflict =
  | {
      readonly code: 'MULTIPLE_OPEN_NODES';
      readonly openNodeIds: readonly string[];
      readonly laterExecutedNodeIds: readonly string[];
    }
  | {
      readonly code: 'OPEN_NODE_PRECEDES_LATER_EXECUTION';
      readonly openNodeIds: readonly string[];
      readonly laterExecutedNodeIds: readonly string[];
    };

export interface ExecutionDerivedLocationState {
  readonly currentNodeId: string | null;
  readonly targetNodeId: string | null;
  readonly lastObservedAt: Date;
  readonly lastDistanceToCurrentTargetMeters: number | null;
  readonly lastDistanceToNextTargetMeters: number | null;
  readonly outsideTargetConsecutiveCount: number;
  readonly locationStatus: 'RELIABLE' | 'INDETERMINATE';
}

export interface LocationObservation {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number;
  readonly observedAt: Date;
  readonly speedMetersPerSecond?: number;
  readonly headingDegrees?: number;
}

export type ExecutionEvidenceReliability =
  'SUFFICIENT' | 'WEAK' | 'INDETERMINATE';

export type ExecutionEvidenceReasonCode =
  | 'TARGET_UNIQUE'
  | 'WITHIN_ARRIVAL_RADIUS'
  | 'ACCURACY_SUFFICIENT'
  | 'ACCURACY_INSUFFICIENT'
  | 'MULTIPLE_CANDIDATES'
  | 'CURRENT_NODE_OPEN'
  | 'SUPPRESSION_ACTIVE'
  | 'MOTION_CONTRADICTS_ARRIVAL'
  | 'TARGET_COORDINATES_UNAVAILABLE'
  | 'FRONTIER_INCONSISTENT'
  | 'TARGET_OUTSIDE_RADIUS'
  | 'DUPLICATE_OBSERVATION'
  | 'DEPARTURE_EVIDENCE_SUFFICIENT';

export interface ExecutionDecisionEvidence {
  readonly reliability: ExecutionEvidenceReliability;
  readonly policyVersion: string;
  readonly reasonCodes: readonly ExecutionEvidenceReasonCode[];
  readonly competingNodeIds: readonly string[];
}

export type ExecutionLocationDecision =
  | {
      readonly status: 'INDETERMINATE_LOCATION';
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
      readonly evidence: ExecutionDecisionEvidence;
    }
  | {
      readonly status: 'MANUAL_CONFIRMATION_AVAILABLE' | 'NO_CHANGE';
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
      readonly evidence: ExecutionDecisionEvidence;
    }
  | {
      readonly status: 'CONFIRMED_ARRIVAL';
      readonly nodeId: string;
      readonly possiblySkippedNodeIds: readonly string[];
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
      readonly evidence: ExecutionDecisionEvidence;
    }
  | {
      readonly status: 'CONFIRMED_DEPARTURE';
      readonly nodeId: string;
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
      readonly evidence: ExecutionDecisionEvidence;
    };

export function resolveExecutionFrontier(
  nodes: readonly ExecutionTimelineNode[],
): ExecutionFrontier {
  const orderedNodes = [...nodes].sort(compareTimelineNodes);
  const openNodes = orderedNodes.filter(
    (node) => node.hasActualArrival && !node.hasActualDeparture,
  );
  if (openNodes.length > 1) {
    return {
      orderedNodes,
      currentNode: openNodes[0]!,
      targetNode: null,
      state: 'INCONSISTENT',
      conflict: {
        code: 'MULTIPLE_OPEN_NODES',
        openNodeIds: openNodes.map((node) => node.id),
        laterExecutedNodeIds: laterExecutedNodeIds(orderedNodes, openNodes[0]!),
      },
    };
  }
  const onlyOpenNode = openNodes[0];
  if (onlyOpenNode !== undefined) {
    const laterExecuted = laterExecutedNodeIds(orderedNodes, onlyOpenNode);
    if (laterExecuted.length > 0) {
      return {
        orderedNodes,
        currentNode: onlyOpenNode,
        targetNode: null,
        state: 'INCONSISTENT',
        conflict: {
          code: 'OPEN_NODE_PRECEDES_LATER_EXECUTION',
          openNodeIds: [onlyOpenNode.id],
          laterExecutedNodeIds: laterExecuted,
        },
      };
    }
  }
  let frontierIndex = -1;
  let currentIndex = -1;
  for (let index = 0; index < orderedNodes.length; index += 1) {
    const node = orderedNodes[index]!;
    if (
      node.executionStatus === 'SKIPPED' ||
      node.hasActualArrival ||
      node.hasActualDeparture
    ) {
      frontierIndex = index;
    }
    if (node.hasActualArrival && !node.hasActualDeparture) {
      currentIndex = index;
    }
  }
  const currentNode = currentIndex < 0 ? null : orderedNodes[currentIndex]!;
  const targetNode =
    orderedNodes
      .slice(frontierIndex + 1)
      .find((node) => node.executionStatus !== 'SKIPPED') ?? null;
  const state =
    orderedNodes.length === 0
      ? 'COMPLETED'
      : currentNode !== null
        ? 'AT_NODE'
        : frontierIndex < 0
          ? 'NOT_STARTED'
          : targetNode === null
            ? 'COMPLETED'
            : 'EN_ROUTE';
  return { orderedNodes, currentNode, targetNode, state, conflict: null };
}

export function isTripExecutionNaturallyComplete(
  nodes: readonly ExecutionTimelineNode[],
): boolean {
  if (nodes.length === 0) return false;
  const frontier = resolveExecutionFrontier(nodes);
  if (frontier.state === 'INCONSISTENT') return false;
  const hasExecutionEvidence = frontier.orderedNodes.some(
    (node) =>
      node.hasActualArrival ||
      node.hasActualDeparture ||
      node.executionStatus === 'SKIPPED',
  );
  return hasExecutionEvidence && frontier.targetNode === null;
}

export function decideExecutionLocation(input: {
  readonly nodes: readonly ExecutionTimelineNode[];
  readonly previousState: ExecutionDerivedLocationState | null;
  readonly suppressedArrivalNodeIds?: readonly string[];
  readonly sample: LocationObservation;
  readonly policy: ExecutionLocationPolicy;
}): ExecutionLocationDecision {
  const frontier = resolveExecutionFrontier(input.nodes);
  const baseState = stateFor(input.sample.observedAt, frontier, 'RELIABLE');
  const evidence = (
    reliability: ExecutionEvidenceReliability,
    reasonCodes: readonly ExecutionEvidenceReasonCode[],
    competingNodeIds: readonly string[] = [],
  ): ExecutionDecisionEvidence => ({
    reliability,
    policyVersion: input.policy.version,
    reasonCodes,
    competingNodeIds,
  });
  if (frontier.state === 'INCONSISTENT') {
    return {
      status: 'NO_CHANGE',
      state: baseState,
      releasedArrivalSuppressionNodeIds: [],
      evidence: evidence('INDETERMINATE', ['FRONTIER_INCONSISTENT']),
    };
  }
  if (input.sample.accuracyMeters > input.policy.maxReliableAccuracyMeters) {
    return {
      status: 'INDETERMINATE_LOCATION',
      state: { ...baseState, locationStatus: 'INDETERMINATE' },
      releasedArrivalSuppressionNodeIds: [],
      evidence: evidence('INDETERMINATE', ['ACCURACY_INSUFFICIENT']),
    };
  }
  const target = frontier.targetNode;
  if (target === null) {
    return {
      status: 'NO_CHANGE',
      state: baseState,
      releasedArrivalSuppressionNodeIds: [],
      evidence: evidence('INDETERMINATE', ['TARGET_OUTSIDE_RADIUS']),
    };
  }
  if (!hasCoordinates(target)) {
    return {
      status: 'MANUAL_CONFIRMATION_AVAILABLE',
      state: baseState,
      releasedArrivalSuppressionNodeIds: [],
      evidence: evidence('INDETERMINATE', ['TARGET_COORDINATES_UNAVAILABLE']),
    };
  }

  const targetDistance = haversineDistanceMeters(input.sample, target);
  const suppressedArrivalNodeIds = new Set(
    input.suppressedArrivalNodeIds ?? [],
  );
  const targetSuppressed = suppressedArrivalNodeIds.has(target.id);
  const outsideSuppressedTarget =
    targetDistance >
    arrivalRadius(target.targetKind, input.policy) +
      input.policy.exitHysteresisMeters;
  const current = frontier.currentNode;
  // An open ARRIVAL is a causal barrier. Location may establish its DEPARTURE
  // first, but may not create a later ARRIVAL in the same decision.
  if (current !== null) {
    if (!hasCoordinates(current)) {
      return {
        status: 'NO_CHANGE',
        state: { ...baseState, lastDistanceToNextTargetMeters: targetDistance },
        releasedArrivalSuppressionNodeIds:
          targetSuppressed && outsideSuppressedTarget ? [target.id] : [],
        evidence: evidence('INDETERMINATE', ['CURRENT_NODE_OPEN']),
      };
    }
    const currentDistance = haversineDistanceMeters(input.sample, current);
    const outside =
      currentDistance >
      arrivalRadius(current.targetKind, input.policy) +
        input.policy.exitHysteresisMeters;
    const sameFrontier =
      input.previousState?.currentNodeId === current.id &&
      input.previousState.targetNodeId === target.id;
    const movementTowardNext =
      sameFrontier &&
      input.previousState.lastDistanceToCurrentTargetMeters !== null &&
      input.previousState.lastDistanceToNextTargetMeters !== null &&
      currentDistance > input.previousState.lastDistanceToCurrentTargetMeters &&
      targetDistance < input.previousState.lastDistanceToNextTargetMeters;
    const outsideCount = outside
      ? sameFrontier
        ? (input.previousState?.outsideTargetConsecutiveCount ?? 0) + 1
        : 1
      : 0;
    const state = {
      ...baseState,
      lastDistanceToCurrentTargetMeters: currentDistance,
      lastDistanceToNextTargetMeters: targetDistance,
      outsideTargetConsecutiveCount: outsideCount,
    };
    const releasedArrivalSuppressionNodeIds =
      targetSuppressed && outsideSuppressedTarget ? [target.id] : [];
    if (
      outside &&
      movementTowardNext &&
      outsideCount >= input.policy.minimumDepartureSamples
    ) {
      return {
        status: 'CONFIRMED_DEPARTURE',
        nodeId: current.id,
        state,
        releasedArrivalSuppressionNodeIds,
        evidence: evidence('SUFFICIENT', [
          'ACCURACY_SUFFICIENT',
          'DEPARTURE_EVIDENCE_SUFFICIENT',
        ]),
      };
    }
    const overlappingLaterNodes = outside
      ? []
      : frontier.orderedNodes
          .slice(
            frontier.orderedNodes.findIndex((node) => node.id === target.id),
          )
          .filter(
            (node) =>
              node.executionStatus !== 'SKIPPED' &&
              !node.hasActualArrival &&
              !suppressedArrivalNodeIds.has(node.id) &&
              hasCoordinates(node) &&
              haversineDistanceMeters(input.sample, node) <=
                arrivalRadius(node.targetKind, input.policy),
          );
    return {
      status: 'NO_CHANGE',
      state,
      releasedArrivalSuppressionNodeIds,
      evidence:
        overlappingLaterNodes.length > 0
          ? evidence(
              'WEAK',
              ['CURRENT_NODE_OPEN', 'MULTIPLE_CANDIDATES'],
              [current.id, ...overlappingLaterNodes.map((node) => node.id)],
            )
          : evidence('INDETERMINATE', ['CURRENT_NODE_OPEN']),
    };
  }
  // A later arrival cannot by itself prove that the user has left a node whose
  // automatic arrival they explicitly corrected. This is important when place
  // radii overlap: preserve the correction until the sample is outside that
  // node's exit boundary.
  if (targetSuppressed && !outsideSuppressedTarget) {
    return {
      status: 'NO_CHANGE',
      releasedArrivalSuppressionNodeIds: [],
      evidence: evidence('WEAK', ['SUPPRESSION_ACTIVE']),
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: targetDistance,
      },
    };
  }

  const targetIndex = frontier.orderedNodes.findIndex(
    (node) => node.id === target.id,
  );
  const arrivalCandidates = frontier.orderedNodes
    .slice(targetIndex)
    .filter(
      (node) =>
        node.executionStatus !== 'SKIPPED' &&
        !node.hasActualArrival &&
        !suppressedArrivalNodeIds.has(node.id) &&
        hasCoordinates(node) &&
        haversineDistanceMeters(input.sample, node) <=
          arrivalRadius(node.targetKind, input.policy),
    );
  if (arrivalCandidates.length > 1) {
    return {
      status: 'NO_CHANGE',
      releasedArrivalSuppressionNodeIds: targetSuppressed ? [target.id] : [],
      state: { ...baseState, lastDistanceToNextTargetMeters: targetDistance },
      evidence: evidence(
        'WEAK',
        ['ACCURACY_SUFFICIENT', 'MULTIPLE_CANDIDATES'],
        arrivalCandidates.map((node) => node.id),
      ),
    };
  }
  const arrival = arrivalCandidates[0];
  if (arrival !== undefined && hasCoordinates(arrival)) {
    const arrivalDistance = haversineDistanceMeters(input.sample, arrival);
    if (
      motionContradictsArrival(
        input.sample,
        arrival,
        arrivalDistance,
        input.policy,
      )
    ) {
      return {
        status: 'NO_CHANGE',
        releasedArrivalSuppressionNodeIds: targetSuppressed ? [target.id] : [],
        state: {
          ...baseState,
          lastDistanceToNextTargetMeters: arrivalDistance,
        },
        evidence: evidence('WEAK', [
          'ACCURACY_SUFFICIENT',
          'MOTION_CONTRADICTS_ARRIVAL',
        ]),
      };
    }
    const arrivalIndex = frontier.orderedNodes.findIndex(
      (node) => node.id === arrival.id,
    );
    return {
      status: 'CONFIRMED_ARRIVAL',
      nodeId: arrival.id,
      possiblySkippedNodeIds: frontier.orderedNodes
        .slice(targetIndex, arrivalIndex)
        .filter(
          (node) => node.executionStatus === null && !node.hasActualArrival,
        )
        .map((node) => node.id),
      releasedArrivalSuppressionNodeIds: targetSuppressed ? [target.id] : [],
      evidence: evidence('SUFFICIENT', [
        'ACCURACY_SUFFICIENT',
        'TARGET_UNIQUE',
        'WITHIN_ARRIVAL_RADIUS',
      ]),
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: arrivalDistance,
      },
    };
  }

  if (targetSuppressed) {
    return {
      status: 'NO_CHANGE',
      releasedArrivalSuppressionNodeIds: outsideSuppressedTarget
        ? [target.id]
        : [],
      evidence: evidence('INDETERMINATE', ['TARGET_OUTSIDE_RADIUS']),
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: targetDistance,
      },
    };
  }

  return {
    status: 'NO_CHANGE',
    state: {
      ...baseState,
      lastDistanceToNextTargetMeters: targetDistance,
    },
    releasedArrivalSuppressionNodeIds: [],
    evidence: evidence('INDETERMINATE', ['TARGET_OUTSIDE_RADIUS']),
  };
}

function motionContradictsArrival(
  sample: LocationObservation,
  target: ExecutionTimelineNode & { latitude: number; longitude: number },
  distanceMeters: number,
  policy: ExecutionLocationPolicy,
): boolean {
  if (
    sample.speedMetersPerSecond === undefined ||
    sample.headingDegrees === undefined ||
    sample.speedMetersPerSecond < policy.clearPassThroughSpeedMetersPerSecond ||
    distanceMeters < 1
  )
    return false;
  const latitude1 = radians(sample.latitude);
  const latitude2 = radians(target.latitude);
  const longitudeDelta = radians(target.longitude - sample.longitude);
  const bearing =
    (Math.atan2(
      Math.sin(longitudeDelta) * Math.cos(latitude2),
      Math.cos(latitude1) * Math.sin(latitude2) -
        Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta),
    ) *
      180) /
    Math.PI;
  const angularDifference = Math.abs(
    ((sample.headingDegrees - bearing + 540) % 360) - 180,
  );
  return angularDifference >= policy.clearPassThroughHeadingAwayDegrees;
}

export function haversineDistanceMeters(
  left: { readonly latitude: number; readonly longitude: number },
  right: { readonly latitude: number; readonly longitude: number },
): number {
  const radius = 6_371_000;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function compareTimelineNodes(
  left: ExecutionTimelineNode,
  right: ExecutionTimelineNode,
): number {
  return (
    left.sequence - right.sequence ||
    left.position - right.position ||
    compareCodePoints(left.id, right.id)
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function laterExecutedNodeIds(
  orderedNodes: readonly ExecutionTimelineNode[],
  openNode: ExecutionTimelineNode,
): readonly string[] {
  const openIndex = orderedNodes.findIndex((node) => node.id === openNode.id);
  return orderedNodes
    .slice(openIndex + 1)
    .filter(
      (node) =>
        node.executionStatus === 'SKIPPED' ||
        node.hasActualArrival ||
        node.hasActualDeparture,
    )
    .map((node) => node.id);
}

function hasCoordinates(
  node: ExecutionTimelineNode,
): node is ExecutionTimelineNode & { latitude: number; longitude: number } {
  return node.latitude !== null && node.longitude !== null;
}

function arrivalRadius(
  kind: ExecutionTargetKind,
  policy: ExecutionLocationPolicy,
): number {
  switch (kind) {
    case 'AIRPORT':
      return policy.airportArrivalRadiusMeters;
    case 'TRANSIT_HUB':
      return policy.transitHubArrivalRadiusMeters;
    case 'PLACE':
      return policy.placeArrivalRadiusMeters;
  }
}

function stateFor(
  observedAt: Date,
  frontier: ExecutionFrontier,
  locationStatus: ExecutionDerivedLocationState['locationStatus'],
): ExecutionDerivedLocationState {
  return {
    currentNodeId: frontier.currentNode?.id ?? null,
    targetNodeId: frontier.targetNode?.id ?? null,
    lastObservedAt: observedAt,
    lastDistanceToCurrentTargetMeters: null,
    lastDistanceToNextTargetMeters: null,
    outsideTargetConsecutiveCount: 0,
    locationStatus,
  };
}

function radians(value: number): number {
  return (value * Math.PI) / 180;
}
