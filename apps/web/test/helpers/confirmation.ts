import type { Page } from '@playwright/test';

type Confirmation = {
  message(): string;
  accept(): Promise<void>;
  dismiss(): Promise<void>;
};
type Handler = (dialog: Confirmation) => unknown;
const handlers = new WeakMap<Page, { callback: Handler; once: boolean }>();
const installed = new WeakSet<Page>();

async function install(page: Page) {
  if (installed.has(page)) return;
  installed.add(page);
  await page.exposeBinding(
    'testApplicationConfirmation',
    async (_, message: string) => {
      const handler = handlers.get(page);
      if (!handler) return;
      if (handler.once) handlers.delete(page);
      await handler.callback({
        message: () => message,
        accept: () => page.locator('[data-confirm-accept]').click(),
        dismiss: () => page.locator('[data-confirm-cancel]').click(),
      });
    },
  );
  const observe = () => {
    const seen = new WeakSet<Element>();
    const scan = () =>
      document
        .querySelectorAll('dialog.confirmation[open]')
        .forEach((dialog) => {
          if (seen.has(dialog)) return;
          seen.add(dialog);
          void (
            window as unknown as {
              testApplicationConfirmation(message: string): Promise<void>;
            }
          ).testApplicationConfirmation(
            dialog.querySelector('#confirmation-message')!.textContent!,
          );
        });
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    scan();
  };
  await page.addInitScript(observe);
  await page.evaluate(observe);
}

/** Existing business assertions now answer the actual application confirmation. */
export async function onConfirmation(page: Page, callback: Handler) {
  handlers.set(page, { callback, once: false });
  await install(page);
}
export async function onceConfirmation(page: Page, callback: Handler) {
  handlers.set(page, { callback, once: true });
  await install(page);
}
export function clearConfirmation(page: Page) {
  handlers.delete(page);
}
