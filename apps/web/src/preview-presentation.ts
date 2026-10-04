import type {
  RoutePreviewView,
  TripView,
  RouteTimePointView,
} from '@travel/contracts';
import { duration, esc, modeLabel } from './model.js';
import { transportClockParts } from './transport-display.js';

export interface PreviewPresentation {
  readonly scope: string;
  readonly endpoints: string;
  readonly preserved: readonly string[];
  readonly changes: readonly string[];
  readonly important: readonly string[];
  readonly blockers: readonly string[];
  readonly adjustments: readonly string[];
  readonly times: readonly string[];
  readonly segments: readonly {
    service: string;
    endpoints: string;
    time: string;
  }[];
  readonly replacements: readonly string[];
}

/** Only same-basis, owned Trip labels may enrich immutable Preview evidence. No I/O or writes. */
export function previewPresentation(
  p: RoutePreviewView,
  trip?: TripView | null,
): PreviewPresentation {
  const s = p.changeSummary;
  const matching = trip?.id === p.tripId && trip.version === p.basisVersion;
  const nodes = matching ? trip.days.flatMap((d) => d.nodes) : [];
  const node = (id: string) => nodes.find((n) => n.id === id);
  const label = (id: string, fallback = '相关地点') =>
    node(id)?.place?.name?.trim() ||
    (node(id)?.kind === 'FREE_ACTION'
      ? node(id)?.note?.trim() || '自由行动'
      : fallback);
  const edges = matching
    ? trip.connections.flatMap((c) => (c.transport ? [c.transport] : []))
    : [];
  const edgeLabel = (id: string) => {
    const e = edges.find((e) => e.id === id);
    return e
      ? `${e.serviceLabel?.trim() || modeLabel[e.mode]}：${label(e.fromNodeId, '起点')} → ${label(e.toNodeId, '终点')}`
      : '原有交通（名称待定）';
  };
  const external = s.externalOriginReplacement;
  const corridor = s.routeCorridor;
  const suffix = corridor?.replacementScope === 'SUFFIX';
  const fromId =
    corridor?.replacementAnchorFromNodeId ??
    corridor?.anchorFromNodeId ??
    p.currentConnection.fromNodeId;
  const toId =
    external?.destinationNodeId ??
    corridor?.replacementAnchorToNodeId ??
    corridor?.anchorToNodeId ??
    p.currentConnection.toNodeId;
  const from = external
    ? external.materializedOrigin.location.name?.trim() || '已确认的地点 / 站点'
    : label(fromId, p.candidate.legs[0]?.from.name?.trim() || '起点名称待定');
  const to = label(
    toId,
    p.candidate.legs.at(-1)?.to.name?.trim() || '终点名称待定',
  );
  const preserved: string[] = [];
  if (suffix || external) preserved.push('前面的已确认部分保持不变。');
  preserved.push('这次调整保留起点与目的地。');
  if (external)
    preserved[preserved.length - 1] =
      '保留目的地；从你确认的位置开始后续路线。';
  const removed = s.nodesToRemove ?? [];
  const technical = removed.filter((r) => {
    const n = node(r.nodeId);
    return (
      n?.source === 'ROUTE_GENERATED' &&
      n.autoReplaceable &&
      !n.userModifiedAt &&
      !r.protected
    );
  });
  const important = removed
    .filter((r) => !technical.includes(r))
    .map(
      (r) =>
        `涉及移除：${label(r.nodeId)}${node(r.nodeId)?.source === 'USER_PLANNED' ? '（你添加的安排）' : '（受保护或影响尚未确认）'}。请核对。`,
    );
  if (s.nodesToRemove === undefined)
    preserved.push('地点移除信息未提供；请核对完整方案。');
  else if (removed.length === 0) preserved.push('不会删除地点。');
  else if (
    matching &&
    removed.every((r) => node(r.nodeId)?.source === 'ROUTE_GENERATED')
  )
    preserved.push('你手工添加的地点不会被删除。');
  const replaceIds =
    s.willReplaceTransportEdgeIds ??
    (s.willReplaceTransportEdgeId ? [s.willReplaceTransportEdgeId] : []);
  const changes = [
    s.transportAction === 'CREATE'
      ? '新增这一段交通。'
      : replaceIds.length
        ? `将替换这段路线中的 ${replaceIds.length} 段交通。`
        : '将替换当前交通；完整范围未提供。',
  ];
  if (s.transportAction === 'REPLACE' && replaceIds.length) {
    changes.push(...[...new Set(replaceIds)].slice(0, 2).map(edgeLabel));
    if (replaceIds.length > 2) changes.push('其余交通见展开详情。');
  }
  if (technical.length)
    changes.push(
      `移除 ${technical.length} 个旧方案自动生成的换乘点，按新路线安排换乘。`,
    );
  if (s.nodesToCreate?.length)
    changes.push(`新方案增加 ${s.nodesToCreate.length} 个路线地点 / 换乘点。`);
  if (s.nodesToReuse?.length)
    preserved.push(`保留并复用 ${s.nodesToReuse.length} 个已有换乘点。`);
  const blockers: string[] = [];
  if (!p.adoptable) {
    const statusReason = {
      EXPIRED: '这个方案已过期，请重新查询。',
      SUPERSEDED_POLICY: '路线规则已更新，请重新生成方案。',
      ADOPT_UNSUPPORTED: '这个旧版方案目前不支持采用，请重新查询。',
      BLOCKED: '',
      ACTIVE: '',
    }[p.status];
    if (statusReason) blockers.push(statusReason);
    if (s.protectedBlockingTransportEdgeIds?.length)
      blockers.push(
        '这个方案会覆盖受保护的交通事实，当前不能替换。车辆实测不代表你本人已经出发或到达。',
      );
    for (const r of s.protectedBlockingNodes ?? []) {
      const reasons = r.protectionReasons;
      const locked = node(r.nodeId)?.timeIntents.some((i) => i.locked);
      const reason = reasons.includes('USER_TIME_INTENT')
        ? locked
          ? '会影响你锁定的时间要求'
          : '会影响你设置的时间要求'
        : reasons.includes('ACTUAL')
          ? '会覆盖已保存的实际时间事实'
          : reasons.includes('NOTE') || reasons.includes('USER_MODIFIED')
            ? '包含你保留或修改的内容，不能自动移除或调整'
            : '包含受保护的关联内容，不能自动移除或调整';
      blockers.push(`${label(r.nodeId)}：${reason}。`);
    }
    if (s.downstreamImpact?.status === 'INFEASIBLE')
      blockers.push('新路线与后续安排的时间冲突，当前无法采用。');
    if (!blockers.length)
      blockers.push(
        '当前不能采用；预览未提供可确认的具体原因，请重新查询或核对安排。',
      );
  }
  const adjustments = (s.requiredUserAdjustments ?? []).map(
    (a) =>
      `${label(a.nodeId)}：${duration(a.fromDurationSeconds)} → ${duration(a.toDurationSeconds)}`,
  );
  const time = (t: RouteTimePointView | null) => {
    const parts = transportClockParts(t);
    return parts ? `${parts.date} ${parts.clock} · ${parts.zone}` : '待定';
  };
  const times = [
    `新方案计划出发 ${time(p.candidate.overall.departure)}`,
    `新方案计划到达 ${time(p.candidate.overall.arrival)}`,
  ];
  const impact = s.downstreamImpact;
  if (impact) {
    times.push(
      `${label(impact.nodeId)} · 后续停留：${duration(impact.projectedDwellSeconds)}`,
    );
    if (impact.status === 'USER_REQUIREMENT_VIOLATION')
      important.push('后续停留低于你设置的最短停留，需要明确确认调整。');
    if (impact.status === 'SOFT_DEVIATION')
      important.push('后续停留少于系统建议；这不是新的用户最低要求。');
    if (impact.status === 'UNKNOWN')
      important.push('后续时间影响暂时无法确定。');
  } else times.push('后续时间影响未提供；无法确认整天的时间变化。');
  const locations = [
    ...s.generatedTransferPoints,
    ...(s.nodesToCreate ?? []).map((n) => n.location),
    ...(s.nodesToReuse ?? []).map((n) => n.location),
  ];
  const refLabel = (ref: string) =>
    ref === 'FROM_NODE' || ref === 'EXTERNAL_ORIGIN'
      ? from
      : ref === 'TO_NODE'
        ? to
        : locations.find((l) => l.ref === ref)?.name?.trim() || '换乘地点待定';
  // Explicit legIndex is the only link to the original leg order. Never match names.
  const orderedSegments = s.proposedSegments.map((segment, index) => ({
    order: segment.legIndex ?? index,
    service: segment.serviceLabel?.trim() || modeLabel[segment.mode] || '交通',
    endpoints: `${refLabel(segment.fromRef)} → ${refLabel(segment.toRef)}`,
    time: `计划 ${time(segment.departure)} → ${time(segment.arrival)}`,
  }));
  const internal = (s.internalTransferDetails ?? []).map((transfer) => ({
    order: transfer.legIndex,
    service: '站内步行换乘',
    endpoints: `${transfer.from.name?.trim() || '换乘起点待定'} → ${transfer.to.name?.trim() || '换乘终点待定'}`,
    time: `换乘时长 ${duration(transfer.durationSeconds)}`,
  }));
  const segments = s.proposedSegments.every(
    (segment) => segment.legIndex !== undefined,
  )
    ? [...orderedSegments, ...internal].sort((a, b) => a.order - b.order)
    : [...orderedSegments, ...internal];

  return {
    scope: external
      ? '从你确认的当前位置 / 站点开始'
      : suffix
        ? `从 ${from} 之后调整`
        : corridor?.replacementScope === 'FULL_CORRIDOR'
          ? '将重新规划这一段路线'
          : '调整这一段交通',
    endpoints: `${from} → ${to}`,
    preserved,
    changes,
    important,
    blockers,
    adjustments,
    times,
    segments,
    replacements: [...new Set(replaceIds)].map(edgeLabel),
  };
}

