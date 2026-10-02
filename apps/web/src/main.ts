import type {
  AdoptRoutePreviewResponse,
  ConnectionView,
  ItineraryNodeView,
  OperationReceiptView,
  RouteCandidateView,
  RoutePreviewView,
  RouteQueryResponse,
  ScheduleNodeProjectionView,
  ScheduleProjectionView,
  SessionResponse,
  TripCommandInput,
  TripListResponse,
  TripView,
  UndoRouteAdoptionResponse,
} from '@travel/contracts';
import { TravelApi, WebError, errorText } from './api.js';
import { DetailDrawer } from './drawer.js';
import {
  candidateConflict,
  departureFloor,
  duration,
  esc,
  formatTime,
  temporalLabel,
  transportTime,
  localInput,
  localToInstant,
  modeLabel,
  nodeZone,
  orderedNodes,
  routeConnections,
  isFoldedTransfer,
  times,
} from './model.js';
import { navigation, placeMap, type MapLocation } from './maps.js';
import './styles.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const detail = document.querySelector<HTMLDialogElement>('#detail')!;
const tokenKey = 'travel.web.session';
const api = new TravelApi(() => sessionStorage.getItem(tokenKey));
let trip: TripView | null = null;
let schedule: ScheduleProjectionView | null = null;
let dayId = '';
let busy = false;
let notice = '';
let epoch = 0;
let selection:
  | { type: 'place'; nodeId: string }
  | { type: 'route'; from: string; to: string }
  | null = null;
