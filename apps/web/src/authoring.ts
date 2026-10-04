import type {
  DayOccurrenceTargetInput,
  ItineraryNodeView,
  TripAuthoringCommandInput,
  TripAuthoringRequest,
  TripListResponse,
  TripView,
  UserView,
} from '@travel/contracts';
import { PlaceSearchPicker } from './place-search.js';
import { TravelApi, WebError } from './api.js';
import { esc, orderedNodes } from './model.js';

export interface EditorDay {
  key: string;
  localDate: string;
  target: DayOccurrenceTargetInput;
  nodes: readonly ItineraryNodeView[];
  temporary: boolean;
  occupied: boolean;
  label: string;
}
export interface TemporaryDay {
  key: string;
  localDate: string;
  side: 'before' | 'after';
}
export function shiftedDate(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
/** Temporary dates are UI intent only. Never merge equal-date occurrence identities. */
export function editorDays(
  trip: TripView,
  temporary: readonly TemporaryDay[],
): EditorDay[] {
  const real = [...trip.days]
    .sort((a, b) => a.sequence - b.sequence)
    .map((d, i) => ({
      key: d.dayOccurrenceId,
      localDate: d.localDate,
      target: { type: 'EXISTING' as const, dayOccurrenceId: d.dayOccurrenceId },
      nodes: d.nodes,
      temporary: false,
      occupied: d.transportProjections.some((p) => p.role === 'OCCUPIED'),
      label: `第 ${i + 1} 天 · ${d.localDate}`,
    }));
  const virtual = (d: TemporaryDay): EditorDay => ({
    ...d,
    target: {
      type: 'NEW',
      localDate: d.localDate,
      sequence: d.side === 'before' ? 0 : real.length,
    },
    nodes: [],
    temporary: true,
    occupied: false,
    label: `${d.localDate} · 待添加`,
  });
  if (!real.length && !temporary.length)
    return [
      {
        key: 'anchor',
        localDate: trip.planningAnchorDate,
        target: {
          type: 'NEW',
          localDate: trip.planningAnchorDate,
          sequence: 0,
        },
        nodes: [],
        temporary: true,
        occupied: false,
        label: `${trip.planningAnchorDate} · 规划日`,
      },
    ];
  return [
    ...temporary.filter((d) => d.side === 'before').map(virtual),
    ...real,
    ...temporary.filter((d) => d.side === 'after').map(virtual),
  ];
}
export function arrangementName(n: ItineraryNodeView): string {
  return n.place?.name ?? (n.note?.split('\n')[0]?.trim() || '自由行动');
}
function value(form: HTMLFormElement) {
  return JSON.stringify([...new FormData(form).entries()]);
}
const content = (text: string) =>
  `<span class="control-content">${text}</span>`;
interface Hooks {
  api: TravelApi;
  detail: HTMLDialogElement;
  getTrip(): TripView | null;
  getOwner(): string | null;
  days(): EditorDay[];
  open(title: string, html: string): void;
  act(operation: () => Promise<void>): void;
  accepted(
    trip: TripView,
    command: TripAuthoringCommandInput | null,
  ): Promise<void>;
  load(tripId: string): Promise<void>;
  dirty(value: boolean): void;
  message(text: string): void;
}
/** One authoring draft bound to one owner/Trip. Existing place editors remain independent. */
export class TripAuthoringEditor {
  private context: {
    owner: string;
    tripId: string | null;
    mode: 'add' | 'move' | 'create';
    dayKey: string;
    nodeId?: string;
  } | null = null;
  private baseline = '';
  private recoveryRequired = false;
  private pending: {
    path: string;
    body: Record<string, unknown>;
    submitted: string;
    searchSnapshot: string | null;
    command: TripAuthoringCommandInput | null;
    beforeNodeIds: readonly string[];
  } | null = null;
  private acceptedSnapshot: string | null = null;
  private selectionOutcomeUnknown = false;
  private readonly placeSearch: PlaceSearchPicker;
  constructor(private readonly h: Hooks) {
    this.placeSearch = new PlaceSearchPicker(h.api);
  }
  get dayKey() {
    return this.context?.dayKey ?? '';
  }
  get owner() {
    return this.context?.owner;
  }
  get active() {
    return this.context !== null;
  }
  reset() {
    this.placeSearch.reset();
    this.selectionOutcomeUnknown = false;
    this.context = null;
    this.pending = null;
    this.recoveryRequired = false;
    this.acceptedSnapshot = null;
  }
  private form() {
    return this.h.detail.querySelector<HTMLFormElement>('form[data-authoring]');
  }
  private begin(mode: 'add' | 'move' | 'create', dayKey = '', nodeId?: string) {
    const owner = this.h.getOwner();
    if (!owner) throw new Error('请先核验登录账户。');
    this.placeSearch.reset();
    this.selectionOutcomeUnknown = false;
    this.context = {
      owner,
      tripId: mode === 'create' ? null : this.h.getTrip()!.id,
      mode,
      dayKey,
      ...(nodeId ? { nodeId } : {}),
    };
    this.pending = null;
    this.recoveryRequired = false;
    this.acceptedSnapshot = null;
  }
  private baselineForm() {
    this.baseline = this.form() ? value(this.form()!) : '';
    this.h.dirty(false);
  }
  openAdd(day: EditorDay) {
    this.begin('add', day.key);
    this.h.open(
      '添加安排',
      `<p class="authoring-date">${esc(day.label)}</p>${day.occupied ? '<p class="warning">这张日期卡已被跨日交通占用，不能添加普通安排。</p>' : `<p>想在这一天安排什么？</p><div class="authoring-types"><button data-authoring-kind="place">${content('地点')}</button><button data-authoring-kind="activity">${content('自由行动')}</button></div><p class="muted">时间可稍后设置，未指定时保持待定。</p>`}<p id="save-status" role="status"></p>`,
    );
    this.baselineForm();
  }
  openMove(n: ItineraryNodeView) {
    this.begin('move', n.dayOccurrenceId, n.id);
    this.h.open(
      '调整日期与顺序',
      `<p>${esc(arrangementName(n))}</p><p class="muted">只调整安排位置，不改时间事实。影响已选交通或受保护安排时会停止，原数据保留。</p><form id="authoring-move" data-authoring><label>放在哪一天<select name="day">${this.dayOptions(n.dayOccurrenceId)}</select></label><label>放在什么位置<select name="position" required></select></label><button class="primary">${content('保存位置')}</button></form><p id="save-status" role="status"></p>`,
    );
    this.updatePositions(n.position);
    this.baselineForm();
  }
  openCreate() {
    this.begin('create');
    this.h.open(
      '新建旅行',
      `<p>先确定旅行名称和规划开始日期，安排可以逐步补充。</p><form id="authoring-create" data-authoring><label>旅行名称<input name="name" maxlength="200" required autocomplete="off"></label><label>规划开始日期<input name="date" type="date" required></label><label>人数<input name="people" type="number" min="1" step="1" value="1" required></label><button class="primary">${content('创建旅行')}</button></form><p class="muted">空旅行不占用日期；添加第一个安排后才建立正式范围。</p><p id="save-status" role="status"></p>`,
    );
    this.baselineForm();
  }
  private dayOptions(selected: string) {
    return this.h
      .days()
      .map(
        (d) =>
          `<option value="${esc(d.key)}" ${d.key === selected ? 'selected' : ''} ${d.occupied ? 'disabled' : ''}>${esc(d.label)}</option>`,
      )
      .join('');
  }
  private updatePositions(selected?: number) {
    const f = this.form();
    if (!f || this.context?.mode !== 'move') return;
    const d = this.h
      .days()
      .find(
        (d) =>
          d.key === (f.elements.namedItem('day') as HTMLSelectElement).value,
      );
    const nodes = d?.nodes.filter((n) => n.id !== this.context?.nodeId) ?? [];
    const input = f.elements.namedItem('position') as HTMLSelectElement;
    input.innerHTML = [
      `<option value="0">最前面</option>`,
      ...nodes.map(
        (n, i) =>
          `<option value="${i + 1}" data-after="${n.id}">在「${esc(arrangementName(n))}」之后</option>`,
      ),
    ].join('');
    input.value = String(Math.min(selected ?? nodes.length, nodes.length));
  }
  chooseKind(kind: string) {
    if (!this.context || this.context.mode !== 'add') return;
    const day = this.h.days().find((d) => d.key === this.context!.dayKey);
    if (!day) return;
    const place = kind === 'place';
    this.h.open(
      place ? '添加地点' : '添加自由行动',
      `<p class="authoring-date">${esc(day.label)}</p><form id="authoring-add" data-authoring data-kind="${place ? 'place' : 'activity'}">${place ? '<p class="muted">搜索新地点，或从本人已保存的地点选择。</p><label>已保存的地点<select name="place" required><option value="">正在读取地点…</option></select></label><label>备注（可选）<textarea name="note" maxlength="2000" rows="3"></textarea></label>' : '<label>活动名称<input name="title" maxlength="200" required autocomplete="off" placeholder="例如：附近散步、休息"></label>'}<button class="primary">${content(place ? '添加地点' : '添加自由行动')}</button></form>${place ? '<p data-place-availability role="status"></p>' : ''}<p class="muted">到达、出发和停留可稍后设置，不自动填时间。</p><p id="save-status" role="status"></p>`,
    );
    this.baselineForm();
    if (place) {
      this.placeSearch.mount(
        this.form()!,
        this.context.tripId!,
        () => this.input(),
        (error) =>
          this.h.act(async () => {
            throw error;
          }),
      );
      this.h.act(() => this.loadPlaces(true));
    }
  }
  private async loadPlaces(initial: boolean) {
    const context = this.context;
    const user = await this.h.api.request<UserView>('/me');
    if (user.id !== context?.owner)
      throw new Error('请使用原账户；不会读取其他账户的地点。');
    const list = await this.h.api.request<TripListResponse>('/trips');
    if (context !== this.context) return;
    const places = new Map(
      list.trips.flatMap((t) =>
        orderedNodes(t).flatMap((n) =>
          n.place ? [[n.place.id, n.place] as const] : [],
        ),
      ),
    );
    const select = this.form()?.elements.namedItem(
      'place',
    ) as HTMLSelectElement | null;
    if (!select) return;
    const selected = select.value;
    select.innerHTML =
      '<option value="">请选择地点</option>' +
      [...places.values()]
        .map(
          (p) =>
            `<option value="${p.id}">${esc(p.name)}${p.address ? ` · ${esc(p.address)}` : ''}</option>`,
        )
        .join('');
    if (selected && places.has(selected)) select.value = selected;
    else if (selected.startsWith('search:') && this.placeSearch.candidate) {
      const candidate = this.placeSearch.candidate;
      const option = new Option(`搜索候选 · ${candidate.name}`, selected);
      option.dataset.searchedPlace = 'true';
      select.add(option);
      select.value = selected;
    } else if (selected) {
      select.insertAdjacentHTML(
        'afterbegin',
        '<option value="">原地点已不可用，请重新选择</option>',
      );
      select.value = '';
    }
    this.h.detail.querySelector('[data-place-availability]')!.innerHTML =
      places.size
        ? ''
        : '没有已保存的可靠地点。可以搜索新地点，或先添加自由行动。';
    if (initial)
      this.baseline = JSON.stringify(
        [...new FormData(this.form()!).entries()].map(([k, v]) => [
          k,
          k === 'note' || k === 'place' ? '' : v,
        ]),
      );
    this.input();
  }

  input() {
    const f = this.form();
    if (!f) return;
    // Search controls are intentionally absent from the formal command snapshot.
    // Their own baseline is captured before any async saved-place read.
    const dirty = value(f) !== this.baseline || this.placeSearch.dirty;
    this.h.dirty(dirty);
    this.h.message(dirty ? '还有未保存的修改。' : '当前表单与已提交内容一致。');
  }
  change(target: HTMLElement) {
    if (target.getAttribute('name') === 'day') this.updatePositions();
    this.input();
  }
  showRecovery(error: unknown) {
    if (!this.context) return;
    if (
      !(error instanceof WebError) ||
      !(
        error.status === 401 ||
        ['NETWORK', 'SERVICE_UNAVAILABLE', 'VERSION_CONFLICT'].includes(
          error.code,
        )
      )
    )
      return;
    this.recoveryRequired = true;
    if (error.code === 'VERSION_CONFLICT') this.pending = null;
    let panel = this.h.detail.querySelector('#authoring-recovery');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'authoring-recovery';
      this.h.detail.querySelector('.sheet-body')!.prepend(panel);
    }
    panel.innerHTML = sessionStorage.getItem('travel.web.session')
      ? '<p>草稿仍保留。恢复后重新读取同一账户的行程，再核对日期和顺序。</p><button data-authoring-recover><span class="control-content">重新读取并核对</span></button>'
      : '<p>草稿仍保留，请使用原账户恢复登录。</p><form id="authoring-login"><label>受邀邮箱<input name="email" type="email" required></label><button><span class="control-content">发送登录链接</span></button></form><form id="authoring-consume"><label>粘贴完整登录链接<input name="link" type="url" required autocomplete="off"></label><button><span class="control-content">恢复登录并核对</span></button></form>';
  }
  async recover() {
    if (!this.context) return;
    const user = await this.h.api.request<UserView>('/me');
    if (user.id !== this.context.owner)
      throw new Error('请使用原账户恢复，这份草稿不能转交其他账户。');
    if (this.pending) {
      // An unknown write outcome is reconciled by the same server idempotency key.
      const pending = this.pending;
      try {
        const fresh = await this.h.api.request<TripView>(
          pending.path,
          pending.body,
        );
        this.accept(fresh, pending);
        await this.h.accepted(fresh, pending.command);
      } catch (error) {
        if (error instanceof WebError && error.code === 'VERSION_CONFLICT')
          this.pending = null;
        else if (
          pending.path.endsWith('/place-selection') &&
          error instanceof WebError &&
          error.code === 'VALIDATION_ERROR'
        ) {
          // The old evidence cannot be resubmitted. Read authority before any fresh selection;
          // neither acknowledge the unknown write nor discard the user's note draft.
          this.pending = null;
          const form = this.form();
          const current = form ? this.placeSearch.selection(form) : null;
          if (
            !current ||
            current.selectionToken === pending.body.selectionToken
          ) {
            this.placeSearch.clearSelection();
            form?.querySelector('[data-searched-place]')?.remove();
            this.h.detail
              .querySelector('[data-selected-summary]')
              ?.replaceChildren();
          }
          this.selectionOutcomeUnknown = true;
        } else throw error;
      }
    }
    const oldForm = this.form();
    const oldDay = (
      oldForm?.elements.namedItem('day') as HTMLSelectElement | null
    )?.value;
    const oldPosition = oldForm?.elements.namedItem(
      'position',
    ) as HTMLSelectElement | null;
    const afterNodeId = oldPosition?.selectedOptions[0]?.dataset.after;
    const atStart = oldPosition?.value === '0';
    if (this.context.tripId) await this.h.load(this.context.tripId);
    if (this.form()?.dataset.kind === 'place') await this.loadPlaces(false);
    delete this.h.detail.dataset.unavailable;
    const form = this.form();
    if (form?.id === 'authoring-move') {
      const dayInput = form.elements.namedItem('day') as HTMLSelectElement;
      dayInput.innerHTML = this.dayOptions(oldDay ?? '');
      if (!this.h.days().some((d) => d.key === oldDay)) {
        dayInput.insertAdjacentHTML(
          'afterbegin',
          '<option value="">原日期已变化，请重新选择</option>',
        );
        dayInput.value = '';
      }
      this.updatePositions();
      const position = form.elements.namedItem('position') as HTMLSelectElement;
      const matching = [...position.options].find((o) =>
        atStart ? o.value === '0' : o.dataset.after === afterNodeId,
      );
      if (matching) position.value = matching.value;
      else {
        position.insertAdjacentHTML(
          'afterbegin',
          '<option value="">原相邻安排已变化，请重新选择位置</option>',
        );
        position.value = '';
      }
    }
    const missingTarget =
      this.context.mode === 'add' &&
      !this.h.days().some((d) => d.key === this.context!.dayKey);
    this.h.detail.querySelector('#authoring-recovery')!.innerHTML =
      `<p>已重新读取当前版本。${this.selectionOutcomeUnknown ? '旧地点候选已失效，上次写入结果仍需核对。请先确认当前安排是否已有该地点，再搜索和明确选择；备注草稿保留。' : '草稿尚未提交，请核对目标日期、位置及当前安排。'}</p>${
        this.selectionOutcomeUnknown
          ? `<p>当前安排：${
              this.h
                .days()
                .flatMap((d) => d.nodes.map(arrangementName))
                .map(esc)
                .join('、') || '暂无安排'
            }</p>`
          : ''
      }${missingTarget ? `<label>原日期卡已变化，请重新选择目标日期<select id="authoring-retarget"><option value="">请选择日期</option>${this.dayOptions('')}</select></label>` : ''}<button data-authoring-ack><span class="control-content">已核对，继续编辑</span></button>`;
  }
  acknowledge() {
    const retarget = this.h.detail.querySelector<HTMLSelectElement>(
      '#authoring-retarget',
    );
    if (retarget && this.context) {
      const day = this.h
        .days()
        .find((d) => d.key === retarget.value && !d.occupied);
      if (!day) {
        this.h.message('请选择新的目标日期，再核对这份草稿。');
        return;
      }
      this.context.dayKey = day.key;
      const dateLabel = this.h.detail.querySelector('.authoring-date');
      if (dateLabel) dateLabel.textContent = day.label;
      this.baseline = '';
      this.acceptedSnapshot = null;
    }
    this.recoveryRequired = false;
    this.selectionOutcomeUnknown = false;
    this.h.detail.querySelector('#authoring-recovery')?.remove();
    this.input();
  }

  private accept(
    fresh: TripView,
    pending: NonNullable<TripAuthoringEditor['pending']>,
  ) {
    if (
      pending.command?.type === 'ADD_PLACE_VISIT' ||
      pending.command?.type === 'ADD_FREE_ACTION'
    ) {
      const added = orderedNodes(fresh).filter(
        (n) => !pending.beforeNodeIds.includes(n.id),
      );
      if (added.length === 1 && this.context)
        this.context.dayKey = added[0]!.dayOccurrenceId;
    } else if (pending.command?.type === 'MOVE_NODE' && this.context)
      this.context.dayKey =
        orderedNodes(fresh).find((n) => n.id === this.context!.nodeId)
          ?.dayOccurrenceId ?? this.context.dayKey;
    this.selectionOutcomeUnknown = false;
    this.baseline = pending.submitted;
    this.placeSearch.acknowledge(pending.searchSnapshot);
    this.acceptedSnapshot = pending.submitted;
    this.pending = null;
    if (this.context?.mode === 'create') this.context.tripId = fresh.id;
    this.input();
  }
  submit(form: HTMLFormElement) {
    if (!this.context) return;
    if (this.recoveryRequired) {
      this.h.message('请先重新读取并核对草稿，再提交。');
      return;
    }
    const submitted = value(form),
      data = new FormData(form),
      searchSnapshot = this.placeSearch.snapshot;
    const searched =
      this.context.mode === 'add' ? this.placeSearch.selection(form) : null;
    if (this.acceptedSnapshot === submitted) {
      this.h.message('这份内容已保存，请修改后再提交。');
      return;
    }
    this.h.act(async () => {
      const context = this.context!;
      const actor = await this.h.api.request<UserView>('/me');
      if (actor.id !== context.owner)
        throw new Error('请使用原账户；这份草稿不能转交其他账户。');
      let command: TripAuthoringCommandInput | null = null;
      let path: string, body: Record<string, unknown>;
      if (context.mode === 'create') {
        path = '/trips';
        body = {
          name: String(data.get('name')).trim(),
          planningAnchorDate: data.get('date'),
          defaultPeopleCount: Number(data.get('people')),
          idempotencyKey: crypto.randomUUID(),
        };
      } else {
        const trip = this.h.getTrip();
        if (!trip || trip.id !== context.tripId)
          throw new Error('请先恢复并核对这份旅行。');
        const day = this.h
          .days()
          .find(
            (d) =>
              d.key ===
              (context.mode === 'move' ? data.get('day') : context.dayKey),
          );
        if (!day) throw new Error('目标日期卡已变化，请重新选择。');
        if (context.mode === 'move')
          command = {
            type: 'MOVE_NODE',
            nodeId: context.nodeId!,
            targetDay: day.target,
            position: Number(data.get('position')),
          };
        else if (form.dataset.kind === 'place')
          command = {
            type: 'ADD_PLACE_VISIT',
            targetDay: day.target,
            position: day.nodes.length,
            place: { type: 'EXISTING', placeId: String(data.get('place')) },
            note: String(data.get('note') ?? '') || null,
          };
        else
          command = {
            type: 'ADD_FREE_ACTION',
            targetDay: day.target,
            position: day.nodes.length,
            note: String(data.get('title')).trim(),
          };
        path = `/trips/${trip.id}/authoring`;
        body = {
          baseTripVersion: trip.version,
          idempotencyKey: crypto.randomUUID(),
          command,
        } satisfies TripAuthoringRequest;
      }
      if (searched && command?.type === 'ADD_PLACE_VISIT') {
        path = `/trips/${context.tripId}/place-selection`;
        body = {
          selectionToken: searched.selectionToken,
          baseTripVersion: this.h.getTrip()!.version,
          idempotencyKey: body.idempotencyKey,
          targetDay: command.targetDay,
          position: command.position,
          note: command.note,
        };
      }
      const pending = this.pending ?? {
        path,
        body,
        submitted,
        searchSnapshot,
        command,
        beforeNodeIds: this.h.getTrip()
          ? orderedNodes(this.h.getTrip()!).map((n) => n.id)
          : [],
      };
      this.pending = pending;
      let fresh: TripView;
      try {
        fresh = await this.h.api.request<TripView>(pending.path, pending.body);
      } catch (error) {
        if (
          error instanceof WebError &&
          error.status >= 400 &&
          error.status < 500
        )
          this.pending = null;
        throw error;
      }
      this.accept(fresh, pending);
      await this.h.accepted(fresh, pending.command);
      this.h.message(
        `本次提交已保存。${value(form) !== this.baseline || this.placeSearch.dirty ? ' 新修改仍未保存。' : ''}`,
      );
    });
  }
}