/** Markup has no commands; the caller retains its existing explicit Adopt action. */
export function previewMarkup(v: PreviewPresentation): string {
  const list = (items: readonly string[]) =>
    `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  return `<section class="preview-presentation" aria-label="路线调整预览">
    <header><span class="preview-eyebrow">调整范围</span><h3>这条路线</h3><strong class="preview-scope">${esc(v.scope)}</strong><p>${esc(v.endpoints)}</p></header>
    ${v.blockers.length ? `<section class="preview-important" aria-label="不能采用的原因"><h4>当前不能采用</h4>${list(v.blockers)}</section>` : ''}
    <section><h4>保持不变</h4>${list(v.preserved)}</section>
    <section><h4>关键变化</h4>${list(v.changes)}</section>
    ${v.important.length ? `<section class="preview-important"><h4>重要影响</h4>${list(v.important)}</section>` : ''}
    <section><h4>计划时间</h4>${list(v.times)}<p class="muted">这是待采用的计划；尚未改变你的行程。与原计划的完整时间差未提供。</p></section>
    ${v.adjustments.length ? `<label class="check preview-consent"><input id="accept-adjustments" type="checkbox"><span>我同意将以下最短停留改为：${v.adjustments.map(esc).join('；')}</span></label>` : ''}
    <details class="preview-details"><summary>查看交通与换乘详情</summary>${v.replacements.length ? `<h4>将替换的交通</h4>${list(v.replacements)}` : ''}<h4>新方案分段</h4><ol>${v.segments.map((s) => `<li><strong>${esc(s.service)}</strong><p>${esc(s.endpoints)}</p><small>${esc(s.time)}</small></li>`).join('')}</ol>${!v.segments.length ? '<p>分段信息未提供。</p>' : ''}</details>
  </section>`;
}
