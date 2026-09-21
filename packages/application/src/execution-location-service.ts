import type {
  ExecutionContextResponse,
  ExecutionEventView,
  ExecutionLocationResponse,
  ExecutionLocationSampleRequest,
  ExecutionMutationResponse,
  ExecutionUndoResponse,
  ManualExecutionEventRequest,
  UndoExecutionEventRequest,
} from '@travel/contracts';
import {
  decideExecutionLocation,
  DEFAULT_EXECUTION_LOCATION_POLICY,
  resolveExecutionFrontier,
  type ExecutionLocationPolicy,
  type ExecutionTargetKind,
  type ExecutionTimelineNode,
} from '@travel/domain';
import { createHash, randomUUID } from 'node:crypto';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  CommitExecutionResult,
  ExecutionContextRecord,
  ExecutionEventRecord,
  ExecutionLocationRepository,
} from './execution-location-ports.js';
import type { ExecutionRiskService } from './execution-risk-service.js';
import type { FlightMonitoringService } from './flight-monitoring-service.js';
import { parseAbsoluteInstantInput } from './time-input.js';

export interface ExecutionLocationServiceOptions {
  readonly now?: () => Date;
  readonly policy?: ExecutionLocationPolicy;
  readonly airportTriggerClaimLeaseMs?: number;
}

const DEFAULT_AIRPORT_TRIGGER_CLAIM_LEASE_MS = 120_000;

export class ExecutionLocationService {
  private readonly now: () => Date;
  private readonly policy: ExecutionLocationPolicy;
  private readonly airportTriggerClaimLeaseMs: number;

  constructor(
    private readonly repository: ExecutionLocationRepository,
    private readonly executionRiskService: ExecutionRiskService,
    private readonly flightMonitoringService: FlightMonitoringService,
    options: ExecutionLocationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.policy = options.policy ?? DEFAULT_EXECUTION_LOCATION_POLICY;
    this.airportTriggerClaimLeaseMs =
      options.airportTriggerClaimLeaseMs ??
      DEFAULT_AIRPORT_TRIGGER_CLAIM_LEASE_MS;
    if (
      !Number.isSafeInteger(this.airportTriggerClaimLeaseMs) ||
      this.airportTriggerClaimLeaseMs <= 0
    ) {
      throw new Error('airportTriggerClaimLeaseMs must be a positive integer');
    }
  }

