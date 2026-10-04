import type {
  ControlledAlternativeSearchRequest,
  ControlledAlternativeSearchResponse,
  GroundTransitRouteReevaluationHandoffView,
} from '@travel/contracts';
import type { Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type { GroundTransitRouteReevaluationService } from './ground-transit-route-reevaluation-service.js';
import type { RouteQueryService } from './route-query-service.js';

/** Authorization glue only. The existing query/preview/adoption services own planning. */
export class ControlledAlternativeSearchService {
  constructor(
    private readonly reevaluation: Pick<
      GroundTransitRouteReevaluationService,
      'getHandoff'
    >,
    private readonly routes: Pick<
      RouteQueryService,
      'queryRoutes' | 'queryExternalOriginRoutes'
    >,
  ) {}

  async search(
    actor: Actor,
    tripId: string,
    input: ControlledAlternativeSearchRequest,
  ): Promise<ControlledAlternativeSearchResponse> {
    const expected = input.handoff;
    const identity = handoffPlanningIdentity(expected);
    if (identity === null || expected.tripId !== tripId) throw stale();
    const current = await this.reevaluation.getHandoff(
      actor,
      tripId,
      expected.sourceTransportEdgeId,
    );
    if (handoffPlanningIdentity(current) !== identity) throw stale();
    // The server reissues its trusted time hint; the client cannot change bounds,
    // location or timezone. Query still applies its normal locked persistence checks.
    const result = current.externalQuery
      ? await this.routes.queryExternalOriginRoutes(
          actor,
          tripId,
          current.externalQuery.externalOriginId,
          current.externalQuery,
        )
      : await this.routes.queryRoutes(actor, tripId, current.query!);
    const after = await this.reevaluation.getHandoff(
      actor,
      tripId,
      current.sourceTransportEdgeId,
    );
    if (handoffPlanningIdentity(after) !== identity) throw stale();
    return { handoff: current, result };
  }
}

/** Ignore only the advancing server-now instant, never authorization or query identity. */
export function handoffPlanningIdentity(
  h: GroundTransitRouteReevaluationHandoffView,
): string | null {
  if (!h || h.readiness !== 'READY' || !!h.query === !!h.externalQuery)
    return null;
  const q = h.query ?? h.externalQuery!;
  if (
    !Number.isSafeInteger(q.basisVersion) ||
    q.basisVersion < 1 ||
    typeof q.toNodeId !== 'string'
  )
    return null;
  return JSON.stringify({
    tripId: h.tripId,
    planningFactsHash: h.planningFactsHash ?? null,
    edge: h.sourceTransportEdgeId,
    route: h.adoptedRouteId,
    originBasis: h.originBasis ?? null,
    externalOriginStatus: h.externalOriginStatus ?? null,
    reasonCodes: [...h.reasonCodes].sort(),
    basisVersion: q.basisVersion,
    from: h.query?.fromNodeId ?? h.externalQuery?.externalOriginId,
    external: !!h.externalQuery,
    to: q.toNodeId,
    hint: q.hint
      ? {
          type: q.hint.type,
          timeZone: q.hint.timeZone,
          // ARRIVE_BY is a real upper bound, not an advancing now hint.
          ...(q.hint.type === 'ARRIVE_BY' ? { instant: q.hint.instant } : {}),
        }
      : null,
  });
}
function stale() {
  return new ApplicationError(
    'VERSION_CONFLICT',
    '重新规划入口已变化，请重新读取影响并核验起点。',
    409,
  );
}
