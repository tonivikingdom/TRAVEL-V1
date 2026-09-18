import { describe, expect, it } from 'vitest';

import { createWorkerRuntime } from '../src/runtime.js';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: resolvePromise,
  };
}

function timerHarness() {
  const timer = {} as ReturnType<typeof setInterval>;
  let callback: (() => void) | undefined;
  let scheduled = 0;
  let cancelled = 0;

  return {
    timer,
    get callback() {
      return callback;
    },
    get scheduled() {
      return scheduled;
    },
    get cancelled() {
      return cancelled;
    },
    setInterval(next: () => void) {
      callback = next;
      scheduled += 1;
      return timer;
    },
    clearInterval(value: ReturnType<typeof setInterval>) {
      expect(value).toBe(timer);
      cancelled += 1;
    },
  };
}

describe('worker runtime lifecycle', () => {
  it('does not register a timer when stopped during the first probe', async () => {
    const firstProbe = deferred();
    const harness = timerHarness();
    let closes = 0;
    const runtime = createWorkerRuntime({
      heartbeat: () => firstProbe.promise,
      close: async () => {
        closes += 1;
      },
      intervalMs: 10,
      setInterval: harness.setInterval,
      clearInterval: harness.clearInterval,
    });

    const startPromise = runtime.start();
    await Promise.resolve();
    const stopPromise = runtime.stop('SIGTERM');
    firstProbe.resolve();

    await Promise.all([startPromise, stopPromise]);

    expect(runtime.state).toBe('STOPPED');
    expect(harness.scheduled).toBe(0);
    expect(harness.cancelled).toBe(0);
    expect(closes).toBe(1);
  });

  it('waits for an in-flight periodic probe before closing', async () => {
    const periodicProbe = deferred();
    const harness = timerHarness();
    let calls = 0;
    let closes = 0;
    const runtime = createWorkerRuntime({
      heartbeat: async () => {
        calls += 1;
        if (calls === 1) {
          return;
        }
        await periodicProbe.promise;
      },
      close: async () => {
        closes += 1;
      },
      intervalMs: 10,
      setInterval: harness.setInterval,
      clearInterval: harness.clearInterval,
    });

    await runtime.start();
    harness.callback?.();
    await Promise.resolve();
    const stopPromise = runtime.stop('SIGTERM');

    expect(closes).toBe(0);
    periodicProbe.resolve();
    await stopPromise;

    expect(runtime.state).toBe('STOPPED');
    expect(harness.cancelled).toBe(1);
    expect(closes).toBe(1);
  });

  it('bounds shutdown when an in-flight probe never settles', async () => {
    const periodicProbe = deferred();
    const harness = timerHarness();
    let calls = 0;
    let closes = 0;
    const runtime = createWorkerRuntime({
      heartbeat: async () => {
        calls += 1;
        if (calls > 1) {
          await periodicProbe.promise;
        }
      },
      close: async () => {
        closes += 1;
      },
      intervalMs: 10,
      shutdownTimeoutMs: 10,
      setInterval: harness.setInterval,
      clearInterval: harness.clearInterval,
    });

    await runtime.start();
    harness.callback?.();
    await Promise.resolve();
    await runtime.stop('SIGTERM');

    expect(runtime.state).toBe('STOPPED');
    expect(closes).toBe(1);
  });

  it('makes repeated stop calls idempotent and never starts a new heartbeat', async () => {
    const harness = timerHarness();
    let calls = 0;
    let closes = 0;
    const signals: string[] = [];
    const runtime = createWorkerRuntime({
      heartbeat: async () => {
        calls += 1;
      },
      close: async () => {
        closes += 1;
      },
      intervalMs: 10,
      onStopping: (signal) => signals.push(signal),
      setInterval: harness.setInterval,
      clearInterval: harness.clearInterval,
    });

    await runtime.start();
    await runtime.stop('SIGTERM');
    await runtime.stop('SIGINT');
    harness.callback?.();

    expect(calls).toBe(1);
    expect(closes).toBe(1);
    expect(signals).toEqual(['SIGTERM']);
  });
});