  async observeLocation(
    actor: Actor,
    tripId: string,
    input: ExecutionLocationSampleRequest,
  ): Promise<ExecutionLocationResponse> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    const sample = {
      latitude: coordinate(input.latitude, 'latitude', -90, 90),
      longitude: coordinate(input.longitude, 'longitude', -180, 180),
      accuracyMeters: positiveFinite(input.accuracyMeters, 'accuracyMeters'),
      observedAt: parseAbsoluteInstantInput(input.observedAt, 'observedAt'),
    };
    validateOptionalMotion(input);
    validateObservedAt(sample.observedAt, this.now(), this.policy, true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await this.requireContext(actor, tripId);
      if (context.locationAssistance.state !== 'ENABLED') {
        throw new ApplicationError(
          'ASSISTANCE_INACTIVE',
          '该行程的位置辅助尚未开启或当前已暂停。',
          409,
        );
      }
      const frontier = resolveExecutionFrontier(toDomainNodes(context));
      requireConsistentFrontier(frontier);
      const previousObservedAt = context.observationWatermarkAt;
      if (
        previousObservedAt !== null &&
        sample.observedAt.getTime() < previousObservedAt.getTime()
      ) {
        throw staleSample();
      }
      if (
        previousObservedAt !== null &&
        sample.observedAt.getTime() === previousObservedAt.getTime()
      ) {
        const airportTriggerAttempted =
          context.autoRecord.state === 'ENABLED'
            ? await this.afterMutation(actor, context, null)
            : false;
        return this.locationResponse(
          actor,
          context,
          'NO_CHANGE',
          null,
          airportTriggerAttempted,
        );
      }
      const decision = decideExecutionLocation({
        nodes: toDomainNodes(context),
        previousState: context.locationState,
        suppressedArrivalNodeIds: context.suppressedArrivalNodeIds,
        sample,
        policy: this.policy,
      });
      const result = await this.repository.commitLocation({
        ownerUserId: actor.userId,
        tripId,
        expectedTripVersion: context.tripVersion,
        expectedObservationWatermarkAt: previousObservedAt,
        decision,
        observedAt: sample.observedAt,
        expectedLocationCapabilityRevision: context.locationAssistance.revision,
        expectedAutoRecordCapabilityRevision: context.autoRecord.revision,
        autoRecordEnabled: context.autoRecord.state === 'ENABLED',
      });
      if (result.status === 'RETRY' || result.status === 'VERSION_CONFLICT') {
        continue;
      }
      const success = requireSuccess(result);
      const autoRecordEnabled = context.autoRecord.state === 'ENABLED';
      const airportTriggerAttempted = autoRecordEnabled
        ? await this.afterMutation(actor, context, success.event)
        : false;
      return this.locationResponse(
        actor,
        { ...context, tripVersion: success.resultingTripVersion },
        autoRecordEnabled ? decision.status : detectedStatus(decision.status),
        success.event,
        airportTriggerAttempted,
      );
    }
    throw new ApplicationError(
      'VERSION_CONFLICT',
      '行程执行上下文正在变化，请重试。',
      409,
      true,
    );
  }

  async createManualEvent(
    actor: Actor,
    tripId: string,
    input: ManualExecutionEventRequest,
  ): Promise<ExecutionMutationResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(input.nodeId, 'nodeId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    const baseTripVersion = positiveInteger(
      input.baseTripVersion,
      'baseTripVersion',
    );
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      'idempotencyKey',
      1,
      200,
    );
    const occurredAt = parseAbsoluteInstantInput(
      input.occurredAt,
      'occurredAt',
    );
    validateObservedAt(occurredAt, this.now(), this.policy, false);
    const eventType = manualType(input.type);
    const requestHash = hashParts([
      tripId,
      input.nodeId,
      eventType,
      occurredAt.toISOString(),
      String(baseTripVersion),
    ]);
    const replay = await this.repository.findEventByIdempotencyKey({
      ownerUserId: actor.userId,
      tripId,
      idempotencyKey,
      requestHash,
    });
    if (replay.status === 'CONFLICT') throw idempotencyConflict();
    if (replay.status === 'MATCH') {
      const context = await this.requireContext(actor, tripId);
      const airportTriggerAttempted = await this.afterMutation(
        actor,
        context,
        replay.event,
      );
      return {
        event: toEventView(replay.event),
        resultingTripVersion: replay.tripVersion,
        idempotentReplay: true,
        airportTriggerAttempted,
      };
    }
    const context = await this.requireContext(actor, tripId);
    validateManualContext(context, input.nodeId, eventType);
    const frontier = resolveExecutionFrontier(toDomainNodes(context));
    const result = await this.repository.commitManual({
      ownerUserId: actor.userId,
      tripId,
      baseTripVersion,
      idempotencyKey,
      requestHash,
      type: eventType,
      nodeId: input.nodeId,
      occurredAt,
      expectedCurrentNodeId: frontier.currentNode?.id ?? null,
      expectedTargetNodeId: frontier.targetNode?.id ?? null,
    });
    const success = requireSuccess(result);
    if (success.event === null) throw new Error('Manual event missing');
    const airportTriggerAttempted = await this.afterMutation(
      actor,
      context,
      success.event,
    );
    return {
      event: toEventView(success.event),
      resultingTripVersion: success.resultingTripVersion,
      idempotentReplay: success.idempotentReplay,
      airportTriggerAttempted,
    };
  }

  async undoEvent(
    actor: Actor,
    tripId: string,
    eventId: string,
    input: UndoExecutionEventRequest,
  ): Promise<ExecutionUndoResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(eventId, 'eventId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    const baseTripVersion = positiveInteger(
      input.baseTripVersion,
      'baseTripVersion',
    );
    const idempotencyKey = boundedText(
      input.idempotencyKey,
      'idempotencyKey',
      1,
      200,
    );
    const result = await this.repository.undoEvent({
      ownerUserId: actor.userId,
      tripId,
      eventId,
      baseTripVersion,
      idempotencyKey,
      requestHash: hashParts([tripId, eventId, String(baseTripVersion)]),
      now: this.now(),
    });
    const success = requireSuccess(result);
    if (success.event === null) throw new Error('Undo event missing');
    await this.executionRiskService.evaluateTripRisks(actor, tripId);
    return {
      event: toEventView(success.event),
      resultingTripVersion: success.resultingTripVersion,
      idempotentReplay: success.idempotentReplay,
    };
  }

  async getExecution(
    actor: Actor,
    tripId: string,
  ): Promise<ExecutionContextResponse> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'READ_PRIVATE_RESOURCE');
    const context = await this.requireContext(actor, tripId);
    const frontier = resolveExecutionFrontier(toDomainNodes(context));
    const risks = await this.executionRiskService.listRisks(actor, tripId);
    return {
      tripId,
      tripVersion: context.tripVersion,
      currentNodeId: frontier.currentNode?.id ?? null,
      targetNodeId: frontier.targetNode?.id ?? null,
      currentState: frontier.state,
      frontierConflict: frontier.conflict,
      latestArrival: latestFact(context, 'ARRIVAL'),
      latestDeparture: latestFact(context, 'DEPARTURE'),
      possibleSkippedNodeIds: context.possibleSkippedNodeIds,
      confirmedSkippedNodeIds: context.confirmedSkippedNodeIds,
      locationStatus: context.locationState?.locationStatus ?? 'NO_SAMPLE',
      activeRisks: risks.risks,
    };
  }

  private async requireContext(
    actor: Actor,
    tripId: string,
  ): Promise<ExecutionContextRecord> {
    const context = await this.repository.findOwnedContext({
      ownerUserId: actor.userId,
      tripId,
    });
    if (context === null) {
      throw new ApplicationError('NOT_FOUND', '行程不存在。', 404);
    }
    return context;
  }

  private async afterMutation(
    actor: Actor,
    context: ExecutionContextRecord,
    event: ExecutionEventRecord | null,
  ): Promise<boolean> {
    const arrivals = [
      ...context.pendingAirportArrivalEvents,
      ...(event?.type === 'ARRIVAL' && event.airportTriggerCompletedAt === null
        ? [event]
        : []),
    ].filter(
      (item, index, values) =>
        values.findIndex((candidate) => candidate.id === item.id) === index,
    );
    if (event !== null || arrivals.length > 0) {
      await this.executionRiskService.evaluateTripRisks(actor, context.tripId);
    }
    let attempted = false;
    for (const arrival of arrivals) {
      const flight = context.flightDepartures.find(
        (item) => item.departureNodeId === arrival.nodeId,
      );
      if (flight === undefined) continue;
      const claimedAt = this.now();
      const claimToken = randomUUID();
      const claim = await this.repository.claimAirportTrigger({
        ownerUserId: actor.userId,
        tripId: context.tripId,
        eventId: arrival.id,
        claimToken,
        claimedAt,
        expiredBefore: new Date(
          claimedAt.getTime() - this.airportTriggerClaimLeaseMs,
        ),
      });
      if (claim.status !== 'CLAIMED') continue;
      attempted = true;
      try {
        await this.flightMonitoringService.trigger(
          actor,
          context.tripId,
          flight.flightBindingId,
          { type: 'ARRIVED_AT_AIRPORT', airportIata: flight.airportIata },
          flight.monitoringCapabilityRevision,
        );
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'ASSISTANCE_INACTIVE'
        ) {
          await this.repository.completeAirportTrigger({
            ownerUserId: actor.userId,
            tripId: context.tripId,
            eventId: arrival.id,
            claimToken: claim.claimToken,
            completedAt: this.now(),
          });
          continue;
        }
        await this.repository.releaseAirportTriggerClaim({
          ownerUserId: actor.userId,
          tripId: context.tripId,
          eventId: arrival.id,
          claimToken: claim.claimToken,
        });
        throw error;
      }
      await this.repository.completeAirportTrigger({
        ownerUserId: actor.userId,
        tripId: context.tripId,
        eventId: arrival.id,
        claimToken: claim.claimToken,
        completedAt: this.now(),
      });
    }
    return attempted;
  }

  private async locationResponse(
    actor: Actor,
    context: ExecutionContextRecord,
    status: ExecutionLocationResponse['status'],
    event: ExecutionEventRecord | null,
    airportTriggerAttempted: boolean,
  ): Promise<ExecutionLocationResponse> {
    const confirmationRecommended =
      (status === 'INDETERMINATE_LOCATION' ||
        status === 'MANUAL_CONFIRMATION_AVAILABLE') &&
      (await this.executionRiskService.listRisks(actor, context.tripId)).risks
        .length > 0;
    return {
      status,
      event: event === null ? null : toEventView(event),
      resultingTripVersion: context.tripVersion,
      confirmationRecommended,
      airportTriggerAttempted,
    };
  }
}

