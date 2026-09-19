import type {
  CreateRoutePreviewRequest,
  RouteCandidateView,
  RouteLocationView,
  RoutePreviewLocationView,
  RoutePreviewSegmentView,
  RoutePreviewView,
} from '@travel/contracts';
import {
  validateRouteCandidate,
  type NormalizedRouteCandidate,
} from '@travel/domain';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import {
  systemClock,
  type Clock,
  type RouteCandidateSnapshotRecord,
  type RoutePlanningRepository,
  type StoredRoutePreviewPayload,
} from './route-planning-ports.js';
import {
  hashRouteCandidateSnapshot,
  restoreNormalizedCandidate,
} from './route-snapshot.js';
import {
  evaluateTripScheduleRecord,
  orderedTripNodes,
} from './schedule-evaluation.js';
import { validateIanaTimeZoneInput } from './time-input.js';
import type {
  TransportEdgeRecord,
  TripAggregateRecord,
  TripRepository,
} from './trip-ports.js';

const POLICY_VERSION = 'route-adoption-preview-v1';

export interface RoutePreviewServiceOptions {
  readonly previewTtlSeconds: number;
  readonly clock?: Clock;
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
    if (snapshot.basisVersion !== basisVersion) throw stalePreview();

    const now = (this.options.clock ?? systemClock).now();
    assertSnapshotFresh(snapshot, now);
    const candidate = validateSnapshot(snapshot);
    const { fromNode, toNode } = requireCurrentAdjacency(trip, snapshot);
    const schedule = evaluateTripScheduleRecord(trip);
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
      earliestDeparture:
        fromProjection.departure.requirementWindow.earliest === null
          ? null
          : new Date(fromProjection.departure.requirementWindow.earliest),
      latestArrival:
        toProjection.arrival.requirementWindow.latest === null
          ? null
          : new Date(toProjection.arrival.requirementWindow.latest),
    };
    if (!validateRouteCandidate(candidate, bounds).accepted) {
      throw stalePreview();
    }

    const currentTransport = trip.transportEdges.find(
      (edge) =>
        edge.fromNodeId === snapshot.fromNodeId &&
        edge.toNodeId === snapshot.toNodeId,
    );
    const candidateView = toCandidateView(snapshot);
    const changeSummary = buildChangeSummary(candidate, currentTransport);
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
      policyVersion: POLICY_VERSION,
      currentConnection: {
        fromNodeId: snapshot.fromNodeId,
        toNodeId: snapshot.toNodeId,
        state: currentTransport === undefined ? 'MISSING' : 'ACTIVE',
        transport:
          currentTransport === undefined
            ? null
            : {
                id: currentTransport.id,
                mode: currentTransport.mode,
                fixedService: currentTransport.fixedService,
                serviceLabel: currentTransport.serviceLabel,
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
      policyVersion: POLICY_VERSION,
      previewPayload,
      now,
      createdAt: now,
      expiresAt,
    });
    switch (created.status) {
      case 'NOT_FOUND':
        throw notFound();
      case 'VERSION_CONFLICT':
        throw versionConflict();
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

function validateSnapshot(
  snapshot: RouteCandidateSnapshotRecord,
): NormalizedRouteCandidate {
  const hash = hashRouteCandidateSnapshot({
    tripId: snapshot.tripId,
    basisVersion: snapshot.basisVersion,
    fromNodeId: snapshot.fromNodeId,
    toNodeId: snapshot.toNodeId,
    provider: snapshot.provider,
    observedAt: snapshot.observedAt.toISOString(),
    candidatePayload: snapshot.candidatePayload,
  });
  if (hash !== snapshot.candidateHash) throw stalePreview();
  try {
    const candidate = restoreNormalizedCandidate(snapshot.candidatePayload);
    if (
      candidate.provider !== snapshot.provider ||
      candidate.providerCandidateRef !== snapshot.providerCandidateRef ||
      candidate.observedAt.getTime() !== snapshot.observedAt.getTime() ||
      candidate.validUntil?.getTime() !==
        snapshot.providerValidUntil?.getTime() ||
      !candidateUsesSupportedZones(candidate) ||
      !validateRouteCandidate(candidate, {
        earliestDeparture: null,
        latestArrival: null,
      }).accepted
    ) {
      throw stalePreview();
    }
    return candidate;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw stalePreview();
  }
}

function requireCurrentAdjacency(
  trip: TripAggregateRecord,
  snapshot: RouteCandidateSnapshotRecord,
) {
  const nodes = orderedTripNodes(trip);
  const fromIndex = nodes.findIndex((node) => node.id === snapshot.fromNodeId);
  const fromNode = nodes[fromIndex];
  const toNode = nodes[fromIndex + 1];
  if (
    fromIndex < 0 ||
    fromNode?.kind !== 'PLACE_VISIT' ||
    toNode?.id !== snapshot.toNodeId ||
    toNode.kind !== 'PLACE_VISIT'
  ) {
    throw stalePreview();
  }
  return { fromNode, toNode };
}

function buildChangeSummary(
  candidate: NormalizedRouteCandidate,
  currentTransport: TransportEdgeRecord | undefined,
): RoutePreviewView['changeSummary'] {
  const transferPoints: RoutePreviewLocationView[] = [];
  for (let index = 0; index + 1 < candidate.legs.length; index += 1) {
    const incoming = candidate.legs[index];
    const outgoing = candidate.legs[index + 1];
    if (
      incoming === undefined ||
      outgoing === undefined ||
      !sameTransferLocation(incoming.to, outgoing.from)
    ) {
      throw previewUnsupported('路线候选的换乘点不连续。');
    }
    if (incoming.to.latitude === null || incoming.to.longitude === null) {
      throw previewUnsupported('路线候选的换乘点缺少可定位坐标。');
    }
    transferPoints.push({ ...incoming.to, ref: `TRANSFER_${index}` });
  }
  const proposedSegments: RoutePreviewSegmentView[] = candidate.legs.map(
    (leg, index) => ({
      fromRef: index === 0 ? 'FROM_NODE' : `TRANSFER_${index - 1}`,
      toRef:
        index === candidate.legs.length - 1 ? 'TO_NODE' : `TRANSFER_${index}`,
      mode: leg.mode,
      fixedService: leg.fixedService,
      serviceLabel: leg.serviceLabel,
      providerRef: leg.providerRef,
      departure: toNullableTimePoint(leg.departure),
      arrival: toNullableTimePoint(leg.arrival),
      durationSeconds: leg.durationSeconds,
    }),
  );
  return {
    transportAction: currentTransport === undefined ? 'CREATE' : 'REPLACE',
    willReplaceTransportEdgeId: currentTransport?.id ?? null,
    requiresGeneratedNodes: transferPoints.length > 0,
    generatedTransferPoints: transferPoints,
    proposedSegments,
    temporalLayer: 'PLANNED',
    temporalSourceKind: 'ADOPTED_TRANSPORT_FACT',
  };
}

function sameTransferLocation(
  left: RouteLocationView,
  right: RouteLocationView,
): boolean {
  if (left.providerPlaceRef !== null && right.providerPlaceRef !== null) {
    return left.providerPlaceRef === right.providerPlaceRef;
  }
  return (
    left.latitude !== null &&
    left.longitude !== null &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude
  );
}

function toCandidateView(
  snapshot: RouteCandidateSnapshotRecord,
): RouteCandidateView {
  return {
    ...snapshot.candidatePayload,
    candidateSnapshotId: snapshot.id,
    snapshotExpiresAt: snapshot.expiresAt.toISOString(),
  };
}

function toNullableTimePoint(
  point: { readonly instant: Date; readonly timeZone: string } | null,
) {
  return point === null
    ? null
    : { instant: point.instant.toISOString(), timeZone: point.timeZone };
}

function candidateUsesSupportedZones(
  candidate: NormalizedRouteCandidate,
): boolean {
  try {
    validateIanaTimeZoneInput(candidate.departure.timeZone);
    validateIanaTimeZoneInput(candidate.arrival.timeZone);
    for (const leg of candidate.legs) {
      if (leg.departure !== null) {
        validateIanaTimeZoneInput(leg.departure.timeZone);
      }
      if (leg.arrival !== null) {
        validateIanaTimeZoneInput(leg.arrival.timeZone);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function assertSnapshotFresh(
  snapshot: RouteCandidateSnapshotRecord,
  now: Date,
): void {
  if (
    snapshot.expiresAt <= now ||
    (snapshot.providerValidUntil !== null && snapshot.providerValidUntil <= now)
  ) {
    throw stalePreview();
  }
}

function toPreviewView(
  preview: {
    readonly id: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
    readonly previewPayload: StoredRoutePreviewPayload;
  },
  now: Date,
): RoutePreviewView {
  const active = preview.expiresAt > now;
  return {
    ...preview.previewPayload,
    previewId: preview.id,
    createdAt: preview.createdAt.toISOString(),
    expiresAt: preview.expiresAt.toISOString(),
    adoptable: active,
    status: active ? 'ACTIVE' : 'EXPIRED',
  };
}

function earlier(left: Date, right: Date): Date {
  return left < right ? left : right;
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

function stalePreview(): ApplicationError {
  return new ApplicationError(
    'PREVIEW_STALE',
    '路线候选已过期或不再满足当前安全条件。',
    409,
  );
}

function previewUnsupported(message: string): ApplicationError {
  return new ApplicationError('PREVIEW_UNSUPPORTED', message, 422);
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
