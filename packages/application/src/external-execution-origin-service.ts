import { createHash } from 'node:crypto';
import {
  assessGroundTransitOperational,
  isValidResolvedTransitHub,
  resolveExternalTransitHubIdentity,
  resolveExternalExecutionOriginCurrentness,
} from '@travel/domain';
import type {
  ConfirmExternalOriginRequest,
  DepartExternalOriginRequest,
  ExternalExecutionOriginView,
  ExternalOriginResponse,
} from '@travel/contracts';
import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type {
  ExternalExecutionOriginRepository,
  ExternalOriginContext,
  ExternalOriginRecord,
  GroundTransitHubResolver,
} from './external-execution-origin-ports.js';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function externalOriginView(
  origin: ExternalOriginRecord,
  context: ExternalOriginContext,
): ExternalExecutionOriginView {
  return {
    id: origin.id,
    tripId: origin.tripId,
    kind: origin.kind,
    provider: origin.provider,
    providerHubRef: origin.providerHubRef,
    canonicalHubRef: origin.canonicalHubRef,
    name: origin.name,
    latitude: origin.latitude,
    longitude: origin.longitude,
    timeZone: origin.timeZone,
    sourceAdoptedRouteId: origin.sourceAdoptedRouteId,
    sourceTransportEdgeId: origin.sourceTransportEdgeId,
    sourceGroundTransitLegExecutionId: origin.sourceGroundTransitLegExecutionId,
    sourceGroundTransitObservationId: origin.sourceGroundTransitObservationId,
    sourceObservationIdentity: origin.sourceObservationIdentity,
    sourceObservationFactsHash: origin.sourceObservationFactsHash,
    status: origin.status,
    confirmationSource: 'MANUAL',
    sourceObservationFetchedAt: origin.sourceObservationFetchedAt.toISOString(),
    arrivedAt: origin.arrivedAt.toISOString(),
    departedAt: origin.departedAt?.toISOString() ?? null,
    invalidatedAt: origin.invalidatedAt?.toISOString() ?? null,
    currentness: resolveExternalExecutionOriginCurrentness({
      origin,
      origins: context.origins,
      executionEvents: context.executionEvents,
      frontierState: context.frontierState,
    }),
  };
}
export class ExternalExecutionOriginService {
  constructor(
    private readonly repository: ExternalExecutionOriginRepository,
    private readonly resolver: GroundTransitHubResolver,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async candidate(context: ExternalOriginContext) {
    const leg = context.leg;
    const identity = resolveExternalTransitHubIdentity({
      current: leg?.current ?? false,
      baseline: leg?.baseline ?? null,
      observation: leg?.latestObservation ?? null,
      assessment:
        leg?.baseline == null
          ? null
          : assessGroundTransitOperational({
              baseline: leg.baseline,
              previousObservation: leg.previousObservation ?? null,
              latestObservation: leg.latestObservation,
              attentionState: leg.attentionState ?? null,
              now: this.now(),
              state: leg.state,
              current: leg.current,
              availableAtBoarding: leg.availableAtBoarding ?? null,
              actualServiceDeparture: leg.actualServiceDeparture ?? null,
              downstreamProtectedDeparture:
                leg.downstreamProtectedDeparture ?? null,
            }),
      itineraryHubs: context.itineraryHubs,
    });
    if (identity.status !== 'ELIGIBLE')
      return {
        availability: identity.status,
        reason: identity.reason,
        candidate: null,
      } as const;
    if (context.evidence === null || leg === null)
      return {
        availability: 'UNRESOLVED',
        reason: 'ACCEPTED_OBSERVATION_UNRESOLVED',
        candidate: null,
      } as const;
    let resolved: Awaited<ReturnType<GroundTransitHubResolver['resolveHub']>>;
    try {
      resolved = await this.resolver.resolveHub(identity);
    } catch {
      return {
        availability: 'UNRESOLVED',
        reason: 'HUB_RESOLVER_UNAVAILABLE',
        candidate: null,
      } as const;
    }
    if (resolved.status !== 'RESOLVED')
      return {
        availability: 'UNRESOLVED',
        reason: `HUB_RESOLVER_${resolved.status}`,
        candidate: null,
      } as const;
    if (
      !isValidResolvedTransitHub(
        resolved.hub,
        identity.provider,
        identity.providerHubRef,
      )
    )
      return {
        availability: 'UNRESOLVED',
        reason: 'HUB_RESOLVER_METADATA_INVALID',
        candidate: null,
      } as const;
    const candidate = {
      provider: resolved.hub.provider,
      providerHubRef: resolved.hub.providerHubRef,
      canonicalHubRef: resolved.hub.canonicalHubRef,
      name: resolved.hub.name,
      latitude: resolved.hub.latitude,
      longitude: resolved.hub.longitude,
      timeZone: resolved.hub.timeZone,
      sourceAdoptedRouteId: leg.adoptedRouteId,
      sourceTransportEdgeId: leg.transportEdgeId,
      sourceGroundTransitLegExecutionId: leg.id,
      sourceGroundTransitObservationId: context.evidence.id,
      sourceObservationIdentity: context.evidence.identity,
      sourceObservationFetchedAt: context.evidence.fetchedAt.toISOString(),
      sourceObservationFactsHash: context.evidence.factsHash,
    };
    const candidateRef = digest([
      'external-origin-candidate-v1',
      context.tripId,
      context.tripVersion,
      candidate.sourceAdoptedRouteId,
      candidate.sourceTransportEdgeId,
      candidate.sourceGroundTransitLegExecutionId,
      candidate.sourceGroundTransitObservationId,
      candidate.sourceObservationIdentity,
      candidate.sourceObservationFetchedAt,
      candidate.sourceObservationFactsHash,
      candidate.provider,
      candidate.providerHubRef,
      candidate.canonicalHubRef,
      candidate.name,
      candidate.latitude,
      candidate.longitude,
      candidate.timeZone,
    ]);
    return {
      availability: 'CONFIRMATION_REQUIRED',
      reason: 'EXTERNAL_EXECUTION_ORIGIN_CONFIRMATION_REQUIRED',
      candidate: { ...candidate, candidateRef },
    } as const;
  }
  async get(
    actor: Actor,
    tripId: string,
    transportEdgeId: string,
  ): Promise<ExternalOriginResponse> {
    ids(actor, 'READ_PRIVATE_RESOURCE', tripId, transportEdgeId);
    const context = await this.repository.read({
      ownerUserId: actor.userId,
      tripId,
      transportEdgeId,
    });
    if (context === null || context.leg === null)
      throw new ApplicationError('NOT_FOUND', '地面交通执行记录不存在。', 404);
    const result = await this.candidate(context);
    // Arrival timestamps can tie at storage precision. Prefer the one open
    // record rather than allowing UUID order to hide it behind departed history.
    const latest =
      context.origins.find((origin) => origin.status === 'ARRIVED') ??
      context.origins[0];
    const currentOrigin =
      latest === undefined ? null : externalOriginView(latest, context);
    // Historical evidence is independent of subsequent provider recovery.
    return {
      tripId,
      sourceTransportEdgeId: transportEdgeId,
      availability:
        currentOrigin?.currentness === 'CURRENT'
          ? 'CONFIRMED'
          : currentOrigin?.currentness === 'CONFLICT'
            ? 'UNRESOLVED'
            : result.availability,
      reasonCodes:
        currentOrigin?.currentness === 'CURRENT'
          ? ['EXTERNAL_EXECUTION_ORIGIN_AVAILABLE']
          : currentOrigin?.currentness === 'CONFLICT'
            ? ['EXTERNAL_ORIGIN_CONFLICT']
            : [result.reason],
      candidate: result.candidate,
      currentOrigin,
    };
  }
  async confirm(
    actor: Actor,
    tripId: string,
    transportEdgeId: string,
    input: ConfirmExternalOriginRequest,
  ) {
    ids(actor, 'WRITE_PRIVATE_RESOURCE', tripId, transportEdgeId);
    validateMutation(input);
    if (!/^[0-9a-f]{64}$/u.test(input.candidateRef))
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'candidateRef 无效。',
        400,
      );
    return this.repository.mutate({
      ownerUserId: actor.userId,
      tripId,
      transportEdgeId,
      originId: null,
      action: 'ARRIVAL',
      ...input,
      requestHash: digest([
        'external-origin-arrival-v1',
        tripId,
        transportEdgeId,
        input.baseTripVersion,
        input.candidateRef,
      ]),
      now: this.now(),
      revalidate: async (context) => {
        const result = await this.candidate(context);
        if (
          result.candidate === null ||
          result.candidate.candidateRef !== input.candidateRef
        )
          throw new ApplicationError(
            'EXTERNAL_ORIGIN_CANDIDATE_STALE',
            '外部站点候选已变化，请重新确认。',
            409,
          );
        return result.candidate;
      },
    });
  }
  async depart(
    actor: Actor,
    tripId: string,
    originId: string,
    input: DepartExternalOriginRequest,
  ) {
    ids(actor, 'WRITE_PRIVATE_RESOURCE', tripId, originId);
    validateMutation(input);
    return this.repository.mutate({
      ownerUserId: actor.userId,
      tripId,
      transportEdgeId: null,
      originId,
      action: 'DEPARTURE',
      ...input,
      requestHash: digest([
        'external-origin-departure-v1',
        tripId,
        originId,
        input.baseTripVersion,
      ]),
      now: this.now(),
      revalidate: async () => {
        throw new Error('Departure does not resolve a candidate');
      },
    });
  }
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function ids(
  actor: Actor,
  action: 'READ_PRIVATE_RESOURCE' | 'WRITE_PRIVATE_RESOURCE',
  ...values: string[]
) {
  if (values.some((value) => !UUID.test(value)))
    throw new ApplicationError('VALIDATION_ERROR', 'id 无效。', 400);
  authorize(actor, action, {
    kind: 'PRIVATE_RESOURCE',
    ownerUserId: actor.userId,
  });
}
function validateMutation(input: DepartExternalOriginRequest) {
  if (
    !Number.isSafeInteger(input.baseTripVersion) ||
    input.baseTripVersion < 1 ||
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.trim() === '' ||
    input.idempotencyKey.length > 200
  )
    throw new ApplicationError('VALIDATION_ERROR', '版本或幂等键无效。', 400);
}