function toDomainNodes(
  context: ExecutionContextRecord,
): readonly ExecutionTimelineNode[] {
  const airports = new Set(
    context.flightDepartures.map((item) => item.departureNodeId),
  );
  return context.nodes.map((node) => ({
    id: node.id,
    sequence: node.sequence,
    position: node.position,
    latitude: node.latitude,
    longitude: node.longitude,
    targetKind: targetKind(node.providerHubRef, airports.has(node.id)),
    hasActualArrival: node.actualArrival !== null,
    hasActualDeparture: node.actualDeparture !== null,
    executionStatus: node.executionStatus,
  }));
}

function targetKind(
  providerHubRef: string | null,
  airport: boolean,
): ExecutionTargetKind {
  return airport
    ? 'AIRPORT'
    : providerHubRef === null
      ? 'PLACE'
      : 'TRANSIT_HUB';
}

function validateManualContext(
  context: ExecutionContextRecord,
  nodeId: string,
  type: 'ARRIVAL' | 'DEPARTURE' | 'SKIP_CONFIRMED',
): void {
  const frontier = resolveExecutionFrontier(toDomainNodes(context));
  requireConsistentFrontier(frontier);
  const valid =
    type === 'ARRIVAL'
      ? frontier.targetNode?.id === nodeId
      : type === 'DEPARTURE'
        ? frontier.currentNode?.id === nodeId
        : context.possibleSkippedNodeIds.includes(nodeId);
  if (!valid) {
    throw new ApplicationError(
      'EXECUTION_EVENT_CONFLICT',
      '该节点与当前执行上下文不匹配。',
      409,
    );
  }
}

