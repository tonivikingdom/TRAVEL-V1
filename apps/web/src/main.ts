import type {
  AdoptRoutePreviewRequest,
  ControlledAlternativeSearchResponse,
  GroundTransitRouteReevaluationHandoffView,
  TripImpactView,
  InTripView,
  GroundTransitExecutionResponse,
  FlightMovementView,
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
  UserView,
  RouteCandidateLegView,
  TransportEdgeView,
  TemporalValueView,
} from '@travel/contracts';
import { TravelApi, WebError, errorText } from './api.js';
import { DetailDrawer } from './drawer.js';
import {
  installInteractions,
  confirmAction,
  validateForm,
} from './interactions.js';
installInteractions();
import {
  candidateConflict,
  departureFloor,
  duration,
  esc,
  formatTime,
  temporalLabel,
  transportTime,
  savedLegTransport,
  localInput,
  localToInstant,
  modeLabel,
  nodeZone,
  orderedNodes,
  routeConnections,
  isFoldedTransfer,
  times,
} from './model.js';
import { navigation, placeMap, mapMode, type MapLocation } from './maps.js';
import { isAggregateTransit, transportClockPair } from './transport-display.js';
import { explicitQueryMode, selectedQueryMode } from './route-query-mode.js';
import { inTripProjection, type InTripStep } from './in-trip.js';
import {
  TripAuthoringEditor,
  editorDays,
  shiftedDate,
  arrangementName,
  type TemporaryDay,
} from './authoring.js';
import {
  backupOwner,
  bindBackupOwner,
  backupTimestamp,
  downloadBackup,
  essentialsBody,
  liveEssentials,
  localBackups,
  saveLocalBackup,
} from './essentials.js';
import { impactSummary, impactDetails, impactPresentation } from './impact.js';
import { alternativeEntry } from './alternatives.js';
import { previewPresentation, previewMarkup } from './preview-presentation.js';
import {
  configureMapAdapter,
  regionMapAdapter,
  unconfiguredMapAdapter,
} from './map-adapter.js';
import { miniMapMarkup, mountMiniMap } from './mini-map.js';
import { SyntheticMapAdapter } from './synthetic-map-adapter.js';
import { RegionalMapComposition } from './regional-map-composition.js';
import { browserMapConfig } from './map-browser-config.js';
import { providerMapAdapters } from './provider-map-adapters.js';
import { MapSdkLoader } from './map-sdk-loader.js';
import './mini-map.css';
import './styles.css';
import './interactions.css';
import './preview-presentation.css';

// Synthetic maps are only available in the development harness, never production.
if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get('mapHarness') === 'SYNTHETIC'
) {
  const state = new URLSearchParams(location.search).get('mapState');
  configureMapAdapter(
    new SyntheticMapAdapter(
      state === 'failure' || state === 'slow' || state === 'hang'
        ? state
        : 'ready',
    ),
  );
}

const root = document.querySelector<HTMLDivElement>('#app')!;
const detail = document.querySelector<HTMLDialogElement>('#detail')!;
const tokenKey = 'travel.web.session';
const api = new TravelApi(() => sessionStorage.getItem(tokenKey));
let trip: TripView | null = null;
let schedule: ScheduleProjectionView | null = null;
let dayId = '';
let viewMode: 'itinerary' | 'today' = 'itinerary';
let inTrip: InTripView | null = null;
let ground: GroundTransitExecutionResponse | null = null;
let tripImpact: TripImpactView | null = null;
let inTripReadAt: string | null = null;
let inTripReadUnavailable = false;
let temporaryDays: TemporaryDay[] = [];
let busy = false;
let notice = '';
let epoch = 0;
let selection:
  | { type: 'place'; nodeId: string }
  | { type: 'route'; from: string; to: string }
  | {
      type: 'alternative';
      handoff: GroundTransitRouteReevaluationHandoffView;
      invalid: boolean;
    }
  | null = null;
let draftDirty = false;
let currentUserId: string | null = backupOwner();
let requestedTripId: string | null = null;
let materialsOpen = false;
let externalMapOpening = false;
let materialsVerifying = false;
let materialsRead = 0;
let viewingBackup: import('@travel/contracts').StaticBackupView | null = null;
let latestBackup: import('@travel/contracts').StaticBackupView | null = null;
let backupNotice = '';
let backupPending: {
  tripId: string;
  baseTripVersion: number;
  idempotencyKey: string;
} | null = null;
const sdkHarness =
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get('mapHarness') === 'SYNTHETIC_SDK';
const mapSlots = providerMapAdapters(
  browserMapConfig(
    sdkHarness
      ? {
          VITE_GOOGLE_MAPS_BROWSER_KEY: 'SYNTHETIC_BROWSER_SDK_KEY',
          VITE_GOOGLE_MAPS_EMBED_ENABLED: 'true',
          VITE_GOOGLE_MAPS_ENTITLEMENT_APPROVED: 'true',
          VITE_GOOGLE_MAPS_STORAGE_APPROVED: 'true',
          VITE_GOOGLE_MAPS_ATTRIBUTION_APPROVED: 'true',
        }
      : {
          VITE_GOOGLE_MAPS_BROWSER_KEY: import.meta.env
            .VITE_GOOGLE_MAPS_BROWSER_KEY,
          VITE_GOOGLE_MAPS_EMBED_ENABLED: import.meta.env
            .VITE_GOOGLE_MAPS_EMBED_ENABLED,
          VITE_GOOGLE_MAPS_ENTITLEMENT_APPROVED: import.meta.env
            .VITE_GOOGLE_MAPS_ENTITLEMENT_APPROVED,
          VITE_GOOGLE_MAPS_STORAGE_APPROVED: import.meta.env
            .VITE_GOOGLE_MAPS_STORAGE_APPROVED,
          VITE_GOOGLE_MAPS_ATTRIBUTION_APPROVED: import.meta.env
            .VITE_GOOGLE_MAPS_ATTRIBUTION_APPROVED,
          VITE_BAIDU_MAPS_BROWSER_KEY: import.meta.env
            .VITE_BAIDU_MAPS_BROWSER_KEY,
          VITE_BAIDU_MAPS_EMBED_ENABLED: import.meta.env
            .VITE_BAIDU_MAPS_EMBED_ENABLED,
          VITE_BAIDU_MAPS_ENTITLEMENT_APPROVED: import.meta.env
            .VITE_BAIDU_MAPS_ENTITLEMENT_APPROVED,
          VITE_BAIDU_MAPS_STORAGE_APPROVED: import.meta.env
            .VITE_BAIDU_MAPS_STORAGE_APPROVED,
          VITE_BAIDU_MAPS_ATTRIBUTION_APPROVED: import.meta.env
            .VITE_BAIDU_MAPS_ATTRIBUTION_APPROVED,
          VITE_BAIDU_MAPS_COORDINATES_APPROVED: import.meta.env
            .VITE_BAIDU_MAPS_COORDINATES_APPROVED,
        },
  ),
  new MapSdkLoader(document, window as unknown as Record<string, unknown>),
  window as unknown as Record<string, unknown>,
);
if (sdkHarness) {
  const real = mapSlots.GOOGLE;
  mapSlots.GOOGLE = {
    provider: 'GOOGLE',
    embedded: real.embedded,
    synthetic: true,
    mount: real.mount.bind(real),
    externalMapUrl: real.externalMapUrl.bind(real),
    externalNavigationUrl: real.externalNavigationUrl.bind(real),
  };
}
// DEV evidence still consumes the real regional API/composition, but never loads a Provider.
if (
  import.meta.env.DEV &&
  new URLSearchParams(location.search).get('mapHarness') ===
    'SYNTHETIC_REGIONAL'
) {
  const state = new URLSearchParams(location.search).get('mapState');
  for (const provider of ['GOOGLE', 'BAIDU'] as const) {
    const real = mapSlots[provider];
    const synthetic = new SyntheticMapAdapter(
      state === 'failure' || state === 'slow' || state === 'hang'
        ? state
        : 'ready',
    );
    mapSlots[provider] = {
      provider,
      embedded: true,
      synthetic: true,
      mount: synthetic.mount.bind(synthetic),
      externalMapUrl: real.externalMapUrl.bind(real),
      externalNavigationUrl: real.externalNavigationUrl.bind(real),
    };
  }
}
const regionalMaps = new RegionalMapComposition(
  () =>
    trip &&
    currentUserId &&
    sessionStorage.getItem(tokenKey) &&
    requestedTripId === trip.id &&
    !viewingBackup
      ? { owner: currentUserId, trip }
      : null,
  (id, nodeId, signal) =>
    api.request(
      `/trips/${id}/places/${nodeId}/provider-capability`,
      undefined,
      signal,
    ),
  mapSlots,
);
if (regionMapAdapter() === unconfiguredMapAdapter)
  configureMapAdapter(regionalMaps);
