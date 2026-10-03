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
    element.addEventListener('pointercancel', () => {
      this.pointer = null;
      element.style.transform = '';
    });
    element.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-close]')) this.close();
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
    this.element.querySelector<HTMLElement>('[data-close]')?.focus();
  }
  close() {
    if (!this.mayClose()) return;
    this.element.close();
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
