import type { TripImpactView, TripView } from '@travel/contracts';
import { esc, orderedNodes } from './model.js';
import { arrangementName } from './authoring.js';

/** Presentation only: severity comes from the authoritative read, never local time arithmetic. */
export function impactPresentation(
  trip: TripView,
  impact: TripImpactView | null,
) {
  if (
    !impact ||
    impact.tripId !== trip.id ||
    impact.basisVersion !== trip.version
  )
    return {
      tone: 'unknown',
      title: '暂时无法判断后续影响',
      description: '影响信息暂不可用或版本已变化，请重新载入。',
    };
  if (
    impact.items.some((i) => i.status === 'VIOLATED' || i.status === 'CONFLICT')
  )
    return {
      tone: 'replan',
      title: '后续安排需要调整',
      description: '已有时间或交通事实与当前安排冲突，请先查看直接原因。',
    };
  if (
    impact.items.some((i) => i.status === 'UNKNOWN') ||
    impact.handoffs.some((h) => h.readiness === 'ORIGIN_UNRESOLVED')
  )
    return {
      tone: 'unknown',
      title: '暂时无法判断后续影响',
      description: '部分时间、运行信息或重新规划起点还不确定。',
    };
  if (impact.items.some((i) => i.changed))
    return {
      tone: 'attention',
      title: '时间或交通有变化',
      description: '当前已有判断未发现后续冲突，请查看变化与剩余停留。',
    };
  return {
    tone: 'quiet',
    title: '当前已核对安排可继续',
    description: '未发现已有事实与要求的冲突；不代表实时运行保证。',
  };
}
export function impactSummary(trip: TripView, impact: TripImpactView | null) {
  const p = impactPresentation(trip, impact);
  return `<section class="trip-impact impact-${p.tone}" aria-label="后续影响"><div><strong>${esc(p.title)}</strong><p>${esc(p.description)}</p></div><button data-action="view-impact"><span class="control-content">查看影响</span></button></section>`;
}
export function impactDetails(trip: TripView, impact: TripImpactView | null) {
  const p = impactPresentation(trip, impact),
    nodes = orderedNodes(trip);
  const name = (id: string | null) =>
    nodes.find((n) => n.id === id)
      ? arrangementName(nodes.find((n) => n.id === id)!)
      : '相关安排';
  const edgeName = (id: string | null) => {
    const c = trip.connections.find((c) => c.transport?.id === id);
    return c ? `${name(c.fromNodeId)} → ${name(c.toNodeId)}` : '相关交通';
  };
  const valid =
    impact?.tripId === trip.id && impact.basisVersion === trip.version
      ? impact
      : null;
  const items =
    valid?.items.filter((i) => i.status !== 'SATISFIED' || i.changed) ?? [];
  return `<section class="impact-detail"><p class="eyebrow">后续安排</p><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p>${items.length ? `<ol>${items.map((i) => `<li class="impact-item"><p class="impact-location">${esc(i.transportEdgeId ? edgeName(i.transportEdgeId) : name(i.nodeId))}</p><h4>${esc(i.title)}</h4><p>${esc(i.explanation)}</p><small>${i.status === 'UNKNOWN' ? '信息不足' : i.status === 'VIOLATED' || i.status === 'CONFLICT' ? '需要处理' : '有变化'}</small></li>`).join('')}</ol>` : valid ? '<p>已有事实与时间要求暂未显示需要处理的冲突。</p>' : ''}${valid?.handoffs.map((h) => `<article class="handoff"><h4>${esc(edgeName(h.sourceTransportEdgeId))}</h4>${h.readiness === 'NOT_REQUIRED' ? '<p>当前运营判断不要求重新规划。</p>' : h.readiness === 'ORIGIN_UNRESOLVED' ? `<p>需要先确认当前位置 / 当前进度。</p><p>${h.reasonCodes.includes('QUERY_TIME_ZONE_UNRESOLVED') ? '缺少可靠起点时区。' : h.reasonCodes.includes('OPERATIONAL_ASSESSMENT_UNAVAILABLE') ? '缺少可关联的运营判断。' : '已有执行进度不足以确定安全的重新规划起点。'}</p>` : `<p>${h.originBasis === 'CONFIRMED_EXECUTION_NODE' ? `前面的已确认部分保持不变，从 ${esc(name(h.query?.fromNodeId ?? null))} 之后重新规划。` : h.originBasis === 'CONFIRMED_EXTERNAL_EXECUTION_ORIGIN' ? '可从你已确认到达的站点重新规划；之前的执行记录保持不变。' : `当前仍可从 ${esc(name(h.query?.fromNodeId ?? null))} 开始核对后续路线。`}</p><button data-impact-handoff="${esc(h.sourceTransportEdgeId)}"><span class="control-content">查看调整方案</span></button>`}</article>`).join('') ?? ''}<p class="muted">车辆与航班运行事实不表示你本人已经出发或到达。查看影响不会修改行程、生成路线或产生费用。</p>${valid ? `<p class="muted">核对于 ${esc(valid.evaluatedAt.replace('T', ' ').replace('Z', ' UTC'))}；状态变化后请重新载入。</p>` : ''}</section>`;
}
