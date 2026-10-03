import type {
  CreateRoutePreviewRequest,
  RoutePreviewView,
} from '@travel/contracts';
import { validateRouteCandidate } from '@travel/domain';
import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import {
  systemClock,
  type Clock,
  type RoutePlanningRepository,
  type StoredRoutePreviewPayload,
} from './route-planning-ports.js';
import { hashRoutePreviewPayload } from './route-snapshot.js';
import { evaluateRouteReplacementSchedule } from './schedule-evaluation.js';
import type { TripAggregateRecord, TripRepository } from './trip-ports.js';
import type { ExternalExecutionOriginRepository } from './external-execution-origin-ports.js';
import {
  buildExternalOriginPreviewPayload,
  EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION,
  LEGACY_EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION,
} from './external-origin-route-preview.js';
import {
  validateSnapshot,
  assertSnapshotFresh,
  requireCurrentCorridor,
  buildChangeSummary,
  normalizeSameHubConfirmations,
  toCandidateView,
  earlier,
  laterNullable,
  earlierNullable,
  stalePreview,
} from './route-preview-plan.js';

export const ROUTE_PREVIEW_POLICY_VERSION = 'route-adoption-preview-v3';

export interface RoutePreviewServiceOptions {
  readonly previewTtlSeconds: number;
  readonly clock?: Clock;
  readonly externalOrigins?: ExternalExecutionOriginRepository;
}

export class RoutePreviewService {
  constructor(
    private readonly tripRepository: TripRepository,
    private readonly planningRepository: RoutePlanningRepository,
    private readonly options: RoutePreviewServiceOptions,
  ) {
    requireTtl(options.previewTtlSeconds);
  }

  async createPreview(
    actor: Actor,
    tripId: string,
    input: CreateRoutePreviewRequest,
  ): Promise<RoutePreviewView> {
    requireUuid(tripId, 'tripId');
    requireUuid(input.candidateSnapshotId, 'candidateSnapshotId');
    const basisVersion = positiveInteger(input.basisVersion, 'basisVersion');
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const trip = await this.requireTrip(actor.userId, tripId);
    if (trip.version !== basisVersion) throw versionConflict();
    const snapshot = await this.planningRepository.findSnapshotOwned({
      ownerUserId: actor.userId,
      tripId,
      snapshotId: input.candidateSnapshotId,
    });
    if (snapshot === null) throw notFound();
    if (snapshot.origin.type === 'EXTERNAL_EXECUTION_ORIGIN') {
      const read = this.options.externalOrigins?.readPlanning?.bind(
        this.options.externalOrigins,
      );
      const save = this.planningRepository.createExternalOriginPreview?.bind(
        this.planningRepository,
      );
      if (read === undefined || save === undefined)
        throw new ApplicationError(
          'PREVIEW_UNSUPPORTED',
          '外部执行起点的预览能力尚未配置。',
          422,
        );
      const context = await read({
        ownerUserId: actor.userId,
        tripId,
        externalOriginId: snapshot.origin.externalOriginId,
      });
      if (context === null) throw stalePreview();
      const now = (this.options.clock ?? systemClock).now();
      const previewPayload = buildExternalOriginPreviewPayload({
        trip,
        snapshot,
        context,
        now,
        sameHubWalkingLegIndexes: input.sameHubWalkingLegIndexes,
      });
      const expiresAt = earlier(
        snapshot.expiresAt,
        new Date(now.getTime() + this.options.previewTtlSeconds * 1000),
      );
      const result = await save({
        ownerUserId: actor.userId,
        tripId,
        basisVersion,
        snapshotId: snapshot.id,
        expectedCandidateHash: snapshot.candidateHash,
        policyVersion: EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION,
        previewPayload,
        previewHash: hashRoutePreviewPayload(previewPayload),
        now,
        createdAt: now,
        expiresAt,
        ...(input.sameHubWalkingLegIndexes === undefined
          ? {}
          : { sameHubWalkingLegIndexes: input.sameHubWalkingLegIndexes }),
      });
      if (result.status === 'NOT_FOUND') throw notFound();
      if (result.status !== 'SUCCESS') throw stalePreview();
      return toPreviewView(result.preview, now);
    }
    if (snapshot.fromNodeId === null) throw stalePreview();
    if (snapshot.basisVersion !== basisVersion) throw stalePreview();

    const now = (this.options.clock ?? systemClock).now();
    assertSnapshotFresh(snapshot, now);
    const candidate = validateSnapshot(snapshot);
    const corridor = requireCurrentCorridor(trip, snapshot);
    const { fromNode, toNode } = corridor;
    const schedule = evaluateRouteReplacementSchedule(
      trip,
      corridor.replacementTransportEdgeIds,
    );
    if (schedule.conflicts.length > 0) throw stalePreview();
    const fromProjection = schedule.nodes.find(
      (node) => node.nodeId === fromNode.id,
    );
    const toProjection = schedule.nodes.find(
      (node) => node.nodeId === toNode.id,
    );
    if (fromProjection === undefined || toProjection === undefined) {
      throw stalePreview();
    }
    const bounds = {
      earliestDeparture: laterNullable(
        snapshot.queryTimeCondition.hardEarliestDeparture === null
          ? null
          : new Date(snapshot.queryTimeCondition.hardEarliestDeparture),
        fromProjection.departure.requirementWindow.earliestBasis.some(
          (basis) => basis.ruleId !== 'MIN_DWELL_FORWARD',
        )
          ? fromProjection.departure.requirementWindow.earliest
          : null,
      ),
      latestArrival: earlierNullable(
        snapshot.queryTimeCondition.hardLatestArrival === null
          ? null
          : new Date(snapshot.queryTimeCondition.hardLatestArrival),
        toProjection.arrival.requirementWindow.latest,
      ),
    };
    if (!validateRouteCandidate(candidate, bounds).accepted) {
      throw stalePreview();
    }

    const candidateView = toCandidateView(snapshot);
    const changeSummary = buildChangeSummary(
      candidate,
      snapshot,
      trip,
      corridor,
      normalizeSameHubConfirmations(
        input.sameHubWalkingLegIndexes,
        candidate.legs.length,
      ),
      schedule,
    );
    const expiresAt = earlier(
      snapshot.expiresAt,
      new Date(now.getTime() + this.options.previewTtlSeconds * 1_000),
    );
    if (expiresAt <= now) throw stalePreview();
    const previewPayload: StoredRoutePreviewPayload = {
      tripId,
      basisVersion,
      candidateSnapshotId: snapshot.id,
      candidateHash: snapshot.candidateHash,
      policyVersion: ROUTE_PREVIEW_POLICY_VERSION,
      currentConnection: {
        fromNodeId: snapshot.fromNodeId,
        toNodeId: snapshot.toNodeId,
        state: corridor.currentTransports.length === 0 ? 'MISSING' : 'ACTIVE',
        transport:
          corridor.currentTransports[0] === undefined
            ? null
            : {
                id: corridor.currentTransports[0].id,
                mode: corridor.currentTransports[0].mode,
                fixedService: corridor.currentTransports[0].fixedService,
                serviceLabel: corridor.currentTransports[0].serviceLabel,
              },
      },
      candidate: candidateView,
      changeSummary,
    };
    const created = await this.planningRepository.createPreview({
      ownerUserId: actor.userId,
      tripId,
      basisVersion,
      snapshotId: snapshot.id,
      expectedCandidateHash: snapshot.candidateHash,
      fromNodeId: snapshot.fromNodeId,
      toNodeId: snapshot.toNodeId,
      policyVersion: ROUTE_PREVIEW_POLICY_VERSION,
      previewPayload,
      previewHash: hashRoutePreviewPayload(previewPayload),
      now,
      createdAt: now,
      expiresAt,
    });
    switch (created.status) {
      case 'NOT_FOUND':
        throw notFound();
      case 'VERSION_CONFLICT':
        throw versionConflict();
      case 'PREVIEW_UNSUPPORTED':
        throw new ApplicationError(
          'PREVIEW_UNSUPPORTED',
          '外部执行起点暂不支持 Preview。',
          422,
        );
      case 'NOT_ADJACENT':
      case 'PREVIEW_STALE':
        throw stalePreview();
      case 'SUCCESS':
        return toPreviewView(created.preview, now);
    }
  }

