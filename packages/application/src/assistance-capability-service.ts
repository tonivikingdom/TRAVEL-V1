import type {
  AssistanceAction,
  AssistanceCapabilityView,
  AssistanceMutationRequest,
  AssistanceMutationResponse,
  TripAssistanceKind,
  TripAssistanceResponse,
} from '@travel/contracts';
import { createHash } from 'node:crypto';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  AssistanceCapabilityRecord,
  AssistanceCapabilityRepository,
  AssistanceMutationRepositoryResult,
} from './assistance-capability-ports.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FLIGHT_ELIGIBILITY_WINDOW_MS = 24 * 60 * 60_000;

export interface AssistanceCapabilityServiceOptions {
  readonly now?: () => Date;
}

export class AssistanceCapabilityService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: AssistanceCapabilityRepository,
    options: AssistanceCapabilityServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getTrip(actor: Actor, tripId: string): Promise<TripAssistanceResponse> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'READ_PRIVATE_RESOURCE');
    const records = await this.repository.getTripCapabilities({
      ownerUserId: actor.userId,
      tripId,
    });
    if (records === null) throw notFound();
    const location = records.find(
      (item) => item.kind === 'LOCATION_ASSISTANCE',
    )!;
    return {
      tripId,
      capabilities: records.map((record) =>
        toView(
          record,
          record.kind === 'AUTO_RECORD' && location.state !== 'ENABLED'
            ? 'LOCATION_ASSISTANCE_INACTIVE'
            : null,
        ),
      ),
    };
  }

  async mutateTrip(
    actor: Actor,
    tripId: string,
    kind: TripAssistanceKind,
    input: AssistanceMutationRequest,
  ): Promise<AssistanceMutationResponse> {
    requireUuid(tripId, 'tripId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    const parsed = parseMutation(input);
    return requireMutation(
      await this.repository.mutateTripCapability({
        ownerUserId: actor.userId,
        tripId,
        kind,
        ...parsed,
        requestHash: hash([
          tripId,
          kind,
          parsed.action,
          String(parsed.baseRevision),
        ]),
        now: this.now(),
      }),
    );
  }

  async getFlight(
    actor: Actor,
    tripId: string,
    flightBindingId: string,
  ): Promise<AssistanceCapabilityView> {
    requireUuid(tripId, 'tripId');
    requireUuid(flightBindingId, 'flightBindingId');
    authorizeSelf(actor, 'READ_PRIVATE_RESOURCE');
    const result = await this.repository.getFlightCapability({
      ownerUserId: actor.userId,
      tripId,
      flightBindingId,
    });
    if (result === null) throw notFound();
    const eligible = isFlightEligible(
      result.flightStatus,
      result.scheduledDepartureAt,
      this.now(),
    );
    return toView(
      result.capability,
      result.capability.state === 'ENABLED' && !eligible
        ? 'NOT_CURRENTLY_ELIGIBLE'
        : null,
    );
  }

  async mutateFlight(
    actor: Actor,
    tripId: string,
    flightBindingId: string,
    input: AssistanceMutationRequest,
  ): Promise<AssistanceMutationResponse> {
    requireUuid(tripId, 'tripId');
    requireUuid(flightBindingId, 'flightBindingId');
    authorizeSelf(actor, 'WRITE_PRIVATE_RESOURCE');
    const parsed = parseMutation(input);
    return requireMutation(
      await this.repository.mutateFlightCapability({
        ownerUserId: actor.userId,
        tripId,
        flightBindingId,
        ...parsed,
        requestHash: hash([
          tripId,
          flightBindingId,
          'FLIGHT_MONITORING',
          parsed.action,
          String(parsed.baseRevision),
        ]),
        now: this.now(),
      }),
    );
  }
}

function parseMutation(input: AssistanceMutationRequest) {
  const actions: readonly AssistanceAction[] = [
    'ENABLE',
    'PAUSE',
    'RESUME',
    'STOP',
  ];
  if (!actions.includes(input.action)) validation('action 无效。');
  if (
    !Number.isSafeInteger(input.baseCapabilityRevision) ||
    input.baseCapabilityRevision < 0
  ) {
    validation('baseCapabilityRevision 无效。');
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    validation('idempotencyKey 无效。');
  }
  return {
    action: input.action,
    baseRevision: input.baseCapabilityRevision,
    idempotencyKey,
  };
}

function requireMutation(
  result: AssistanceMutationRepositoryResult,
): AssistanceMutationResponse {
  if (result.status === 'SUCCESS') {
    return {
      capability: toView(result.capability, null),
      idempotentReplay: result.idempotentReplay,
    };
  }
  if (result.status === 'NOT_FOUND') throw notFound();
  if (result.status === 'IDEMPOTENCY_CONFLICT') {
    throw new ApplicationError(
      'IDEMPOTENCY_CONFLICT',
      '同一幂等键已用于不同请求。',
      409,
    );
  }
  throw new ApplicationError(
    'CAPABILITY_CONFLICT',
    result.status === 'REVISION_CONFLICT'
      ? '辅助能力已被其他设备更新，请刷新后重试。'
      : '该辅助能力不能执行当前状态转换。',
    409,
  );
}

function toView(
  record: AssistanceCapabilityRecord,
  effectiveOverride:
    'LOCATION_ASSISTANCE_INACTIVE' | 'NOT_CURRENTLY_ELIGIBLE' | null,
): AssistanceCapabilityView {
  const effectiveEnabled =
    record.state === 'ENABLED' && effectiveOverride === null;
  return {
    kind: record.kind,
    scope: record.scope,
    scopeId: record.scopeId,
    state: record.state,
    revision: record.revision,
    enabledAt: record.enabledAt?.toISOString() ?? null,
    resumedAt: record.resumedAt?.toISOString() ?? null,
    pausedAt: record.pausedAt?.toISOString() ?? null,
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
    stopReason: record.stopReason,
    effectiveEnabled,
    effectiveReason:
      effectiveOverride ??
      (record.state === 'ENABLED' ? 'ENABLED' : record.state),
  };
}

function isFlightEligible(
  status: string,
  scheduledDepartureAt: Date | null,
  now: Date,
): boolean {
  return (
    scheduledDepartureAt !== null &&
    !['DEPARTED', 'EN_ROUTE', 'LANDED', 'ARRIVED'].includes(status) &&
    scheduledDepartureAt.getTime() - now.getTime() <=
      FLIGHT_ELIGIBILITY_WINDOW_MS
  );
}

function authorizeSelf(
  actor: Actor,
  action: 'READ_PRIVATE_RESOURCE' | 'WRITE_PRIVATE_RESOURCE',
) {
  authorize(actor, action, {
    kind: 'PRIVATE_RESOURCE',
    ownerUserId: actor.userId,
  });
}

function requireUuid(value: string, field: string): void {
  if (!UUID.test(value)) validation(`${field} 无效。`);
}

function validation(message: string): never {
  throw new ApplicationError('VALIDATION_ERROR', message, 400);
}

function notFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', '找不到该资源。', 404);
}

function hash(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
