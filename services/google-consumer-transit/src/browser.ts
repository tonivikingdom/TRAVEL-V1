import { X509Certificate, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright-core';
import {
  PROVIDER,
  TransitError,
  wallClock,
  type Query,
  type SearchResult,
} from './contract.js';
import type { Config } from './config.js';
import { selectResponse, type PageEvidence } from './parser.js';
import { VerificationUpdates, waitForVerification } from './verification.js';

export function blockedPage(url: string, text: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.hostname === 'accounts.google.com' ||
    parsed.pathname.startsWith('/sorry') ||
    /unusual traffic|captcha|verify (?:that )?you are (?:a )?human|access denied|temporarily blocked|sign in to continue/i.test(
      text,
    )
  );
}
export function pageStateMatches(url: string, query: Query): boolean {
  const value = new URL(url);
  return (
    value.hostname === 'www.google.com' &&
    value.pathname.startsWith('/maps/dir/') &&
    value.pathname.includes(
      `!6e${query.timeMode === 'DEPART_AT' ? 0 : 1}!7e2!8j${wallClock(query)}!3e3`,
    )
  );
}
// Passive verification of a request emitted by Google's visible UI. This is
// never a private request builder. Unknown encodings fail closed.
export function responseRequestMatches(rawUrl: string, query: Query): boolean {
  const url = new URL(rawUrl);
  const pb = url.searchParams.get('pb') ?? '';
  return (
    url.protocol === 'https:' &&
    url.hostname === 'www.google.com' &&
    url.pathname === '/maps/preview/directions' &&
    new RegExp(
      `!19m3!1e${query.timeMode === 'DEPART_AT' ? 0 : 1}!2e2!3j${wallClock(query)}(?:!|$)`,
    ).test(pb)
  );
}
async function checkBlocked(page: Page): Promise<void> {
  if (blockedPage(page.url(), await page.locator('body').innerText()))
    throw new TransitError('UPSTREAM_BLOCKED');
}
export interface TransitClient {
  search(query: Query, signal: AbortSignal): Promise<SearchResult>;
  close(): Promise<void>;
}
export class BrowserClient implements TransitClient {
  private launch: Promise<Browser> | undefined;
  private closing = false;
  private readonly contexts = new Set<BrowserContext>();
  constructor(
    private readonly config: Config,
    private readonly launchForTest?: () => Promise<Browser>,
  ) {}
  private async ensureBrowser(): Promise<Browser> {
    if (this.closing) throw new TransitError('BROWSER_UNAVAILABLE');
    if (!this.launch) {
      this.launch = (async () => {
        if (this.launchForTest) return this.launchForTest();
        const args: string[] = [];
        // Trust only the environment's explicitly provided proxy certificate, never disable TLS checks.
        if (process.env.CODEX_PROXY_CERT) {
          const cert = new X509Certificate(
            await readFile(process.env.CODEX_PROXY_CERT),
          );
          const pin = createHash('sha256')
            .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
            .digest('base64');
          args.push(`--ignore-certificate-errors-spki-list=${pin}`);
        }
        const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
        const browser = await chromium.launch({
          executablePath: this.config.executablePath,
          headless: this.config.headless,
          timeout: 15000,
          args,
          ...(proxy ? { proxy: { server: proxy } } : {}),
        });
        browser.on('disconnected', () => {
          this.launch = undefined;
        });
        return browser;
      })().catch(() => {
        this.launch = undefined;
        throw new TransitError('BROWSER_UNAVAILABLE');
      });
    }
    return this.launch;
  }
  async search(query: Query, signal: AbortSignal): Promise<SearchResult> {
    let stage = 'browser-start';
    let context: BrowserContext | undefined;
    let activePage: Page | undefined;
    let restricted = false;
    let upstreamFailure = false;
    const abort = () => {
      void context?.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const throwAborted = () => {
      if (signal.aborted)
        throw signal.reason instanceof TransitError
          ? signal.reason
          : new TransitError('REQUEST_CANCELLED');
    };
    try {
      throwAborted();
      const browser = await this.ensureBrowser();
      throwAborted();
      context = await browser.newContext({
        locale: 'en-US',
        timezoneId: query.timezone,
      });
      this.contexts.add(context);
      throwAborted();
      const page = await context.newPage();
      activePage = page;
      page.setDefaultTimeout(12000);
      const raws: string[] = [];
      const capturedAt: string[] = [];
      const pending = new Set<Promise<void>>();
      const updates = new VerificationUpdates();
      await page.exposeFunction('transitEvidenceChanged', () =>
        updates.notify(),
      );
      let responseFailure = false;
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (
          url.hostname !== 'www.google.com' ||
          url.protocol !== 'https:' ||
          url.pathname !== '/maps/preview/directions'
        )
          return;
        if (response.status() === 403 || response.status() === 429) {
          restricted = true;
          updates.notify();
          return;
        }
        if (response.status() !== 200) {
          responseFailure = true;
          upstreamFailure = true;
          return;
        }
        if (!responseRequestMatches(response.request().url(), query)) return;
        if (raws.length + pending.size >= 20) {
          responseFailure = true;
          return;
        }
        const task = (async () => {
          try {
            const declared = Number(response.headers()['content-length']);
            if (declared > 5_000_000) {
              responseFailure = true;
              return;
            }
            const body = await response.text();
            if (body.length > 5_000_000) {
              responseFailure = true;
              return;
            }
            raws.push(body);
            capturedAt.push(new Date().toISOString());
          } catch {
            responseFailure = true;
          }
        })();
        pending.add(task);
        void task.finally(() => {
          pending.delete(task);
          updates.notify();
        });
      });
      const seed = new URL('https://www.google.com/maps/dir/');
      seed.search = new URLSearchParams({
        api: '1',
        origin: `${query.origin.latitude},${query.origin.longitude}`,
        destination: `${query.destination.latitude},${query.destination.longitude}`,
        travelmode: 'transit',
        hl: 'en',
      }).toString();
      stage = 'navigation';
      const navigation = await page.goto(seed.toString(), {
        waitUntil: 'domcontentloaded',
      });
      if (navigation?.status() === 403 || navigation?.status() === 429)
        throw new TransitError('UPSTREAM_BLOCKED');
      await checkBlocked(page);
      // Optional consent is an explicit anonymous preference, not an authentication/verification bypass.
      const consent = page.getByRole('button', {
        name: 'Reject all',
        exact: true,
      });
      if (await consent.isVisible()) await consent.click();
      await page.evaluate(() => {
        new MutationObserver(() => {
          void (
            window as unknown as { transitEvidenceChanged: () => Promise<void> }
          ).transitEvidenceChanged();
        }).observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
      stage = 'time-mode';
      await page
        .getByRole('button', { name: 'Leave now', exact: true })
        .waitFor();
      await checkBlocked(page);
      const main = page.getByRole('main', { name: 'Directions', exact: true });
      const modeLabel =
        query.timeMode === 'DEPART_AT' ? 'Depart at' : 'Arrive by';
      await main
        .getByRole('button', { name: 'Leave now', exact: true })
        .click();
      await page
        .getByRole('menuitemradio', { name: modeLabel, exact: true })
        .click();
      const dateButton = main.getByRole('button', {
        name: /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/,
      });
      stage = 'calendar';
      await dateButton.click();
      const date = new Date(`${query.date}T12:00:00Z`);
      const dayLabel = `${date.getUTCDate()} ${date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' })}`;
      const day = page.getByRole('gridcell', { name: dayLabel, exact: true });
      // Current visible calendar only. Unknown month-navigation controls fail explicitly rather than fabricate state.
      if ((await day.count()) !== 1)
        throw new TransitError('UNSUPPORTED_QUERY');
      await day.click();
      // Wait for Google's own date state, not elapsed time. Keep every bounded
      // response: submitting an unchanged time need not generate another one.
      await page.waitForFunction(
        ({ mode, date }) => {
          const path = location.pathname;
          const stamp = path.match(
            new RegExp(`!6e${mode}!7e2!8j(\\d+)!3e3`),
          )?.[1];
          return (
            stamp !== undefined &&
            new Date(Number(stamp) * 1000).toISOString().slice(0, 10) === date
          );
        },
        { mode: query.timeMode === 'DEPART_AT' ? 0 : 1, date: query.date },
      );
      await checkBlocked(page);
      const [hours, minutes] = query.time.split(':').map(Number);
      const timeLabel = `${hours! % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours! < 12 ? 'AM' : 'PM'}`;
      const input = main.getByRole('textbox');
      stage = 'time-input';
      await input.fill(timeLabel);
      await input.press('Enter');
      stage = 'response-verification';
      const dateLabel = date.toLocaleDateString('en-US', {
        timeZone: 'UTC',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      // Collect multiple page-generated responses; do not send or construct private API requests.
      return await waitForVerification(
        updates,
        async () => {
          throwAborted();
          await checkBlocked(page);
          if (restricted) throw new TransitError('UPSTREAM_BLOCKED');
          await Promise.all([...pending]);
          const pageEvidence: PageEvidence = {
            modeVisible: await main
              .getByRole('button', { name: modeLabel, exact: true })
              .isVisible(),
            dateVisible: (await dateButton.innerText()) === dateLabel,
            timeVisible:
              (await input.inputValue()).replace(/\s/gu, '') ===
              timeLabel.replace(/\s/gu, ''),
            pageStateMatches: pageStateMatches(page.url(), query),
            timezoneMatches:
              (await page.evaluate(
                () => Intl.DateTimeFormat().resolvedOptions().timeZone,
              )) === query.timezone,
            text: await main.innerText(),
            noRoutesVisible: false,
          };
          pageEvidence.noRoutesVisible =
            /could not calculate transit directions|no transit routes|no routes found|no transit directions/i.test(
              pageEvidence.text,
            );
          if (!raws.length) {
            if (responseFailure && !pending.size)
              throw new TransitError('UPSTREAM_ERROR');
            return undefined;
          }
          const { parsed, index } = selectResponse(raws, query, pageEvidence);
          return {
            status: 'OK' as const,
            provider: PROVIDER,
            queryVerified: true as const,
            requestedQuery: query,
            fetchedAt: capturedAt[index]!,
            candidateCount: parsed.candidates.length,
            candidates: parsed.candidates,
            cacheHit: false as const,
            evidence: {
              modeVisible: true as const,
              dateVisible: true as const,
              timeVisible: true as const,
              pageStateMatches: true as const,
              timezoneMatches: true as const,
              selectedResponseIndex: index,
              responseCount: raws.length,
            },
          };
        },
        signal,
        12000,
      );
    } catch (e) {
      throwAborted();
      if (restricted) throw new TransitError('UPSTREAM_BLOCKED', stage);
      // A challenge can appear while a UI locator is waiting. Preserve that classification on timeout.
      if (activePage) {
        try {
          if (
            blockedPage(
              activePage.url(),
              await activePage.locator('body').innerText({ timeout: 500 }),
            )
          ) {
            throw new TransitError('UPSTREAM_BLOCKED', stage);
          }
        } catch (inspection) {
          if (inspection instanceof TransitError) throw inspection;
        }
      }
      if (upstreamFailure) throw new TransitError('UPSTREAM_ERROR', stage);
      if (e instanceof TransitError)
        throw new TransitError(e.code, e.stage ?? stage);
      if (e instanceof Error && e.name === 'TimeoutError')
        throw new TransitError('UPSTREAM_TIMEOUT', stage);
      throw new TransitError('UPSTREAM_ERROR', stage);
    } finally {
      signal.removeEventListener('abort', abort);
      if (context) {
        await context.close().catch(() => {});
        this.contexts.delete(context);
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.contexts].map((c) => c.close().catch(() => {})));
    await this.launch?.then((b) => b.close()).catch(() => {});
    this.launch = undefined;
  }
}
