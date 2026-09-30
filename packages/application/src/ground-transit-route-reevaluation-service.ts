import type { GroundTransitRouteReevaluationHandoffView } from '@travel/contracts';
import {
  assessGroundTransitOperational,
  resolveGroundTransitRouteReevaluationHandoff,
} from '@travel/domain';

import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type { GroundTransitRepository } from './ground-transit-ports.js';
import { resolveCurrentRouteCorridor } from './route-corridor.js';
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
            fromNodeId: route!.anchorFromNodeId,
            corridorNodeIds: corridor!.nodes.map((node) => node.id),
          })
        : false;
    const decision = resolveGroundTransitRouteReevaluationHandoff({
      requiredAction: operational?.requiredAction ?? 'NONE',
      routeCurrent,
      operationalKnown: operational !== null,
      corridorResolved,
      legExecutionState: leg.state,
      independentExecutionProgress,
      basisVersion: trip.version,
      fromNodeId: route?.anchorFromNodeId ?? '',
      toNodeId: route?.anchorToNodeId ?? '',
      timeZone:
        corridor === null
          ? null
          : corridorTimeZone(corridor.currentTransports, corridor.nodes),
      now: this.now(),
    });
    return {
      tripId,
      sourceTransportEdgeId: transportEdgeId,
      adoptedRouteId: leg.adoptedRouteId,
      readiness: decision.readiness,
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
    };
  }
}

function corridorTimeZone(
  edges: readonly TransportEdgeRecord[],
  nodes: readonly ItineraryNodeRecord[],
): string | null {
  const zoneCandidates = [
    ...edges.flatMap((edge) =>
      (['PLANNED', 'ESTIMATED'] as const).flatMap((layer) =>
        edge.timeValues
          .filter(
            (value) => value.pointKind === 'DEPARTURE' && value.layer === layer,
          )
          .map((value) => value.timeZone),
      ),
    ),
    ...nodes[0]!.timeIntents.map((intent) => intent.timeZone),
    ...nodes[0]!.timeValues.map((value) => value.timeZone),
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
