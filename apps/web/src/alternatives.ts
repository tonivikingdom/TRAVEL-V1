import type {
  GroundTransitRouteReevaluationHandoffView,
  TripView,
} from '@travel/contracts';
import { esc, formatTime, orderedNodes } from './model.js';
import { arrangementName } from './authoring.js';

export function alternativeEntry(
  trip: TripView,
  handoff: GroundTransitRouteReevaluationHandoffView,
) {
  const query = handoff.query ?? handoff.externalQuery;
  const name = (id: string | undefined) => {
    const n = orderedNodes(trip).find((n) => n.id === id);
    return n ? arrangementName(n) : '已确认的当前位置';
  };
  return `<section class="alternative-search"><p class="eyebrow">调整后续交通</p><h3>${esc(handoff.externalQuery ? '从已确认的当前位置' : name(handoff.query?.fromNodeId))} → ${esc(name(query?.toNodeId))}</h3><p>${handoff.originBasis === 'CONFIRMED_EXECUTION_NODE' ? '前面的已确认部分保持不变，只核对后续路线。' : handoff.externalQuery ? '从你已确认到达的位置开始；先前执行记录保持不变。' : '只核对这段路线，不会重做整个旅行。'}</p>${query?.hint ? `<p class="muted">${query.hint.type === 'ARRIVE_BY' ? '最晚到达' : '出发参考'}：${esc(formatTime(query.hint))}。搜索时重新核验起点与时间。</p>` : ''}<p>搜索和查看方案不会改变当前行程；只有明确采用才会保存调整。</p><button class="primary" data-action="search-alternatives"><span class="control-content">搜索替代方案</span></button><button data-action="recheck-impact"><span class="control-content">重新核验影响</span></button><div id="candidates" aria-live="polite"></div><div id="choice"></div></section><p id="save-status" role="status"></p>`;
}