function backupFallback() {
  const saved = localBackups(currentUserId).filter(
    (b) => !requestedTripId || b.tripId === requestedTripId,
  );
  return `<section class="backup-fallback"><h2>静态行程备份</h2><p>与在线行程独立，此内容不会自动更新。</p>${saved.length ? saved.map((b) => `<button data-local-backup="${b.tripId}">查看最近备份 · ${esc(b.name)}</button><p class="muted">备份生成于 ${esc(backupTimestamp(b.generatedAt))}</p>`).join('') : '<p>暂无可用备份。本机没有保存的静态备份；服务恢复后可查看或生成。</p>'}</section>`;
}
function renderMaterials() {
  if (materialsVerifying && !viewingBackup) {
    root.innerHTML =
      '<header><button data-action="close-materials">‹ 返回行程</button><div class="brand">TRAVEL</div></header><main class="essentials"><h1>旅行资料 / 备份</h1><p role="status">正在核验在线行程资料…</p></main>';
    return;
  }
  const value = viewingBackup ?? (trip ? liveEssentials(trip, inTrip) : null);
  root.innerHTML = `<header><button data-action="close-materials">‹ ${trip ? '返回行程' : '返回'}</button><div class="brand">TRAVEL</div></header><main class="essentials">${viewingBackup ? `<p class="backup-label">正在查看备份</p><h1>静态行程备份</h1><p class="backup-stamp">备份生成于 ${esc(backupTimestamp(viewingBackup.generatedAt))}</p><details class="technical-details"><summary>备份资料详情</summary><p>资料版本 ${viewingBackup.tripVersion}</p></details><p></p><p class="backup-warning">此内容不会自动更新。${trip && trip.id === viewingBackup.tripId ? (trip.version !== viewingBackup.tripVersion ? `在线行程已有修改，这份备份保留生成时的内容。` : '版本与已读取的在线行程一致，交通和航班信息仍是保存时的内容。') : '服务暂时不可用，无法核验在线版本。'} 保存时预计时间不是现在重新查询的结果。</p><div class="backup-actions"><button data-action="download-backup">下载静态文件</button>${trip ? `<button data-action="live-essentials" ${materialsVerifying ? 'disabled' : ''}>查看在线旅行资料</button>` : ''}</div>` : `<p class="eyebrow">在线行程资料</p><h1>旅行资料 / 备份</h1><p>地点、备注与已保存的交通信息。先查看在线行程；备份由你主动更新。</p><div class="backup-actions"><button class="primary" data-action="generate-backup" ${busy ? 'disabled' : ''}>更新离线备份</button>${latestBackup ? '<button data-action="view-backup">查看最近备份</button>' : '<span>暂无可用备份</span>'}</div><p class="muted">更新后会在此浏览器保存一份私人备份，包含备注。共享设备请退出以清除本机副本；下载文件需自行保管。</p>${latestBackup ? `<p>最近备份生成于 ${esc(backupTimestamp(latestBackup.generatedAt))}</p>` : ''}`}<p role="status">${esc(backupNotice)}</p>${value ? essentialsBody(value, !!viewingBackup) : '<p>暂无可用资料。</p>'}${viewingBackup ? '<p class="muted">此备份只供查看。行程修改后，请主动更新备份。</p>' : ''}</main>`;
}
async function openMaterials() {
  if (!trip || busy || (detail.open && !(await drawerClose()))) return;
  const basis = trip,
    owner = currentUserId,
    credential = sessionStorage.getItem(tokenKey),
    navigation = epoch,
    request = ++materialsRead;
  const active = () =>
    request === materialsRead &&
    materialsOpen &&
    navigation === epoch &&
    currentUserId === owner &&
    sessionStorage.getItem(tokenKey) === credential &&
    trip?.id === basis.id &&
    trip.version === basis.version;
  materialsOpen = true;
  materialsVerifying = true;
  // Keep the explicitly opened static artifact while verifying either entry.
  backupNotice = viewingBackup ? '正在核验在线行程资料…' : '';
  inTrip = null;
  inTripReadUnavailable = true;
  render();
  try {
    // Auxiliary failures do not establish a core outage. Verify the authority.
    const fresh = await api.request<TripView>(`/trips/${basis.id}`);
    if (!active()) return;
    if (fresh.id !== basis.id || fresh.version !== basis.version)
      throw new WebError(409, 'VERSION_CONFLICT', '行程已变化，请重新载入。');
    trip = fresh;
    const reads = await Promise.allSettled([
      api.request<import('@travel/contracts').LatestStaticBackupResponse>(
        `/trips/${basis.id}/backup`,
      ),
      api.request<InTripView>(`/trips/${basis.id}/in-trip`),
    ]);
    if (!active()) return;
    backupNotice = '';
    const [backup, evidence] = reads;
    for (const result of reads)
      if (
        result.status === 'rejected' &&
        result.reason instanceof WebError &&
        [401, 403, 404].includes(result.reason.status)
      )
        throw result.reason;
    if (backup.status === 'fulfilled') latestBackup = backup.value.backup;
    else {
      latestBackup =
        viewingBackup ??
        localBackups(owner).find((b) => b.tripId === basis.id) ??
        null;
      backupNotice = latestBackup
        ? '未能读取服务器备份；已有静态备份仍可查看。'
        : '未能读取服务器备份；暂无可用备份。';
    }
    if (evidence.status === 'fulfilled') {
      if (
        evidence.value.tripId !== basis.id ||
        evidence.value.tripVersion !== basis.version
      )
        throw new WebError(409, 'VERSION_CONFLICT', '行程已变化，请重新载入。');
      inTrip = evidence.value;
      inTripReadUnavailable = false;
      inTripReadAt = new Date().toISOString();
    } else backupNotice += ' 航班资料暂时无法读取。';
    materialsVerifying = false;
    viewingBackup = null;
    render();
  } catch (error) {
    if (!active()) return;
    // An explicitly opened artifact may have no persistent device copy.
    const keepStatic =
      !!viewingBackup &&
      error instanceof WebError &&
      (error.status >= 500 || (error.status === 0 && error.code === 'NETWORK'));
    materialsOpen = keepStatic;
    materialsVerifying = false;
    if (!keepStatic) viewingBackup = null;
    trip = null;
    schedule = null;
    inTrip = null;
    ground = null;
    notice = errorText(error);
    backupNotice = keepStatic ? notice : '';
    if (error instanceof WebError && error.status === 401) {
      sessionStorage.removeItem(tokenKey);
      bindBackupOwner(null);
      currentUserId = null;
      latestBackup = null;
    }
    render();
  }
}
async function generateBackup() {
  if (!trip || !currentUserId || busy) return;
  const basis = trip,
    owner = currentUserId;
  backupPending ??= {
    tripId: basis.id,
    baseTripVersion: basis.version,
    idempotencyKey: crypto.randomUUID(),
  };
  if (backupPending.tripId !== basis.id)
    backupPending = {
      tripId: basis.id,
      baseTripVersion: basis.version,
      idempotencyKey: crypto.randomUUID(),
    };
  busy = true;
  backupNotice = '正在生成备份…';
  render();
  try {
    const b = await api.request<import('@travel/contracts').StaticBackupView>(
      `/trips/${basis.id}/backup`,
      {
        baseTripVersion: backupPending.baseTripVersion,
        idempotencyKey: backupPending.idempotencyKey,
      },
    );
    backupPending = null;
    if (currentUserId !== owner || b.tripId !== basis.id) return;
    latestBackup = b;
    try {
      saveLocalBackup(owner, b);
      backupNotice =
        '备份已生成并保存在此浏览器。可下载静态文件，离开网页后也能查看。';
    } catch {
      backupNotice =
        '服务器备份已生成，但本机保存失败。请下载静态文件以供断网时查看。';
    }
    viewingBackup = b;
  } catch (e) {
    if (
      e instanceof WebError &&
      !['NETWORK', 'SERVICE_UNAVAILABLE'].includes(e.code)
    )
      backupPending = null;
    backupNotice = errorText(e) + ' 旧备份仍保留。';
    if (
      e instanceof WebError &&
      ([401, 403, 404].includes(e.status) ||
        ['NETWORK', 'SERVICE_UNAVAILABLE'].includes(e.code))
    ) {
      trip = null;
      schedule = null;
      materialsOpen = false;
      viewingBackup = null;
      notice = errorText(e);
      if (e.status === 401) {
        sessionStorage.removeItem(tokenKey);
        bindBackupOwner(null);
        currentUserId = null;
      }
    }
  } finally {
    busy = false;
    render();
  }
}

let detailBasis: { userId: string; tripId: string; nodeId: string } | null =
  null;
