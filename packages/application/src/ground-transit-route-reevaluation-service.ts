import { hashRoutePlanningReadBasis } from './route-snapshot.js';
import type { GroundTransitRouteReevaluationHandoffView } from '@travel/contracts';
import {
  resolveExternalOriginRouteQueryAuthorization,
  assessGroundTransitOperational,
  resolveGroundTransitRouteReevaluationHandoff,
} from '@travel/domain';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type { ExternalExecutionOriginService } from './external-execution-origin-service.js';
import type { GroundTransitRepository } from './ground-transit-ports.js';
import { resolveCurrentRouteCorridor } from './route-corridor.js';
import { resolveConfirmedRouteExecutionOriginForTrip } from './confirmed-route-execution-origin.js';
import { orderedTripNodes } from './schedule-evaluation.js';
import { validateIanaTimeZoneInput } from './time-input.js';
import type {
  ItineraryNodeRecord,
  TransportEdgeRecord,
  TripRepository,
} from './trip-ports.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface GroundTransitRouteProgressRepository {
  hasIndependentProgress(input: {
    readonly ownerUserId: string;
    readonly tripId: string;
    readonly legExecutionId: string;
    readonly fromNodeId: string;
    readonly corridorNodeIds: readonly string[];
  }): Promise<boolean>;
}

/** Read-only glue between accepted execution facts and the existing route query. */
export class GroundTransitRouteReevaluationService {
  constructor(
    private readonly trips: TripRepository,
    private readonly groundTransit: GroundTransitRepository,
    private readonly progress: GroundTransitRouteProgressRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly externalOrigins?: ExternalExecutionOriginService,
  ) {}

