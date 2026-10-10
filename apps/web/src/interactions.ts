import { esc } from './model.js';

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function validCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}
let sequence = 0;
const fields = (form: HTMLFormElement) =>
  [...form.querySelectorAll<Field>('input,select,textarea')].filter(
    (field) =>
      !field.name.startsWith('_dateDraft_') &&
      !field.name.startsWith('_timeDraft_') &&
      !field.hasAttribute('data-zone'),
  );

function fieldName(field: Field): string {
  const labels: Record<string, string> = {
    name: '旅行名称',
    date: '开始日期',
    people: '人数',
    email: '邮箱',
    title: '活动名称',
    place: '地点',
    day: '目标日期',
    position: '位置',
    when: '当地日期与时间',
    zone: '事件所在地',
    minutes: '停留分钟数',
    link: '完整登录链接',
    travelMode: '查询方式',
    note: '备注',
  };
  return (
    labels[field.name] ??
    (field.hasAttribute('data-place-query') ? '地点名称或地址' : '此项')
  );
}

export function fieldProblem(field: Field): string {
  if (
    field.disabled ||
    (field instanceof HTMLInputElement &&
      ['button', 'submit', 'checkbox', 'radio'].includes(field.type))
  )
    return '';
  const raw = field.value;
  const value = raw.trim();
  const label = fieldName(field);
  if ((field.required || field.name === 'zone') && !value)
    return `${['date', 'place', 'day', 'position', 'zone', 'travelMode'].includes(field.name) ? '请选择' : '请输入'}${label}`;
  if (!value && !field.validity.badInput) return '';
  if (
    'maxLength' in field &&
    field.maxLength >= 0 &&
    raw.length > field.maxLength
  )
    return `${label}最多 ${field.maxLength} 字`;
  if (field instanceof HTMLInputElement) {
    if (field.type === 'number') {
      if (
        field.validity.badInput ||
        !Number.isFinite(Number(value)) ||
        !Number.isInteger(Number(value))
      )
        return field.name === 'people'
          ? '人数需为 1 或以上的整数'
          : `${label}需为整数`;
      if (field.min && Number(value) < Number(field.min))
        return field.name === 'people'
          ? '人数需为 1 或以上的整数'
          : `${label}需为 ${field.min} 或以上的整数`;
    }
    if (field.type === 'email' && field.validity.typeMismatch)
      return '请输入有效的邮箱地址';
    if (field.type === 'url' && field.validity.typeMismatch)
      return '请粘贴完整的登录链接';
    if (field.getAttribute('type') === 'date' && !validCivilDate(value))
      return '请选择有效的日期';
    if (field.getAttribute('type') === 'datetime-local') {
      const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/u.exec(value);
      if (
        !parts ||
        !validCivilDate(parts[1]!) ||
        Number(parts[2]) > 23 ||
        Number(parts[3]) > 59
      )
        return '请选择有效日期并输入时间（00:00–23:59）';
    }
  }
  return field.validity.valid ? '' : `请检查${label}的格式或范围`;
}

export function showFieldError(field: Field, message: string) {
  field.id ||= `travel-field-${++sequence}`;
  const id = `${field.id}-error`;
  let error = document.getElementById(id);
  if (!error) {
    error = document.createElement('span');
    error.id = id;
    error.className = 'field-error';
    const anchor =
      field.name === 'place' && field.closest('label')?.hidden
        ? field.closest('label')!
        : (field.closest('.date-control,.stepper') ?? field);
    anchor.insertAdjacentElement('afterend', error);
    const descriptions = new Set(
      (field.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean),
    );
    descriptions.add(id);
    field.setAttribute('aria-describedby', [...descriptions].join(' '));
  }
  error.textContent = message;
  error.hidden = !message;
  field.setAttribute('aria-invalid', String(!!message));
  const proxy =
    field.name === 'zone'
      ? field.form?.querySelector('[data-zone]')
      : field.name === 'place' && field.closest('label')?.hidden
        ? field.form?.querySelector('[data-place-query]')
        : field.closest('.date-control')?.querySelector('button');
  proxy?.setAttribute('aria-invalid', String(!!message));
  proxy?.setAttribute('aria-describedby', id);
}

