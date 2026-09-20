import type {
  ExecutionRiskEvaluationResponse,
  ExecutionRiskListResponse,
  ExecutionRiskView,
  NotificationView,
} from '@travel/contracts';
import {
  evaluateExecutionRisks,
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

const SNOOZE_MILLISECONDS = 15 * 60 * 1_000;

export interface ExecutionRiskServiceOptions {
  readonly now?: () => Date;
}

export class ExecutionRiskService {
  private readonly now: () => Date;

  constructor(
    private readonly tripRepository: TripRepository,
    private readonly riskRepository: ExecutionRiskRepository,
    options: ExecutionRiskServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async evaluateTripRisks(
    actor: Actor,
    tripId: string,
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
      const desiredRisks = evaluateExecutionRisks(toDomainInput(trip)).map(
        toDesiredRisk,
      );
      const result = await this.riskRepository.reconcile({
        ownerUserId: actor.userId,
        tripId,
        basisTripVersion: trip.version,
        now: this.now(),
        desiredRisks,
      });
      if (result.status === 'NOT_FOUND') throw notFound();
      if (result.status === 'VERSION_CONFLICT') continue;
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

function toDomainInput(trip: TripAggregateRecord) {
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
      timeValues: edge.timeValues,
    })),
  };
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