  async getHandoff(
    actor: Actor,
    tripId: string,
    transportEdgeId: string,
  ): Promise<GroundTransitRouteReevaluationHandoffView> {
    if (!UUID.test(tripId) || !UUID.test(transportEdgeId)) {
      throw new ApplicationError('VALIDATION_ERROR', 'id 无效。', 400);
    }
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const [trip, execution] = await Promise.all([
      this.trips.findOwnedById({ ownerUserId: actor.userId, tripId }),
      this.groundTransit.listOwned({ ownerUserId: actor.userId, tripId }),
    ]);
    if (trip === null || execution === null) throw notFound();
    const leg = execution.legs.find(
      (candidate) => candidate.transportEdgeId === transportEdgeId,
    );
    if (leg === undefined) throw notFound();

    const route = trip.adoptedRoutes?.find(
      (candidate) => candidate.id === leg.adoptedRouteId,
    );
    const ordered = orderedTripNodes(trip);
    const fromIndex = ordered.findIndex(
      (node) => node.id === route?.anchorFromNodeId,
    );
    const toIndex = ordered.findIndex(
      (node) => node.id === route?.anchorToNodeId,
    );
    const corridor =
      route === undefined
        ? null
        : resolveCurrentRouteCorridor(trip, ordered, fromIndex, toIndex);
    const routeCurrent =
      leg.current &&
      route?.status === 'ACTIVE' &&
      trip.transportEdges.some(
        (edge) =>
          edge.id === transportEdgeId &&
          edge.source === 'ADOPTED_ROUTE' &&
          edge.adoptedRouteId === route.id,
      );
    const corridorResolved =
      corridor !== null &&
      corridor.currentAdoptedRouteId === leg.adoptedRouteId &&
      corridor.currentTransports.some((edge) => edge.id === transportEdgeId);
    const operational =
      leg.baseline === null
        ? null
        : assessGroundTransitOperational({
            baseline: leg.baseline,
            previousObservation: leg.previousObservation ?? null,
            latestObservation: leg.latestObservation,
            attentionState: leg.attentionState ?? null,
            now: this.now(),
            state: leg.state,
            current: routeCurrent,
            availableAtBoarding: leg.availableAtBoarding ?? null,
            actualServiceDeparture: leg.actualServiceDeparture ?? null,
            downstreamProtectedDeparture:
              leg.downstreamProtectedDeparture ?? null,
          });
    const independentExecutionProgress =
      routeCurrent &&
      corridorResolved &&
      operational?.requiredAction === 'ROUTE_REEVALUATION_REQUIRED'
        ? await this.progress.hasIndependentProgress({
            ownerUserId: actor.userId,
            tripId,
            legExecutionId: leg.id,
            fromNodeId: route!.anchorFromNodeId!,
            corridorNodeIds: corridor!.nodes.map((node) => node.id),
          })
        : false;
    const executionOrigin = resolveConfirmedRouteExecutionOriginForTrip(
      trip,
      route?.anchorFromNodeId ?? '',
      route?.anchorToNodeId ?? '',
      independentExecutionProgress,
    );
    const queryOriginNodeId =
      executionOrigin.status === 'CONFIRMED_NODE'
        ? executionOrigin.nodeId
        : (route?.anchorFromNodeId ?? '');
    const decision = resolveGroundTransitRouteReevaluationHandoff({
      requiredAction: operational?.requiredAction ?? 'NONE',
      routeCurrent,
      operationalKnown: operational !== null,
      corridorResolved,
      legExecutionState: leg.state,
      independentExecutionProgress,
      executionOrigin,
      basisVersion: trip.version,
      fromNodeId: route?.anchorFromNodeId ?? '',
      toNodeId: route?.anchorToNodeId ?? '',
      timeZone:
        corridor === null
          ? null
          : resolveRouteOriginTimeZone(
              queryOriginNodeId,
              corridor.currentTransports,
              corridor.nodes,
            ),
      now: this.now(),
    });
    const withPlanningBasis = (
      view: GroundTransitRouteReevaluationHandoffView,
      external: unknown = null,
    ): GroundTransitRouteReevaluationHandoffView => ({
      ...view,
      planningFactsHash: hashRoutePlanningReadBasis({
        tripVersion: trip.version,
        route: route ?? null,
        corridor: corridor?.replacementTransportEdgeIds ?? null,
        leg,
        executionOrigin,
        executionEvents: trip.routeExecutionEvents ?? [],
        external,
      }),
    });
    if (this.externalOrigins !== undefined && routeCurrent) {
      const external = await this.externalOrigins.get(
        actor,
        tripId,
        transportEdgeId,
      );
      const externalOrigin = external.currentOrigin;
      // Trip-level currentness is not provenance for the requested leg.
      const matchesRequestedSource =
        externalOrigin !== null &&
        externalOrigin.sourceTransportEdgeId === transportEdgeId &&
        externalOrigin.sourceGroundTransitLegExecutionId === leg.id &&
        externalOrigin.sourceAdoptedRouteId === leg.adoptedRouteId;
      const externalSourceRoute =
        trip.adoptedRoutes?.find(
          (row) => row.id === externalOrigin?.sourceAdoptedRouteId,
        ) ?? null;
      const externalSourceEdge =
        trip.transportEdges.find(
          (row) => row.id === externalOrigin?.sourceTransportEdgeId,
        ) ?? null;
      if (
        externalOrigin !== null &&
        matchesRequestedSource &&
        externalSourceRoute !== null &&
        resolveExternalOriginRouteQueryAuthorization({
          origin: {
            ...externalOrigin,
            arrivedAt: new Date(externalOrigin.arrivedAt),
            departedAt:
              externalOrigin.departedAt === null
                ? null
                : new Date(externalOrigin.departedAt),
            invalidatedAt:
              externalOrigin.invalidatedAt === null
                ? null
                : new Date(externalOrigin.invalidatedAt),
          },
          currentness: externalOrigin.currentness,
          sourceRoute: externalSourceRoute,
          sourceEdge: externalSourceEdge,
          toNodeId: externalSourceRoute.anchorToNodeId,
        }) === 'AUTHORIZED'
      ) {
        return withPlanningBasis(
          {
            tripId,
            sourceTransportEdgeId: transportEdgeId,
            adoptedRouteId: leg.adoptedRouteId,
            readiness: 'READY',
            originBasis: 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN',
            query: null,
            externalQuery: {
              externalOriginId: externalOrigin.id,
              basisVersion: trip.version,
              toNodeId: externalSourceRoute.anchorToNodeId,
              hint: {
                type: 'DEPART_AT',
                instant: this.now().toISOString(),
                timeZone: externalOrigin.timeZone,
              },
            },
            reasonCodes: ['EXTERNAL_EXECUTION_ORIGIN_AVAILABLE'],
            externalOriginStatus: external.availability,
          },
          externalOrigin,
        );
      }
      if (
        (externalOrigin?.currentness !== 'CURRENT' || matchesRequestedSource) &&
        (external.candidate !== null ||
          external.currentOrigin?.currentness === 'CURRENT' ||
          external.availability === 'UNRESOLVED')
      ) {
        return withPlanningBasis(
          {
            tripId,
            sourceTransportEdgeId: transportEdgeId,
            adoptedRouteId: leg.adoptedRouteId,
            readiness: 'ORIGIN_UNRESOLVED',
            originBasis: null,
            query: null,
            reasonCodes: [
              ...external.reasonCodes,
              'EXTERNAL_ORIGIN_ROUTE_QUERY_UNAVAILABLE',
            ],
            externalOriginStatus: external.availability,
          },
          externalOrigin,
        );
      }
    }
    return withPlanningBasis({
      tripId,
      sourceTransportEdgeId: transportEdgeId,
      adoptedRouteId: leg.adoptedRouteId,
      readiness: decision.readiness,
      originBasis: decision.originBasis,
      reasonCodes: decision.reasonCodes,
      query:
        decision.query === null
          ? null
          : {
              basisVersion: decision.query.basisVersion,
              fromNodeId: decision.query.fromNodeId,
              toNodeId: decision.query.toNodeId,
              hint: {
                ...decision.query.hint,
                instant: decision.query.hint.instant.toISOString(),
              },
            },
    });
  }
}

/** A query hint's zone must be evidenced at its from-node, never downstream. */
export function resolveRouteOriginTimeZone(
  anchorFromNodeId: string,
  edges: readonly Pick<TransportEdgeRecord, 'fromNodeId' | 'timeValues'>[],
  nodes: readonly Pick<
    ItineraryNodeRecord,
    'id' | 'timeValues' | 'timeIntents'
  >[],
): string | null {
  const originNode = nodes.find((node) => node.id === anchorFromNodeId);
  const zoneCandidates = [
    ...edges
      .filter((edge) => edge.fromNodeId === anchorFromNodeId)
      .flatMap((edge) =>
        (['PLANNED', 'ESTIMATED'] as const).flatMap((layer) =>
          edge.timeValues
            .filter(
              (value) =>
                value.pointKind === 'DEPARTURE' && value.layer === layer,
            )
            .map((value) => value.timeZone),
        ),
      ),
    ...(originNode?.timeIntents.map((intent) => intent.timeZone) ?? []),
    ...(originNode?.timeValues.map((value) => value.timeZone) ?? []),
  ];
  for (const zone of zoneCandidates) {
    if (zone === null) continue;
    try {
      return validateIanaTimeZoneInput(zone);
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
    }
  }
  return null;
}

function notFound(): ApplicationError {
  return new ApplicationError('NOT_FOUND', '地面交通执行记录不存在。', 404);
}