function requireConsistentFrontier(
  frontier: ReturnType<typeof resolveExecutionFrontier>,
): void {
  if (frontier.state !== 'INCONSISTENT') return;
  throw new ApplicationError(
    'EXECUTION_EVENT_CONFLICT',
    '执行记录存在因果冲突，请先纠正实际到达或离开记录。',
    409,
  );
}

function requireSuccess(result: CommitExecutionResult) {
  if (result.status === 'SUCCESS') return result;
  switch (result.status) {
    case 'NOT_FOUND':
      throw new ApplicationError('NOT_FOUND', '行程或执行事件不存在。', 404);
    case 'VERSION_CONFLICT':
    case 'RETRY':
      throw new ApplicationError(
        'VERSION_CONFLICT',
        '行程已被其他设备更新，请刷新后重试。',
        409,
      );
    case 'FACT_PROTECTED':
      throw new ApplicationError(
        'FACT_PROTECTED',
        '已有权威实际事实，不能由本次执行事件覆盖或撤销。',
        409,
      );
    case 'IDEMPOTENCY_CONFLICT':
      throw idempotencyConflict();
    case 'INVALID_CONTEXT':
    case 'UNDO_CONFLICT':
      throw new ApplicationError(
        'EXECUTION_EVENT_CONFLICT',
        '执行上下文已变化，无法安全完成该操作。',
        409,
      );
    case 'CAPABILITY_CHANGED':
      throw new ApplicationError(
        'CAPABILITY_CHANGED',
        '辅助能力状态已变化；旧位置请求未被处理，请提交新的位置样本。',
        409,
      );
  }
}

