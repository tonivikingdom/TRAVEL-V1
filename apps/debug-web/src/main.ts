import type {
  AdoptRoutePreviewResponse,
  DayOccurrenceTargetInput,
  DayView,
  LivenessResponse,
  NotificationListResponse,
  NotificationView,
  OperationReceiptView,
  ReadinessResponse,
  RouteCandidateView,
  RoutePreviewView,
  RouteQueryResponse,
  ScheduleProjectionView,
  SetResolvedTemporalValueRequest,
  SessionResponse,
  TransportHistoryView,
  TransportHistoryResponse,
  TripCommandInput,
  TripListResponse,
  TripView,
  UndoRouteAdoptionResponse,
  UserView,
} from '@travel/contracts';

import { ApiClient, DebugApiError } from './api.js';
import { consumeFragmentToken } from './magic-link.js';
import { createSessionStore } from './session.js';
import {
  canUndoReceipt,
  classifyRouteQueryFailure,
  invalidateRouteArtifacts,
  isCoreUnavailable,
  isVersionConflict,
  orderedDays,
  shouldClearRecoveredOutage,
} from './state.js';
import './styles.css';

interface DebugState {
  user: UserView | null;
  trips: readonly TripView[];
  currentTrip: TripView | null;
  live: 'UNKNOWN' | 'UP' | 'DOWN';
  ready: 'UNKNOWN' | 'READY' | 'NOT_READY';
  database: string;
  unavailable: boolean;
  message: string | null;
  error: DebugApiError | null;
  notifications: readonly NotificationView[];
  notificationCursor: string | null;
  schedule: ScheduleProjectionView | null;
  routeResponse: RouteQueryResponse | null;
  preview: RoutePreviewView | null;
  receipt: OperationReceiptView | null;
  history: readonly TransportHistoryView[];
}

const root = requiredElement<HTMLDivElement>('app');
const store = createSessionStore(sessionStorage);
const api = new ApiClient({ credential: () => store.getCredential() });
const state: DebugState = {
  user: null,
  trips: [],
  currentTrip: null,
  live: 'UNKNOWN',
  ready: 'UNKNOWN',
  database: 'UNKNOWN',
  unavailable: false,
  message: null,
  error: null,
  notifications: [],
  notificationCursor: null,
  schedule: null,
  routeResponse: null,
  preview: null,
  receipt: store.getLastReceipt(store.getSelectedTripId()),
  history: [],
};

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  void handleForm(form);
});
root.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const actionElement = target.closest<HTMLElement>('[data-action]');
  if (actionElement === null) return;
  void handleAction(actionElement);
});

await initialize();
window.setInterval(() => void refreshHealth(true), 15_000);

async function initialize(): Promise<void> {
  const fragmentToken = consumeFragmentToken(window.location.href, (url) => {
    history.replaceState(null, '', url);
  });
  render();
  await refreshHealth(false);
  if (fragmentToken !== null) {
    await consumeMagicLink(fragmentToken);
    return;
  }
  if (store.getCredential() !== null && !state.unavailable) {
    await recoverSession();
  }
}

async function consumeMagicLink(token: string): Promise<void> {
  await run(async () => {
    const session = await api.post<SessionResponse>(
      '/auth/magic-link/consume',
      {
        token,
      },
    );
    store.setCredential(session.credential);
    state.user = session.user;
    state.message = '登录成功。Magic Link token 已从地址栏清除。';
    await loadWorkspace();
  });
}

async function recoverSession(): Promise<void> {
  await run(async () => {
    state.user = await api.get<UserView>('/me');
    await loadWorkspace();
  });
}

async function loadWorkspace(): Promise<void> {
  await Promise.all([loadTrips(false), loadNotifications(false)]);
  const selected = store.getSelectedTripId();
  if (selected !== null) await loadTrip(selected);
}

async function refreshHealth(allowRecovery: boolean): Promise<void> {
  try {
    const live = await api.get<LivenessResponse>('/health/live');
    state.live = live.status;
    const ready = await api.get<ReadinessResponse>('/health/ready');
    state.ready = ready.status;
    state.database =
      ready.dependencies.find((dependency) => dependency.name === 'postgresql')
        ?.status ?? 'UNKNOWN';
    if (ready.status !== 'READY') {
      enterUnavailable('API 尚未就绪。');
      return;
    }
    const wasUnavailable = state.unavailable;
    state.unavailable = false;
    if (allowRecovery && wasUnavailable && store.getCredential() !== null) {
      await recoverSession();
      if (shouldClearRecoveredOutage(state.error)) state.error = null;
      state.message = '服务已恢复，身份和当前 Trip 已重新同步。';
    }
  } catch (error) {
    state.live = 'DOWN';
    state.ready = 'NOT_READY';
    state.database = 'UNKNOWN';
    enterUnavailable(errorMessage(error));
  }
  render();
}

function enterUnavailable(message: string): void {
  state.unavailable = true;
  state.message = null;
  state.error = new DebugApiError(message, 'NETWORK', null, null, null, true);
  state.trips = [];
  state.currentTrip = null;
  state.schedule = null;
  Object.assign(state, invalidateRouteArtifacts());
  state.history = [];
  render();
}