  async getPreview(
    actor: Actor,
    tripId: string,
    previewId: string,
  ): Promise<RoutePreviewView> {
    requireUuid(tripId, 'tripId');
    requireUuid(previewId, 'previewId');
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const preview = await this.planningRepository.findPreviewOwned({
      ownerUserId: actor.userId,
      tripId,
      previewId,
    });
    if (preview === null) throw notFound();
    return toPreviewView(preview, (this.options.clock ?? systemClock).now());
  }

  private async requireTrip(
    ownerUserId: string,
    tripId: string,
  ): Promise<TripAggregateRecord> {
    const trip = await this.tripRepository.findOwnedById({
      ownerUserId,
      tripId,
    });
    if (trip === null) throw notFound();
    return trip;
  }
}

const SUPPORTED_ROUTE_PREVIEW_POLICIES = new Set([
  ROUTE_PREVIEW_POLICY_VERSION,
  EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION,
  LEGACY_EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION,
]);

function toPreviewView(
  preview: {
    readonly id: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly previewPayload: StoredRoutePreviewPayload;
  },
  now: Date,
): RoutePreviewView {
  const superseded = !SUPPORTED_ROUTE_PREVIEW_POLICIES.has(
    preview.previewPayload.policyVersion,
  );
  const expired = preview.expiresAt <= now;
  const blocked =
    (preview.previewPayload.changeSummary.protectedBlockingTransportEdgeIds
      ?.length ?? 0) > 0 ||
    (preview.previewPayload.changeSummary.protectedBlockingNodes?.length ?? 0) >
      0 ||
    preview.previewPayload.changeSummary.downstreamImpact?.status ===
      'INFEASIBLE';
  const status = superseded
    ? ('SUPERSEDED_POLICY' as const)
    : expired
      ? ('EXPIRED' as const)
      : blocked
        ? ('BLOCKED' as const)
        : preview.previewPayload.policyVersion ===
            LEGACY_EXTERNAL_ROUTE_PREVIEW_POLICY_VERSION
          ? ('ADOPT_UNSUPPORTED' as const)
          : ('ACTIVE' as const);
  return {
    ...preview.previewPayload,
    previewId: preview.id,
    createdAt: preview.createdAt.toISOString(),
    expiresAt: preview.expiresAt.toISOString(),
    adoptable: status === 'ACTIVE',
    status,
  };
}
function notFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', '路线预览资源不存在。', 404);
}

function versionConflict(): ApplicationError {
  return new ApplicationError(
    'VERSION_CONFLICT',
    '行程版本已变化，请重新查询路线。',
    409,
  );
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
  return value;
}

function requireUuid(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new ApplicationError('VALIDATION_ERROR', `${field} 无效。`, 400);
  }
}

function requireTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 604_800) {
    throw new Error('previewTtlSeconds must be 1..604800');
  }
}