function detectedStatus(
  status: ExecutionLocationResponse['status'],
): ExecutionLocationResponse['status'] {
  if (status === 'CONFIRMED_ARRIVAL') return 'ARRIVAL_DETECTED';
  if (status === 'CONFIRMED_DEPARTURE') return 'DEPARTURE_DETECTED';
  return status;
}

function manualType(
  value: ManualExecutionEventRequest['type'],
): 'ARRIVAL' | 'DEPARTURE' | 'SKIP_CONFIRMED' {
  switch (value) {
    case 'MANUAL_ARRIVAL':
      return 'ARRIVAL';
    case 'MANUAL_DEPARTURE':
      return 'DEPARTURE';
    case 'CONFIRM_SKIP':
      return 'SKIP_CONFIRMED';
    default:
      throw new ApplicationError('VALIDATION_ERROR', '执行事件类型无效。', 400);
  }
}

function latestFact(
  context: ExecutionContextRecord,
  pointKind: 'ARRIVAL' | 'DEPARTURE',
) {
  const facts = context.nodes.flatMap((node) => {
    const fact =
      pointKind === 'ARRIVAL' ? node.actualArrival : node.actualDeparture;
    return fact === null ? [] : [{ nodeId: node.id, instant: fact.instant }];
  });
  const latest = facts.sort(
    (left, right) => right.instant.getTime() - left.instant.getTime(),
  )[0];
  return latest === undefined
    ? null
    : { nodeId: latest.nodeId, instant: latest.instant.toISOString() };
}

function toEventView(record: ExecutionEventRecord): ExecutionEventView {
  return {
    id: record.id,
    tripId: record.tripId,
    nodeId: record.nodeId,
    type: record.type,
    source: record.source,
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    undoneAt: record.undoneAt?.toISOString() ?? null,
  };
}

function validateObservedAt(
  observedAt: Date,
  now: Date,
  policy: ExecutionLocationPolicy,
  enforceAge: boolean,
): void {
  if (
    observedAt.getTime() >
    now.getTime() + policy.maxFutureSkewSeconds * 1_000
  ) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      '观测时间明显晚于服务器时间。',
      400,
    );
  }
  if (
    enforceAge &&
    now.getTime() - observedAt.getTime() > policy.maxSampleAgeSeconds * 1_000
  ) {
    throw staleSample();
  }
}

function validateOptionalMotion(input: ExecutionLocationSampleRequest): void {
  if (input.speedMetersPerSecond !== undefined) {
    nonnegativeFinite(input.speedMetersPerSecond, 'speedMetersPerSecond');
  }
  if (input.headingDegrees !== undefined) {
    const heading = nonnegativeFinite(input.headingDegrees, 'headingDegrees');
    if (heading >= 360) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'headingDegrees 必须小于 360。',
        400,
      );
    }
  }
}

function coordinate(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}

function positiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `${field} 必须大于 0。`,
      400,
    );
  }
  return value;
}

function nonnegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `${field} 不能为负数。`,
      400,
    );
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `${field} 必须是正整数。`,
      400,
    );
  }
  return value;
}

function boundedText(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 长度无效。`, 400);
  }
  return normalized;
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

function hashParts(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'), 'utf8')
    .digest('hex');
}

function staleSample(): ApplicationError {
  return new ApplicationError(
    'EXECUTION_SAMPLE_STALE',
    '定位观测已过期或早于服务器已处理的观测。',
    409,
  );
}

function idempotencyConflict(): ApplicationError {
  return new ApplicationError(
    'IDEMPOTENCY_CONFLICT',
    '该幂等键已用于不同的执行请求。',
    409,
  );
}

function authorizeSelf(
  actor: Actor,
  action: 'READ_PRIVATE_RESOURCE' | 'WRITE_PRIVATE_RESOURCE',
): void {
  authorize(actor, action, {
    kind: 'PRIVATE_RESOURCE',
    ownerUserId: actor.userId,
  });
}
