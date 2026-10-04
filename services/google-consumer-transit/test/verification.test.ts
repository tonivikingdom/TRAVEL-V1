import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VerificationUpdates,
  waitForVerification,
} from '../src/verification.js';
import { TransitError } from '../src/contract.js';

afterEach(() => vi.useRealTimers());
describe('SYNTHETIC response/DOM stabilization without fixed sleeps', () => {
  it('retains an already matching response when unchanged input emits no new response', async () => {
    const updates = new VerificationUpdates();
    updates.notify();
    await expect(
      waitForVerification(
        updates,
        async () => 'SYNTHETIC verified retained body',
        new AbortController().signal,
        100,
      ),
    ).resolves.toBe('SYNTHETIC verified retained body');
  });
  it('does not lose an update during asynchronous inspection', async () => {
    const updates = new VerificationUpdates();
    let calls = 0;
    await expect(
      waitForVerification(
        updates,
        async () => {
          if (++calls === 1) {
            updates.notify();
            return undefined;
          }
          return 'SYNTHETIC verified';
        },
        new AbortController().signal,
        100,
      ),
    ).resolves.toBe('SYNTHETIC verified');
    expect(calls).toBe(2);
  });
  it('waits for UI evidence after a stale response and does not accept mismatch', async () => {
    vi.useFakeTimers();
    const updates = new VerificationUpdates();
    let ready = false;
    const outcome = waitForVerification(
      updates,
      async () => {
        if (!ready) throw new TransitError('REQUEST_MISMATCH');
        return 'SYNTHETIC matching mode/date/clocks';
      },
      new AbortController().signal,
      100,
    );
    await vi.advanceTimersByTimeAsync(10);
    ready = true;
    updates.notify();
    await expect(outcome).resolves.toBe('SYNTHETIC matching mode/date/clocks');
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['REQUEST_MISMATCH', 'SCHEMA_CHANGED'] as const)(
    'never bypasses %s at the bounded deadline',
    async (code) => {
      vi.useFakeTimers();
      const outcome = waitForVerification(
        new VerificationUpdates(),
        async () => {
          throw new TransitError(code);
        },
        new AbortController().signal,
        100,
      );
      const check = expect(outcome).rejects.toMatchObject({ code });
      await vi.advanceTimersByTimeAsync(101);
      await check;
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('classifies no response as timeout, not NO_ROUTES', async () => {
    vi.useFakeTimers();
    const outcome = waitForVerification(
      new VerificationUpdates(),
      async () => undefined,
      new AbortController().signal,
      100,
    );
    const check = expect(outcome).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(101);
    await check;
  });
  it.each(['UPSTREAM_BLOCKED', 'NO_ROUTES', 'UPSTREAM_ERROR'] as const)(
    'stops immediately on %s',
    async (code) => {
      await expect(
        waitForVerification(
          new VerificationUpdates(),
          async () => {
            throw new TransitError(code);
          },
          new AbortController().signal,
          100,
        ),
      ).rejects.toMatchObject({ code });
    },
  );
  it('cancellation releases the waiting subscription/timer and preserves its reason', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const updates = new VerificationUpdates();
    const outcome = waitForVerification(
      updates,
      async () => undefined,
      controller.signal,
      100,
    );
    const check = expect(outcome).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new TransitError('REQUEST_CANCELLED'));
    await check;
    expect(vi.getTimerCount()).toBe(0);
    updates.notify();
  });
});
