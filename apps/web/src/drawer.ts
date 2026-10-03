export class DetailDrawer {
  private opener: HTMLElement | null = null;
  private openerKey: { attribute: string; value: string } | null = null;
  private pointer: { id: number; y: number } | null = null;
  private priorOverflow = '';
  constructor(
    readonly element: HTMLDialogElement,
    private readonly mayClose: () => boolean,
    private readonly closed: () => void,
  ) {
    element.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    element.addEventListener('pointerdown', (event) => {
      if (
        !matchMedia('(max-width: 760px)').matches ||
        !(event.target instanceof HTMLElement) ||
        !event.target.closest('[data-drag]') ||
        !event.isPrimary ||
        event.button !== 0 ||
        this.pointer !== null ||
        event.target.closest('button,a,input,textarea,select')
      )
        return;
      this.pointer = { id: event.pointerId, y: event.clientY };
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener('pointermove', (event) => {
      if (this.pointer?.id === event.pointerId)
        element.style.transform = `translateY(${Math.max(0, event.clientY - this.pointer.y)}px)`;
    });
    const end = (event: PointerEvent) => {
      if (this.pointer?.id !== event.pointerId) return;
      const distance = event.clientY - this.pointer.y;
      this.pointer = null;
      element.style.transform = '';
      if (distance >= 110) this.close();
    };
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', () => this.resetDrag());
    element.addEventListener('lostpointercapture', () => this.resetDrag());
    window.visualViewport?.addEventListener('resize', () => this.fitViewport());
    window.visualViewport?.addEventListener('scroll', () =>
      this.fitViewport(false),
    );
    window.addEventListener('resize', () => this.fitViewport());
    element.addEventListener('focusin', () => this.fitViewport());
    element.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-close]')) this.close();
    });
  }
  private resetDrag() {
    const pointer = this.pointer;
    this.pointer = null;
    this.element.style.transform = '';
    if (pointer && this.element.hasPointerCapture(pointer.id))
      this.element.releasePointerCapture(pointer.id);
  }
  private fitViewport(revealFocus = true) {
    if (!this.element.open) return;
    const viewport = window.visualViewport;
    if (viewport && viewport.scale === 1) {
      this.element.style.setProperty(
        '--sheet-viewport-height',
        `${viewport.height}px`,
      );
      this.element.style.setProperty(
        '--sheet-viewport-bottom',
        `${Math.max(0, innerHeight - viewport.height - viewport.offsetTop)}px`,
      );
    } else {
      this.element.style.removeProperty('--sheet-viewport-height');
      this.element.style.removeProperty('--sheet-viewport-bottom');
    }
    const head = this.element.querySelector<HTMLElement>('.sheet-head');
    if (head)
      this.element.style.setProperty(
        '--sheet-head-height',
        `${head.getBoundingClientRect().height}px`,
      );
    if (!revealFocus) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        this.element.open &&
        active instanceof HTMLElement &&
        this.element.contains(active) &&
        active.matches('input,textarea,select')
      )
        active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  open(html: string) {
    delete this.element.dataset.unavailable;
    if (!this.element.open) {
      this.opener = document.activeElement as HTMLElement;
      this.openerKey =
        ['data-node', 'data-route-from'].flatMap((attribute) => {
          const value = this.opener?.getAttribute(attribute);
          return value ? [{ attribute, value }] : [];
        })[0] ?? null;
      this.priorOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      this.element.innerHTML = html;
      this.element.showModal();
    } else this.element.innerHTML = html;
    this.resetDrag();
    this.fitViewport();
    this.element
      .querySelector<HTMLElement>('[data-close]')
      ?.focus({ preventScroll: true });
  }
  close() {
    if (!this.mayClose()) return;
    this.resetDrag();
    this.element.close();
    this.element.style.removeProperty('--sheet-viewport-height');
    this.element.style.removeProperty('--sheet-viewport-bottom');
    document.body.style.overflow = this.priorOverflow;
    this.closed();
    const target = this.opener?.isConnected
      ? this.opener
      : this.openerKey
        ? document.querySelector<HTMLElement>(
            `[${this.openerKey.attribute}="${CSS.escape(this.openerKey.value)}"]`,
          )
        : null;
    (
      target ??
      document.querySelector<HTMLElement>(
        '#app [data-action=reload], #app #login input',
      )
    )?.focus();
  }
}
