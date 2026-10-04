import type { TripImpactView, TripImpactItemView } from '@travel/contracts';
import { authorize, type Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import { evaluateTripExecutionRisks } from './execution-risk-service.js';
import { evaluateTripScheduleRecord } from './schedule-evaluation.js';
import type { TripRepository } from './trip-ports.js';
import type { GroundTransitRepository } from './ground-transit-ports.js';
import type { GroundTransitService } from './ground-transit-service.js';
import type { GroundTransitRouteReevaluationService } from './ground-transit-route-reevaluation-service.js';
import type { InTripReadService } from './in-trip-read-service.js';

/** Owner-only, bounded by the Trip's current legs. No Provider calls or reconciliation writes. */
export class TripImpactService {
  constructor(
    private readonly trips: TripRepository,
    private readonly ground: GroundTransitRepository,
    private readonly groundService: GroundTransitService,
    private readonly reevaluation: GroundTransitRouteReevaluationService,
    private readonly inTrip: InTripReadService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(actor: Actor, tripId: string): Promise<TripImpactView> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        tripId,
      )
    )
      throw new ApplicationError('VALIDATION_ERROR', '旅行编号无效。', 400);
    authorize(actor, 'READ_PRIVATE_RESOURCE', {
      kind: 'PRIVATE_RESOURCE',
      ownerUserId: actor.userId,
    });
    const owned = { ownerUserId: actor.userId, tripId };
    const trip = await this.trips.findOwnedById(owned);
    if (!trip) throw new ApplicationError('NOT_FOUND', '旅行不存在。', 404);
    const now = this.now();
    const [stored, transit, evidence] = await Promise.all([
      this.ground.listOwned(owned),
      this.groundService.getTrip(actor, tripId),
      this.inTrip.read(actor, tripId),
    ]);
    const stale = () =>
      new ApplicationError(
        'VERSION_CONFLICT',
        '行程事实在读取期间发生变化，请重新载入。',
        409,
      );
    if (
      !stored ||
      stored.tripVersion !== trip.version ||
      transit.tripVersion !== trip.version ||
      evidence.tripVersion !== trip.version
    )
      throw stale();
    if (
      transit.legs.length !== stored.legs.length ||
      transit.legs.some((view) => {
        const row = stored.legs.find((row) => row.id === view.id);
        return (
          !row ||
          row.state !== view.state ||
          row.current !== view.current ||
          row.adoptedRouteId !== view.adoptedRouteId ||
          row.transportEdgeId !== view.transportEdgeId ||
          row.observationCount !== view.observationCount ||
          JSON.stringify(row.latestObservation) !==
            JSON.stringify(view.latestObservation)
        );
      })
    )
      throw stale();
    const nodes = trip.dayOccurrences.flatMap((d) => d.nodes);
    const reliableProgress =
      evidence.execution.recordedAt !== null &&
      Date.parse(evidence.execution.recordedAt) <= now.getTime();
    const progressIndex = nodes.findIndex(
      (n) =>
        n.id ===
        (reliableProgress
          ? (evidence.execution.currentNodeId ??
            evidence.execution.targetNodeId)
          : null),
    );
    const relevantIds = new Set(
      nodes.slice(Math.max(0, progressIndex)).map((n) => n.id),
    );
    const completed =
      reliableProgress && evidence.execution.state === 'COMPLETED';
    const currentLegs = transit.legs.filter(
      (l) =>
        l.current &&
        trip.transportEdges.some(
          (e) =>
            e.id === l.transportEdgeId &&
            e.adoptedRouteId === l.adoptedRouteId &&
            relevantIds.has(e.toNodeId),
        ),
    );
    const handoffs = completed
      ? []
      : await Promise.all(
          currentLegs.map((l) =>
            this.reevaluation.getHandoff(actor, tripId, l.transportEdgeId),
          ),
        );
    if (
      handoffs.some(
        (h) =>
          (h.query?.basisVersion ??
            h.externalQuery?.basisVersion ??
            trip.version) !== trip.version,
      )
    )
      throw stale();
    const items: TripImpactItemView[] = [];
    const add = (item: TripImpactItemView) => items.push(item);
    if (!completed) {
      if (evidence.execution.state === 'INCONSISTENT')
        add({
          nodeId: null,
          transportEdgeId: null,
          status: 'UNKNOWN',
          changed: false,
          title: '当前进度需要核对',
          explanation: '已有用户执行记录不一致，不能确定安全的后续起点。',
        });
      if (nodes.length === 0)
        add({
          nodeId: null,
          transportEdgeId: null,
          status: 'UNKNOWN',
          changed: false,
          title: '尚无可核对的安排',
          explanation: '请先添加安排；当前没有后续计划可判断。',
        });
      const schedule = evaluateTripScheduleRecord(trip);
      for (const n of schedule.nodes.filter((n) => relevantIds.has(n.nodeId))) {
        for (const e of n.evaluations) {
          if (e.status !== 'SATISFIED')
            add({
              nodeId: n.nodeId,
              transportEdgeId: null,
              status: e.status,
              changed: false,
              title:
                e.rule === 'MINIMUM'
                  ? '停留要求需要核对'
                  : '重要时间要求需要核对',
              explanation: e.explanation
                .replaceAll('PLANNED', '计划')
                .replaceAll('ESTIMATED', '预计')
                .replaceAll('ACTUAL', '事实时间'),
            });
        }
        const arrival = n.arrival.effective?.value,
          departure = n.departure.effective?.value;
        if (!arrival || !departure) {
          if (!n.evaluations.some((e) => e.status === 'UNKNOWN'))
            add({
              nodeId: n.nodeId,
              transportEdgeId: null,
              status: 'UNKNOWN',
              changed: false,
              title: '时间信息不足',
              explanation:
                '缺少可靠的到达或出发时间，暂时无法判断这段安排的后续影响。',
            });
        } else {
          const changes = (
            [
              ['到达', n.arrival],
              ['出发', n.departure],
            ] as const
          ).filter(
            ([, p]) =>
              p.effective?.value.layer === 'ESTIMATED' &&
              p.estimated &&
              p.planned &&
              p.estimated.instant.getTime() !== p.planned.instant.getTime(),
          );
          const descriptions = changes.map(
            ([label, p]) =>
              `${label}预计比原计划${p.estimated!.instant > p.planned!.instant ? '晚' : '早'} ${Math.abs(p.estimated!.instant.getTime() - p.planned!.instant.getTime()) / 60000} 分钟`,
          );
          // Display-only comparison, not a feasibility rule or a new minimum.
          const plannedArrival =
            n.arrival.planned?.instant ??
            n.anchors.find((a) => a.pointKind === 'ARRIVAL')?.value.instant;
          const plannedDeparture =
            n.departure.planned?.instant ??
            n.anchors.find((a) => a.pointKind === 'DEPARTURE')?.value.instant;
          const lostDwell =
            plannedArrival && plannedDeparture && n.dwellSeconds !== null
              ? (plannedDeparture.getTime() - plannedArrival.getTime()) / 1000 -
                n.dwellSeconds
              : null;
          add({
            nodeId: n.nodeId,
            transportEdgeId: null,
            status: 'SATISFIED',
            changed: changes.length > 0,
            title: changes.length ? '时间有变化' : '已核对安排时间',
            explanation: descriptions.length
              ? `${descriptions.join('；')}。${lostDwell !== null && lostDwell > 0 ? `预计停留时间缩短 ${lostDwell / 60} 分钟。` : ''}${n.dwellSeconds !== null ? `当前停留 ${n.dwellSeconds / 60} 分钟。` : ''}${n.evaluations.length && n.evaluations.every((e) => e.status === 'SATISFIED') ? '当前时间要求仍满足。' : '未发现该安排已有时间要求的冲突。'}`
              : '未发现该安排已有时间要求的冲突。',
          });
        }
      }
      for (const c of schedule.conflicts)
        if (relevantIds.has(c.nodeId))
          add({
            nodeId: c.nodeId,
            transportEdgeId: null,
            status: 'CONFLICT',
            changed: false,
            title: '后续时间约束无法同时满足',
            explanation: c.explanation,
          });
      for (const r of evaluateTripExecutionRisks(trip, stored.legs, now)) {
        if (r.protectedNodeId && !relevantIds.has(r.protectedNodeId)) continue;
        add({
          nodeId: r.protectedNodeId ?? r.sourceNodeId,
          transportEdgeId:
            r.protectedTransportEdgeId ?? r.sourceTransportEdgeId,
          status:
            r.severity === 'INFEASIBLE'
              ? 'VIOLATED'
              : r.severity === 'UNKNOWN'
                ? 'UNKNOWN'
                : 'SATISFIED',
          changed: r.severity === 'EXECUTABLE_RISK',
          title:
            r.kind === 'FIXED_SERVICE_MISSED'
              ? '按当前可靠时间赶不上已选交通'
              : '后续衔接需要核对',
          explanation: r.explanation,
        });
      }
      for (const leg of currentLegs) {
        const unavailable =
          leg.state === 'UNKNOWN' ||
          leg.safety.boarding.realtimeFreshness !== 'FRESH' ||
          leg.safety.boarding.feasibility === 'UNKNOWN' ||
          leg.safety.transferToNext?.feasibility === 'UNKNOWN';
        const disrupted =
          leg.operational.disposition === 'CURRENT_PLAN_NO_LONGER_FEASIBLE';
        const reasons = leg.operational.changeKinds;
        add({
          nodeId: null,
          transportEdgeId: leg.transportEdgeId,
          status: disrupted
            ? 'VIOLATED'
            : unavailable
              ? 'UNKNOWN'
              : 'SATISFIED',
          changed: leg.operational.requiresUserAttention,
          title: disrupted
            ? '当前交通需要重新规划'
            : unavailable
              ? '交通运行信息暂不可核验'
              : '交通运行有更新',
          explanation: reasons.includes('SERVICE_CANCELLED')
            ? '已选服务取消，不能继续依赖原班次。'
            : reasons.some((r) =>
                  [
                    'SERVICE_SHORT_TURNED',
                    'TERMINUS_CHANGED',
                    'OPERATING_ENDPOINT_CHANGED',
                  ].includes(r),
                )
              ? '服务终点或停靠目标有变化，原路线需要重新评估。'
              : disrupted
                ? '当前服务无法完成原采用的上下车目标。'
                : unavailable
                  ? '运行事实缺失或已过期；不能据此判断准点或后续可达。'
                  : leg.operational.requiresUserAttention
                    ? '服务运行有变化；当前运营判断尚未要求替换路线。'
                    : '当前运营判断未要求替换路线。',
        });
      }
      for (const f of evidence.flights) {
        const edge = trip.transportEdges.find(
          (e) => e.id === f.transportEdgeId,
        );
        if (!edge || !relevantIds.has(edge.toNodeId)) continue;
        const disrupted = ['CANCELLED', 'DIVERTED'].includes(
          f.latestSnapshot.status,
        );
        add({
          nodeId: null,
          transportEdgeId: edge.id,
          status: disrupted ? 'VIOLATED' : 'UNKNOWN',
          changed: true,
          title: disrupted ? '航班安排需要核对' : '航班后续影响暂无法完全判断',
          explanation: disrupted
            ? f.latestSnapshot.status === 'CANCELLED'
              ? '已保存航班事实报告取消。'
              : '已保存航班事实报告备降，原目的地需要核对。'
            : f.providerUnavailable
              ? '航班来源暂不可用；不能以旧预计保证后续衔接。'
              : '航班信息是已保存的运行事实，尚无当前实时核验；车辆实测不表示你本人已登机或抵达。',
        });
      }
    }
    // Observations can change without Trip.version: reject mixed read bases too.
    const [finalTrip, finalGround, finalEvidence] = await Promise.all([
      this.trips.findOwnedById(owned),
      this.ground.listOwned(owned),
      this.inTrip.read(actor, tripId),
    ]);
    const groundFacts = (g: typeof stored | null) => JSON.stringify(g?.legs);
    if (
      !finalTrip ||
      finalTrip.version !== trip.version ||
      groundFacts(finalGround) !== groundFacts(stored) ||
      JSON.stringify(finalEvidence) !== JSON.stringify(evidence)
    )
      throw stale();
    return {
      tripId,
      basisVersion: trip.version,
      evaluatedAt: now.toISOString(),
      items,
      handoffs,
    };
  }
}
