export type WorkerRuntimeState =
  'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'FAILED';

type TimerHandle = ReturnType<typeof setInterval>;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface WorkerRuntimeDependencies {
  readonly heartbeat: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly intervalMs: number;
  readonly shutdownTimeoutMs?: number;
  readonly onStopping?: (signal: string) => void;
  readonly onHeartbeatError?: (error: unknown) => void;
  readonly setInterval?: (callback: () => void, delay: number) => TimerHandle;
  readonly clearInterval?: (timer: TimerHandle) => void;
}

export interface WorkerRuntime {
  readonly state: WorkerRuntimeState;
  start(): Promise<void>;
  stop(signal: string): Promise<void>;
}

export function createWorkerRuntime(
  dependencies: WorkerRuntimeDependencies,
): WorkerRuntime {
  const schedule = dependencies.setInterval ?? setInterval;
  const cancel = dependencies.clearInterval ?? clearInterval;
  const inFlight = new Set<Promise<void>>();
  let currentState: WorkerRuntimeState = 'IDLE';
  let timer: TimerHandle | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const shutdownTimeoutMs =
    dependencies.shutdownTimeoutMs !== undefined &&
    Number.isFinite(dependencies.shutdownTimeoutMs) &&
    dependencies.shutdownTimeoutMs > 0
      ? Math.floor(dependencies.shutdownTimeoutMs)
      : DEFAULT_SHUTDOWN_TIMEOUT_MS;

  function readState(): WorkerRuntimeState {
    return currentState;
  }

  function runHeartbeat(): Promise<void> {
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(dependencies.heartbeat());
    } catch (error) {
      operation = Promise.reject(error);
    }
    inFlight.add(operation);
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation),
    );
    return operation;
  }

  async function waitForInFlight(): Promise<void> {
    const pending = Promise.allSettled([...inFlight]).then(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, shutdownTimeoutMs);
    });

    await Promise.race([pending, bounded]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }

  function reportHeartbeatError(error: unknown): void {
    try {
      dependencies.onHeartbeatError?.(error);
    } catch {
      // Observability must not create a new unhandled rejection in the worker.
    }
  }

  function scheduleHeartbeat(): void {
    if (currentState !== 'RUNNING') {
      return;
    }

    void runHeartbeat().catch(reportHeartbeatError);
  }

  async function start(): Promise<void> {
    if (startPromise !== undefined) {
      await startPromise;
      return;
    }

    if (currentState !== 'IDLE') {
      return;
    }

    currentState = 'STARTING';
    startPromise = (async () => {
      try {
        await runHeartbeat();

        // A signal may have moved the runtime to STOPPING while the first
        // probe was in flight. Never register a timer after that transition.
        if (currentState !== 'STARTING') {
          return;
        }

        timer = schedule(scheduleHeartbeat, dependencies.intervalMs);
        currentState = 'RUNNING';
      } catch (error) {
        // TypeScript narrows the state after the awaited first probe; read it
        // through the public state union so a concurrent stop remains visible.
        const stateAtError = readState();
        if (stateAtError === 'STOPPING' || stateAtError === 'STOPPED') {
          return;
        }

        currentState = 'FAILED';
        await stop('startup_failed');
        throw error;
      }
    })();

    await startPromise;
  }

  async function stop(signal: string): Promise<void> {
    if (stopPromise !== undefined) {
      await stopPromise;
      return;
    }

    stopPromise = (async () => {
      if (currentState === 'STOPPED') {
        return;
      }

      currentState = 'STOPPING';
      try {
        dependencies.onStopping?.(signal);
      } catch {
        // A status log must not prevent resource cleanup.
      }

      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }

      await waitForInFlight();
      try {
        await dependencies.close();
      } finally {
        currentState = 'STOPPED';
      }
    })();

    await stopPromise;
  }

  return {
    get state(): WorkerRuntimeState {
      return currentState;
    },
    start,
    stop,
  };
}
