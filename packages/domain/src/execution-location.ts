export type ExecutionTargetKind = 'PLACE' | 'TRANSIT_HUB' | 'AIRPORT';

export interface ExecutionLocationPolicy {
  readonly maxReliableAccuracyMeters: number;
  readonly placeArrivalRadiusMeters: number;
  readonly transitHubArrivalRadiusMeters: number;
  readonly airportArrivalRadiusMeters: number;
  readonly exitHysteresisMeters: number;
  readonly minimumDepartureSamples: number;
  readonly maxFutureSkewSeconds: number;
  readonly maxSampleAgeSeconds: number;
}

export const DEFAULT_EXECUTION_LOCATION_POLICY: ExecutionLocationPolicy = {
  maxReliableAccuracyMeters: 100,
  placeArrivalRadiusMeters: 75,
  transitHubArrivalRadiusMeters: 150,
  airportArrivalRadiusMeters: 300,
  exitHysteresisMeters: 50,
  minimumDepartureSamples: 2,
  maxFutureSkewSeconds: 120,
  maxSampleAgeSeconds: 300,
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
}

export type ExecutionLocationDecision =
  | {
      readonly status: 'INDETERMINATE_LOCATION';
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
    }
  | {
      readonly status: 'MANUAL_CONFIRMATION_AVAILABLE' | 'NO_CHANGE';
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
    }
  | {
      readonly status: 'CONFIRMED_ARRIVAL';
      readonly nodeId: string;
      readonly possiblySkippedNodeIds: readonly string[];
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
    }
  | {
      readonly status: 'CONFIRMED_DEPARTURE';
      readonly nodeId: string;
      readonly state: ExecutionDerivedLocationState;
      readonly releasedArrivalSuppressionNodeIds: readonly string[];
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

export function decideExecutionLocation(input: {
  readonly nodes: readonly ExecutionTimelineNode[];
  readonly previousState: ExecutionDerivedLocationState | null;
  readonly suppressedArrivalNodeIds?: readonly string[];
  readonly sample: LocationObservation;
  readonly policy: ExecutionLocationPolicy;
}): ExecutionLocationDecision {
  const frontier = resolveExecutionFrontier(input.nodes);
  const baseState = stateFor(input.sample.observedAt, frontier, 'RELIABLE');
  if (input.sample.accuracyMeters > input.policy.maxReliableAccuracyMeters) {
    return {
      status: 'INDETERMINATE_LOCATION',
      state: { ...baseState, locationStatus: 'INDETERMINATE' },
      releasedArrivalSuppressionNodeIds: [],
    };
  }
  const target = frontier.targetNode;
  if (target === null) {
    return {
      status: 'NO_CHANGE',
      state: baseState,
      releasedArrivalSuppressionNodeIds: [],
    };
  }
  if (!hasCoordinates(target)) {
    return {
      status: 'MANUAL_CONFIRMATION_AVAILABLE',
      state: baseState,
      releasedArrivalSuppressionNodeIds: [],
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
  if (
    !targetSuppressed &&
    targetDistance <= arrivalRadius(target.targetKind, input.policy)
  ) {
    return {
      status: 'CONFIRMED_ARRIVAL',
      nodeId: target.id,
      possiblySkippedNodeIds: [],
      releasedArrivalSuppressionNodeIds: [],
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: targetDistance,
      },
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
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: targetDistance,
      },
    };
  }

  const targetIndex = frontier.orderedNodes.findIndex(
    (node) => node.id === target.id,
  );
  const laterArrival = frontier.orderedNodes
    .slice(targetIndex + 1)
    .find(
      (node) =>
        node.executionStatus !== 'SKIPPED' &&
        !node.hasActualArrival &&
        !suppressedArrivalNodeIds.has(node.id) &&
        hasCoordinates(node) &&
        haversineDistanceMeters(input.sample, node) <=
          arrivalRadius(node.targetKind, input.policy),
    );
  if (laterArrival !== undefined && hasCoordinates(laterArrival)) {
    const laterIndex = frontier.orderedNodes.findIndex(
      (node) => node.id === laterArrival.id,
    );
    return {
      status: 'CONFIRMED_ARRIVAL',
      nodeId: laterArrival.id,
      possiblySkippedNodeIds: frontier.orderedNodes
        .slice(targetIndex, laterIndex)
        .filter(
          (node) => node.executionStatus === null && !node.hasActualArrival,
        )
        .map((node) => node.id),
      releasedArrivalSuppressionNodeIds: targetSuppressed ? [target.id] : [],
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: haversineDistanceMeters(
          input.sample,
          laterArrival,
        ),
      },
    };
  }

  if (targetSuppressed) {
    return {
      status: 'NO_CHANGE',
      releasedArrivalSuppressionNodeIds: outsideSuppressedTarget
        ? [target.id]
        : [],
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: targetDistance,
      },
    };
  }

  const current = frontier.currentNode;
  if (current === null || !hasCoordinates(current)) {
    return {
      status: 'NO_CHANGE',
      releasedArrivalSuppressionNodeIds: [],
      state: {
        ...baseState,
        lastDistanceToNextTargetMeters: targetDistance,
      },
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
  if (
    outside &&
    movementTowardNext &&
    outsideCount >= input.policy.minimumDepartureSamples
  ) {
    return {
      status: 'CONFIRMED_DEPARTURE',
      nodeId: current.id,
      state,
      releasedArrivalSuppressionNodeIds: [],
    };
  }
  return {
    status: 'NO_CHANGE',
    state,
    releasedArrivalSuppressionNodeIds: [],
  };
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