async function handleForm(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  switch (form.id) {
    case 'login-form':
      await run(async () => {
        await api.post('/auth/magic-link/request', {
          email: requiredFormString(data, 'email'),
        });
        state.message =
          '登录链接已请求。Dev/Test 环境请从 capture mail 中打开。';
      });
      break;
    case 'create-trip-form':
      await mutate(async () =>
        api.post<TripView>('/trips', {
          name: requiredFormString(data, 'name'),
          planningAnchorDate: requiredFormString(data, 'planningAnchorDate'),
          defaultPeopleCount: formNumber(data, 'defaultPeopleCount'),
        }),
      );
      await loadTrips(false);
      break;
    case 'add-place-form':
      await executeTripCommand({
        type: 'ADD_PLACE_VISIT',
        targetDay: dayTarget(data),
        position: formNumber(data, 'position'),
        place: {
          type: 'CUSTOM',
          name: requiredFormString(data, 'name'),
          latitude: formNumber(data, 'latitude'),
          longitude: formNumber(data, 'longitude'),
          address: nullableFormString(data, 'address'),
        },
        note: nullableFormString(data, 'note'),
      });
      break;
    case 'add-free-action-form':
      await executeTripCommand({
        type: 'ADD_FREE_ACTION',
        targetDay: dayTarget(data),
        position: formNumber(data, 'position'),
        note: nullableFormString(data, 'note'),
      });
      break;
    case 'manual-transport-form':
      await executeTripCommand({
        type: 'SET_MANUAL_TRANSPORT',
        fromNodeId: requiredFormString(data, 'fromNodeId'),
        toNodeId: requiredFormString(data, 'toNodeId'),
        mode: requiredFormString(data, 'mode') as 'WALKING',
        fixedService: data.get('fixedService') === 'on',
        serviceLabel: nullableFormString(data, 'serviceLabel'),
        note: nullableFormString(data, 'note'),
      });
      break;
    case 'temporal-value-form':
      await writeTemporalValue(data);
      break;
    case 'time-intent-form':
      await setTimeIntent(data);
      break;
    case 'min-dwell-form':
      await executeTripCommand({
        type: 'SET_MIN_DWELL',
        nodeId: requiredFormString(data, 'nodeId'),
        durationSeconds: formNumber(data, 'durationSeconds'),
        locked: data.get('locked') === 'on',
      });
      break;
    case 'route-query-form':
      await queryRoutes(data);
      break;
    case 'preview-form':
      await createPreview(data);
      break;
  }
}

async function handleAction(element: HTMLElement): Promise<void> {
  const action = element.dataset.action;
  const id = element.dataset.id;
  switch (action) {
    case 'logout':
      await run(async () => {
        await api.post<void>('/auth/logout');
        store.clearCredential();
        store.clearTripState();
        resetAuthenticatedState();
        state.message = '已退出登录。';
      });
      break;
    case 'refresh-health':
      await refreshHealth(true);
      break;
    case 'refresh-trips':
      await run(async () => loadTrips(true));
      break;
    case 'select-trip':
      if (id !== undefined) await run(async () => loadTrip(id));
      break;
    case 'refresh-trip':
      if (state.currentTrip !== null) {
        await run(async () => {
          Object.assign(state, invalidateRouteArtifacts());
          await loadTrip(state.currentTrip!.id);
          state.message = 'Trip 已刷新；旧 Candidate / Preview 已清除。';
        });
      }
      break;
    case 'delete-node':
      if (id !== undefined)
        await executeTripCommand({ type: 'DELETE_NODE', nodeId: id });
      break;
    case 'move-up':
    case 'move-down':
      if (id !== undefined)
        await moveNodeOneStep(id, action === 'move-up' ? -1 : 1);
      break;
    case 'move-node':
      if (id !== undefined) await moveNodePrompt(id);
      break;
    case 'replace-place':
      if (id !== undefined) await replacePlacePrompt(id);
      break;
    case 'clear-transport':
      if (id !== undefined)
        await executeTripCommand({
          type: 'CLEAR_TRANSPORT',
          transportEdgeId: id,
        });
      break;
    case 'remove-intent':
      await removeIntent(element);
      break;
    case 'toggle-intent-lock':
      await toggleIntentLock(element);
      break;
    case 'evaluate':
      await evaluateSchedule();
      break;
    case 'choose-candidate':
      chooseCandidate(Number(element.dataset.index));
      break;
    case 'adopt':
      await adoptPreview();
      break;
    case 'undo':
      await undoAdoption();
      break;
    case 'load-history':
      await loadHistory();
      break;
    case 'dismiss-notification':
      if (id !== undefined) await dismissNotification(id);
      break;
    case 'load-more-notifications':
      await loadNotifications(true);
      break;
  }
}

async function loadTrips(renderAfter: boolean): Promise<void> {
  const response = await api.get<TripListResponse>('/trips');
  state.trips = response.trips;
  if (renderAfter) render();
}

async function loadTrip(id: string): Promise<void> {
  state.currentTrip = await api.get<TripView>(
    `/trips/${encodeURIComponent(id)}`,
  );
  store.setSelectedTripId(id);
  state.receipt = store.getLastReceipt(id);
  state.schedule = null;
  state.history = [];
  Object.assign(state, invalidateRouteArtifacts());
  render();
}

async function loadNotifications(append: boolean): Promise<void> {
  const cursor = append ? state.notificationCursor : null;
  const query = new URLSearchParams({ limit: '20' });
  if (cursor !== null) query.set('cursor', cursor);
  const response = await api.get<NotificationListResponse>(
    `/notifications?${query.toString()}`,
  );
  state.notifications = append
    ? [...state.notifications, ...response.notifications]
    : response.notifications;
  state.notificationCursor = response.nextCursor;
  render();
}