export function validateForm(form: HTMLFormElement): boolean {
  prepareForm(form);
  let first: Field | undefined;
  for (const field of fields(form)) {
    const problem = fieldProblem(field);
    showFieldError(field, problem);
    if (problem && !first) first = field;
  }
  if (first) {
    const focus =
      first.name === 'zone'
        ? (form.querySelector<HTMLElement>('[data-zone]') ?? first)
        : first.name === 'place' && first.closest('label')?.hidden
          ? (form.querySelector<HTMLElement>('[data-place-query]') ?? first)
          : (first
              .closest('.date-control')
              ?.querySelector<HTMLElement>('button') ?? first);
    if (first.name === 'zone') {
      const details = focus.closest('details');
      if (details) details.open = true;
    }
    focus.focus();
    form.querySelector('[data-form-validation]')!.textContent =
      '请检查标出的项目后再提交。';
  } else form.querySelector('[data-form-validation]')!.textContent = '';
  return !first;
}

function prepareForm(form: HTMLFormElement) {
  form.noValidate = true;
  if (!form.querySelector('[data-form-validation]')) {
    const status = document.createElement('p');
    status.dataset.formValidation = '';
    status.className = 'form-validation';
    status.setAttribute('role', 'status');
    form.append(status);
  }
}

const civil = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dateLabel = (value: string) =>
  value
    ? `${value.slice(0, 4)} 年 ${Number(value.slice(5, 7))} 月 ${Number(value.slice(8, 10))} 日`
    : '选择日期';
let activeCalendar: { close(): void } | null = null;