let recoveryRequired = false;
let acceptedWrite = '';
const dirtyForms = new Set<string>();
const formBaselines = new Map<string, string>();
let routeCandidates: readonly RouteCandidateView[] = [];
let preview: RoutePreviewView | null = null;
let receipt: OperationReceiptView | null = null;
let pendingAlternativeAdopt: {
  ownerUserId: string;
  tripId: string;
  previewId: string;
  input: AdoptRoutePreviewRequest;
} | null = null;
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
function savedForm(id: string, submitted: string) {
  const form = detail.querySelector<HTMLFormElement>(`#${id}`);
  formBaselines.set(id, submitted);
  if (form && formValue(form) !== submitted) dirtyForms.add(id);
  else dirtyForms.delete(id);
  draftDirty = dirtyForms.size > 0;
}
function discardFormDrafts() {
  for (const id of dirtyForms) {
    const form = detail.querySelector<HTMLFormElement>(`#${id}`);
    const baseline = formBaselines.get(id);
    if (!form || !baseline) continue;
    const values = new Map<string, string>(JSON.parse(baseline));
    for (const field of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >('[name]')) {
      if (field instanceof HTMLInputElement && field.type === 'checkbox')
        field.checked = values.has(field.name);
      else field.value = values.get(field.name) ?? '';
    }
    const zone = form.querySelector<HTMLSelectElement>('[data-zone]');
    if (zone) zone.value = values.get('zone') ?? '';
  }
  dirtyForms.clear();
  draftDirty = false;
}
function removalControls(n: ItineraryNodeView) {
  return n.timeIntents
    .map(
      (i) =>
        `<button class="remove-intent" data-intent="${i.id}">移除${i.kind === 'MIN_DWELL' ? '停留' : i.pointKind === 'ARRIVAL' ? '到达' : '出发'}${i.kind === 'MIN_DWELL' ? '' : { EXACT: '指定', NOT_AFTER: '最晚', NOT_BEFORE: '最早', MINIMUM: '' }[i.operator]}要求</button>`,
    )
    .join('');
}
function refreshIntentControls(n: ItineraryNodeView) {
  const summary = detail.querySelector('[data-requirements]');
  if (summary) summary.innerHTML = requirements(n);
  const controls = detail.querySelector('[data-remove-intents]');
  if (controls) {
    controls.innerHTML = removalControls(n);
    if (busy)
      controls
        .querySelectorAll<HTMLButtonElement>('button')
        .forEach((button) => {
          button.dataset.wasDisabled = 'false';
          button.disabled = true;
        });
  }
}
const drawer = new DetailDrawer(
  detail,
  async () => {
    if (busy) return false;
    const accepted =
      !draftDirty ||
      (await confirmAction('还有未保存的修改。放弃后将恢复已保存的内容。'));
    return accepted && !busy;
  },
  () => {
    authoring.reset();
    selection = null;
    pendingAlternativeAdopt = null;
    preview = null;
    routeCandidates = [];
    draftDirty = false;
    recoveryRequired = false;
    detailBasis = null;
    dirtyForms.clear();
    formBaselines.clear();
    epoch++;
  },
);
const authoring = new TripAuthoringEditor({
  api,
  detail,
  getTrip: () => trip,
  getOwner: () => currentUserId,
  days: () => (trip ? editorDays(trip, temporaryDays) : []),
  open: (title, html) => {
    selection = null;
    detailBasis = null;
    recoveryRequired = false;
    drawer.open(frame(title, html), title === '新建旅行' ? 'modal' : 'drawer');
  },
  act: (operation) => {
    void act(operation);
  },
  dirty: (value) => {
    draftDirty = value;
  },
  message: status,
  created: async () => {
    disableBusy(false);
    await drawer.close();
  },
  load: loadTrip,
  accepted: async (fresh, command) => {
    trip = fresh;
    inTrip = null;
    ground = null;
    notice = '';
    acceptedWrite = '本次提交已保存到服务器';
    if (!command || command.targetDay.type === 'NEW') temporaryDays = [];
    dayId = authoring.dayKey;
    routeCandidates = [];
    preview = null;
    receipt = null;
    epoch++;
    schedule = await api.request<ScheduleProjectionView>(
      `/trips/${fresh.id}/schedule/evaluate`,
      { basisVersion: fresh.version },
    );
    if (schedule.tripId !== fresh.id || schedule.basisVersion !== fresh.version)
      throw new WebError(
        409,
        'VERSION_CONFLICT',
        '行程版本已变化，请重新载入。',
      );
    if (viewMode === 'today') await readInTrip(fresh, epoch);
    render();
  },
});
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${({ pin: 'M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6', arrow: 'm5 12 14 0m-5-5 5 5-5 5', close: 'm6 6 12 12M6 18 18 6', calendar: 'M5 5h14v15H5zM8 2v6m8-6v6M5 10h14', route: 'M6 5a2 2 0 1 0 0 .1M18 19a2 2 0 1 0 0 .1M8 5h6a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 6h6', clock: 'M12 3a9 9 0 1 0 .1 0M12 7v5l3 2' } as Record<string, string>)[name] ?? 'M5 12h14'}"/></svg>`;
function projection(id: string): ScheduleNodeProjectionView | undefined {
  return schedule?.tripId === trip?.id &&
    schedule?.basisVersion === trip?.version
    ? schedule?.nodes.find((n) => n.nodeId === id)
    : undefined;
}
function node(id: string) {
  return trip ? orderedNodes(trip).find((n) => n.id === id) : undefined;
}
function nodeTitle(n: ItineraryNodeView) {
  return arrangementName(n);
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
        `<div><span>${label}${v ? ` · ${temporalLabel(v)}` : ''}</span><strong>${esc(formatTime(v, dayDate(n.dayOccurrenceId)))}</strong>${v ? `<small class="time-zone" title="${esc(v.timeZone)}">当地时间</small>` : ''}</div>`,
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
function modeSwitch() {
  return `<div class="essentials-entry"><button data-action="essentials">旅行资料 / 备份</button></div><nav class="view-switch" aria-label="查看方式"><button data-view="today" aria-pressed="${viewMode === 'today'}">今天 / 下一步</button><button data-view="itinerary" aria-pressed="${viewMode === 'itinerary'}">全部日程</button></nav>`;
}
async function readInTrip(fresh: TripView, request: number) {
  tripImpact = null;
  const results = await Promise.allSettled([
    api.request<InTripView>(`/trips/${fresh.id}/in-trip`),
    api.request<GroundTransitExecutionResponse>(
      `/trips/${fresh.id}/execution/ground-transit`,
    ),
    api.request<TripImpactView>(`/trips/${fresh.id}/impact`),
  ]);
  if (request !== epoch) return;
  for (const result of results)
    if (
      result.status === 'rejected' &&
      result.reason instanceof WebError &&
      [401, 403].includes(result.reason.status)
    ) {
      trip = null;
      schedule = null;
      inTrip = null;
      ground = null;
      concealUnavailableDetails();
      throw result.reason;
    }
  for (const result of results) {
    if (
      result.status === 'fulfilled' &&
      (result.value.tripId !== fresh.id ||
        ('tripVersion' in result.value
          ? result.value.tripVersion
          : result.value.basisVersion) !== fresh.version)
    )
      throw new WebError(
        409,
        'VERSION_CONFLICT',
        '行程版本已变化，请重新载入。',
      );
  }
  const [stored, transit, impact] = results;
  tripImpact = impact.status === 'fulfilled' ? impact.value : null;
  if (
    impact.status === 'rejected' &&
    impact.reason instanceof WebError &&
    impact.reason.code === 'VERSION_CONFLICT'
  )
    throw impact.reason;
  inTrip =
    stored?.status === 'fulfilled' &&
    stored.value.tripId === fresh.id &&
    stored.value.tripVersion === fresh.version
      ? stored.value
      : null;
  ground =
    transit?.status === 'fulfilled' &&
    transit.value.tripId === fresh.id &&
    transit.value.tripVersion === fresh.version
      ? transit.value
      : null;
  inTripReadUnavailable = !inTrip;
  inTripReadAt = new Date().toISOString();
}
function stepTitle(step: InTripStep) {
  return step.kind === 'node'
    ? arrangementName(step.node)
    : `${modeLabel[step.connection.transport!.mode]} · ${step.connection.transport!.serviceLabel ?? '已选交通'}`;
}
function stepDetailButton(step: InTripStep, label = '查看完整详情') {
  return step.kind === 'node'
    ? `<button data-node="${step.node.id}">${label}</button>`
    : `<button data-route-from="${step.routeFrom}" data-route-to="${step.routeTo}">${label}</button>`;
}
function todayEdge(edge: TransportEdgeView, index: number | null) {
  const matches =
    ground?.legs.filter(
      (l) =>
        l.transportEdgeId === edge.id &&
        l.adoptedRouteId === edge.adoptedRouteId &&
        l.legIndex === index,
    ) ?? [];
  const health =
    matches.length === 1 ? matches[0]!.safety.boarding.realtimeFreshness : null;
  const flight = inTrip?.flights.find((f) => f.transportEdgeId === edge.id);
  const unknown =
    (['BUS', 'RAIL'].includes(edge.mode) && health !== 'FRESH') ||
    (edge.mode === 'FLIGHT' && (!flight || flight.providerUnavailable));
  return unknown
    ? {
        ...edge,
        timeValues: edge.timeValues.filter((v) => v.layer !== 'ESTIMATED'),
      }
    : edge;
}
function originalChanged(
  leg: RouteCandidateLegView,
  edge: TransportEdgeView | null,
) {
  return (
    !edge ||
    Date.parse(transportTime(edge.timeValues, 'DEPARTURE')?.instant ?? '') !==
      Date.parse(leg.departure?.instant ?? '') ||
    Date.parse(transportTime(edge.timeValues, 'ARRIVAL')?.instant ?? '') !==
      Date.parse(leg.arrival?.instant ?? '')
  );
}
function todayTransport(step: Extract<InTripStep, { kind: 'transport' }>) {
  const edge =
    trip!.connections.find(
      (c) => c.transport?.id === step.connection.transport?.id,
    )?.transport ?? step.connection.transport!;
  const saved = trip!.savedRoutes?.find(
    (r) => r.adoptedRouteId === edge.adoptedRouteId,
  );
  const leg =
    saved && step.legIndex !== null ? saved.legs[step.legIndex] : null;
  const matches =
    ground?.legs.filter(
      (l) =>
        l.transportEdgeId === edge.id &&
        l.adoptedRouteId === edge.adoptedRouteId &&
        l.legIndex === step.legIndex,
    ) ?? [];
  const freshness =
    matches.length === 1 ? matches[0]!.safety.boarding.realtimeFreshness : null;
  const flight = inTrip?.flights.find((f) => f.transportEdgeId === edge.id);
  const stale =
    (edge.mode === 'FLIGHT' && (!flight || flight.providerUnavailable)) ||
    freshness === 'STALE' ||
    freshness === 'UNAVAILABLE' ||
    (!ground && ['BUS', 'RAIL'].includes(edge.mode));
  const current = todayEdge(edge, step.legIndex);
  const status =
    !ground && ['BUS', 'RAIL'].includes(edge.mode)
      ? '实时状态暂不可用'
      : stale
        ? freshness === 'STALE'
          ? '更新已过期；实时状态未知'
          : '实时状态暂不可用'
        : edge.timeValues.some((v) => v.sourceKind === 'PROVIDER_OBSERVATION')
          ? '已保存交通更新；不保证实时'
          : '暂无实时更新';
  const observation = edge.timeValues
    .filter((v) => v.sourceKind === 'PROVIDER_OBSERVATION')
    .map((v) => v.observedAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
  const update = `<p class="realtime-status">${status}${observation ? `<small>信息更新于 ${esc(observation.replace('T', ' ').replace('Z', ' UTC'))}</small>` : ''}</p>`;
  const target = node(step.connection.toNodeId)?.place;
  const endpointNavigation =
    target && ['WALKING', 'DRIVING', 'TAXI'].includes(edge.mode)
      ? navigation(target, undefined, mapMode(edge.mode))
      : null;
  let body = leg
    ? `<ol class="legs next-leg">${legView(leg, current, true, originalChanged(leg, current))}</ol>`
    : `<h3>${esc(stepTitle(step))}</h3>${transportClock(current)}${endpointNavigation ? `<p>终点：${esc(target!.name)}</p><div class="segment-actions"><a href="${esc(endpointNavigation)}" target="_blank" rel="noopener noreferrer">${edge.mode === 'WALKING' ? '步行' : '驾车'}到分段终点</a></div>` : '<p class="muted">上/下车地点未保存，暂无可靠上车点导航。</p>'}`;
  if (stale && edge.timeValues.some((v) => v.layer === 'ESTIMATED'))
    body +=
      '<p class="muted">此前预计已失去实时可靠性；当前显示计划或已保存车辆实测。</p>';
  const transfer =
    saved && saved.legs.length > 1
      ? `<details class="transfer-details"><summary>查看完整换乘 · ${saved.legs.length} 段</summary><ol class="legs">${saved.legs
          .map((l, i) => {
            const proven = savedLegTransport(saved, i, trip!.connections);
            const current = proven ? todayEdge(proven, i) : null;
            return legView(l, current, true, originalChanged(l, current));
          })
          .join('')}</ol></details>`
      : '';
  return update + body + transfer + stepDetailButton(step, '查看整段路线');
}
function flightMovement(
  m: FlightMovementView,
  protectedActual: TemporalValueView | null = null,
  unavailable = false,
) {
  const point = (instant: string | null) =>
    instant && m.timeZone ? { instant, timeZone: m.timeZone } : null;
  const current =
    protectedActual?.instant ??
    m.runwayUtc ??
    (unavailable ? null : (m.revisedUtc ?? m.predictedUtc)) ??
    m.scheduledUtc;
  const label =
    protectedActual || m.runwayUtc
      ? '车辆实测 · 跑道时间'
      : !unavailable && m.revisedUtc
        ? '修订 / 预计'
        : !unavailable && m.predictedUtc
          ? '预测 · 非实际'
          : '计划';
  return `<p class="flight-clock"><span>${label}</span><strong>${esc(formatTime(point(current)))}</strong>${current !== m.scheduledUtc ? `<small>原计划 ${esc(formatTime(point(m.scheduledUtc)))}</small>` : ''}</p>${protectedActual && m.runwayUtc && Date.parse(protectedActual.instant) !== Date.parse(m.runwayUtc) ? '<p class="warning">供应商跑道时间与已保护车辆事实不一致，请核对。</p>' : ''}${unavailable && (m.revisedUtc || m.predictedUtc) ? '<small>此前预计暂无实时核验，当前保留计划或车辆实测。</small>' : ''}<p>${esc(m.airportName ?? m.airportIata ?? '机场待定')}<br>航站楼 ${esc(m.terminal ?? '待定')} · 登机口 ${esc(m.gate ?? '待定')}</p>`;
}
function todayFlights(edgeId: string | null) {
  const flights =
    inTrip && inTrip.tripVersion === trip?.version
      ? inTrip.flights.filter((f) => edgeId === f.transportEdgeId)
      : [];
  const edge = trip?.connections.find(
    (c) => c.transport?.id === edgeId,
  )?.transport;
  const actual = (kind: 'DEPARTURE' | 'ARRIVAL') =>
    edge?.timeValues.find(
      (v) =>
        v.pointKind === kind &&
        v.layer === 'ACTUAL' &&
        v.sourceKind === 'PROVIDER_OBSERVATION',
    ) ?? null;
  const status: Record<string, string> = {
    SCHEDULED: '计划',
    BOARDING: '登机中',
    DEPARTED: '已起飞',
    EN_ROUTE: '飞行中',
    LANDED: '已落地',
    ARRIVED: '已抵达',
    DELAYED: '供应商报告延误',
    CANCELLED: '已取消',
    DIVERTED: '已备降',
    UNKNOWN: '未知',
  };
  return flights
    .map(
      (f) =>
        `<section class="flight-info"><h3>航班 ${esc(f.latestSnapshot.displayFlightNumber)}</h3><p class="muted">${f.providerUnavailable ? '实时状态暂不可用' : '已保存航班信息；暂无实时核验'}<br>信息更新于 ${esc(f.latestSnapshot.fetchedAt.replace('T', ' ').replace('Z', ' UTC'))}</p><p>已保存航班状态：${esc(status[f.latestSnapshot.status] ?? '未知')}（车辆状态）</p><div class="flight-movements"><div><h4>起飞</h4>${flightMovement(f.latestSnapshot.departure, actual('DEPARTURE'), f.providerUnavailable)}</div><div><h4>抵达</h4>${flightMovement(f.latestSnapshot.arrival, actual('ARRIVAL'), f.providerUnavailable)}</div></div><p>行李转盘 ${esc(f.latestSnapshot.arrival.baggageBelt ?? '待定')}</p><small>车辆实测不表示你本人已经登机、出发或到达。</small><details><summary>更多航班资料</summary><p>机型 ${esc(f.latestSnapshot.aircraft?.model ?? '待定')}</p><p>航空公司 ${esc(f.latestSnapshot.airline.name ?? '待定')}</p></details></section>`,
    )
    .join('');
}
function renderToday() {
  if (!trip) return;
  let deviceZone: string | null = null;
  try {
    deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    /* unknown */
  }
  const displayTrip: TripView = {
    ...trip,
    connections: trip.connections.map((c) => {
      const edge = c.transport;
      if (!edge) return c;
      const route = trip!.savedRoutes?.find(
        (r) => r.adoptedRouteId === edge.adoptedRouteId,
      );
      const index =
        route?.legs.findIndex(
          (_, i) =>
            savedLegTransport(route, i, trip!.connections)?.id === edge.id,
        ) ?? -1;
      return { ...c, transport: todayEdge(edge, index >= 0 ? index : null) };
    }),
  };
  const p = inTripProjection(
    displayTrip,
    schedule,
    inTrip,
    new Date(),
    deviceZone,
  );
  const step = p.step;
  const title = p.context
    ? `${p.context.localDate} · ${p.context.clock}`
    : '当前日期未知';
  const body = step
    ? step.kind === 'node'
      ? `<h2>${esc(stepTitle(step))}</h2>${step.node.place ? (step.node.place.address ? '' : '<p class="muted">地址待定</p>') : '<p class="muted">自由行动 · 地点待定</p>'}${timeGrid(step.node)}${requirements(step.node)}${projection(step.node.id)?.status === 'VIOLATED' || projection(step.node.id)?.status === 'CONFLICT' ? '<p class="warning">当前安排与重要时间要求有冲突，请查看详情。</p>' : ''}<p class="action-time">${step.end ? `${temporalLabel(step.end)} ${esc(formatTime(step.end, p.day?.localDate))} 出发` : step.start ? `${temporalLabel(step.start)} ${esc(formatTime(step.start, p.day?.localDate))} 到达` : '时间待定'}<small>暂时无法确定建议出发时间</small></p>${step.node.place ? mapLinks(step.node.place) : ''}${stepDetailButton(step)}`
      : todayTransport(step) +
        todayFlights(step.connection.transport?.id ?? null)
    : `<div class="empty">${!p.context ? '缺少可靠时间上下文，请查看全部日程。' : p.ambiguous ? '今天有重复日期卡，当前进度未知；请在全部日程中选择日期卡。' : !p.day ? '今天没有这趟旅行的安排。' : '今天还没有安排。'}</div>`;
  const impactTone = impactPresentation(trip, tripImpact).tone;
  const urgentImpact = impactTone === 'replan' || impactTone === 'attention';
  const nextTransport = p.following.find((s) => s.kind === 'transport');
  const flightEdge =
    nextTransport?.kind === 'transport' &&
    nextTransport.connection.transport?.mode === 'FLIGHT'
      ? nextTransport.connection.transport.id
      : null;
  root.innerHTML = `<header><button data-action="trips" class="back">‹ 旅行</button><div class="brand">${icon('route')} TRAVEL</div><button data-action="reload">重新载入</button></header>${modeSwitch()}<main class="in-trip"><div class="today-heading"><p class="eyebrow">今天 · ${esc(p.context?.timeZone ?? '时区未知')} · 设备时区</p><h1>${esc(title)}</h1><p>${esc(trip.name)}</p></div>${p.day ? `<div class="authoring-toolbar"><button data-action="add-arrangement" data-authoring-day="${p.day.dayOccurrenceId}" ${p.day.transportProjections.some((v) => v.role === 'OCCUPIED') ? 'disabled' : ''}><span class="control-content">${icon('pin')}添加安排</span></button></div>` : ''}${banner()}<p class="progress-status" role="status">${esc(p.progress)}<small>${p.progress === '当前进度未知' ? '按时间查看计划，不代表你已经到达或出发。' : '基于已有用户记录，不是当前定位。'}</small></p>${inTripReadUnavailable ? '<p class="warning">执行记录与航班资料暂不可用，按计划查看。</p>' : ''}${urgentImpact ? impactSummary(trip, tripImpact, true) : ''}<article class="next-step"><p class="eyebrow">${p.past ? '计划时间已过 · 请核对安排' : step?.kind === 'transport' ? '按计划接下来 · 下一段交通' : '按计划接下来'}</p>${body}</article>${urgentImpact ? '' : impactSummary(trip, tripImpact, true)}${receipt ? '<div class="undo"><span>已使用新的路线</span><button data-action="undo"><span class="control-content">撤销刚才的路线修改</span></button></div>' : ''}${p.following.length ? `<section class="following"><h3>接下来</h3>${p.following.map((s) => `<article><p>${esc(stepTitle(s))}<small>${s.start ? `${temporalLabel(s.start)} ${esc(formatTime(s.start))}` : '时间待定'}</small></p>${stepDetailButton(s, '查看详情')}</article>`).join('')}</section>` : ''}${flightEdge ? todayFlights(flightEdge) : ''}<p class="read-context">${inTripReadAt ? `行程读取于 ${esc(inTripReadAt.replace('T', ' ').replace('Z', ' UTC'))}。` : ''}查看和导航不会改变行程。需要更新时请重新载入。</p><button data-view="itinerary">查看全部日程</button></main>`;
}
function render() {
  if (
    regionalMaps.sync() &&
    regionMapAdapter() === regionalMaps &&
    trip &&
    !viewingBackup
  ) {
    const basis = trip,
      owner = currentUserId;
    void regionalMaps.preload().then(() => {
      if (
        !regionalMaps.sync() &&
        trip?.id === basis.id &&
        trip.version === basis.version &&
        currentUserId === owner &&
        !viewingBackup
      )
        render();
    });
  }
  if (materialsOpen && (viewingBackup || trip)) {
    renderMaterials();
    return;
  }
  if (!sessionStorage.getItem(tokenKey)) {
    root.innerHTML = `<main class="login"><div class="brand">${icon('route')} TRAVEL</div><h1>把旅行安排好</h1><p>使用受邀邮箱登录，查看你的旅行。</p>${banner()}<form id="login"><label>邮箱<input name="email" type="email" autocomplete="email" required></label><button class="primary">发送登录链接</button></form><p class="muted">只向已获邀请的账户提供登录链接。</p></main>`;
    return;
  }
  if (!trip) {
    root.innerHTML = `<header><div class="brand">${icon('route')} TRAVEL</div><div class="header-actions"><button data-action="reload">重新载入</button><button data-action="logout">退出</button></div></header><main class="trip-list"><div class="page-heading"><h1>你的旅行</h1><button data-action="create-trip" class="primary"><span class="control-content">${icon('calendar')}新建旅行</span></button></div>${banner()}<div id="trips">${notice ? '暂时无法读取在线行程。' : '正在读取旅行…'}</div>${notice ? backupFallback() : ''}</main>`;
    return;
  }
  if (viewMode === 'today') {
    renderToday();
    return;
  }
  const days = editorDays(trip, temporaryDays);
  const day = days.find((d) => d.key === dayId) ?? days[0];
  dayId = day?.key ?? '';
  const shownNodes =
    day?.nodes.filter((n) => !isFoldedTransfer(trip!, n)) ?? [];
  root.innerHTML = `<header><button data-action="trips" class="back">‹ 旅行</button><div class="brand">${icon('route')} TRAVEL</div><button data-action="reload">重新载入</button></header>${modeSwitch()}<main class="workspace"><aside class="date-sidebar"><p class="eyebrow">这次旅行</p><h1>${esc(trip.name)}</h1><p class="muted">${trip.defaultPeopleCount} 人 · ${esc(trip.effectiveStartDate ?? trip.planningAnchorDate)}</p><nav aria-label="旅行日期">${days.map((d, i) => `<button data-day="${d.key}" class="${d.key === dayId ? 'selected' : ''}"><span class="control-content">${icon('calendar')}<span>第 ${i + 1} 天<small>${esc(d.localDate)}${d.temporary ? ' · 待添加' : ''}</small></span></span></button>`).join('')}</nav><div class="date-extension"><button data-action="previous-day"><span class="control-content">${icon('calendar')}添加前一天</span></button><button data-action="next-day"><span class="control-content">${icon('calendar')}添加下一天</span></button></div></aside><section class="itinerary"><div class="page-heading"><div><p class="eyebrow">按计划查看</p><h2>${esc(day?.localDate ?? '日程')}</h2><p class="mobile-trip">${esc(trip.name)}</p></div><span class="badge"><span class="control-content">${shownNodes.length} 个安排</span></span></div>${day?.temporary ? '<p class="temporary-day-note">这是临时规划日，添加有效安排后才占用日期；离开或刷新不会保留空白日。</p>' : ''}<div class="authoring-toolbar"><button class="primary" data-action="add-arrangement" ${day?.occupied ? 'disabled' : ''}><span class="control-content">${icon('pin')}添加安排</span></button></div>${banner()}${receipt ? '<div class="undo"><span>已使用新的路线</span><button data-action="undo">撤销刚才的路线修改</button></div>' : ''}<div class="timeline">${
    shownNodes.length
      ? shownNodes
          .map((n) => {
            const chain = routeConnections(trip!, n.id);
            const connection = chain[0]
              ? { ...chain[0], toNodeId: chain.at(-1)!.toNodeId }
              : undefined;
            return `<article class="place-card"><button class="place-open" data-node="${n.id}"><span class="place-icon">${icon('pin')}</span><span><strong>${esc(nodeTitle(n))}</strong><small>${esc(n.place?.address ?? (n.place ? '地址未提供' : '未指定地点'))}</small></span><span aria-hidden="true">›</span></button>${timeGrid(n)}${requirements(n)}${projection(n.id)?.status === 'VIOLATED' || projection(n.id)?.status === 'CONFLICT' ? '<p class="warning">当前安排与重要时间要求有冲突，请查看详情。</p>' : ''}<div class="arrangement-actions"><button data-authoring-move="${n.id}"><span class="control-content">${icon('calendar')}调整日期与顺序</span></button></div></article>${connection ? connectionCard(connection) : ''}`;
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
  const savedLeg = edge ? selectedLegForEdge(edge.id) : null;
  const departure = localTransportTime(
    edge ? transportTime(edge.timeValues, 'DEPARTURE') : null,
    savedLeg?.departure?.timeZone,
  );
  const conflict =
    departure && floor && Date.parse(departure.instant) < Date.parse(floor);
  return `<button class="connection ${conflict ? 'conflict' : ''}" data-route-from="${c.fromNodeId}" data-route-to="${c.toNodeId}">${icon('route')}<span><strong>${esc(edge ? `${modeLabel[edge.mode]} · ${edge.serviceLabel ?? '已选交通'}` : '选择交通')}</strong><small>${edge ? `${departure ? temporalLabel(departure) : '待定'} ${esc(formatTime(departure, from ? dayDate(from.dayOccurrenceId) : undefined))} 出发 · 前往 ${esc(to ? nodeTitle(to) : '下一安排')}` : '查看方案或在地图中查询'}</small>${conflict ? '<small class="warning">出发早于当前可出发时间，原路线仍保留</small>' : ''}</span><span>›</span></button>`;
}
function frame(title: string, body: string) {
  return `<div class="sheet-head"><div class="drag-zone" data-drag><div class="handle" aria-hidden="true"></div></div><div class="sheet-title"><h2 id="detail-title">${esc(title)}</h2><button data-close aria-label="关闭详情">${icon('close')}</button></div></div><div class="sheet-body">${body}</div>`;
}
function mapLinks(
  location: MapLocation,
  routeOrigin?: MapLocation,
  transit = false,
) {
  const map = placeMap(location),
    nav = navigation(location, routeOrigin, transit ? 'transit' : 'walking');
  return `<div class="map-links">${map ? `<a href="${esc(map)}" target="_blank" rel="noopener noreferrer">${icon('pin')}查看地图</a>` : '<span>暂无可靠位置，无法打开地图</span>'}${nav ? `<a href="${esc(nav)}" target="_blank" rel="noopener noreferrer">${icon('arrow')}${transit ? '在地图中查询' : '导航到这里'}</a>` : ''}</div>${transit ? '<p class="muted">外部地图会重新查询；不保证保留本方案的日期、班次与票价。</p>' : ''}`;
}
function zoneField(zone: string | null, label: string) {
  const labels: Record<string, string> = {
    'Asia/Tokyo': '东京 / 日本',
    'Asia/Shanghai': '中国',
    'Asia/Hong_Kong': '香港',
    'Europe/London': '伦敦 / 英国',
    'Europe/Paris': '巴黎 / 法国',
    'America/New_York': '纽约 / 美国',
    'America/Los_Angeles': '洛杉矶 / 美国',
    UTC: '协调世界时',
  };
  const zones = [
    ...new Set([
      ...(zone ? [zone] : []),
      ...Object.keys(labels),
      ...Intl.supportedValuesOf('timeZone'),
    ]),
  ];
  return `<input name="zone" type="hidden" value="${esc(zone ?? '')}"><details class="zone-choice" ${zone ? '' : 'open'}><summary>${zone ? `当地时间 · ${esc(labels[zone] ?? zone.split('/').at(-1)?.replaceAll('_', ' '))}（更换地区）` : '请先选择事件所在地'}</summary><label>${esc(label)}<select data-zone><option value="">选择地区</option>${zones.map((z) => `<option value="${esc(z)}" ${z === zone ? 'selected' : ''}>${esc(labels[z] ?? z.replaceAll('_', ' ').replaceAll('/', ' · '))}</option>`).join('')}</select></label></details>`;
}
async function openPlace(n: ItineraryNodeView) {
  if (detail.open && !(await drawerClose())) return;
  selection = { type: 'place', nodeId: n.id };
  detailBasis =
    trip && currentUserId
      ? { userId: currentUserId, tripId: trip.id, nodeId: n.id }
      : null;
  recoveryRequired = false;
  draftDirty = false;
  const zone = nodeZone(n, projection(n.id));
  drawer.open(
    frame(
      nodeTitle(n),
      `<p class="address">${esc(n.place?.address ?? '地址未提供')}</p>${n.place && regionMapAdapter() === unconfiguredMapAdapter ? mapLinks(n.place) : ''}${miniMapMarkup('place')}${timeGrid(n)}<div data-requirements>${requirements(n)}</div><details class="edit"><summary>编辑重要时间要求</summary><p class="muted">要求独立于计划/预计/实际时间，不会改写已发生事实。</p><form id="time-edit" class="editor-group"><h3>到达与出发要求</h3><label>要求<select name="requirement"><option value="ARRIVAL:NOT_AFTER">最晚到达</option><option value="ARRIVAL:NOT_BEFORE">最早到达</option><option value="ARRIVAL:EXACT">指定到达</option><option value="DEPARTURE:NOT_BEFORE">最早出发</option><option value="DEPARTURE:NOT_AFTER">最晚出发</option><option value="DEPARTURE:EXACT">指定出发</option></select></label><label>当地日期与时间<input name="when" type="datetime-local" required></label>${zoneField(zone, '时间要求所在地')}<label class="check"><input name="locked" type="checkbox" checked>保护这项要求</label><button class="primary">保存时间要求</button></form><form id="dwell-edit" class="editor-group"><h3>至少停留</h3><label>至少停留（分钟）<input name="minutes" type="number" min="1" step="1" value="${n.timeIntents.find((i) => i.kind === 'MIN_DWELL')?.durationSeconds ? String(n.timeIntents.find((i) => i.kind === 'MIN_DWELL')!.durationSeconds! / 60) : ''}" required></label><button>保存停留要求</button></form><div data-remove-intents>${removalControls(n)}</div></details><form id="note-edit" class="editor-group"><h3>备注</h3><label>备注<textarea name="note" maxlength="2000" rows="3" placeholder="这处安排需要记住什么？">${esc(n.note ?? '')}</textarea></label><button class="primary">保存备注</button></form><p id="save-status" role="status">已读取服务器数据</p>`,
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
    detail.querySelector<HTMLSelectElement>('#time-edit [data-zone]')!.value =
      existing.timeZone;
    detail.querySelector<HTMLInputElement>(
      '#time-edit input[name=locked]',
    )!.checked = existing.locked;
  }
  mountMiniMap(
    detail.querySelector<HTMLElement>('[data-mini-map]')!,
    'place',
    [n.place ? { ...n.place, nodeId: n.id } : null],
    regionMapAdapter(),
  );
  baselineForms();
}
function refreshPlaceSummary(id: string) {
  const fresh = node(id);
  if (!fresh) return;
  const grid = detail.querySelector('.times');
  if (grid) grid.outerHTML = timeGrid(fresh);
  refreshIntentControls(fresh);
}
async function drawerClose() {
  return drawer.close();
}
function wholeRouteMap(
  from: MapLocation,
  to: MapLocation,
  modes: readonly string[],
) {
  const mode = modes.every((m) => m === 'WALKING')
    ? 'walking'
    : modes.every((m) => ['DRIVING', 'TAXI'].includes(m))
      ? 'driving'
      : modes.every((m) => mapMode(m) !== null)
        ? 'transit'
        : null;
  const link = navigation(to, from, mode);
  return link
    ? `<div class="map-links"><a class="whole-route-map" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${icon('route')}在地图中查询整段</a></div><p class="muted map-disclaimer">外部查询不锁定原班次、日期或票价。${mode ? '' : '请在地图中选择方式。'}</p>`
    : '<p class="muted">原起终点或方式不完整，无法在地图中查询原路线。</p>';
}
function selectedLegForEdge(edgeId: string) {
  for (const route of trip?.savedRoutes ?? []) {
    const links =
      route.legTransportEdges?.filter(
        (link) => link.transportEdgeId === edgeId,
      ) ?? [];
    if (links.length !== 1) continue;
    const legIndex = links[0]!.legIndex;
    if (savedLegTransport(route, legIndex, trip!.connections)?.id === edgeId)
      return route.legs[legIndex] ?? null;
  }
  return null;
}
function localTransportTime(
  value: TemporalValueView | null,
  eventZone?: string | null,
) {
  // Display conversion only. The raw Provider instant, layer/source and stored
  // timezone remain immutable. Event zone comes from a proven saved endpoint.
  return value && eventZone ? { ...value, timeZone: eventZone } : value;
}
function transportClock(
  edge?: TransportEdgeView | null,
  leg?: RouteCandidateLegView,
) {
  const departure = localTransportTime(
    edge ? transportTime(edge.timeValues, 'DEPARTURE') : null,
    leg?.departure?.timeZone,
  );
  const arrival = localTransportTime(
    edge ? transportTime(edge.timeValues, 'ARRIVAL') : null,
    leg?.arrival?.timeZone,
  );
  return clockPairView(
    departure,
    arrival,
    true,
    isAggregateTransit(leg ?? edge),
  );
}
function clockPairView(
  departure: Pick<
    TemporalValueView,
    'instant' | 'timeZone' | 'layer' | 'sourceKind'
  > | null,
  arrival: Pick<
    TemporalValueView,
    'instant' | 'timeZone' | 'layer' | 'sourceKind'
  > | null,
  saved: boolean,
  aggregateEstimate = false,
) {
  const pair = transportClockPair(departure, arrival);
  const ends = (
    [
      ['出发', departure, pair.from],
      ['到达', arrival, pair.to],
    ] as const
  )
    .map(
      ([label, value, parts]) =>
        `<div class="clock-end"><span>${label} · ${value ? (aggregateEstimate && value.layer === 'PLANNED' ? '预计' : temporalLabel(value)) : '未知'}</span><strong>${esc(parts?.clock ?? (value ? '时间不可用' : '待定'))}</strong>${!pair.sharedContext && parts ? `<small title="${esc(parts.timeZone)}">${esc(parts.date)}<br>${esc(parts.zone)}</small>` : ''}</div>`,
    )
    .join('<span class="clock-arrow" aria-hidden="true">→</span>');
  return `<div class="${saved ? 'current-transport-times' : 'candidate-transport-times'}">${pair.sharedContext ? `<p class="clock-context" title="${esc(pair.from!.timeZone)}">${esc(pair.sharedContext)}</p>` : ''}<div class="clock-pair">${ends}</div>${pair.zoneChange ? '<small class="clock-context">时区切换 · 两端各按当地时间</small>' : ''}</div>${aggregateEstimate ? '<small class="aggregate-estimate">聚合预计时间，不代表具体班次。</small>' : ''}${[departure, arrival].some((v) => v?.layer === 'ACTUAL' && v.sourceKind === 'PROVIDER_OBSERVATION') ? '<small class="vehicle-note">车辆实测不表示你本人已经出发或到达。</small>' : ''}`;
}
function legTimes(
  l: RouteCandidateLegView,
  edge?: TransportEdgeView | null,
  saved = false,
  originalPlan = true,
) {
  if (!saved) {
    const planned = (value: RouteCandidateLegView['departure']) =>
      value
        ? {
            ...value,
            layer: 'PLANNED' as const,
            sourceKind: 'ADOPTED_TRANSPORT_FACT' as const,
          }
        : null;
    return clockPairView(
      planned(l.departure),
      planned(l.arrival),
      false,
      isAggregateTransit(l),
    );
  }
  const departure = edge ? transportTime(edge.timeValues, 'DEPARTURE') : null;
  const arrival = edge ? transportTime(edge.timeValues, 'ARRIVAL') : null;
  const historical =
    originalPlan &&
    (!departure ||
      !arrival ||
      departure.instant !== l.departure?.instant ||
      arrival.instant !== l.arrival?.instant ||
      departure.layer !== 'PLANNED' ||
      arrival.layer !== 'PLANNED');
  const original = transportClockPair(l.departure, l.arrival);
  const current = transportClockPair(
    localTransportTime(departure, l.departure?.timeZone),
    localTransportTime(arrival, l.arrival?.timeZone),
  );
  const originalEnd = (parts: typeof original.from) =>
    parts
      ? `${parts.clock}${original.sharedContext ? '' : `（${parts.date} · ${parts.zone}）`}`
      : '待定';
  return (
    transportClock(edge, l) +
    (historical
      ? `<div class="original-plan"><span>原方案${isAggregateTransit(l) ? '预计' : '计划'}：${esc(originalEnd(original.from))} → ${esc(originalEnd(original.to))}</span>${original.sharedContext && original.sharedContext !== current.sharedContext ? `<small>${esc(original.sharedContext)}</small>` : ''}</div>`
      : '') +
    (!edge ? '<small>当前分段时间暂无可靠对应。</small>' : '')
  );
}

function legView(
  l: RouteCandidateLegView,
  current?: TransportEdgeView | null,
  saved = false,
  originalPlan = true,
) {
  const mode = mapMode(l.mode);
  const publicTransport = mode === 'transit';
  const target = publicTransport ? l.from : l.to;
  // Walking to boarding is a separate action from looking up this saved service.
  const nav = mode
    ? navigation(target, undefined, publicTransport ? 'walking' : mode)
    : null;
  const links = [l.from, l.to]
    .map((location, i) => {
      const url = placeMap(location);
      return url
        ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开${i === 0 ? '起点' : '终点'}地点</a>`
        : `<span>${i === 0 ? '起点' : '终点'}位置未知</span>`;
    })
    .join('');
  return `<li class="transport-segment"><div class="segment-heading"><span class="segment-mode">${icon('route')}${esc(modeLabel[l.mode])}</span>${saved && current?.provider === 'SYNTHETIC' ? '<span class="source-tag">合成数据</span>' : ''}</div><strong class="segment-service">${esc(l.serviceLabel ?? modeLabel[l.mode])}</strong>${legTimes(l, current, saved, originalPlan)}<dl class="segment-stops"><div><dt>${publicTransport ? '上车' : '起点'}</dt><dd>${esc(l.from.name)}</dd></div><div><dt>${publicTransport ? '下车' : '终点'}</dt><dd>${esc(l.to.name)}</dd></div></dl><div class="segment-actions">${nav ? `<a class="segment-navigation" href="${esc(nav)}" target="_blank" rel="noopener noreferrer">${icon('pin')}${publicTransport ? '步行到上车点' : l.mode === 'WALKING' ? '步行到分段终点' : '驾车到分段终点'}</a>` : '<span class="muted">暂无可靠导航目标</span>'}<div class="map-links secondary-map-links">${links}</div></div></li>`;
}
function savedTransport(chain: readonly ConnectionView[]) {
  const ids = chain.map((c) => c.transport?.id);
  const saved = trip?.savedRoutes?.find(
    (r) =>
      r.adoptedRouteId === chain[0]?.transport?.adoptedRouteId &&
      r.transportEdgeIds.length === ids.length &&
      r.transportEdgeIds.every((id) => ids.includes(id)),
  );
  if (saved)
    return `<ol class="legs saved-legs">${saved.legs.map((leg, legIndex) => legView(leg, savedLegTransport(saved, legIndex, chain), true)).join('')}</ol>`;
  // Manual/legacy edges have only their real itinerary endpoints. Do not invent
  // service boarding locations when immutable selected segments are unavailable.
  return `<ol class="legs saved-legs">${chain
    .map((c) => {
      const t = c.transport;
      const from = node(c.fromNodeId)?.place,
        to = node(c.toNodeId)?.place;
      if (!t) return '';
      const summary = `<strong>${esc(modeLabel[t.mode])} ${esc(t.serviceLabel ?? '')}</strong>${transportClock(t)}`;
      if (!from || !to)
        return `<li>${summary}<p>地点信息不完整，无法导航。</p></li>`;
      if (['RAIL', 'BUS', 'FERRY'].includes(t.mode))
        return `<li>${summary}<p>行程地点：${esc(from.name)} → ${esc(to.name)}</p><p>上/下车地点未保存，不能提供上车点导航。</p></li>`;
      return legView(
        {
          mode: t.mode,
          fixedService: t.fixedService,
          serviceLabel: t.serviceLabel,
          providerRef: t.providerRef,
          from: { ...from, providerPlaceRef: null },
          to: { ...to, providerPlaceRef: null },
          departure: transportTime(t.timeValues, 'DEPARTURE'),
          arrival: transportTime(t.timeValues, 'ARRIVAL'),
          durationSeconds: null,
        },
        t,
        true,
        false,
      );
    })
    .join('')}</ol>`;
}
async function openRoute(from: string, to: string) {
  if (detail.open && !(await drawerClose())) return;
  const origin = node(from),
    destination = node(to);
  if (!origin || !destination) return;
  selection = { type: 'route', from, to };
  detailBasis = null;
  recoveryRequired = false;
  preview = null;
  routeCandidates = [];
  candidatesBasis = -1;
  epoch++;
  const zone = nodeZone(origin, projection(from));
  const floor = departureFloor(origin, projection(from));
  const chain = routeConnections(trip!, from);
  const connection = chain[0];
  const queryMode = selectedQueryMode(chain);
  const modeControl = queryMode
    ? `<p class="muted">查询方式：${esc(modeLabel[queryMode])} · 沿用当前交通</p>`
    : `<p class="muted" id="query-mode-help">无法从当前交通确定查询方式，请明确选择。不会自动更改已选交通。</p><label>查询方式<select name="travelMode" required aria-describedby="query-mode-help"><option value="">请选择查询方式</option>${['WALKING', 'DRIVING', 'TRANSIT', 'CYCLING'].map((mode) => `<option value="${mode}">${esc(modeLabel[mode])}</option>`).join('')}</select></label>`;
  drawer.open(
    frame(
      '交通与路线',
      `<p class="route-endpoints"><strong>${esc(nodeTitle(origin))}</strong><span aria-hidden="true">→</span><strong>${esc(nodeTitle(destination))}</strong></p><section class="route-current-summary" data-route-stage="current"><h3>当前交通</h3><details open><summary>当前路线与时间</summary>${connection?.transport ? savedTransport(chain) : '<p class="muted">尚未选择交通</p>'}</details><button type="button" class="primary" data-route-search-open>更换路线</button></section><aside class="route-map-note">${
        regionMapAdapter() !== unconfiguredMapAdapter
          ? ''
          : origin.place && destination.place
            ? wholeRouteMap(
                origin.place,
                destination.place,
                chain.map((c) => c.transport?.mode ?? 'OTHER'),
              )
            : '<p>这段交通尚无完整起终点信息，不能查询原路线。</p>'
      }${miniMapMarkup('transport')}</aside><section data-route-stage="search"><h3 class="route-search-heading">查找新的路线</h3><p class="muted">${floor && zone ? `按到达/停留与独立要求建议从：${esc(formatTime({ instant: floor, timeZone: zone }))}` : '尚无法验证起点的可出发时间，请提供查询条件。'}<br>仅搜索不会更改行程。</p><form id="route-search">${modeControl}<label>查询条件<select name="type"><option value="DEPART_AT">从指定时间出发</option><option value="ARRIVE_BY">在指定时间前到达</option></select></label><label>当地日期与时间<input name="when" type="datetime-local" value="${esc(floor && zone ? localInput(floor, zone) : '')}" required></label>${zoneField(zone, '查询条件所在地')}<button class="primary" ${origin.place && destination.place ? '' : 'disabled'}>搜索路线</button></form></section><section data-route-stage="candidates"><button type="button" class="route-stage-back" data-route-back="search">‹ 返回查询条件</button><div id="candidates" aria-live="polite"></div></section><section data-route-stage="preview"><button type="button" class="route-stage-back" data-route-back="candidates">‹ 返回路线方案</button><div id="choice"></div></section><p id="save-status" role="status"></p>`,
    ),
  );
  setRouteStage(connection?.transport ? 'current' : 'search');
  const boarding = chain.flatMap((c) => {
    const leg = c.transport ? selectedLegForEdge(c.transport.id) : null;
    return leg && ['BUS', 'RAIL', 'FERRY'].includes(leg.mode) ? [leg.from] : [];
  })[0];
  mountMiniMap(
    detail.querySelector<HTMLElement>('[data-mini-map]')!,
    'transport',
    [
      origin.place ? { ...origin.place, nodeId: origin.id } : null,
      destination.place
        ? { ...destination.place, nodeId: destination.id }
        : null,
    ],
    regionMapAdapter(),
    boarding ? { location: boarding, label: '导航到上车地点' } : undefined,
  );
}
async function openAlternatives(
  handoff: GroundTransitRouteReevaluationHandoffView,
) {
  const q = handoff.query ?? handoff.externalQuery;
  if (
    !trip ||
    handoff.tripId !== trip.id ||
    handoff.readiness !== 'READY' ||
    !q ||
    q.basisVersion !== trip.version
  ) {
    status('重新规划入口已变化，请重新核验影响。');
    return;
  }
  if (detail.open && !(await drawerClose())) return;
  selection = { type: 'alternative', handoff, invalid: false };
  recoveryRequired = false;
  detailBasis = null;
  preview = null;
  routeCandidates = [];
  candidatesBasis = -1;
  epoch++;
  drawer.open(frame('查看调整方案', alternativeEntry(trip, handoff)));
}
async function finishAdoption(result: AdoptRoutePreviewResponse) {
  acceptedWrite = '路线调整已保存到服务器';
  pendingAlternativeAdopt = null;
  receipt = result.operationReceipt;
  undoKey = crypto.randomUUID();
  draftDirty = false;
  disableBusy(false);
  await drawer.close();
  await loadTrip(result.trip.id);
  notice = '已使用这条路线。';
  render();
}
async function sendAlternativeAdoption() {
  const pending = pendingAlternativeAdopt;
  if (!pending || currentUserId !== pending.ownerUserId)
    throw new Error('请使用原账户核验本次提交，不能接管其他账户的调整。');
  try {
    const user = await api.request<UserView>('/me');
    if (user.id !== pending.ownerUserId)
      throw new Error('当前账户不匹配，不能重试这次提交。');
    const result = await api.request<AdoptRoutePreviewResponse>(
      `/trips/${pending.tripId}/previews/${pending.previewId}/adopt`,
      pending.input,
    );
    await finishAdoption(result);
  } catch (error) {
    if (
      error instanceof WebError &&
      error.code === 'NETWORK' &&
      pendingAlternativeAdopt
    ) {
      let retry = detail.querySelector('#adoption-retry');
      if (!retry) {
        retry = document.createElement('section');
        retry.id = 'adoption-retry';
        detail.querySelector('.sheet-body')!.append(retry);
      }
      retry.innerHTML =
        '<p>尚未确认这次采用是否成功。联网后可核验同一次提交，不会重复采用。</p><button data-action="retry-alternative-adopt"><span class="control-content">核验本次采用</span></button>';
    } else if (!acceptedWrite) pendingAlternativeAdopt = null;
    throw error;
  }
}
const routeScroll: Record<string, number> = {};
function setRouteStage(stage: string) {
  const current = detail.dataset.routeStage;
  if (current) routeScroll[current] = detail.scrollTop;
  detail.dataset.routeStage = stage;
  detail
    .querySelectorAll<HTMLElement>('[data-route-stage]')
    .forEach((el) => (el.hidden = el.dataset.routeStage !== stage));
  const map = detail.querySelector<HTMLElement>('.route-map-note');
  if (map) map.hidden = !['current', 'search'].includes(stage);
  requestAnimationFrame(() => {
    detail.scrollTop = routeScroll[stage] ?? 0;
  });
}
function showCandidates() {
  if (selection?.type === 'route') setRouteStage('candidates');
  const target = detail.querySelector('#candidates');
  if (!target) return;
  target.innerHTML = `<h3>路线方案</h3>${
    routeCandidates.length
      ? routeCandidates
          .map((c, i) => {
            const warning = candidateConflict(
              c,
              c.queryTimeCondition.hardEarliestDeparture,
            );
            return `<button class="candidate" data-candidate="${i}" ${warning ? 'disabled' : ''}><span><strong>${isAggregateTransit(c.legs[0]) ? '预计 ' : ''}${esc(formatTime(c.overall.departure))} → ${isAggregateTransit(c.legs.at(-1)) ? '预计 ' : ''}${esc(formatTime(c.overall.arrival))}</strong><small>${c.legs.map((l) => esc(modeLabel[l.mode])).join(' → ')} · ${duration(c.overall.durationSeconds)}</small><small>${c.fare ? `${esc(c.fare.amount)} ${esc(c.fare.currency)}` : '费用未知'}${c.provider === 'SYNTHETIC' ? ' · 合成开发数据' : ''}</small>${warning ? `<small class="warning">${esc(warning)}</small>` : ''}</span><span>›</span></button>`;
          })
          .join('')
      : '<p>没有符合条件的路线。可以调整查询条件或在地图中查询。</p>'
  }`;
}
function showPreview(p: RoutePreviewView) {
  if (selection?.type === 'route') setRouteStage('preview');
  const target = detail.querySelector('#choice');
  if (!target) return;
  target.innerHTML = `<section class="choice">${previewMarkup(previewPresentation(p, trip))}<details class="preview-details"><summary>查看方案地点与导航</summary><ol class="legs">${p.candidate.legs.map((leg) => legView(leg)).join('')}</ol></details><button class="primary" data-action="adopt" ${p.adoptable && p.status === 'ACTIVE' ? '' : 'disabled'}><span class="control-content">${selection?.type === 'alternative' ? '采用此调整' : '使用这条路线'}</span></button></section>`;
  target.scrollIntoView({ block: 'start' });
}
function showAlternativeRecovery() {
  if (selection?.type !== 'alternative' || trip || !detail.open) return;
  let panel = detail.querySelector('#alternative-recovery');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'alternative-recovery';
    detail.querySelector('.sheet-body')!.append(panel);
  }
  panel.innerHTML =
    '<p>当前无法核验行程与起点。旧方案不会作为当前事实显示。</p><button data-action="recheck-impact"><span class="control-content">重新核验影响</span></button>';
}
function showRecovery(error?: unknown) {
  if (authoring.active) {
    authoring.showRecovery(error ?? new WebError(0, 'NETWORK', '连接已中断'));
    return;
  }
  if (!detail.open || selection?.type !== 'place') return;
  recoveryRequired = true;
  let panel = detail.querySelector('#draft-recovery');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'draft-recovery';
    detail.querySelector('.sheet-body')!.prepend(panel);
  }
  panel.innerHTML = sessionStorage.getItem(tokenKey)
    ? '<p>草稿仍在。重新读取后请核对服务器内容，再决定保存。</p><button data-action="recover-draft">重新读取并核对草稿</button>'
    : '<p>请在这里恢复登录，草稿不会关闭。</p><form id="recovery-login"><label>受邀邮箱<input name="email" type="email" autocomplete="email" required></label><button>发送登录链接</button></form><form id="recovery-consume"><label>粘贴邮件中的完整登录链接<input name="link" type="url" required autocomplete="off"></label><button>恢复登录并读取草稿</button></form>';
}
async function recoverDraft() {
  if (!detailBasis)
    throw new Error('无法核验这份草稿的账户，请保留内容并重新打开。');
  const user = await api.request<UserView>('/me');
  if (user.id !== detailBasis.userId) {
    sessionStorage.removeItem(tokenKey);
    trip = null;
    schedule = null;
    render();
    concealUnavailableDetails();
    throw new Error('请使用原账户恢复；不会向其他账户展示旅行数据或保存草稿。');
  }
  await loadTrip(detailBasis.tripId);
  const fresh = node(detailBasis.nodeId);
  if (!fresh) {
    trip = null;
    schedule = null;
    throw new Error('原安排已不存在，不能保存这份草稿。');
  }
  delete detail.dataset.unavailable;
  detail.querySelector('#detail-title')!.textContent = nodeTitle(fresh);
  refreshPlaceSummary(fresh.id);
  detail.querySelector('#draft-recovery')!.innerHTML =
    `<p>已读取最新版本，请核对服务器备注与时间要求后再保存草稿。</p><p>服务器备注：${esc(fresh.note ?? '无')}</p><button data-action="acknowledge-draft">已核对，保留草稿继续编辑</button>`;
  status('已重新读取，请核对服务器内容；草稿尚未提交。');
}
function concealUnavailableDetails() {
  if (!detail.open) return;
  detail.dataset.unavailable = 'true';
  const title = detail.querySelector('#detail-title');
  if (title) title.textContent = '暂无法读取详情';
}
function status(message: string) {
  const active = detail.querySelector<HTMLFormElement>('form[data-saving]');
  if (active) {
    let local = active.querySelector<HTMLElement>('[data-group-status]');
    if (!local) {
      local = document.createElement('p');
      local.dataset.groupStatus = '';
      local.className = 'group-status';
      local.setAttribute('role', 'status');
      active.append(local);
    }
    local.textContent = message;
  }
  const target = detail.querySelector('#save-status');
  if (target) target.textContent = message;
}
function disableBusy(value: boolean) {
  busy = value;
  detail.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    if (b.hasAttribute('data-source')) return;
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
  status('正在保存或读取…');
  acceptedWrite = '';
  try {
    await operation();
  } catch (error) {
    if (
      selection?.type === 'alternative' &&
      error instanceof WebError &&
      (['VERSION_CONFLICT', 'PREVIEW_STALE'].includes(error.code) ||
        [401, 403, 404].includes(error.status))
    ) {
      selection.invalid = true;
      preview = null;
      routeCandidates = [];
      detail.querySelector('#choice')?.replaceChildren();
      detail.querySelector('#candidates')?.replaceChildren();
    }
    if (error instanceof WebError && error.status === 401) {
      sessionStorage.removeItem(tokenKey);
      trip = null;
      schedule = null;
      render();
      concealUnavailableDetails();
    }
    if (
      error instanceof WebError &&
      ['NETWORK', 'SERVICE_UNAVAILABLE', 'VERSION_CONFLICT'].includes(
        error.code,
      )
    ) {
      trip = null;
      schedule = null;
      render();
      concealUnavailableDetails();
    }
    const pending = detail.querySelector('#candidates');
    if (pending?.textContent === '正在查询…')
      pending.textContent = '未取得路线方案，请核对条件后重试。';
    showRecovery(error);
    showAlternativeRecovery();
    status(
      `${acceptedWrite ? `${acceptedWrite}；后续读取/核对未完成。` : ''}${errorText(error)}`,
    );
    notice = `${acceptedWrite ? `${acceptedWrite}；后续读取/核对未完成。` : ''}${errorText(error)}`;
    if (!detail.open) render();
  } finally {
    disableBusy(false);
    if (
      selection?.type === 'alternative' &&
      (selection.invalid || pendingAlternativeAdopt)
    ) {
      const search = detail.querySelector<HTMLButtonElement>(
        '[data-action=search-alternatives]',
      );
      if (search) search.disabled = true;
      if (pendingAlternativeAdopt)
        detail
          .querySelector<HTMLButtonElement>('[data-action=adopt]')
          ?.setAttribute('disabled', '');
    }
    if (materialsOpen) render();
  }
}
async function loadTrip(id: string) {
  requestedTripId = id;
  materialsOpen = false;
  viewingBackup = null;
  latestBackup =
    localBackups(currentUserId).find((b) => b.tripId === id) ?? null;
  const request = ++epoch;
  const fresh = await api.request<TripView>(`/trips/${id}`);
  const evaluated = await api.request<ScheduleProjectionView>(
    `/trips/${id}/schedule/evaluate`,
    { basisVersion: fresh.version },
  );
  if (evaluated.tripId !== fresh.id || evaluated.basisVersion !== fresh.version)
    throw new WebError(409, 'VERSION_CONFLICT', '行程版本已变化，请重新载入。');
  if (request !== epoch) return;
  if (!authoring.active) temporaryDays = [];
  trip = fresh;
  schedule = evaluated;
  inTrip = null;
  ground = null;
  if (viewMode === 'today') await readInTrip(fresh, request);
  if (request !== epoch) return;
  notice = '';
  render();
}
async function listTrips() {
  requestedTripId = null;
  materialsOpen = false;
  viewingBackup = null;
  temporaryDays = [];
  dayId = '';
  trip = null;
  schedule = null;
  receipt = null;
  inTrip = null;
  ground = null;
  viewMode = 'itinerary';
  notice = '';
  render();
  try {
    const result = await api.request<TripListResponse>('/trips');
    if (trip) return;
    root.querySelector('#trips')!.innerHTML = result.trips.length
      ? result.trips
          .map(
            (t) =>
              `<article class="trip-card"><button class="trip-card-open" data-trip="${t.id}"><span><strong>${esc(t.name)}</strong><small>${esc(t.effectiveStartDate ?? t.planningAnchorDate)} · ${t.defaultPeopleCount} 人</small></span><span aria-hidden="true">›</span></button></article>`,
          )
          .join('')
      : '<div class="empty"><h2>还没有旅行</h2><p>创建一趟旅行，再逐步添加安排。</p></div>';
  } catch (error) {
    notice = errorText(error);
    render();
    root.querySelector('#trips')!.innerHTML =
      '<button data-action="trips">重新载入</button>';
  }
}
async function command(
  value: TripCommandInput,
  accepted?: (fresh: TripView) => void,
) {
  if (!trip) return;
  const fresh = await api.request<TripView>(`/trips/${trip.id}/commands`, {
    baseTripVersion: trip.version,
    command: value,
  });
  trip = fresh;
  acceptedWrite = '本次提交已保存到服务器';
  accepted?.(fresh);
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
root.addEventListener('click', async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (!target) return;
  if (target.dataset.localBackup) {
    const b = localBackups(currentUserId).find(
      (b) => b.tripId === target.dataset.localBackup,
    );
    if (b) {
      materialsOpen = true;
      viewingBackup = b;
      backupNotice = '';
      render();
    }
    return;
  }
  if (target.dataset.action === 'essentials') {
    void openMaterials();
    return;
  }
  if (target.dataset.action === 'generate-backup') {
    void generateBackup();
    return;
  }
  if (target.dataset.action === 'view-backup' && latestBackup) {
    viewingBackup = latestBackup;
    render();
    return;
  }
  if (target.dataset.action === 'download-backup' && viewingBackup) {
    downloadBackup(viewingBackup);
    return;
  }
  if (target.dataset.action === 'live-essentials') {
    void openMaterials();
    return;
  }
  if (target.dataset.action === 'close-materials') {
    if (busy) return;
    materialsRead++;
    materialsVerifying = false;
    materialsOpen = false;
    viewingBackup = null;
    render();
    return;
  }
  if (target.dataset.action === 'view-impact' && trip) {
    if (detail.open && !(await drawerClose())) return;
    selection = null;
    drawer.open(frame('查看影响', impactDetails(trip, tripImpact)));
    return;
  }
  if (target.dataset.view && trip) {
    if (detail.open && !(await drawerClose())) return;
    viewMode = target.dataset.view === 'today' ? 'today' : 'itinerary';
    if (viewMode === 'today') void act(() => loadTrip(trip!.id));
    else render();
    return;
  }
  if (target.dataset.action === 'create-trip') {
    if (detail.open && !(await drawerClose())) return;
    authoring.openCreate();
    return;
  }
  if (target.dataset.action === 'add-arrangement' && trip) {
    const day = editorDays(trip, temporaryDays).find(
      (d) => d.key === (target.dataset.authoringDay ?? dayId),
    );
    if (day) {
      if (detail.open && !(await drawerClose())) return;
      authoring.openAdd(day);
    }
    return;
  }
  if (target.dataset.authoringMove && trip) {
    if (detail.open && !(await drawerClose())) return;
    const n = node(target.dataset.authoringMove);
    if (n) authoring.openMove(n);
    return;
  }
  if (
    ['previous-day', 'next-day'].includes(target.dataset.action ?? '') &&
    trip
  ) {
    if (busy) return;
    const days = editorDays(trip, temporaryDays),
      side = target.dataset.action === 'previous-day' ? 'before' : 'after';
    const edge = side === 'before' ? days[0] : days.at(-1);
    const localDate = shiftedDate(
      edge?.localDate ?? trip.planningAnchorDate,
      side === 'before' ? -1 : 1,
    );
    const key = `temporary:${crypto.randomUUID()}`;
    const d = { key, localDate, side } as const;
    temporaryDays =
      side === 'before' ? [d, ...temporaryDays] : [...temporaryDays, d];
    dayId = key;
    render();
    return;
  }
  if (target.dataset.trip) void act(() => loadTrip(target.dataset.trip!));
  if (target.dataset.day) {
    if (detail.open && !(await drawerClose())) return;
    viewMode = 'itinerary';
    dayId = target.dataset.day;
    epoch++;
    render();
  }
  if (target.dataset.node) await openPlace(node(target.dataset.node)!);
  if (target.dataset.routeFrom)
    await openRoute(target.dataset.routeFrom, target.dataset.routeTo!);
  if (target.dataset.action === 'trips') void listTrips();
  if (target.dataset.action === 'reload')
    void act(() => {
      const id = trip?.id ?? (receipt ? requestedTripId : null);
      return id ? loadTrip(id) : listTrips();
    });
  if (target.dataset.action === 'logout')
    void act(async () => {
      try {
        await api.request('/auth/logout', {});
      } finally {
        sessionStorage.removeItem(tokenKey);
        bindBackupOwner(null);
        currentUserId = null;
        materialsOpen = false;
        viewingBackup = null;
        latestBackup = null;
        backupPending = null;
        trip = null;
        schedule = null;
        render();
      }
    });
  if (target.dataset.action === 'undo' && receipt && trip)
    void act(async () => {
      const result = await api.request<UndoRouteAdoptionResponse>(
        `/trips/${trip!.id}/operations/${receipt!.id}/undo`,
        { baseTripVersion: trip!.version, idempotencyKey: undoKey },
      );
      acceptedWrite = '路线修改已撤销到服务器';
      receipt = null;
      await loadTrip(result.trip.id);
      notice = '刚才的路线修改已撤销。';
      render();
    });
});
root.addEventListener('submit', (event) => {
  event.preventDefault();
  if ((event.target as HTMLFormElement).id !== 'login') return;
  if (!validateForm(event.target as HTMLFormElement)) return;
  if (busy) return;
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  const button = form.querySelector<HTMLButtonElement>('button')!;
  const sending = document.createElement('p');
  sending.setAttribute('role', 'status');
  sending.textContent = '正在发送登录链接…';
  form.querySelector('[data-login-status]')?.remove();
  sending.dataset.loginStatus = '';
  form.append(sending);
  button.disabled = true;
  disableBusy(true);
  void (async () => {
    try {
      await api.request('/auth/magic-link/request', {
        email: data.get('email'),
      });
      sending.textContent = '如果该邮箱已获邀请，登录链接将发送到邮箱。';
    } catch (error) {
      sending.textContent = errorText(error);
    } finally {
      disableBusy(false);
      button.disabled = false;
    }
  })();
});
detail.addEventListener('input', (event) => {
  if (authoring.active) {
    if ((event.target as HTMLElement).closest('[data-authoring]'))
      authoring.input();
    return;
  }
  if ((event.target as HTMLElement).closest('#route-search')) {
    epoch++;
    routeCandidates = [];
    preview = null;
    detail.querySelector('#candidates')!.innerHTML = '';
    detail.querySelector('#choice')!.innerHTML = '';
  }
  const form = (event.target as HTMLElement).closest<HTMLFormElement>('form');
  if (!form || !['note-edit', 'time-edit', 'dwell-edit'].includes(form.id))
    return;
  if (formValue(form) !== formBaselines.get(form.id)) dirtyForms.add(form.id);
  else dirtyForms.delete(form.id);
  draftDirty = dirtyForms.size > 0;
  status(draftDirty ? '还有未保存的修改。' : '当前表单与已保存内容一致。');
});
detail.addEventListener('click', async (event) => {
  const handoffEntry = (event.target as HTMLElement).closest<HTMLElement>(
    '[data-impact-handoff]',
  );
  if (handoffEntry) {
    if (busy || !trip || tripImpact?.basisVersion !== trip.version) return;
    const handoff = tripImpact.handoffs.find(
      (h) => h.sourceTransportEdgeId === handoffEntry.dataset.impactHandoff,
    );
    if (handoff) await openAlternatives(handoff);
    return;
  }

  const target = (event.target as HTMLElement).closest<HTMLElement>('button,a');
  if (!target) return;
  if (target instanceof HTMLAnchorElement && draftDirty) {
    event.preventDefault();
    const url = new URL(target.href, location.href);
    if (!['https:', 'http:'].includes(url.protocol)) return;
    if (externalMapOpening) return;
    externalMapOpening = true;
    try {
      const destination = window.open('about:blank', '_blank');
      if (destination) {
        const referrer = destination.document.createElement('meta');
        referrer.name = 'referrer';
        referrer.content = 'no-referrer';
        destination.document.head.append(referrer);
        destination.opener = null;
      }
      const accepted = await confirmAction(
        '当前编辑尚未保存。打开外部地图后，草稿仍保留。',
        '打开地图',
        '继续编辑',
      );
      if (!accepted) {
        destination?.close();
        return;
      }
      if (destination) {
        const navigation = destination.document.createElement('a');
        navigation.href = url.href;
        navigation.rel = 'noopener noreferrer';
        navigation.referrerPolicy = 'no-referrer';
        destination.document.body.append(navigation);
        navigation.click();
      } else
        status(
          '浏览器阻止了新窗口。请允许此站点打开新窗口后重试；草稿仍保留。',
        );
    } finally {
      externalMapOpening = false;
    }
    return;
  }
  if (target.hasAttribute('data-route-search-open')) {
    setRouteStage('search');
    return;
  }
  if (target.dataset.routeBack) {
    setRouteStage(target.dataset.routeBack);
    return;
  }
  if (target.dataset.authoringKind) {
    await authoring.chooseKind(target.dataset.authoringKind);
    return;
  }
  if (target.hasAttribute('data-authoring-recover')) {
    void act(() => authoring.recover());
    return;
  }
  if (target.hasAttribute('data-authoring-ack')) {
    authoring.acknowledge();
    return;
  }
  if (
    target.dataset.action === 'retry-alternative-adopt' &&
    pendingAlternativeAdopt
  ) {
    void act(sendAlternativeAdoption);
    return;
  }
  if (target.dataset.action === 'recheck-impact') {
    void act(async () => {
      const id = trip?.id ?? requestedTripId;
      if (!id) return;
      viewMode = 'today';
      await loadTrip(id);
      disableBusy(false);
      await drawer.close();
      drawer.open(frame('查看影响', impactDetails(trip!, tripImpact)));
    });
    return;
  }
  if (
    target.dataset.action === 'search-alternatives' &&
    selection?.type === 'alternative'
  ) {
    if (selection.invalid || !trip) {
      status('请先重新核验影响和起点，再搜索。');
      return;
    }
    const context = selection,
      basis = trip.version,
      tripId = trip.id;
    void act(async () => {
      const request = ++epoch;
      preview = null;
      routeCandidates = [];
      detail.querySelector('#choice')!.innerHTML = '';
      detail.querySelector('#candidates')!.textContent = '正在查询…';
      let response: ControlledAlternativeSearchResponse;
      try {
        response = await api.request<ControlledAlternativeSearchResponse>(
          `/trips/${tripId}/alternatives/query`,
          { handoff: context.handoff },
        );
      } catch (error) {
        if (
          error instanceof WebError &&
          ['PROVIDER_UNAVAILABLE', 'ROUTE_PROVIDER_UNCONFIGURED'].includes(
            error.code,
          )
        ) {
          detail.querySelector('#candidates')!.innerHTML =
            '<p class="warning">暂时无法搜索替代方案。原行程与已选路线保持不变，可以稍后重试。</p>';
          throw new WebError(
            error.status,
            error.code,
            '暂时无法搜索替代方案；这不表示没有可用路线。',
          );
        }
        throw error;
      }
      if (request !== epoch || selection !== context || trip?.version !== basis)
        return;
      if (
        response.result.tripId !== tripId ||
        response.result.basisVersion !== basis
      )
        throw new WebError(409, 'VERSION_CONFLICT', '搜索版本已变化。');
      routeCandidates = response.result.candidates;
      candidatesBasis = basis;
      showCandidates();
      status('搜索完成。请选择一个方案查看变化，尚未修改行程。');
    });
    return;
  }
  if (target.dataset.action === 'recover-draft') void act(recoverDraft);
  if (target.dataset.action === 'acknowledge-draft') {
    recoveryRequired = false;
    detail.querySelector('#draft-recovery')?.remove();
    status('已核对最新服务器版本，草稿尚未保存。');
  }
  if (target.dataset.intent && selection?.type === 'place') {
    if (busy) return;
    if (recoveryRequired || !trip) {
      status('请先重新读取并核对草稿，再修改服务器要求。');
      return;
    }
    if (
      draftDirty &&
      !(await confirmAction('移除要求前，需放弃当前未保存的修改。'))
    )
      return;
    if (busy || recoveryRequired || !trip || selection?.type !== 'place')
      return;
    const n = node(selection.nodeId)!;
    const intent = n.timeIntents.find((i) => i.id === target.dataset.intent);
    if (!intent) {
      showRecovery();
      status('该要求已变化，请重新读取并核对。');
      return;
    }
    // Consent discards only edits already present, before accepting any later input.
    if (draftDirty) discardFormDrafts();
    const formId = intent.kind === 'MIN_DWELL' ? 'dwell-edit' : 'time-edit';
    const form = detail.querySelector<HTMLFormElement>(`#${formId}`)!;
    const submitted = formValue(form);
    detail
      .querySelectorAll('form[data-saving]')
      .forEach((el) => el.removeAttribute('data-saving'));
    form.dataset.saving = '';
    const data = new FormData(form);
    const editsRemovedRequirement =
      intent.kind === 'MIN_DWELL' ||
      data.get('requirement') === `${intent.pointKind}:${intent.operator}`;
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
        (fresh) => {
          const acceptedNode = fresh.days
            .flatMap((d) => d.nodes)
            .find((item) => item.id === n.id)!;
          refreshIntentControls(acceptedNode);
          if (!editsRemovedRequirement) return;
          const fieldName = intent.kind === 'MIN_DWELL' ? 'minutes' : 'when';
          const acceptedSnapshot = JSON.stringify(
            [...data.entries()].map(([key, value]) => [
              key,
              key === fieldName ? '' : value,
            ]),
          );
          if (formValue(form) === submitted)
            form.querySelector<HTMLInputElement>(
              `input[name=${fieldName}]`,
            )!.value = '';
          savedForm(formId, acceptedSnapshot);
        },
      );
      refreshPlaceSummary(n.id);
      status(
        `要求已移除，当前安排已重新核对。${draftDirty ? ' 还有未保存的修改。' : ''}`,
      );
    });
  }
  if (
    target.dataset.candidate !== undefined &&
    trip &&
    (selection?.type === 'route' ||
      (selection?.type === 'alternative' && !selection.invalid))
  )
    void act(async () => {
      const request = ++epoch;
      const candidate = routeCandidates[Number(target.dataset.candidate)]!;
      if (
        !candidate ||
        candidatesBasis !== trip!.version ||
        candidate.queryBasisVersion !== trip!.version
      )
        throw new Error('行程已变化，请重新搜索。');
      const result = await api.request<RoutePreviewView>(
        `/trips/${trip!.id}/previews`,
        {
          basisVersion: trip!.version,
          candidateSnapshotId: candidate.candidateSnapshotId,
        },
      );
      if (request !== epoch) return;
      if (
        result.tripId !== trip!.id ||
        result.basisVersion !== trip!.version ||
        result.candidateSnapshotId !== candidate.candidateSnapshotId
      )
        throw new WebError(409, 'PREVIEW_STALE', '方案已变化，请重新核验。');
      preview = result;
      mutationKey = crypto.randomUUID();
      showPreview(result);
      status('已核对方案，使用前请确认下方影响。');
    });
  if (target.dataset.action === 'adopt' && preview && trip)
    void act(async () => {
      if (
        preview!.status !== 'ACTIVE' ||
        !preview!.adoptable ||
        preview!.basisVersion !== trip!.version ||
        (selection?.type === 'alternative' && selection.invalid)
      )
        throw new WebError(409, 'PREVIEW_STALE', '方案已变化，请重新核验。');
      const adjustments = preview!.changeSummary.requiredUserAdjustments ?? [];
      if (
        adjustments.length &&
        !detail.querySelector<HTMLInputElement>('#accept-adjustments')?.checked
      )
        throw new Error('请明确同意停留变更，或选择其他路线。');
      const input: AdoptRoutePreviewRequest = {
        baseTripVersion: trip!.version,
        idempotencyKey: mutationKey,
        ...(adjustments.length ? { acceptedUserAdjustments: adjustments } : {}),
      };
      if (selection?.type === 'alternative') {
        if (!currentUserId) throw new Error('请先核验当前账户。');
        pendingAlternativeAdopt = {
          ownerUserId: currentUserId,
          tripId: trip!.id,
          previewId: preview!.previewId,
          input,
        };
        await sendAlternativeAdoption();
      } else {
        const result = await api.request<AdoptRoutePreviewResponse>(
          `/trips/${trip!.id}/previews/${preview!.previewId}/adopt`,
          input,
        );
        await finishAdoption(result);
      }
    });
});
detail.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (authoring.active) {
    if (target.closest('[data-authoring]')) authoring.change(target);
    return;
  }
  if (target.hasAttribute('data-zone')) {
    const field = target
      .closest('form')
      ?.querySelector<HTMLInputElement>('input[name=zone]');
    if (field) {
      field.value = target.value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  if (target.name === 'type' && selection?.type === 'route') {
    const n = node(
      target.value === 'ARRIVE_BY' ? selection.to : selection.from,
    );
    const zone = n ? nodeZone(n, projection(n.id)) : null;
    const field = detail.querySelector<HTMLInputElement>(
      '#route-search input[name=zone]',
    );
    if (field) {
      field.value = zone ?? '';
      const choice = field
        .closest('form')
        ?.querySelector<HTMLDetailsElement>('.zone-choice');
      if (choice)
        choice.outerHTML = zoneField(zone, '查询条件所在地').replace(
          /^<input[^>]+>/u,
          '',
        );
    }
  }
});
detail.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  if (!validateForm(form)) return;
  detail
    .querySelectorAll('form[data-saving]')
    .forEach((el) => el.removeAttribute('data-saving'));
  form.dataset.saving = '';
  const data = new FormData(form);
  if (authoring.active) {
    if (form.id === 'authoring-login') {
      void act(async () => {
        await api.request('/auth/magic-link/request', {
          email: data.get('email'),
        });
        status('请查看邮件并在此恢复登录。草稿仍保留。');
      });
      return;
    }
    if (form.id === 'authoring-consume') {
      void act(async () => {
        const url = new URL(String(data.get('link')));
        const token = new URLSearchParams(url.hash.slice(1)).get('token');
        if (!token) throw new Error('请粘贴完整登录链接。');
        const result = await api.request<SessionResponse>(
          '/auth/magic-link/consume',
          { token },
        );
        form.reset();
        if (result.user.id !== authoring.owner)
          throw new Error('请使用原账户恢复，草稿不能转交其他账户。');
        sessionStorage.setItem(tokenKey, result.credential);
        currentUserId = result.user.id;
        bindBackupOwner(currentUserId);
        await authoring.recover();
      });
      return;
    }
    if (form.hasAttribute('data-authoring')) authoring.submit(form);
    return;
  }
  const submitted = formValue(form);
  const saved = () => savedForm(form.id, submitted);
  const message = (text: string) =>
    status(`${text}${draftDirty ? ' 还有未保存的修改。' : ''}`);
  if (form.id === 'recovery-login') {
    void act(async () => {
      await api.request('/auth/magic-link/request', {
        email: data.get('email'),
      });
      status('请查看邮箱，将登录链接粘贴到这里。草稿仍保留。');
    });
    return;
  }
  if (form.id === 'recovery-consume') {
    void act(async () => {
      const url = new URL(String(data.get('link')));
      const token = new URLSearchParams(url.hash.slice(1)).get('token');
      if (!token) throw new Error('请粘贴邮件中的完整登录链接。');
      const result = await api.request<SessionResponse>(
        '/auth/magic-link/consume',
        { token },
      );
      form.reset();
      if (result.user.id !== detailBasis?.userId)
        throw new Error('请使用原账户登录；这份草稿不能转交其他账户。');
      sessionStorage.setItem(tokenKey, result.credential);
      currentUserId = result.user.id;
      bindBackupOwner(currentUserId);
      await recoverDraft();
    });
    return;
  }
  if (recoveryRequired && selection?.type === 'place' && detailBasis) {
    status('当前无法保存，请先重新读取并核对草稿，再保存。');
    return;
  }
  if (!trip || !selection) {
    status('当前无法保存，请联网后重新载入并核对。未保存内容仍在窗口中。');
    return;
  }
  if (form.id === 'note-edit' && selection.type === 'place') {
    const id = selection.nodeId;
    void act(async () => {
      await command(
        {
          type: 'SET_NODE_NOTE',
          nodeId: id,
          note: String(data.get('note') ?? '') || null,
        },
        (fresh) => {
          const acceptedNote =
            fresh.days.flatMap((day) => day.nodes).find((n) => n.id === id)
              ?.note ?? '';
          const acceptedSnapshot = JSON.stringify(
            [...data.entries()].map(([key, value]) => [
              key,
              key === 'note' ? acceptedNote : value,
            ]),
          );
          if (formValue(form) === submitted)
            form.querySelector<HTMLTextAreaElement>('textarea')!.value =
              acceptedNote;
          savedForm(form.id, acceptedSnapshot);
        },
      );
      refreshPlaceSummary(id);
      message('备注已保存到服务器');
    });
  }
  if (form.id === 'time-edit' && selection.type === 'place') {
    const id = selection.nodeId;
    void act(async () => {
      const [pointKind, operator] = String(data.get('requirement')).split(':');
      await command(
        {
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
        },
        saved,
      );
      refreshPlaceSummary(id);
      message('时间要求已保存，当前安排已重新核对。');
    });
  }
  if (form.id === 'dwell-edit' && selection.type === 'place') {
    const id = selection.nodeId;
    void act(async () => {
      await command(
        {
          type: 'SET_MIN_DWELL',
          nodeId: id,
          durationSeconds: Number(data.get('minutes')) * 60,
          locked: true,
        },
        saved,
      );
      refreshPlaceSummary(id);
      message('停留要求已保存，当前安排已重新核对。');
    });
  }
  if (form.id === 'route-search' && selection.type === 'route') {
    const { from, to } = selection;
    const travelMode =
      selectedQueryMode(routeConnections(trip!, from)) ??
      explicitQueryMode(data.get('travelMode'));
    if (!travelMode) {
      status('无法确定查询方式，请明确选择；尚未发送路线请求。');
      return;
    }
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
          travelMode,
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
  if (!viewingBackup) materialsOpen = false;
  trip = null;
  schedule = null;
  notice =
    '当前无网，无法查看行程。未保存编辑仍在详情窗口中，联网后请重新核对。';
  render();
  concealUnavailableDetails();
  status(notice);
  showRecovery();
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
    bindBackupOwner(null);
    currentUserId = null;
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
  if (sessionStorage.getItem(tokenKey)) {
    try {
      currentUserId = (await api.request<UserView>('/me')).id;
      bindBackupOwner(currentUserId);
      await listTrips();
    } catch (error) {
      if (
        error instanceof WebError &&
        (error.code === 'NETWORK' || error.code === 'SERVICE_UNAVAILABLE')
      ) {
        notice = errorText(error);
        render();
      } else {
        sessionStorage.removeItem(tokenKey);
        bindBackupOwner(null);
        currentUserId = null;
        notice = errorText(error);
        render();
      }
    }
  }
}
setInterval(() => {
  if (viewMode === 'today' && trip && !busy && !detail.open && !materialsOpen)
    render();
}, 30000);
void start();