async function dismissNotification(id: string): Promise<void> {
  await run(async () => {
    await api.post(`/notifications/${encodeURIComponent(id)}/dismiss`);
    await loadNotifications(false);
  });
}

async function executeTripCommand(command: TripCommandInput): Promise<void> {
  const trip = requireTrip();
  await mutate(() =>
    api.post<TripView>(`/trips/${trip.id}/commands`, {
      baseTripVersion: trip.version,
      command,
    }),
  );
}

async function writeTemporalValue(data: FormData): Promise<void> {
  const trip = requireTrip();
  const subjectType = requiredFormString(data, 'subjectType');
  const subjectId = requiredFormString(data, 'subjectId');
  const request: SetResolvedTemporalValueRequest = {
    baseTripVersion: trip.version,
    subject:
      subjectType === 'NODE'
        ? { type: 'NODE', nodeId: subjectId }
        : { type: 'TRANSPORT', transportEdgeId: subjectId },
    value: {
      layer: requiredFormString(data, 'layer') as 'PLANNED',
      pointKind: requiredFormString(data, 'pointKind') as 'ARRIVAL',
      instant: requiredFormString(data, 'instant'),
      timeZone: requiredFormString(data, 'timeZone'),
      sourceKind: requiredFormString(data, 'sourceKind') as 'USER_VALUE',
      sourceRef: nullableFormString(data, 'sourceRef'),
      observedAt: nullableFormString(data, 'observedAt'),
    },
  };
  await mutate(() =>
    api.post<TripView>(`/trips/${trip.id}/temporal-values`, request),
  );
}

async function setTimeIntent(data: FormData): Promise<void> {
  await executeTripCommand({
    type: 'SET_TIME_INTENT',
    nodeId: requiredFormString(data, 'nodeId'),
    pointKind: requiredFormString(data, 'pointKind') as 'ARRIVAL',
    operator: requiredFormString(data, 'operator') as 'EXACT',
    instant: requiredFormString(data, 'instant'),
    timeZone: requiredFormString(data, 'timeZone'),
    locked: data.get('locked') === 'on',
  });
}

async function removeIntent(element: HTMLElement): Promise<void> {
  const nodeId = element.dataset.nodeId;
  const kind = element.dataset.kind;
  if (nodeId === undefined) return;
  if (kind === 'MIN_DWELL') {
    await executeTripCommand({ type: 'REMOVE_MIN_DWELL', nodeId });
    return;
  }
  await executeTripCommand({
    type: 'REMOVE_TIME_INTENT',
    nodeId,
    pointKind: element.dataset.pointKind as 'ARRIVAL',
    operator: element.dataset.operator as 'EXACT',
  });
}

async function toggleIntentLock(element: HTMLElement): Promise<void> {
  if (element.dataset.id === undefined) return;
  await executeTripCommand({
    type: 'SET_TIME_INTENT_LOCK',
    intentId: element.dataset.id,
    locked: element.dataset.locked !== 'true',
  });
}

async function evaluateSchedule(): Promise<void> {
  const trip = requireTrip();
  await run(async () => {
    state.schedule = await api.post<ScheduleProjectionView>(
      `/trips/${trip.id}/schedule/evaluate`,
      { basisVersion: trip.version },
    );
  });
}

async function queryRoutes(data: FormData): Promise<void> {
  const trip = requireTrip();
  const hintType = requiredFormString(data, 'hintType');
  await run(async () => {
    state.routeResponse = await api.post<RouteQueryResponse>(
      `/trips/${trip.id}/routes/query`,
      {
        basisVersion: trip.version,
        fromNodeId: requiredFormString(data, 'fromNodeId'),
        toNodeId: requiredFormString(data, 'toNodeId'),
        hint:
          hintType === 'NONE'
            ? null
            : {
                type: hintType,
                instant: requiredFormString(data, 'instant'),
                timeZone: requiredFormString(data, 'timeZone'),
              },
      },
    );
    state.preview = null;
  }, true);
}

function chooseCandidate(index: number): void {
  if (state.routeResponse?.candidates[index] === undefined) return;
  const form = document.querySelector<HTMLFormElement>('#preview-form');
  const input = form?.elements.namedItem('candidateSnapshotId');
  if (input instanceof HTMLInputElement) {
    input.value = state.routeResponse.candidates[index]!.candidateSnapshotId;
    input.focus();
  }
}

async function createPreview(data: FormData): Promise<void> {
  const trip = requireTrip();
  const indexes = nullableFormString(data, 'sameHubWalkingLegIndexes');
  await run(async () => {
    state.preview = await api.post<RoutePreviewView>(
      `/trips/${trip.id}/previews`,
      {
        basisVersion: trip.version,
        candidateSnapshotId: requiredFormString(data, 'candidateSnapshotId'),
        ...(indexes === null
          ? {}
          : {
              sameHubWalkingLegIndexes: indexes
                .split(',')
                .map((value) => Number.parseInt(value.trim(), 10)),
            }),
      },
    );
  });
}