let draftDirty = false;
const dirtyForms = new Set<string>();
const formBaselines = new Map<string, string>();
let routeCandidates: readonly RouteCandidateView[] = [];
let preview: RoutePreviewView | null = null;
let receipt: OperationReceiptView | null = null;
let mutationKey = crypto.randomUUID();
let undoKey = crypto.randomUUID();
let candidatesBasis = -1;
function formValue(form: HTMLFormElement) {
  return JSON.stringify([...new FormData(form).entries()]);
}
function baselineForms() {
  dirtyForms.clear();
  formBaselines.clear();
  detail
    .querySelectorAll<HTMLFormElement>('form')
    .forEach((f) => formBaselines.set(f.id, formValue(f)));
}
function savedForm(id: string) {
  const form = detail.querySelector<HTMLFormElement>(`#${id}`);
  if (form) formBaselines.set(id, formValue(form));
  dirtyForms.delete(id);
  draftDirty = dirtyForms.size > 0;
}
const drawer = new DetailDrawer(
  detail,
  () =>
    !busy && (!draftDirty || confirm('还有未保存的修改。放弃这些修改并关闭？')),
  () => {
    selection = null;
    preview = null;
    routeCandidates = [];
    draftDirty = false;
    epoch++;
  },
);
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${({ pin: 'M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6', arrow: 'm5 12 14 0m-5-5 5 5-5 5', close: 'm6 6 12 12M6 18 18 6', calendar: 'M5 5h14v15H5zM8 2v6m8-6v6M5 10h14', route: 'M6 5a2 2 0 1 0 0 .1M18 19a2 2 0 1 0 0 .1M8 5h6a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 6h6', clock: 'M12 3a9 9 0 1 0 .1 0M12 7v5l3 2' } as Record<string, string>)[name] ?? 'M5 12h14'}"/></svg>`;
function projection(id: string): ScheduleNodeProjectionView | undefined {
  return schedule?.nodes.find((n) => n.nodeId === id);
}
function node(id: string) {
  return trip ? orderedNodes(trip).find((n) => n.id === id) : undefined;
}
function nodeTitle(n: ItineraryNodeView) {
  return n.place?.name ?? '自由行动';
}
function dayDate(id: string) {
  return trip?.days.find((d) => d.dayOccurrenceId === id)?.localDate;
}
function timeGrid(n: ItineraryNodeView) {
  const t = times(n, projection(n.id));
  return `<div class="times">${(
    [
      ['到达', t.arrival],
      ['出发', t.departure],
    ] as const
  )
    .map(
      ([label, v]) =>
        `<div><span>${label}${v ? ` · ${temporalLabel(v)}` : ''}</span><strong>${esc(formatTime(v, dayDate(n.dayOccurrenceId)))}</strong>${v ? `<small class="time-zone">${esc(v.timeZone)}</small>` : ''}</div>`,
    )
    .join(
      '',
    )}<div><span>停留</span><strong>${esc(duration(t.dwell))}</strong></div></div>`;
}
function requirements(n: ItineraryNodeView) {
  return n.timeIntents
    .map(
      (i) =>
        `<p class="requirement">${i.kind === 'MIN_DWELL' ? `至少停留 ${duration(i.durationSeconds)}` : `${i.pointKind === 'ARRIVAL' ? '到达' : '出发'}${{ EXACT: '需在', NOT_BEFORE: '不早于', NOT_AFTER: '不晚于', MINIMUM: '' }[i.operator]} ${esc(i.instant && i.timeZone ? formatTime({ instant: i.instant, timeZone: i.timeZone }, dayDate(n.dayOccurrenceId)) : '待定')}`}${i.locked ? ' · 受保护' : ''}</p>`,
    )
    .join('');
}
function banner() {
  return notice ? `<p class="message" role="status">${esc(notice)}</p>` : '';
}
function render() {
  if (!sessionStorage.getItem(tokenKey)) {
    root.innerHTML = `<main class="login"><div class="brand">${icon('route')} TRAVEL</div><h1>把旅行安排好</h1><p>使用受邀邮箱登录，查看你的旅行。</p>${banner()}<form id="login"><label>邮箱<input name="email" type="email" autocomplete="email" required></label><button class="primary">发送登录链接</button></form><p class="muted">登录链接将发送到你的邮箱。不提供公开注册。</p></main>`;
    return;
  }
  if (!trip) {
    root.innerHTML = `<header><div class="brand">${icon('route')} TRAVEL</div><div class="header-actions"><button data-action="reload">重新载入</button><button data-action="logout">退出</button></div></header><main class="trip-list"><h1>你的旅行</h1>${banner()}<div id="trips">正在读取旅行…</div></main>`;
    return;
  }
  const day =
    trip.days.find((d) => d.dayOccurrenceId === dayId) ?? trip.days[0];
  dayId = day?.dayOccurrenceId ?? '';
  const shownNodes =
    day?.nodes.filter((n) => !isFoldedTransfer(trip!, n)) ?? [];
  const days = [...trip.days].sort((a, b) => a.sequence - b.sequence);
  root.innerHTML = `<header><button data-action="trips" class="back">‹ 旅行</button><div class="brand">${icon('route')} TRAVEL</div><button data-action="reload">重新载入</button></header><main class="workspace"><aside class="date-sidebar"><p class="eyebrow">这次旅行</p><h1>${esc(trip.name)}</h1><p class="muted">${trip.defaultPeopleCount} 人 · ${esc(trip.effectiveStartDate ?? trip.planningAnchorDate)}</p><nav aria-label="旅行日期">${days.map((d, i) => `<button data-day="${d.dayOccurrenceId}" class="${d.dayOccurrenceId === dayId ? 'selected' : ''}">${icon('calendar')}<span>第 ${i + 1} 天<small>${esc(d.localDate)}</small></span></button>`).join('')}</nav></aside><section class="itinerary"><div class="page-heading"><div><p class="eyebrow">按计划查看</p><h2>${esc(day?.localDate ?? '日程')}</h2><p class="mobile-trip">${esc(trip.name)}</p></div><span class="badge">${shownNodes.length} 个安排</span></div>${banner()}${receipt ? '<div class="undo"><span>已使用新的路线</span><button data-action="undo">撤销刚才的路线修改</button></div>' : ''}<div class="timeline">${
    shownNodes.length
      ? shownNodes
          .map((n) => {
            const chain = routeConnections(trip!, n.id);
            const connection = chain[0]
              ? { ...chain[0], toNodeId: chain.at(-1)!.toNodeId }
              : undefined;
            return `<article class="place-card"><button class="place-open" data-node="${n.id}"><span class="place-icon">${icon('pin')}</span><span><strong>${esc(nodeTitle(n))}</strong><small>${esc(n.place?.address ?? (n.place ? '地址未提供' : '未指定地点'))}</small></span><span aria-hidden="true">›</span></button>${timeGrid(n)}${requirements(n)}${projection(n.id)?.status === 'VIOLATED' || projection(n.id)?.status === 'CONFLICT' ? '<p class="warning">当前安排与重要时间要求有冲突，请查看详情。</p>' : ''}</article>${connection ? connectionCard(connection) : ''}`;
          })
          .join('')
      : `<div class="empty">${day?.nodes.length ? '这一天没有单独的地点安排；跨日交通请查看出发日的交通详情。' : '这一天还没有安排。'}</div>`
  }</div></section><aside class="desktop-hint"><span class="large-pin">${icon('pin')}</span><h3>查看安排详情</h3><p>选择地点查看时间与资料。选择交通查看路线，或主动更换方案。</p><p class="muted">位置未知时，按计划查看；不会推测你已到达。</p></aside></main>`;
}
function connectionCard(c: ConnectionView) {
  const edge = c.transport;
  const from = node(c.fromNodeId);
  const to = node(c.toNodeId);
  const floor = from ? departureFloor(from, projection(from.id)) : null;
  const departure = edge ? transportTime(edge.timeValues, 'DEPARTURE') : null;
  const conflict =
    departure && floor && Date.parse(departure.instant) < Date.parse(floor);
  return `<button class="connection ${conflict ? 'conflict' : ''}" data-route-from="${c.fromNodeId}" data-route-to="${c.toNodeId}">${icon('route')}<span><strong>${esc(edge ? `${modeLabel[edge.mode]} · ${edge.serviceLabel ?? '已选交通'}` : '选择交通')}</strong><small>${edge ? `${departure ? temporalLabel(departure) : '待定'} ${esc(formatTime(departure, from ? dayDate(from.dayOccurrenceId) : undefined))} 出发 · 前往 ${esc(to ? nodeTitle(to) : '下一安排')}` : '查看方案或在地图中查询'}</small>${conflict ? '<small class="warning">出发早于当前可出发时间，原路线仍保留</small>' : ''}</span><span>›</span></button>`;
}
function frame(title: string, body: string) {
  return `<div class="sheet-head" data-drag><div class="handle" aria-hidden="true"></div><div class="sheet-title"><h2 id="detail-title">${esc(title)}</h2><button data-close aria-label="关闭详情">${icon('close')}</button></div></div><div class="sheet-body">${body}</div>`;
}
function mapLinks(
  location: MapLocation,
  routeOrigin?: MapLocation,
  transit = false,
) {
  const map = placeMap(location),
    nav = navigation(location, routeOrigin, transit ? 'transit' : 'walking');
  return `<div class="map-links">${map ? `<a href="${esc(map)}" target="_blank" rel="noopener noreferrer">${icon('pin')}查看地图</a>` : '<span>暂无可靠位置，无法打开地图</span>'}${nav ? `<a href="${esc(nav)}" target="_blank" rel="noopener noreferrer">${icon('arrow')}${transit ? '在地图中查询' : '导航到这里'}</a>` : ''}${/iPhone|iPad/u.test(navigator.userAgent) && placeMap(location, true) ? `<a href="${esc(placeMap(location, true))}" target="_blank" rel="noopener noreferrer">Apple 地图</a>` : ''}</div>${transit ? '<p class="muted">外部地图会重新查询；不保证保留本方案的日期、班次与票价。</p>' : ''}`;
}
function openPlace(n: ItineraryNodeView) {
  if (detail.open && !drawerClose()) return;
  selection = { type: 'place', nodeId: n.id };
  draftDirty = false;
  const zone = nodeZone(n, projection(n.id));
  drawer.open(
    frame(
      nodeTitle(n),
      `<p class="address">${esc(n.place?.address ?? '地址未提供')}</p>${n.place ? mapLinks(n.place) : ''}<p class="map-status">暂不提供内嵌地图，可在地图应用中查看已保存的位置。</p>${timeGrid(n)}<div data-requirements>${requirements(n)}</div><details class="edit"><summary>编辑重要时间要求</summary><p class="muted">要求独立于计划/预计/实际时间，不会改写已发生事实。</p><form id="time-edit"><label>要求<select name="requirement"><option value="ARRIVAL:NOT_AFTER">最晚到达</option><option value="ARRIVAL:NOT_BEFORE">最早到达</option><option value="ARRIVAL:EXACT">指定到达</option><option value="DEPARTURE:NOT_BEFORE">最早出发</option><option value="DEPARTURE:NOT_AFTER">最晚出发</option><option value="DEPARTURE:EXACT">指定出发</option></select></label><label>当地日期与时间<input name="when" type="datetime-local" required></label><label>事件所在地时区<input name="zone" value="${esc(zone ?? '')}" placeholder="例如 Asia/Tokyo" required></label><label class="check"><input name="locked" type="checkbox" checked>保护这项要求</label><button class="primary">保存时间要求</button></form><form id="dwell-edit"><label>至少停留（分钟）<input name="minutes" type="number" min="1" step="1" value="${n.timeIntents.find((i) => i.kind === 'MIN_DWELL')?.durationSeconds ? String(n.timeIntents.find((i) => i.kind === 'MIN_DWELL')!.durationSeconds! / 60) : ''}" required></label><button>保存停留要求</button></form>${n.timeIntents.map((i) => `<button class="remove-intent" data-intent="${i.id}">移除${i.kind === 'MIN_DWELL' ? '停留' : i.pointKind === 'ARRIVAL' ? '到达' : '出发'}${i.kind === 'MIN_DWELL' ? '' : { EXACT: '指定', NOT_AFTER: '最晚', NOT_BEFORE: '最早', MINIMUM: '' }[i.operator]}要求</button>`).join('')}</details><form id="note-edit"><label>备注<textarea name="note" maxlength="2000" rows="3" placeholder="这处安排需要记住什么？">${esc(n.note ?? '')}</textarea></label><button class="primary">保存备注</button></form><p id="save-status" role="status">已读取服务器数据</p>`,
    ),
  );
  const existing = n.timeIntents.find((i) => i.kind === 'POINT_TIME');
  if (existing && existing.instant && existing.timeZone) {
    detail.querySelector<HTMLSelectElement>('#time-edit select')!.value =
      `${existing.pointKind}:${existing.operator}`;
    detail.querySelector<HTMLInputElement>(
      '#time-edit input[name=when]',
    )!.value = localInput(existing.instant, existing.timeZone);
    detail.querySelector<HTMLInputElement>(
      '#time-edit input[name=zone]',
    )!.value = existing.timeZone;
    detail.querySelector<HTMLInputElement>(
      '#time-edit input[name=locked]',
    )!.checked = existing.locked;
  }
  baselineForms();
}
function refreshPlaceSummary(id: string) {
  const fresh = node(id);
  if (!fresh) return;
  const grid = detail.querySelector('.times');
  if (grid) grid.outerHTML = timeGrid(fresh);
  const requirementsElement = detail.querySelector('[data-requirements]');
  if (requirementsElement) requirementsElement.innerHTML = requirements(fresh);
}
function drawerClose() {
  if (busy) return false;
  if (draftDirty && !confirm('还有未保存的修改。放弃这些修改？')) return false;
  draftDirty = false;
  drawer.close();
  return true;
}
function openRoute(from: string, to: string) {
  if (detail.open && !drawerClose()) return;
  const origin = node(from),
    destination = node(to);
  if (!origin || !destination) return;
  selection = { type: 'route', from, to };
  preview = null;
  routeCandidates = [];
  candidatesBasis = -1;
  epoch++;
  const zone = nodeZone(origin, projection(from));
  const floor = departureFloor(origin, projection(from));
  const chain = routeConnections(trip!, from);
  const connection = chain[0];
  drawer.open(
    frame(
      '交通与路线',
      `<p class="route-endpoints">${esc(nodeTitle(origin))}<span>→</span>${esc(nodeTitle(destination))}</p>${origin.place && destination.place ? mapLinks(destination.place, origin.place, true) : '<p>这段交通尚无完整地点信息。</p>'}<p class="map-status">暂不提供内嵌路线图；可展开分段查看地点，或在外部地图中查询。</p><section><h3>当前交通</h3>${
        connection?.transport
          ? `<p>${esc(chain.map((c) => (c.transport ? `${modeLabel[c.transport.mode]} · ${c.transport.serviceLabel ?? '已选交通'}` : '交通待定')).join(' → '))}</p><p>${chain
              .map((c) => c.transport)
              .filter((t) => t !== null)
              .flatMap((t) =>
                ['DEPARTURE', 'ARRIVAL'].map((point) =>
                  transportTime(t.timeValues, point as 'DEPARTURE' | 'ARRIVAL'),
                ),
              )
              .filter((v) => v !== null)
              .map(
                (v) =>
                  `${v.pointKind === 'DEPARTURE' ? '出发' : '到达'} · ${temporalLabel(v)} ${esc(formatTime(v))} (${esc(v.timeZone)})`,
              )
              .join('<br>')}</p>`
          : '<p class="muted">尚未选择交通</p>'
      }</section><h3>查找新的路线</h3><p class="muted">${floor && zone ? `当前可出发条件：${esc(formatTime({ instant: floor, timeZone: zone }))}` : '尚无法验证起点的可出发时间，请提供查询条件。'}<br>仅搜索不会更改行程。</p><form id="route-search"><label>查询条件<select name="type"><option value="DEPART_AT">从指定时间出发</option><option value="ARRIVE_BY">在指定时间前到达</option></select></label><label>当地日期与时间<input name="when" type="datetime-local" value="${esc(floor && zone ? localInput(floor, zone) : '')}" required></label><label>该条件所在地时区<input name="zone" value="${esc(zone ?? '')}" placeholder="请填写事件所在地时区" required></label><button class="primary" ${origin.place && destination.place ? '' : 'disabled'}>搜索路线</button></form><div id="candidates" aria-live="polite"></div><div id="choice"></div><p id="save-status" role="status"></p>`,
    ),
  );
}
function showCandidates() {
  const target = detail.querySelector('#candidates');
  if (!target) return;
  target.innerHTML = `<h3>路线方案</h3>${
    routeCandidates.length
      ? routeCandidates
          .map((c, i) => {
            const origin =
              selection?.type === 'route' ? node(selection.from) : undefined;
            const warning = candidateConflict(
              c,
              origin ? departureFloor(origin, projection(origin.id)) : null,
            );
            return `<button class="candidate" data-candidate="${i}" ${warning ? 'disabled' : ''}><span><strong>${esc(formatTime(c.overall.departure))} → ${esc(formatTime(c.overall.arrival))}</strong><small>${c.legs.map((l) => esc(modeLabel[l.mode])).join(' → ')} · ${duration(c.overall.durationSeconds)}</small><small>${c.fare ? `${esc(c.fare.amount)} ${esc(c.fare.currency)}` : '费用未知'}${c.provider === 'SYNTHETIC' ? ' · 合成开发数据' : ''}</small>${warning ? `<small class="warning">${esc(warning)}</small>` : ''}</span><span>›</span></button>`;
          })
          .join('')
      : '<p>没有符合条件的路线。可以调整查询条件或在地图中查询。</p>'
  }`;
}
function showPreview(p: RoutePreviewView) {
  const target = detail.querySelector('#choice');
  if (!target) return;
  const adjustments = p.changeSummary.requiredUserAdjustments ?? [];
  const impact = p.changeSummary.downstreamImpact;
  target.innerHTML = `<section class="choice"><h3>这条路线</h3><ol class="legs">${p.candidate.legs.map((l) => `<li><strong>${esc(modeLabel[l.mode])} ${esc(l.serviceLabel ?? '')}</strong><p>${esc(l.from.name)} → ${esc(l.to.name)}</p><small>${esc(formatTime(l.departure))} → ${esc(formatTime(l.arrival))}${l.departure ? ` · ${esc(l.departure.timeZone)}` : ''}</small>${l.from.latitude !== null && l.from.longitude !== null ? mapLinks(l.from) : '<p class="muted">上车位置未确认，不提供推测导航。</p>'}</li>`).join('')}</ol><p>会${p.changeSummary.transportAction === 'REPLACE' ? '替换当前交通' : '新增交通'}；目的地保持不变。</p>${impact ? `<p>后续停留：${esc(duration(impact.projectedDwellSeconds))}${['INFEASIBLE', 'USER_REQUIREMENT_VIOLATION'].includes(impact.status) ? ' · 重要安排存在冲突' : ''}</p>` : ''}${adjustments.length ? `<label class="check"><input id="accept-adjustments" type="checkbox">我同意将以下最短停留改为：${adjustments.map((a) => `${esc(node(a.nodeId) ? nodeTitle(node(a.nodeId)!) : '相关地点')} ${duration(a.fromDurationSeconds)} → ${duration(a.toDurationSeconds)}`).join('；')}</label>` : ''}${!p.adoptable ? '<p class="warning">这条方案当前不能使用：存在受保护事实、时间冲突或已过期。请核对后重新查询。</p>' : ''}<button class="primary" data-action="adopt" ${p.adoptable ? '' : 'disabled'}>使用这条路线</button></section>`;
  target.scrollIntoView({ block: 'start' });
}
function concealUnavailableDetails() {
  if (!detail.open) return;
  detail.dataset.unavailable = 'true';
  const title = detail.querySelector('#detail-title');
  if (title) title.textContent = '暂无法读取详情';
}
function status(message: string) {
  const target = detail.querySelector('#save-status');
  if (target) target.textContent = message;
}
function disableBusy(value: boolean) {
  busy = value;
  detail.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    if (value) {
      b.dataset.wasDisabled = String(b.disabled);
      b.disabled = true;
    } else if (b.dataset.wasDisabled !== undefined) {
      b.disabled = b.dataset.wasDisabled === 'true';
      delete b.dataset.wasDisabled;
    }
  });
}
async function act(operation: () => Promise<void>) {
  if (busy) return;
  disableBusy(true);
  try {
    await operation();
  } catch (error) {
    if (error instanceof WebError && error.status === 401) {
      sessionStorage.removeItem(tokenKey);
      trip = null;
      schedule = null;
      render();
    }
    if (
      error instanceof WebError &&
      ['NETWORK', 'SERVICE_UNAVAILABLE'].includes(error.code)
    ) {
      trip = null;
      schedule = null;
      render();
      concealUnavailableDetails();
    }
    const pending = detail.querySelector('#candidates');
    if (pending?.textContent === '正在查询…')
      pending.textContent = '未取得路线方案，请核对条件后重试。';
    status(errorText(error));
    notice = errorText(error);
    if (!detail.open) render();
  } finally {
    disableBusy(false);
  }
}
async function loadTrip(id: string) {
  const request = ++epoch;
  const fresh = await api.request<TripView>(`/trips/${id}`);
  const evaluated = await api.request<ScheduleProjectionView>(
    `/trips/${id}/schedule/evaluate`,
    { basisVersion: fresh.version },
  );
  if (request !== epoch) return;
  trip = fresh;
  schedule = evaluated;
  render();
}
async function listTrips() {
  trip = null;
  schedule = null;
  receipt = null;
  notice = '';
  render();
  try {
    const result = await api.request<TripListResponse>('/trips');
    if (trip) return;
    root.querySelector('#trips')!.innerHTML = result.trips.length
      ? result.trips
          .map(
            (t) =>
              `<button class="trip-card" data-trip="${t.id}"><span><strong>${esc(t.name)}</strong><small>${esc(t.effectiveStartDate ?? t.planningAnchorDate)} · ${t.defaultPeopleCount} 人</small></span>›</button>`,
          )
          .join('')
      : '<div class="empty">还没有旅行。</div>';
  } catch (error) {
    notice = errorText(error);
    render();
    root.querySelector('#trips')!.innerHTML =
      '<button data-action="trips">重新载入</button>';
  }
}
async function command(value: TripCommandInput) {
  if (!trip) return;
  const fresh = await api.request<TripView>(`/trips/${trip.id}/commands`, {
    baseTripVersion: trip.version,
    command: value,
  });
  trip = fresh;
  schedule = await api.request<ScheduleProjectionView>(
    `/trips/${fresh.id}/schedule/evaluate`,
    { basisVersion: fresh.version },
  );
  epoch++;
  routeCandidates = [];
  preview = null;
  receipt = null;
  render();
}
root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (!target) return;
  if (target.dataset.trip) void act(() => loadTrip(target.dataset.trip!));
  if (target.dataset.day) {
    if (detail.open && !drawerClose()) return;
    dayId = target.dataset.day;
    epoch++;
    render();
  }
  if (target.dataset.node) openPlace(node(target.dataset.node)!);
  if (target.dataset.routeFrom)
    openRoute(target.dataset.routeFrom, target.dataset.routeTo!);
  if (target.dataset.action === 'trips') void listTrips();
  if (target.dataset.action === 'reload')
    void act(() => (trip ? loadTrip(trip.id) : listTrips()));
  if (target.dataset.action === 'logout')
    void act(async () => {
      await api.request('/auth/logout', {});
      sessionStorage.removeItem(tokenKey);
      trip = null;
      schedule = null;
      render();
    });
  if (target.dataset.action === 'undo' && receipt && trip)
    void act(async () => {
      const result = await api.request<UndoRouteAdoptionResponse>(
        `/trips/${trip!.id}/operations/${receipt!.id}/undo`,
        { baseTripVersion: trip!.version, idempotencyKey: undoKey },
      );
      receipt = null;
      await loadTrip(result.trip.id);
      notice = '刚才的路线修改已撤销。';
      render();
    });
});
root.addEventListener('submit', (event) => {
  event.preventDefault();
  if ((event.target as HTMLFormElement).id !== 'login') return;
  const data = new FormData(event.target as HTMLFormElement);
  void act(async () => {
    await api.request('/auth/magic-link/request', { email: data.get('email') });
    notice = '如果该邮箱已获邀请，登录链接将发送到邮箱。';
    render();
  });
});
detail.addEventListener('input', (event) => {
  if ((event.target as HTMLElement).closest('#route-search')) {
    epoch++;
    routeCandidates = [];
    preview = null;
    detail.querySelector('#candidates')!.innerHTML = '';
    detail.querySelector('#choice')!.innerHTML = '';
  }
  const form = (event.target as HTMLElement).closest<HTMLFormElement>('form');
  if (!form || form.id === 'route-search') return;
  if (formValue(form) !== formBaselines.get(form.id)) dirtyForms.add(form.id);
  else dirtyForms.delete(form.id);
  draftDirty = dirtyForms.size > 0;
});
detail.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button,a');
  if (!target) return;
  if (
    target instanceof HTMLAnchorElement &&
    draftDirty &&
    !confirm('编辑尚未保存，仍要打开外部地图？当前草稿会保留。')
  ) {
    event.preventDefault();
    return;
  }
  if (target.dataset.intent && selection?.type === 'place') {
    if (
      draftDirty &&
      !confirm('移除要求后将重新载入详情。放弃当前未保存的修改？')
    )
      return;
    const n = node(selection.nodeId)!;
    const intent = n.timeIntents.find((i) => i.id === target.dataset.intent)!;
    void act(async () => {
      await command(
        intent.kind === 'MIN_DWELL'
          ? { type: 'REMOVE_MIN_DWELL', nodeId: n.id }
          : {
              type: 'REMOVE_TIME_INTENT',
              nodeId: n.id,
              pointKind: intent.pointKind!,
              operator: intent.operator as 'EXACT' | 'NOT_BEFORE' | 'NOT_AFTER',
            },
      );
      draftDirty = false;
      const fresh = node(n.id)!;
      detail.close();
      document.body.style.overflow = '';
      openPlace(fresh);
    });
  }
  if (
    target.dataset.candidate !== undefined &&
    trip &&
    selection?.type === 'route'
  )
    void act(async () => {
      const request = ++epoch;
      const candidate = routeCandidates[Number(target.dataset.candidate)]!;
      if (candidatesBasis !== trip!.version)
        throw new Error('行程已变化，请重新搜索。');
      const result = await api.request<RoutePreviewView>(
        `/trips/${trip!.id}/previews`,
        {
          basisVersion: trip!.version,
          candidateSnapshotId: candidate.candidateSnapshotId,
        },
      );
      if (request !== epoch) return;
      preview = result;
      mutationKey = crypto.randomUUID();
      showPreview(result);
      status('已核对方案，使用前请确认下方影响。');
    });
  if (target.dataset.action === 'adopt' && preview && trip)
    void act(async () => {
      const adjustments = preview!.changeSummary.requiredUserAdjustments ?? [];
      if (
        adjustments.length &&
        !detail.querySelector<HTMLInputElement>('#accept-adjustments')?.checked
      )
        throw new Error('请明确同意停留变更，或选择其他路线。');
      const result = await api.request<AdoptRoutePreviewResponse>(
        `/trips/${trip!.id}/previews/${preview!.previewId}/adopt`,
        {
          baseTripVersion: trip!.version,
          idempotencyKey: mutationKey,
          ...(adjustments.length
            ? { acceptedUserAdjustments: adjustments }
            : {}),
        },
      );
      draftDirty = false;
      disableBusy(false);
      drawer.close();
      await loadTrip(result.trip.id);
      receipt = result.operationReceipt;
      undoKey = crypto.randomUUID();
      notice = '已使用这条路线。';
      render();
    });
});
detail.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.name === 'type' && selection?.type === 'route') {
    const n = node(
      target.value === 'ARRIVE_BY' ? selection.to : selection.from,
    );
    const zone = n ? nodeZone(n, projection(n.id)) : null;
    const field = detail.querySelector<HTMLInputElement>(
      '#route-search input[name=zone]',
    );
    if (field) field.value = zone ?? '';
  }
});
detail.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  if (!trip || !selection) {
    status('当前无法保存，请联网后重新载入并核对。未保存内容仍在窗口中。');
    return;
  }
  if (form.id === 'note-edit' && selection.type === 'place') {
    const id = selection.nodeId;
    void act(async () => {
      await command({
        type: 'SET_NODE_NOTE',
        nodeId: id,
        note: String(data.get('note') ?? '') || null,
      });
      detail.querySelector<HTMLTextAreaElement>('#note-edit textarea')!.value =
        node(id)!.note ?? '';
      savedForm('note-edit');
      refreshPlaceSummary(id);
      status('备注已保存到服务器');
    });
  }
  if (form.id === 'time-edit' && selection.type === 'place') {
    const id = selection.nodeId;
    void act(async () => {
      const [pointKind, operator] = String(data.get('requirement')).split(':');
      await command({
        type: 'SET_TIME_INTENT',
        nodeId: id,
        pointKind: pointKind as 'ARRIVAL' | 'DEPARTURE',
        operator: operator as 'EXACT' | 'NOT_AFTER' | 'NOT_BEFORE',
        instant: localToInstant(
          String(data.get('when')),
          String(data.get('zone')),
        ),
        timeZone: String(data.get('zone')),
        locked: data.get('locked') === 'on',
      });
      savedForm('time-edit');
      refreshPlaceSummary(id);
      status('时间要求已保存，当前安排已重新核对。');
    });
  }
  if (form.id === 'dwell-edit' && selection.type === 'place') {
    const id = selection.nodeId;
    void act(async () => {
      await command({
        type: 'SET_MIN_DWELL',
        nodeId: id,
        durationSeconds: Number(data.get('minutes')) * 60,
        locked: true,
      });
      savedForm('dwell-edit');
      refreshPlaceSummary(id);
      status('停留要求已保存，当前安排已重新核对。');
    });
  }
  if (form.id === 'route-search' && selection.type === 'route') {
    const { from, to } = selection;
    void act(async () => {
      const request = ++epoch;
      preview = null;
      detail.querySelector('#choice')!.innerHTML = '';
      routeCandidates = [];
      detail.querySelector('#candidates')!.innerHTML = '正在查询…';
      const basis = trip!.version;
      const result = await api.request<RouteQueryResponse>(
        `/trips/${trip!.id}/routes/query`,
        {
          basisVersion: basis,
          fromNodeId: from,
          toNodeId: to,
          hint: {
            type: String(data.get('type')),
            instant: localToInstant(
              String(data.get('when')),
              String(data.get('zone')),
            ),
            timeZone: String(data.get('zone')),
          },
        },
      );
      if (request !== epoch || trip?.version !== basis) return;
      routeCandidates = result.candidates;
      candidatesBasis = basis;
      showCandidates();
      status('查询完成，尚未修改行程。');
    });
  }
});
window.addEventListener('beforeunload', (event) => {
  if (draftDirty || busy) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('offline', () => {
  epoch++;
  trip = null;
  schedule = null;
  notice =
    '当前无网，无法查看行程。未保存编辑仍在详情窗口中，联网后请重新核对。';
  render();
  concealUnavailableDetails();
  status(notice);
});
window.addEventListener('online', () => {
  notice = '连接已恢复，请重新载入服务器数据。';
  render();
});
async function start() {
  render();
  const url = new URL(location.href);
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  if (token) {
    url.hash = '';
    history.replaceState(null, '', url);
    try {
      const result = await api.request<SessionResponse>(
        '/auth/magic-link/consume',
        { token },
      );
      sessionStorage.setItem(tokenKey, result.credential);
    } catch (error) {
      notice = errorText(error);
      render();
      return;
    }
  }
  if (sessionStorage.getItem(tokenKey)) await listTrips();
}
void start();