function enhanceDate(input: HTMLInputElement) {
  if (input.dataset.calendarReady) return;
  input.dataset.calendarReady = 'true';
  const dateTime = input.getAttribute('type') === 'datetime-local';
  const wrap = document.createElement('span');
  wrap.className = 'date-control';
  input.before(wrap);
  wrap.append(input);
  input.classList.add('date-source');
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'date-trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  wrap.append(trigger);
  let datePart = input.value.slice(0, 10);
  const dateDraft = document.createElement('input');
  dateDraft.type = 'hidden';
  dateDraft.name = `_dateDraft_${input.name}`;
  wrap.append(dateDraft);
  let time: HTMLInputElement | null = null;
  const sync = () => {
    datePart = input.value.slice(0, 10);
    dateDraft.value = datePart;
    trigger.innerHTML = `<span class="control-content"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v15H5zM8 2v6m8-6v6M5 10h14"/></svg>${esc(dateLabel(datePart))}</span>`;
    if (time) time.value = input.value.slice(11, 16);
  };
  if (dateTime) {
    time = document.createElement('input');
    time.type = 'text';
    time.name = `_timeDraft_${input.name}`;
    time.inputMode = 'numeric';
    time.placeholder = 'HH:mm';
    time.setAttribute('aria-label', '当地时间（HH:mm）');
    time.dataset.timePart = '';
    wrap.append(time);
    time.addEventListener('input', () => {
      const part = time!.value;
      const heldDate = datePart;
      input.value =
        /^\d{2}:\d{2}$/u.test(part) && datePart ? `${datePart}T${part}` : '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      datePart = heldDate;
      dateDraft.value = heldDate;
      // Keep an incomplete time visible while the backing native value remains invalid.
      time!.value = part;
      trigger.querySelector('.control-content')!.lastChild!.textContent =
        dateLabel(datePart);
    });
  }
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  sync();
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    activeCalendar?.close();
    const picker = document.createElement('div');
    picker.className = 'calendar';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', '选择日期');
    picker.id = `travel-calendar-${++sequence}`;
    picker.setAttribute('popover', 'manual');
    picker.addEventListener('click', (event) => event.preventDefault());
    trigger.setAttribute('aria-controls', picker.id);
    trigger.setAttribute('aria-expanded', 'true');
    wrap.append(picker);
    const initial = datePart
      ? datePart.split('-').map(Number)
      : [
          new Date().getFullYear(),
          new Date().getMonth() + 1,
          new Date().getDate(),
        ];
    let year = initial[0]!,
      month = initial[1]! - 1,
      focusDate = civil(year, month, initial[2]!);
    const close = () => {
      picker.hidePopover();
      picker.remove();
      trigger.setAttribute('aria-expanded', 'false');
      if (activeCalendar?.close === close) activeCalendar = null;
      document.removeEventListener('pointerdown', outside, true);
      trigger.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      if (
        !picker.contains(event.target as Node) &&
        !trigger.contains(event.target as Node)
      )
        close();
    };
    activeCalendar = { close };
    const changeMonth = (amount: number) => {
      const next = new Date(year, month + amount, 1, 12);
      year = next.getFullYear();
      month = next.getMonth();
      focusDate = civil(year, month, 1);
      renderCalendar();
    };
    const choose = (value: string) => {
      const heldTime = time?.value ?? '';
      datePart = value;
      input.value = dateTime
        ? time?.value && /^\d{2}:\d{2}$/u.test(time.value)
          ? `${value}T${time.value}`
          : ''
        : value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!input.value) {
        datePart = value;
        trigger.querySelector('.control-content')!.lastChild!.textContent =
          dateLabel(value);
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      if (!input.value) {
        datePart = value;
        trigger.querySelector('.control-content')!.lastChild!.textContent =
          dateLabel(value);
      }
      if (time && !input.value) time.value = heldTime;
      dateDraft.value = value;
      close();
    };
    const renderCalendar = () => {
      const first = (new Date(year, month, 1, 12).getDay() + 6) % 7;
      const count = new Date(year, month + 1, 0, 12).getDate();
      const today = civil(
        new Date().getFullYear(),
        new Date().getMonth(),
        new Date().getDate(),
      );
      const minYear = Math.min(year, new Date().getFullYear()) - 100;
      picker.innerHTML = `<div class="calendar-heading"><button type="button" data-month="-1" aria-label="上个月">‹</button><select aria-label="年份">${Array.from({ length: 201 }, (_, i) => `<option value="${minYear + i}" ${minYear + i === year ? 'selected' : ''}>${minYear + i} 年</option>`).join('')}</select><select aria-label="月份">${Array.from({ length: 12 }, (_, i) => `<option value="${i}" ${month === i ? 'selected' : ''}>${i + 1} 月</option>`).join('')}</select><button type="button" data-month="1" aria-label="下个月">›</button></div><p class="sr-only" aria-live="polite">${year} 年 ${month + 1} 月</p><div class="calendar-week" aria-hidden="true">${['一', '二', '三', '四', '五', '六', '日'].map((d) => `<span>${d}</span>`).join('')}</div><div class="calendar-days" role="grid" aria-label="${year} 年 ${month + 1} 月">${'<span aria-hidden="true"></span>'.repeat(first)}${Array.from(
        { length: count },
        (_, i) => {
          const value = civil(year, month, i + 1);
          return `<button type="button" role="gridcell" data-date="${value}" aria-label="${dateLabel(value)}" aria-selected="${value === datePart}" ${value === today ? 'aria-current="date"' : ''} tabindex="${value === focusDate ? '0' : '-1'}">${i + 1}</button>`;
        },
      ).join(
        '',
      )}</div><button type="button" data-calendar-cancel>取消选择</button>`;
      picker
        .querySelectorAll<HTMLButtonElement>('[data-month]')
        .forEach(
          (b) => (b.onclick = () => changeMonth(Number(b.dataset.month))),
        );
      picker.querySelector<HTMLSelectElement>('[aria-label=年份]')!.onchange = (
        event,
      ) => {
        year = Number((event.target as HTMLSelectElement).value);
        focusDate = civil(year, month, 1);
        renderCalendar();
      };
      picker.querySelector<HTMLSelectElement>('[aria-label=月份]')!.onchange = (
        event,
      ) => {
        month = Number((event.target as HTMLSelectElement).value);
        focusDate = civil(year, month, 1);
        renderCalendar();
      };
      picker
        .querySelectorAll<HTMLButtonElement>('[data-date]')
        .forEach((b) => (b.onclick = () => choose(b.dataset.date!)));
      picker.querySelector<HTMLButtonElement>(
        '[data-calendar-cancel]',
      )!.onclick = close;
      picker.querySelector<HTMLElement>(`[data-date="${focusDate}"]`)?.focus();
    };
    picker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        changeMonth(
          (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1),
        );
        return;
      }
      const offset: Record<string, number> = {
        ArrowLeft: -1,
        ArrowRight: 1,
        ArrowUp: -7,
        ArrowDown: 7,
      };
      if (
        offset[event.key] &&
        (event.target as HTMLElement).hasAttribute('data-date')
      ) {
        event.preventDefault();
        const parts = focusDate.split('-').map(Number);
        const next = new Date(
          parts[0]!,
          parts[1]! - 1,
          parts[2]! + offset[event.key]!,
          12,
        );
        year = next.getFullYear();
        month = next.getMonth();
        focusDate = civil(year, month, next.getDate());
        renderCalendar();
      }
    });
    picker.showPopover();
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(340, innerWidth - 8);
    picker.style.width = `${width}px`;
    picker.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - width - 4))}px`;
    picker.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - Math.min(420, innerHeight - 24)))}px`;
    renderCalendar();
    document.addEventListener('pointerdown', outside, true);
  });
}

