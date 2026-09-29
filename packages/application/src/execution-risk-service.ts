import type {
  ExecutionRiskEvaluationResponse,
  ExecutionRiskListResponse,
  ExecutionRiskView,
  NotificationView,
} from '@travel/contracts';
import {
  assessGroundTransitOperational,
  assessGroundTransitSafety,
  evaluateExecutionRisks,
  matchGroundTransitIdentity,
  GROUND_TRANSIT_POLICY,
  type ExecutionBufferEvidence,
  type EvaluatedExecutionRisk,
} from '@travel/domain';
import { createHash } from 'node:crypto';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  DesiredExecutionRisk,
  ExecutionRiskRecord,
  ExecutionRiskRepository,
} from './execution-risk-ports.js';
import type { NotificationRecord } from './ports.js';
import type { TripAggregateRecord, TripRepository } from './trip-ports.js';
import type {
  GroundTransitLegRecord,
  GroundTransitRepository,
} from './ground-transit-ports.js';

const SNOOZE_MILLISECONDS = 15 * 60 * 1_000;

export interface ExecutionRiskServiceOptions {
  readonly now?: () => Date;
  readonly groundTransitRepository?: GroundTransitRepository;
}

export class ExecutionRiskService {
  private readonly now: () => Date;
  private readonly groundTransitRepository: GroundTransitRepository | undefined;

  constructor(
    private readonly tripRepository: TripRepository,
    private readonly riskRepository: ExecutionRiskRepository,
    options: ExecutionRiskServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.groundTransitRepository = options.groundTransitRepository;
  }

  async evaluateTripRisks(
    actor: Actor,
    tripId: string,
    correlation?: {
      readonly groupKey: string;
      readonly sourceTransportEdgeId: string;
      readonly expectedGroundTransitCapabilityRevision?: number;
      readonly observationIdentity?: string;
      readonly observationFetchedAt?: Date;
      readonly requireSourceMatch?: boolean;
    },
  ): Promise<ExecutionRiskEvaluationResponse> {
    requireUuid(tripId, 'tripId');
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const trip = await this.tripRepository.findOwnedById({
        ownerUserId: actor.userId,
        tripId,
      });
      if (trip === null) throw notFound();
      const groundTransitLegs = await this.groundTransitRepository?.listOwned({
        ownerUserId: actor.userId,
        tripId,
      });
      const desiredRisks = evaluateExecutionRisks(
        toDomainInput(trip, groundTransitLegs?.legs ?? [], this.now()),
      ).map(toDesiredRisk);
      const result = await this.riskRepository.reconcile({
        ownerUserId: actor.userId,
        tripId,
        basisTripVersion: trip.version,
        now: this.now(),
        desiredRisks,
        ...(correlation === undefined
          ? {}
          : {
              correlationGroupKey: correlation.groupKey,
              correlationSourceTransportEdgeId:
                correlation.sourceTransportEdgeId,
              ...(correlation.requireSourceMatch === true
                ? { correlationRequireSourceMatch: true }
                : {}),
              ...(correlation.expectedGroundTransitCapabilityRevision ===
              undefined
                ? {}
                : {
                    expectedGroundTransitCapabilityRevision:
                      correlation.expectedGroundTransitCapabilityRevision,
                  }),
              ...(correlation.observationIdentity === undefined ||
              correlation.observationFetchedAt === undefined
                ? {}
                : {
                    expectedGroundTransitObservation: {
                      transportEdgeId: correlation.sourceTransportEdgeId,
                      identity: correlation.observationIdentity,
                      fetchedAt: correlation.observationFetchedAt,
                    },
                  }),
            }),
      });
      if (result.status === 'NOT_FOUND') throw notFound();
      if (result.status === 'VERSION_CONFLICT') continue;
      if (result.status === 'OBSERVATION_OBSOLETE') {
        throw new ApplicationError(
          'GROUND_TRANSIT_OBSERVATION_OBSOLETE',
          '地面交通观测已被更新的事实取代。',
          409,
        );
      }
      if (result.status === 'CAPABILITY_CHANGED') {
        throw new ApplicationError(
          'CAPABILITY_CHANGED',
          '地面交通监控授权已变更；旧请求不再生效。',
          409,
        );
      }
      return {
        tripId,
        evaluationBasisTripVersion: trip.version,
        risks: result.activeRisks.map(toRiskView),
        resolvedRisks: result.resolvedRisks.map(toRiskView),
        notificationsCreated:
          result.notificationsCreated.map(toNotificationView),
      };
    }
    throw new ApplicationError(
      'VERSION_CONFLICT',
      '行程事实在风险评估期间发生变化，请重试。',
      409,
      true,
    );
  }

  async listRisks(
    actor: Actor,
    tripId: string,
  ): Promise<ExecutionRiskListResponse> {
    requireUuid(tripId, 'tripId');
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const risks = await this.riskRepository.listActiveOwned({
      ownerUserId: actor.userId,
      tripId,
    });
    if (risks === null) throw notFound();
    return { risks: risks.map(toRiskView) };
  }

  async acknowledgeRisk(
    actor: Actor,
    tripId: string,
    riskId: string,
  ): Promise<ExecutionRiskView> {
    requireUuid(tripId, 'tripId');
    requireUuid(riskId, 'riskId');
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const risk = await this.riskRepository.acknowledgeOwned({
      ownerUserId: actor.userId,
      tripId,
      riskId,
      now: this.now(),
    });
    if (risk === null) throw notFound();
    return toRiskView(risk);
  }

  async snoozeRisk(
    actor: Actor,
    tripId: string,
    riskId: string,
  ): Promise<ExecutionRiskView> {
    requireUuid(tripId, 'tripId');
    requireUuid(riskId, 'riskId');
    authorize(actor, 'WRITE_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const now = this.now();
    const risk = await this.riskRepository.snoozeOwned({
      ownerUserId: actor.userId,
      tripId,
      riskId,
      now,
      snoozedUntil: new Date(now.getTime() + SNOOZE_MILLISECONDS),
    });
    if (risk === null) throw notFound();
    return toRiskView(risk);
  }
}

