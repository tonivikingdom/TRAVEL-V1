import { chromium, type Page } from 'playwright-core';
import { blockedPage } from '../src/browser.js';

// Read-only instrumentation for this isolated live harness. The service's own
// launcher, launch options, selectors, deadlines and query behavior are retained.
export function pageUrlType(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === 'about:') return 'ABOUT_BLANK';
  if (url.hostname === 'accounts.google.com') return 'GOOGLE_ACCOUNT';
  if (url.hostname === 'consent.google.com') return 'GOOGLE_CONSENT';
  if (url.hostname !== 'www.google.com') return 'OTHER';
  if (url.pathname.startsWith('/sorry')) return 'GOOGLE_VERIFICATION';
  if (url.pathname.startsWith('/maps/dir/')) return 'GOOGLE_MAPS_DIRECTIONS';
  return 'GOOGLE_OTHER';
}

export interface ContextObservation {
  pageUrlType: string | null;
  directionsMainExists: boolean | null;
  leaveNowExists: boolean | null;
  leaveNowVisible: boolean | null;
  blockedPage: boolean | null;
  http403Seen: boolean;
  http429Seen: boolean;
  navigationStatus: number | null;
  contextClosed: boolean;
  observationComplete: boolean;
}

async function inspect(page: Page, observation: ContextObservation) {
  // No URL, text, response body, header or credential is persisted.
  const url = page.url();
  observation.pageUrlType = pageUrlType(url);
  observation.directionsMainExists =
    (await page
      .getByRole('main', { name: 'Directions', exact: true })
      .count()) > 0;
  const leave = page.getByRole('button', { name: 'Leave now', exact: true });
  observation.leaveNowExists = (await leave.count()) > 0;
  observation.leaveNowVisible = await leave.first().isVisible();
  const text = await page.locator('body').innerText({ timeout: 500 });
  observation.blockedPage = blockedPage(url, text);
  observation.observationComplete = true;
}

export function observeLiveBrowser() {
  const observations: ContextObservation[] = [];
  const diagnostics = {
    launchCalls: 0,
    browserDisconnected: false,
    contexts: observations,
  };
  const originalLaunch = chromium.launch;
  chromium.launch = async (options) => {
    diagnostics.launchCalls++;
    const browser = await originalLaunch.call(chromium, options);
    browser.once('disconnected', () => {
      diagnostics.browserDisconnected = true;
    });
    const originalContext = browser.newContext.bind(browser);
    browser.newContext = async (contextOptions) => {
      const context = await originalContext(contextOptions);
      const observation: ContextObservation = {
        pageUrlType: null,
        directionsMainExists: null,
        leaveNowExists: null,
        leaveNowVisible: null,
        blockedPage: null,
        http403Seen: false,
        http429Seen: false,
        navigationStatus: null,
        contextClosed: false,
        observationComplete: false,
      };
      observations.push(observation);
      context.once('close', () => {
        observation.contextClosed = true;
      });
      context.on('page', (page) => {
        page.on('response', (response) => {
          const url = new URL(response.url());
          if (!/(^|\.)google\.com$/.test(url.hostname)) return;
          if (response.status() === 403) observation.http403Seen = true;
          if (response.status() === 429) observation.http429Seen = true;
          if (
            response.request().isNavigationRequest() &&
            response.frame() === page.mainFrame()
          )
            observation.navigationStatus = response.status();
        });
      });
      const originalClose = context.close.bind(context);
      let inspected = false;
      context.close = async (closeOptions) => {
        if (!inspected) {
          inspected = true;
          const page = context.pages()[0];
          if (page) {
            try {
              await inspect(page, observation);
            } catch {
              // Diagnostics never replace or hide the actual service outcome.
            }
          }
        }
        await originalClose(closeOptions);
      };
      return context;
    };
    return browser;
  };
  return {
    diagnostics,
    restore: () => {
      chromium.launch = originalLaunch;
    },
  };
}
