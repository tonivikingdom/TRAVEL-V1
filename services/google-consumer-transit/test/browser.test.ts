import { describe, it, expect, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { BrowserClient } from '../src/browser.js';
import { readConfig } from '../src/config.js';
import { TransitError } from '../src/contract.js';
import { query } from './fixtures.js';
const config = readConfig({
  APP_ENV: 'test',
  LOCAL_TRANSIT_API_TOKEN: 'SYNTHETIC_BROWSER_TEST_TOKEN_32_CHARS',
});
describe('SYNTHETIC browser lifecycle', () => {
  it('classifies a challenge appearing during a failed UI wait and closes the context', async () => {
    const page = {
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      goto: vi.fn(async () => {
        throw Object.assign(new Error('SYNTHETIC wait expired'), {
          name: 'TimeoutError',
        });
      }),
      url: () => 'https://www.google.com/sorry/',
      locator: () => ({ innerText: async () => 'SYNTHETIC unusual traffic' }),
    } as unknown as Page;
    const context = {
      newPage: async () => page,
      close: vi.fn(async () => {}),
    } as unknown as BrowserContext;
    const browser = {
      newContext: async () => context,
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const client = new BrowserClient(config, async () => browser);
    await expect(
      client.search(query, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'UPSTREAM_BLOCKED', stage: 'navigation' });
    expect(context.close).toHaveBeenCalled();
    await client.close();
  });
  it('creates fresh contexts, disposes after parser/navigation failure, and closes its own browser', async () => {
    const contexts: BrowserContext[] = [];
    const newContext = vi.fn(async (options) => {
      expect(options).toEqual({ locale: 'en-US', timezoneId: 'Asia/Tokyo' });
      const page = {
        setDefaultTimeout: vi.fn(),
        on: vi.fn(),
        goto: vi.fn(async () => {
          throw new TransitError('SCHEMA_CHANGED');
        }),
      } as unknown as Page;
      const context = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => {}),
      } as unknown as BrowserContext;
      contexts.push(context);
      return context;
    });
    const browser = {
      newContext,
      on: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const launch = vi.fn(async () => browser);
    const client = new BrowserClient(config, launch);
    for (let i = 0; i < 2; i++)
      await expect(
        client.search(query, new AbortController().signal),
      ).rejects.toThrow('SCHEMA_CHANGED');
    expect(launch).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
    contexts.forEach((c) => expect(c.close).toHaveBeenCalledTimes(1));
    await client.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    await expect(
      client.search(query, new AbortController().signal),
    ).rejects.toThrow('BROWSER_UNAVAILABLE');
  });
  it('cancellation closes the active context and preserves its reason', async () => {
    let rejectNavigation!: (reason: unknown) => void;
    let entered!: () => void;
    const navigationStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const navigation = new Promise<never>((_resolve, reject) => {
      rejectNavigation = reject;
    });
    const page = {
      setDefaultTimeout: vi.fn(),
      on: vi.fn(),
      goto: vi.fn(() => {
        entered();
        return navigation;
      }),
    } as unknown as Page;
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {
        rejectNavigation(new Error('SYNTHETIC Target closed'));
      }),
    } as unknown as BrowserContext;
    const browser = {
      newContext: vi.fn(async () => context),
      on: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const client = new BrowserClient(config, async () => browser);
    const controller = new AbortController();
    const operation = client.search(query, controller.signal);
    const expected = expect(operation).rejects.toThrow('REQUEST_CANCELLED');
    await navigationStarted;
    controller.abort(new TransitError('REQUEST_CANCELLED'));
    await expected;
    expect(context.close).toHaveBeenCalled();
    await client.close();
  });
  it('does not launch for already aborted operations and classifies browser startup failure', async () => {
    const launch = vi.fn(async () => {
      throw new Error('SYNTHETIC executable missing');
    });
    const client = new BrowserClient(config, launch);
    const abort = new AbortController();
    abort.abort(new TransitError('UPSTREAM_TIMEOUT'));
    await expect(client.search(query, abort.signal)).rejects.toThrow(
      'UPSTREAM_TIMEOUT',
    );
    expect(launch).not.toHaveBeenCalled();
    await expect(
      client.search(query, new AbortController().signal),
    ).rejects.toThrow('BROWSER_UNAVAILABLE');
    await client.close();
  });
});