function toDomainInput(
  trip: TripAggregateRecord,
  groundTransitLegs: readonly GroundTransitLegRecord[] = [],
  now: Date = new Date(),
) {
  return {
    nodes: trip.dayOccurrences.flatMap((occurrence) =>
      occurrence.nodes.map((node) => ({
        id: node.id,
        sequence: occurrence.sequence,
        position: node.position,
        timeValues: node.timeValues,
        intents: node.timeIntents,
        systemDwellSuggestionSeconds:
          node.systemDwellSuggestion?.durationSeconds ?? null,
      })),
    ),
    transports: trip.transportEdges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      fixedService: edge.fixedService,
      timeValues: edge.timeValues.filter((value) => {
        const ground = groundTransitLegs.find(
          (leg) => leg.current && leg.transportEdgeId === edge.id,
        );
        return (
          ground === undefined ||
          value.layer !== 'ESTIMATED' ||
          value.sourceKind !== 'PROVIDER_OBSERVATION' ||
          (ground.latestObservation !== null &&
            ground.latestObservation.fetchedAt.getTime() <= now.getTime() &&
            now.getTime() - ground.latestObservation.fetchedAt.getTime() <=
              GROUND_TRANSIT_POLICY.realtimeFreshnessMs)
        );
      }),
    })),
    buffers: groundTransitBuffers(trip, groundTransitLegs, now),
  };
}