export function closeCalendar(): boolean {
  if (!activeCalendar) return false;
  activeCalendar.close();
  return true;
}

export function enhanceInteractions() {
  document.querySelectorAll('form').forEach(prepareForm);
  document
    .querySelectorAll<HTMLInputElement>(
      'input[type=date],input[type=datetime-local]',
    )
    .forEach(enhanceDate);
  document
    .querySelectorAll<HTMLInputElement>('input[name=people]')
    .forEach((input) => {
      if (input.closest('.stepper')) return;
      const wrap = document.createElement('span');
      wrap.className = 'stepper';
      input.before(wrap);
      const minus = document.createElement('button'),
        plus = document.createElement('button');
      minus.type = plus.type = 'button';
      minus.textContent = '−';
      plus.textContent = '+';
      minus.setAttribute('aria-label', '减少人数');
      plus.setAttribute('aria-label', '增加人数');
      wrap.append(minus, input, plus);
      const update = () => {
        minus.disabled = !!input.value && Number(input.value) <= 1;
      };
      [minus, plus].forEach(
        (button, index) =>
          (button.onclick = () => {
            if (!input.value || !Number.isInteger(Number(input.value))) return;
            input.value = String(
              Math.max(1, Number(input.value) + (index ? 1 : -1)),
            );
            input.dispatchEvent(new Event('input', { bubbles: true }));
            update();
          }),
      );
      input.addEventListener('input', update);
      update();
    });
}

export function installInteractions() {
  const enhance = enhanceInteractions;
  let pointerButton = false;
  document.addEventListener(
    'pointerdown',
    (event) => {
      pointerButton =
        event.target instanceof Element && !!event.target.closest('button');
    },
    true,
  );
  document.addEventListener(
    'pointerup',
    () => {
      pointerButton = false;
    },
    true,
  );
  document.addEventListener(
    'pointercancel',
    () => {
      pointerButton = false;
    },
    true,
  );
  new MutationObserver(enhance).observe(document.body, {
    childList: true,
    subtree: true,
  });
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && !validateForm(form)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  document.addEventListener('focusout', (event) => {
    // A blur inserted between pointer-down and click must not move its target.
    // Submit performs the same validation; other buttons keep the current draft.
    if (pointerButton || event.relatedTarget instanceof HTMLButtonElement)
      return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement
    ) {
      const field = event.target.hasAttribute('data-zone')
        ? (event.target.form?.querySelector<HTMLInputElement>(
            'input[name=zone]',
          ) ?? event.target)
        : event.target;
      if (field.form && (field.type !== 'hidden' || field.name === 'zone'))
        showFieldError(field, fieldProblem(field));
    }
  });
  document.addEventListener('input', (event) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement
    )
      if (event.target.getAttribute('aria-invalid') === 'true')
        showFieldError(event.target, fieldProblem(event.target));
  });
  // Native submit() bypasses submit events; route it through the same guarded path.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (this.isConnected && this.ownerDocument === document)
      this.requestSubmit();
    else nativeSubmit.call(this);
  };
  enhance();
}

let pendingConfirmation: Promise<boolean> | null = null;
export function confirmAction(
  message: string,
  action = '放弃修改',
  cancel = '继续编辑',
): Promise<boolean> {
  if (pendingConfirmation) return pendingConfirmation;
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation';
  dialog.dataset.variant = 'modal';
  dialog.setAttribute('aria-labelledby', 'confirmation-title');
  dialog.setAttribute('aria-describedby', 'confirmation-message');
  dialog.innerHTML = `<h2 id="confirmation-title">${esc(action)}</h2><p id="confirmation-message">${esc(message)}</p><div class="dialog-actions"><button type="button" data-confirm-cancel>${esc(cancel)}</button><button type="button" class="danger" data-confirm-accept>${esc(action)}</button></div>`;
  document.body.append(dialog);
  pendingConfirmation = new Promise((resolve) => {
    const finish = (accepted: boolean) => {
      dialog.close();
      dialog.remove();
      pendingConfirmation = null;
      if (opener?.isConnected) opener.focus();
      resolve(accepted);
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!.onclick =
      () => finish(false);
    dialog.querySelector<HTMLButtonElement>('[data-confirm-accept]')!.onclick =
      () => finish(true);
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!.focus();
  });
  return pendingConfirmation;
}