async function adoptPreview(): Promise<void> {
  const trip = requireTrip();
  const preview = state.preview;
  if (preview === null || !preview.adoptable) return;
  await run(async () => {
    const response = await api.post<AdoptRoutePreviewResponse>(
      `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
      {
        baseTripVersion: preview.basisVersion,
        idempotencyKey: crypto.randomUUID(),
        acceptedUserAdjustments:
          preview.changeSummary.requiredUserAdjustments ?? [],
      },
    );
    state.currentTrip = response.trip;
    state.receipt = response.operationReceipt;
    store.setLastReceipt(trip.id, response.operationReceipt);
    Object.assign(state, invalidateRouteArtifacts());
    state.message = '路线已采用；OperationReceipt 已保留供人工核验。';
  });
}

async function undoAdoption(): Promise<void> {
  const trip = requireTrip();
  const receipt = state.receipt;
  if (!canUndoReceipt(receipt, new Date()) || receipt === null) return;
  await run(async () => {
    const response = await api.post<UndoRouteAdoptionResponse>(
      `/trips/${trip.id}/operations/${receipt.id}/undo`,
      { baseTripVersion: trip.version, idempotencyKey: crypto.randomUUID() },
    );
    state.currentTrip = response.trip;
    state.receipt = response.operationReceipt;
    store.setLastReceipt(trip.id, response.operationReceipt);
    state.message = '路线采用已通过补偿事务撤销。';
  });
}

async function loadHistory(): Promise<void> {
  const trip = requireTrip();
  await run(async () => {
    const response = await api.get<TransportHistoryResponse>(
      `/trips/${trip.id}/transport-history`,
    );
    state.history = response.history;
  });
}

async function moveNodeOneStep(nodeId: string, offset: number): Promise<void> {
  const trip = requireTrip();
  const entry = orderedDays(trip.days)
    .flatMap((day) => day.nodes.map((node) => ({ day, node })))
    .find(({ node }) => node.id === nodeId);
  if (entry === undefined) return;
  await executeTripCommand({
    type: 'MOVE_NODE',
    nodeId,
    dayOccurrenceId: entry.day.dayOccurrenceId,
    position: Math.max(0, entry.node.position + offset),
  });
}

async function moveNodePrompt(nodeId: string): Promise<void> {
  const dayOccurrenceId = window.prompt('目标 DayOccurrence ID');
  const position = window.prompt('目标 position');
  if (dayOccurrenceId === null || position === null) return;
  await executeTripCommand({
    type: 'MOVE_NODE',
    nodeId,
    dayOccurrenceId,
    position: Number.parseInt(position, 10),
  });
}

async function replacePlacePrompt(nodeId: string): Promise<void> {
  const name = window.prompt('新的地点名称');
  const latitude = window.prompt('纬度');
  const longitude = window.prompt('经度');
  if (name === null || latitude === null || longitude === null) return;
  await executeTripCommand({
    type: 'REPLACE_PLACE',
    nodeId,
    place: {
      type: 'CUSTOM',
      name,
      latitude: Number(latitude),
      longitude: Number(longitude),
      address: null,
    },
  });
}

async function mutate(operation: () => Promise<TripView>): Promise<void> {
  await run(async () => {
    state.currentTrip = await operation();
    Object.assign(state, invalidateRouteArtifacts());
    state.schedule = null;
  });
}

async function run(
  operation: () => Promise<void>,
  routeOnly = false,
): Promise<void> {
  state.error = null;
  try {
    await operation();
  } catch (error) {
    if (routeOnly) {
      const category = classifyRouteQueryFailure(error);
      if (category === 'PROVIDER_UNAVAILABLE') {
        state.message =
          '交通查询服务当前不可用。Trip 与已有正式计划仍可查看和编辑。';
        state.error = null;
        render();
        return;
      }
      if (category === 'NO_MATCHING_CANDIDATE') {
        state.message = '当前条件下没有找到匹配候选。';
        state.error = null;
        render();
        return;
      }
    }
    state.error = normalizeError(error);
    if (isVersionConflict(error)) {
      Object.assign(state, invalidateRouteArtifacts());
    }
    if (isCoreUnavailable(error)) enterUnavailable(errorMessage(error));
  }
  render();
}

function resetAuthenticatedState(): void {
  state.user = null;
  state.trips = [];
  state.currentTrip = null;
  state.notifications = [];
  state.notificationCursor = null;
  state.schedule = null;
  state.routeResponse = null;
  state.preview = null;
  state.receipt = null;
  state.history = [];
}

function render(): void {
  root.innerHTML = `
    <header class="app-header">
      <div>
        <strong>TRAVEL-V1 开发测试台</strong>
        <span>仅用于 Dev / Test</span>
        <span>不是正式产品界面</span>
      </div>
      <div class="health-strip">
        <span class="status ${statusClass(state.live === 'UP')}">API live: ${esc(state.live)}</span>
        <span class="status ${statusClass(state.ready === 'READY')}">API ready: ${esc(state.ready)}</span>
        <span class="status ${statusClass(state.database === 'READY')}">DB: ${esc(state.database)}</span>
        ${state.user === null ? '' : `<span>${esc(state.user.email)}</span><button data-action="logout">退出</button>`}
        <button data-action="refresh-health">刷新状态</button>
      </div>
    </header>
    ${state.unavailable ? unavailableView() : state.user === null ? loginView() : workspaceView()}
  `;
}

function unavailableView(): string {
  return `<main class="center-panel danger-panel">
    <h1>服务暂时不可用</h1>
    <p>已隐藏旧 Trip，当前不提供离线编辑，也不会声称数据已同步。</p>
    <p>恢复后会依次重新检查 /health/ready、/me 与当前 Trip。</p>
    <button data-action="refresh-health">重新检查</button>
  </main>`;
}

function loginView(): string {
  return `<main class="center-panel">
    <h1>登录开发测试台</h1>
    ${alerts()}
    <form id="login-form" class="stack-form">
      <label>Email<input type="email" name="email" required autocomplete="email" /></label>
      <button type="submit">发送 Magic Link</button>
    </form>
    <p class="muted">请求结果不会透露账号是否存在。Magic Link token 只从 URL fragment 读取，不写入 localStorage。</p>
  </main>`;
}

function workspaceView(): string {
  return `<main class="workspace">
    <aside class="sidebar">
      ${alerts()}
      <section><div class="section-heading"><h2>Trips</h2><button data-action="refresh-trips">刷新</button></div>
        ${tripList()}
        ${createTripForm()}
      </section>
      <section><h2>站内通知</h2>${notificationList()}</section>
    </aside>
    <section class="content">${state.currentTrip === null ? '<div class="empty">选择或创建一个 Trip。</div>' : tripWorkspace(state.currentTrip)}</section>
  </main>`;
}

function alerts(): string {
  const version = state.error?.code === 'VERSION_CONFLICT';
  return `${state.message === null ? '' : `<div class="notice">${esc(state.message)}</div>`}
    ${state.error === null ? '' : `<div class="error"><strong>${esc(state.error.code ?? state.error.kind)}</strong> ${esc(version ? 'Trip 已被其他请求更新。已停止本次操作，请刷新当前 Trip 后重新确认。' : state.error.message)}${version ? '<button data-action="refresh-trip">刷新 Trip</button>' : ''}</div>`}`;
}

function tripList(): string {
  if (state.trips.length === 0) return '<p class="muted">还没有 Trip。</p>';
  return `<div class="trip-list">${state.trips
    .map(
      (
        trip,
      ) => `<button data-action="select-trip" data-id="${attr(trip.id)}" class="trip-item ${state.currentTrip?.id === trip.id ? 'selected' : ''}">
        <strong>${esc(trip.name)}</strong><span>${esc(trip.effectiveStartDate ?? '空')} → ${esc(trip.effectiveEndDate ?? '空')}</span><small>v${trip.version}</small>
      </button>`,
    )
    .join('')}</div>`;
}

function createTripForm(): string {
  return `<details><summary>＋ 新建 Trip</summary><form id="create-trip-form" class="stack-form compact">
    <label>名称<input name="name" required /></label>
    <label>规划锚点<input type="date" name="planningAnchorDate" required /></label>
    <label>人数<input type="number" name="defaultPeopleCount" min="1" value="1" required /></label>
    <button type="submit">创建</button>
  </form></details>`;
}

function notificationList(): string {
  if (state.notifications.length === 0) {
    return '<p>当前没有站内通知。</p><p class="muted">通知基础设施已存在，但实时风险通知业务尚未实现。</p>';
  }
  return `${state.notifications
    .map(
      (item) =>
        `<article class="notification ${item.dismissedAt === null ? '' : 'dismissed'}"><strong>${esc(item.title)}</strong><small>${esc(item.kind)} · ${esc(item.occurredAt)}</small><p>${esc(item.body)}</p>${item.dismissedAt === null ? `<button data-action="dismiss-notification" data-id="${attr(item.id)}">Dismiss</button>` : '<span>已 dismiss</span>'}</article>`,
    )
    .join(
      '',
    )}${state.notificationCursor === null ? '' : '<button data-action="load-more-notifications">加载更多</button>'}`;
}

function tripWorkspace(trip: TripView): string {
  const synthetic = state.routeResponse?.candidates.some(
    (candidate) => candidate.provider === 'SYNTHETIC',
  );
  return `
    <div class="trip-title"><div><h1>${esc(trip.name)}</h1><p>v${trip.version} · ${esc(trip.effectiveStartDate ?? '无有效范围')} → ${esc(trip.effectiveEndDate ?? '无有效范围')}</p></div><button data-action="refresh-trip">刷新 Trip</button></div>
    ${synthetic === true ? '<div class="synthetic-banner">SYNTHETIC 测试交通数据<br />不得视为真实班次</div>' : ''}
    <div class="panel-grid">
      <section class="panel span-2"><h2>Day / Node 时间轴</h2>${timeline(trip)}</section>
      <section class="panel"><h2>添加地点</h2>${addPlaceForm(trip)}</section>
      <section class="panel"><h2>添加 FreeAction</h2>${addFreeActionForm(trip)}</section>
      <section class="panel span-2"><h2>Connections / Manual Transport</h2>${connections(trip)}${manualTransportForm(trip)}</section>
      <section class="panel"><h2>测试事实输入</h2>${temporalForm(trip)}</section>
      <section class="panel"><h2>UserTimeIntent</h2>${intentForms(trip)}</section>
      <section class="panel span-2"><h2>Schedule Projection</h2><button data-action="evaluate">重新评估时间约束</button>${scheduleView()}</section>
      <section class="panel span-2"><h2>Route Query / Candidate</h2>${routeQueryForm(trip)}${candidateView()}</section>
      <section class="panel span-2"><h2>Preview / Adopt / Undo</h2>${previewForm()}${previewView()}${receiptView(trip)}</section>
      <section class="panel span-2"><h2>Transport History</h2><button data-action="load-history">加载历史</button>${historyView()}</section>
    </div>`;
}

function timeline(trip: TripView): string {
  if (trip.days.length === 0)
    return '<p class="muted">空 Trip：尚未占用任何自然日。</p>';
  return `<div class="timeline">${orderedDays(trip.days)
    .map(
      (day) =>
        `<article class="day-card"><header><strong>${esc(day.localDate)} · occurrence #${day.sequence}</strong><code>${esc(day.dayOccurrenceId)}</code></header>${day.nodes.length === 0 ? '<p class="muted">中间空白日期卡</p>' : day.nodes.map((node) => nodeView(day, node)).join('')}</article>`,
    )
    .join('')}</div>`;
}

function nodeView(day: DayView, node: DayView['nodes'][number]): string {
  return `<div class="node-card"><div class="node-main"><strong>${esc(node.kind === 'PLACE_VISIT' ? (node.place?.name ?? 'Place') : 'FreeAction')}</strong><span>position ${node.position}</span><p>${esc(node.note ?? '无备注')}</p></div>
    <div class="actions"><button data-action="move-up" data-id="${attr(node.id)}">上移</button><button data-action="move-down" data-id="${attr(node.id)}">下移</button><button data-action="move-node" data-id="${attr(node.id)}">移到指定日期卡</button>${node.kind === 'PLACE_VISIT' ? `<button data-action="replace-place" data-id="${attr(node.id)}">替换地点</button>` : ''}<button class="danger" data-action="delete-node" data-id="${attr(node.id)}">删除</button></div>
    <details><summary>Debug details / 时间</summary><pre>${esc(JSON.stringify({ dayOccurrenceId: day.dayOccurrenceId, nodeId: node.id, source: node.source, provider: node.provider, providerPlaceRef: node.providerPlaceRef, providerHubRef: node.providerHubRef, adoptedRouteId: node.adoptedRouteId, sourceOperationId: node.sourceOperationId, autoReplaceable: node.autoReplaceable, userModifiedAt: node.userModifiedAt, temporalValues: node.timeValues }, null, 2))}</pre>${intentList(node)}</details>
  </div>`;
}

function intentList(node: DayView['nodes'][number]): string {
  if (node.timeIntents.length === 0) return '<p>无 UserTimeIntent。</p>';
  return node.timeIntents
    .map(
      (intent) =>
        `<div class="intent"><code>${esc(intent.kind)} ${esc(intent.pointKind ?? '')} ${esc(intent.operator)}</code><span>${esc(intent.instant ?? String(intent.durationSeconds))}</span><button data-action="toggle-intent-lock" data-id="${attr(intent.id)}" data-locked="${intent.locked}">${intent.locked ? '解锁' : '锁定'}</button><button data-action="remove-intent" data-node-id="${attr(node.id)}" data-kind="${intent.kind}" data-point-kind="${attr(intent.pointKind ?? '')}" data-operator="${intent.operator}">移除</button></div>`,
    )
    .join('');
}

function dayOptions(trip: TripView, includeNew: boolean): string {
  return `${orderedDays(trip.days)
    .map(
      (day) =>
        `<option value="${attr(day.dayOccurrenceId)}">#${day.sequence} ${esc(day.localDate)} · ${esc(day.dayOccurrenceId.slice(0, 8))}</option>`,
    )
    .join(
      '',
    )}${includeNew ? '<option value="NEW">NEW DayOccurrence</option>' : ''}`;
}

function addPlaceForm(trip: TripView): string {
  return `<form id="add-place-form" class="stack-form compact"><label>DayOccurrence<select name="dayOccurrenceId">${dayOptions(trip, true)}</select></label><div class="two"><label>NEW localDate<input type="date" name="localDate" /></label><label>NEW sequence<input type="number" name="sequence" min="0" value="${trip.days.length}" /></label></div><label>position<input type="number" name="position" min="0" value="0" required /></label><label>名称<input name="name" required /></label><div class="two"><label>纬度<input type="number" step="any" name="latitude" required /></label><label>经度<input type="number" step="any" name="longitude" required /></label></div><label>地址<input name="address" /></label><label>备注<textarea name="note"></textarea></label><button type="submit">ADD_PLACE_VISIT</button></form>`;
}

function addFreeActionForm(trip: TripView): string {
  return `<form id="add-free-action-form" class="stack-form compact"><label>DayOccurrence<select name="dayOccurrenceId">${dayOptions(trip, true)}</select></label><div class="two"><label>NEW localDate<input type="date" name="localDate" /></label><label>NEW sequence<input type="number" name="sequence" min="0" value="${trip.days.length}" /></label></div><label>position<input type="number" name="position" min="0" value="0" required /></label><label>内容<textarea name="note" required></textarea></label><button type="submit">ADD_FREE_ACTION</button></form>`;
}

function connections(trip: TripView): string {
  if (trip.connections.length === 0)
    return '<p class="muted">没有相邻连接。</p>';
  return `<div class="connections">${trip.connections.map((connection) => `<div class="connection state-${connection.state.toLowerCase()}"><code>${esc(connection.fromNodeId.slice(0, 8))} → ${esc(connection.toNodeId.slice(0, 8))}</code><strong>${connection.state}</strong>${connection.transport === null ? '' : `<span>${esc(connection.transport.mode)} · fixed=${connection.transport.fixedService} · ${esc(connection.transport.source)}</span><button data-action="clear-transport" data-id="${attr(connection.transport.id)}">CLEAR_TRANSPORT</button>`}</div>`).join('')}</div>`;
}

function manualTransportForm(trip: TripView): string {
  const missing = trip.connections.filter(
    (connection) => connection.state === 'MISSING',
  );
  if (missing.length === 0) return '';
  return `<form id="manual-transport-form" class="inline-form"><label>Adjacency<select name="adjacency" onchange="const [a,b]=this.value.split('|');this.form.fromNodeId.value=a;this.form.toNodeId.value=b">${missing.map((connection) => `<option value="${attr(connection.fromNodeId)}|${attr(connection.toNodeId)}">${esc(connection.fromNodeId.slice(0, 8))} → ${esc(connection.toNodeId.slice(0, 8))}</option>`).join('')}</select></label><input type="hidden" name="fromNodeId" value="${attr(missing[0]!.fromNodeId)}"/><input type="hidden" name="toNodeId" value="${attr(missing[0]!.toNodeId)}"/><label>mode<select name="mode">${['WALKING', 'DRIVING', 'TAXI', 'RAIL', 'BUS', 'FERRY', 'FLIGHT', 'OTHER'].map((mode) => `<option>${mode}</option>`).join('')}</select></label><label><input type="checkbox" name="fixedService"/>fixedService</label><label>serviceLabel<input name="serviceLabel"/></label><label>note<input name="note"/></label><button type="submit">SET_MANUAL_TRANSPORT</button></form>`;
}

function temporalForm(trip: TripView): string {
  const nodes = trip.days.flatMap((day) => day.nodes);
  const transports = trip.connections.flatMap((connection) =>
    connection.transport === null ? [] : [connection.transport],
  );
  return `<form id="temporal-value-form" class="stack-form compact"><label>Subject type<select name="subjectType"><option>NODE</option><option>TRANSPORT</option></select></label><label>Subject ID<select name="subjectId">${nodes.map((node) => `<option value="${attr(node.id)}">NODE ${esc(node.place?.name ?? node.note ?? node.id)}</option>`).join('')}${transports.map((edge) => `<option value="${attr(edge.id)}">TRANSPORT ${esc(edge.fromNodeId.slice(0, 8))}→${esc(edge.toNodeId.slice(0, 8))}</option>`).join('')}</select></label><div class="two"><label>Layer<select name="layer"><option>PLANNED</option><option>ESTIMATED</option><option>ACTUAL</option></select></label><label>Point<select name="pointKind"><option>ARRIVAL</option><option>DEPARTURE</option></select></label></div><label>Absolute instant<input name="instant" placeholder="2030-10-01T19:30:00+08:00" required /></label><label>IANA timezone<input name="timeZone" value="Asia/Shanghai" required /></label><label>sourceKind<select name="sourceKind"><option>USER_VALUE</option><option>PROVIDER_OBSERVATION</option><option>ADOPTED_TRANSPORT_FACT</option><option>SYSTEM_SUGGESTION</option><option>DERIVED</option></select></label><label>sourceRef<input name="sourceRef" /></label><label>observedAt<input name="observedAt" /></label><button type="submit">写入测试事实</button><p class="muted">不提供强制覆盖 ACTUAL。</p></form>`;
}

function intentForms(trip: TripView): string {
  const options = trip.days
    .flatMap((day) => day.nodes)
    .map(
      (node) =>
        `<option value="${attr(node.id)}">${esc(node.place?.name ?? node.note ?? node.id)}</option>`,
    )
    .join('');
  return `<form id="time-intent-form" class="stack-form compact"><label>Node<select name="nodeId">${options}</select></label><div class="two"><label>Point<select name="pointKind"><option>ARRIVAL</option><option>DEPARTURE</option></select></label><label>要求<select name="operator"><option value="EXACT">精确时间</option><option value="NOT_BEFORE">不能早于</option><option value="NOT_AFTER">不能晚于</option></select></label></div><label>Absolute instant<input name="instant" required /></label><label>IANA timezone<input name="timeZone" value="Asia/Shanghai" required /></label><label><input type="checkbox" name="locked"/>锁定</label><button type="submit">设置时间要求</button></form><hr/><form id="min-dwell-form" class="inline-form"><label>Node<select name="nodeId">${options}</select></label><label>至少停留（秒）<input type="number" name="durationSeconds" min="1" required /></label><label><input type="checkbox" name="locked"/>锁定</label><button type="submit">设置 MIN_DWELL</button></form>`;
}

function scheduleView(): string {
  if (state.schedule === null) return '<p class="muted">尚未评估。</p>';
  return `<div class="debug-output"><h3>Nodes</h3>${state.schedule.nodes.map((node) => `<details><summary>${esc(node.nodeId.slice(0, 8))} · ${node.status}</summary><pre>${esc(JSON.stringify(node, null, 2))}</pre></details>`).join('')}<h3>Violations</h3>${structuredItems(state.schedule.violations)}<h3>Conflicts</h3>${structuredItems(state.schedule.conflicts)}</div>`;
}

function routeQueryForm(trip: TripView): string {
  const places = trip.days
    .flatMap((day) => day.nodes)
    .filter((node) => node.kind === 'PLACE_VISIT');
  const options = places
    .map(
      (node) =>
        `<option value="${attr(node.id)}">${esc(node.place?.name ?? node.id)}</option>`,
    )
    .join('');
  return `<form id="route-query-form" class="inline-form"><label>From<select name="fromNodeId">${options}</select></label><label>To<select name="toNodeId">${options}</select></label><label>偏好<select name="hintType"><option value="NONE">不指定偏好</option><option>DEPART_AT</option><option>ARRIVE_BY</option></select></label><label>instant<input name="instant" /></label><label>timeZone<input name="timeZone" value="Asia/Shanghai" /></label><button type="submit">Route Query</button></form>`;
}

function candidateView(): string {
  const response = state.routeResponse;
  if (response === null) return '<p class="muted">尚未查询。</p>';
  return `<details open><summary>queryTimeCondition</summary><pre>${esc(JSON.stringify(response.timeCondition, null, 2))}</pre></details><div class="candidates">${response.candidates.map((candidate, index) => candidateCard(candidate, index)).join('')}</div>`;
}

function candidateCard(candidate: RouteCandidateView, index: number): string {
  return `<article class="candidate ${candidate.provider === 'SYNTHETIC' ? 'synthetic' : ''}">${candidate.provider === 'SYNTHETIC' ? '<strong class="synthetic-label">SYNTHETIC 测试交通数据 · 不得视为真实班次</strong>' : ''}<h3>${esc(candidate.provider)} / ${esc(candidate.candidateId)}</h3><p>${esc(candidate.overall.departure.instant)} → ${esc(candidate.overall.arrival.instant)} · ${candidate.overall.durationSeconds}s</p><p>observed ${esc(candidate.observedAt)} · valid ${esc(candidate.validUntil ?? 'null')} · snapshot ${esc(candidate.snapshotExpiresAt)}</p><pre>${esc(JSON.stringify({ fare: candidate.fare, planningAssessment: candidate.planningAssessment, legs: candidate.legs, queryTimeCondition: candidate.queryTimeCondition }, null, 2))}</pre><button data-action="choose-candidate" data-index="${index}">选择并生成 Preview</button></article>`;
}

function previewForm(): string {
  return `<form id="preview-form" class="inline-form"><label>candidateSnapshotId<input name="candidateSnapshotId" required /></label><label>sameHubWalkingLegIndexes<input name="sameHubWalkingLegIndexes" placeholder="0,2" /></label><button type="submit">生成 Preview</button></form>`;
}

function previewView(): string {
  const preview = state.preview;
  if (preview === null) return '<p class="muted">尚无 Preview。</p>';
  return `<div class="preview"><p><strong>${esc(preview.status)}</strong> · adoptable=${preview.adoptable} · policy=${esc(preview.policyVersion)} · expires=${esc(preview.expiresAt)}</p><pre>${esc(JSON.stringify(preview.changeSummary, null, 2))}</pre>${preview.adoptable ? '<button data-action="adopt">采用路线</button>' : '<button disabled>不可采用</button>'}</div>`;
}

function receiptView(trip: TripView): string {
  const receipt = state.receipt;
  if (receipt === null)
    return '<p class="muted">尚无本 tab 最近 Adopt / Undo receipt。</p>';
  return `<details open><summary>OperationReceipt · ${esc(receipt.operationType)}</summary><pre>${esc(JSON.stringify(receipt, null, 2))}</pre></details>${canUndoReceipt(receipt, new Date()) && receipt.operationType === 'ROUTE_ADOPT' && receipt.resultingTripVersion === trip.version ? '<button data-action="undo">撤销刚才的路线采用</button>' : '<p class="muted">当前 receipt 不可 Undo；Undo receipt 不提供 Undo-of-Undo。</p>'}`;
}

function historyView(): string {
  if (state.history.length === 0)
    return '<p class="muted">尚未加载或没有历史。</p>';
  return state.history
    .map(
      (item) =>
        `<details><summary>${esc(item.invalidationReason)} · ${esc(item.originalTransportEdgeId)}</summary><pre>${esc(JSON.stringify(item, null, 2))}</pre></details>`,
    )
    .join('');
}

function structuredItems(items: readonly unknown[]): string {
  if (items.length === 0) return '<p class="muted">无</p>';
  return items
    .map((item) => `<pre>${esc(JSON.stringify(item, null, 2))}</pre>`)
    .join('');
}

function dayTarget(data: FormData): DayOccurrenceTargetInput {
  const id = requiredFormString(data, 'dayOccurrenceId');
  return id === 'NEW'
    ? {
        type: 'NEW',
        localDate: requiredFormString(data, 'localDate'),
        sequence: formNumber(data, 'sequence'),
      }
    : { type: 'EXISTING', dayOccurrenceId: id };
}

function requireTrip(): TripView {
  if (state.currentTrip === null) throw new Error('No selected Trip');
  return state.currentTrip;
}

function requiredFormString(data: FormData, key: string): string {
  const value = data.get(key);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function nullableFormString(data: FormData, key: string): string | null {
  const value = data.get(key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function formNumber(data: FormData, key: string): number {
  const value = Number(requiredFormString(data, key));
  if (!Number.isFinite(value)) throw new Error(`${key} must be numeric`);
  return value;
}

function normalizeError(error: unknown): DebugApiError {
  return error instanceof DebugApiError
    ? error
    : new DebugApiError(errorMessage(error), 'HTTP', null, null, null, false);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误。';
}

function statusClass(good: boolean): string {
  return good ? 'good' : 'bad';
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function attr(value: string): string {
  return esc(value);
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} is required`);
  return element as T;
}