function groundTransitBuffers(
  trip: TripAggregateRecord,
  legs: readonly GroundTransitLegRecord[],
  now: Date,
): readonly ExecutionBufferEvidence[] {
  const buffers: ExecutionBufferEvidence[] = [];
  for (const leg of legs) {
    if (!leg.current || leg.baseline === null) continue;
    const edge = trip.transportEdges.find(
      (item) => item.id === leg.transportEdgeId,
    );
    if (edge === undefined) continue;
    const observation = leg.latestObservation;
    const matched =
      observation !== null &&
      matchGroundTransitIdentity(leg.baseline, observation) === 'MATCHED';
    const fresh =
      matched &&
      observation.fetchedAt.getTime() <= now.getTime() &&
      now.getTime() - observation.fetchedAt.getTime() <=
        GROUND_TRANSIT_POLICY.realtimeFreshnessMs;
    const sourceNode = trip.dayOccurrences
      .flatMap((item) => item.nodes)
      .find((item) => item.id === edge.fromNodeId);
    const actualAtBoarding =
      sourceNode?.timeValues.find(
        (value) => value.pointKind === 'ARRIVAL' && value.layer === 'ACTUAL',
      )?.instant ?? null;
    const operational = assessGroundTransitOperational({
      baseline: leg.baseline,
      previousObservation: leg.previousObservation ?? null,
      latestObservation: observation,
      now,
      state: leg.state,
      current: leg.current,
      availableAtBoarding: actualAtBoarding,
      actualServiceDeparture: leg.actualServiceDeparture ?? null,
      downstreamProtectedDeparture: leg.downstreamProtectedDeparture ?? null,
    });
    if (operational.disposition === 'CURRENT_PLAN_NO_LONGER_FEASIBLE') {
      buffers.push({
        id: `ground-operational:${edge.id}`,
        kind: 'SYSTEM_MINIMUM_CONNECTION',
        availableSeconds: -1,
        requiredSeconds: 0,
        sourceNodeId: edge.fromNodeId,
        sourceTransportEdgeId: edge.id,
        protectedTransportEdgeId: edge.id,
        riskKind: operational.irreversibleActualMiss
          ? 'FIXED_SERVICE_MISSED'
          : 'PROTECTED_TIME_INFEASIBLE',
        explanation: operational.irreversibleActualMiss
          ? '可靠的到站事实晚于班次实际出发时间，原路线需要重新评估。'
          : '当前服务无法完成原采用的上下车目标，需要重新评估路线。',
        requiresRouteReevaluation: true,
      });
    }
    const downstream = trip.transportEdges.find(
      (item) => item.fromNodeId === edge.toNodeId && item.fixedService,
    );
    if (
      leg.baseline.serviceClass === 'HIGH_FREQUENCY' &&
      actualAtBoarding !== null &&
      leg.baseline.plannedDeparture !== null
    ) {
      const safety = assessGroundTransitSafety({
        baseline: leg.baseline,
        observation: fresh ? observation : null,
        now,
        availableAt: actualAtBoarding,
        downstreamLatestAt: null,
        boundary: 'BOARDING',
        boardingAccessRequired: downstream !== undefined,
      });
      if (
        safety.totalSystemMinimumSeconds !== null ||
        downstream !== undefined
      ) {
        buffers.push({
          id: `ground-boarding:${edge.id}`,
          kind: 'SYSTEM_MINIMUM_CONNECTION',
          availableSeconds: Math.floor(
            (leg.baseline.plannedDeparture.getTime() -
              actualAtBoarding.getTime()) /
              1_000,
          ),
          requiredSeconds: safety.totalSystemMinimumSeconds,
          sourceNodeId: edge.fromNodeId,
          sourceTransportEdgeId: edge.id,
          protectedTransportEdgeId: downstream?.id ?? edge.id,
          ...(safety.totalSystemMinimumSeconds === null
            ? { riskKind: 'UNKNOWN_EXECUTION_MARGIN' as const }
            : {}),
          requiresRouteReevaluation: true,
        });
      }
    }
    if (downstream === undefined) continue;
    const protectedDeparture = selectTime(downstream.timeValues, 'DEPARTURE');
    const currentArrival = matched
      ? (observation.actualArrival ??
        (fresh ? observation.estimatedArrival : null) ??
        leg.baseline.plannedArrival)
      : leg.baseline.plannedArrival;
    if (protectedDeparture === null) continue;
    const safety = assessGroundTransitSafety({
      baseline: leg.baseline,
      observation: fresh ? observation : null,
      now,
      availableAt: currentArrival,
      downstreamLatestAt: protectedDeparture,
      boundary: 'TRANSFER_TO_NEXT',
    });
    buffers.push({
      id: `ground-transfer:${edge.id}:${downstream.id}`,
      kind: 'SYSTEM_MINIMUM_CONNECTION',
      availableSeconds:
        currentArrival === null
          ? 0
          : Math.floor(
              (protectedDeparture.getTime() - currentArrival.getTime()) / 1_000,
            ),
      requiredSeconds:
        currentArrival === null ? null : safety.transferMinimumSeconds,
      ...(safety.transferMinimumSeconds === null || currentArrival === null
        ? { riskKind: 'UNKNOWN_EXECUTION_MARGIN' as const }
        : {}),
      sourceNodeId: edge.toNodeId,
      sourceTransportEdgeId: edge.id,
      protectedTransportEdgeId: downstream.id,
      protectedNodeId: downstream.fromNodeId,
      requiresRouteReevaluation: true,
    });
  }
  return buffers;
}

