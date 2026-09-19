import {
  evaluateScheduleConstraints,
  type ScheduleEvaluationResult,
  type ScheduleUserTimeIntent,
} from '@travel/domain';

import type {
  TripAggregateRecord,
  UserTimeIntentRecord,
} from './trip-ports.js';

export function evaluateTripScheduleRecord(
  trip: TripAggregateRecord,
): ScheduleEvaluationResult {
  return evaluateScheduleConstraints({
    nodes: orderedTripNodes(trip).map((node) => ({
      nodeId: node.id,
      dayOccurrenceId: node.dayOccurrenceId,
      timeValues: node.timeValues,
      intents: node.timeIntents.map(toDomainIntent),
    })),
    fixedTransportAnchors: trip.transportEdges.flatMap((edge) =>
      edge.fixedService
        ? edge.timeValues
            .filter((value) => value.layer === 'PLANNED')
            .map((value) => ({
              transportEdgeId: edge.id,
              nodeId:
                value.pointKind === 'DEPARTURE'
                  ? edge.fromNodeId
                  : edge.toNodeId,
              pointKind: value.pointKind,
              value,
            }))
        : [],
    ),
    propagationTransportAnchors: trip.transportEdges.flatMap((edge) =>
      edge.timeValues
        .filter(
          (value) =>
            value.layer === 'ACTUAL' ||
            (edge.fixedService && value.layer === 'PLANNED'),
        )
        .map((value) => ({
          transportEdgeId: edge.id,
          nodeId:
            value.pointKind === 'DEPARTURE' ? edge.fromNodeId : edge.toNodeId,
          pointKind: value.pointKind,
          anchorKind:
            value.layer === 'ACTUAL'
              ? ('TRANSPORT_ACTUAL' as const)
              : ('FIXED_TRANSPORT_PLANNED' as const),
          value,
        })),
    ),
  });
}

export function orderedTripNodes(trip: TripAggregateRecord) {
  return trip.dayOccurrences.flatMap((occurrence) => occurrence.nodes);
}

function toDomainIntent(record: UserTimeIntentRecord): ScheduleUserTimeIntent {
  if (
    record.kind === 'POINT_TIME' &&
    record.pointKind !== null &&
    record.operator !== 'MINIMUM' &&
    record.instant !== null &&
    record.timeZone !== null &&
    record.durationSeconds === null
  ) {
    return {
      id: record.id,
      nodeId: record.nodeId,
      kind: 'POINT_TIME',
      pointKind: record.pointKind,
      operator: record.operator,
      instant: record.instant,
      timeZone: record.timeZone,
      durationSeconds: null,
      locked: record.locked,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  if (
    record.kind === 'MIN_DWELL' &&
    record.pointKind === null &&
    record.operator === 'MINIMUM' &&
    record.instant === null &&
    record.timeZone === null &&
    record.durationSeconds !== null
  ) {
    return {
      id: record.id,
      nodeId: record.nodeId,
      kind: 'MIN_DWELL',
      pointKind: null,
      operator: 'MINIMUM',
      instant: null,
      timeZone: null,
      durationSeconds: record.durationSeconds,
      locked: record.locked,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  throw new Error('UserTimeIntent persistence invariant is broken');
}