function selectTime(
  values: TripAggregateRecord['transportEdges'][number]['timeValues'],
  pointKind: 'ARRIVAL' | 'DEPARTURE',
): Date | null {
  return (
    (['ACTUAL', 'ESTIMATED', 'PLANNED'] as const)
      .map(
        (layer) =>
          values.find(
            (value) => value.pointKind === pointKind && value.layer === layer,
          )?.instant ?? null,
      )
      .find((value) => value !== null) ?? null
  );
}

function toDesiredRisk(risk: EvaluatedExecutionRisk): DesiredExecutionRisk {
  const evidence = {
    kind: risk.kind,
    severity: risk.severity,
    sourceNodeId: risk.sourceNodeId,
    sourceTransportEdgeId: risk.sourceTransportEdgeId,
    protectedNodeId: risk.protectedNodeId,
    protectedTransportEdgeId: risk.protectedTransportEdgeId,
    evidenceRefs: risk.evidenceRefs,
    requiresRouteReevaluation: risk.requiresRouteReevaluation,
  };
  return {
    fingerprint: sha256(canonicalParts(risk.fingerprintParts)),
    kind: risk.kind,
    severity: risk.severity,
    sourceNodeId: risk.sourceNodeId,
    sourceTransportEdgeId: risk.sourceTransportEdgeId,
    protectedNodeId: risk.protectedNodeId,
    protectedTransportEdgeId: risk.protectedTransportEdgeId,
    evidenceHash: sha256(JSON.stringify(evidence)),
    evidenceRefs: risk.evidenceRefs,
    requiresRouteReevaluation: risk.requiresRouteReevaluation,
    notificationTitle: notificationTitle(risk),
    notificationBody: risk.explanation,
  };
}

function canonicalParts(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function notificationTitle(risk: EvaluatedExecutionRisk): string {
  switch (risk.severity) {
    case 'INFEASIBLE':
      return '后续固定安排当前无法满足';
    case 'UNKNOWN':
      return '后续安排余量暂时无法判断';
    case 'EXECUTABLE_RISK':
      return '后续受保护安排存在执行风险';
  }
}

function toRiskView(record: ExecutionRiskRecord): ExecutionRiskView {
  return {
    id: record.id,
    tripId: record.tripId,
    kind: record.kind,
    severity: record.severity,
    status: record.status,
    sourceNodeId: record.sourceNodeId,
    sourceTransportEdgeId: record.sourceTransportEdgeId,
    protectedNodeId: record.protectedNodeId,
    protectedTransportEdgeId: record.protectedTransportEdgeId,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    acknowledgedAt: record.acknowledgedAt?.toISOString() ?? null,
    snoozedUntil: record.snoozedUntil?.toISOString() ?? null,
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
    evaluationBasisTripVersion: record.evaluationBasisTripVersion,
    evidenceRefs: record.evidenceRefs,
    requiresRouteReevaluation: record.requiresRouteReevaluation,
  };
}

function toNotificationView(record: NotificationRecord): NotificationView {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    body: record.body,
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    dismissedAt: record.dismissedAt?.toISOString() ?? null,
    tripId: record.tripId,
    flightBindingId: record.flightBindingId,
    flightNumber: record.flightNumber,
    priority: record.priority,
    summary: record.summary,
    changeKinds: Array.isArray(record.changeKinds)
      ? record.changeKinds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
    hasDownstreamImpact: record.hasDownstreamImpact,
    viewedAt: record.viewedAt?.toISOString() ?? null,
  };
}

function requireUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
}

function notFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', '执行风险不存在。', 404);
}
