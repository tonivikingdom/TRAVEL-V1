import type { ClaimedJob, JobRepository, JobType } from '@travel/application';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface JobHandler {
  execute(payloadRef: string, signal: AbortSignal): Promise<void>;
}

export interface JobRunnerConfig {
  readonly leaseDurationMs: number;
  readonly pollingIntervalMs: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly executionTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface JobRunnerDependencies {
  readonly repository: JobRepository;
  readonly handlers: Readonly<Record<JobType, JobHandler>>;
  readonly workerId: string;
  readonly config: JobRunnerConfig;
  readonly now?: () => Date;
  readonly setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  readonly clearTimeout?: (timer: TimerHandle) => void;
  readonly onError?: (event: {
    readonly jobId?: string;
    readonly code: string;
  }) => void;
}

export interface JobRunner {
  readonly running: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  runOnce(): Promise<boolean>;
}

export function createJobRunner(
  dependencies: JobRunnerDependencies,
): JobRunner {
  const now = dependencies.now ?? (() => new Date());
  const schedule = dependencies.setTimeout ?? setTimeout;
  const cancelTimer = dependencies.clearTimeout ?? clearTimeout;
  let accepting = false;
  let timer: TimerHandle | undefined;
  let active: Promise<void> | undefined;
  let activeAbort: AbortController | undefined;
  let stopPromise: Promise<void> | undefined;

  function report(code: string, jobId?: string): void {
    try {
      dependencies.onError?.({
        code,
        ...(jobId === undefined ? {} : { jobId }),
      });
    } catch {
      // Observability must not break queue processing.
    }
  }

  async function runOnce(): Promise<boolean> {
    if (!accepting || active !== undefined) {
      return false;
    }
    const job = await dependencies.repository.claimNext({
      workerId: dependencies.workerId,
      now: now(),
      leaseDurationMs: dependencies.config.leaseDurationMs,
    });
    if (job === null) {
      return false;
    }
    const operation = executeClaimed(job);
    active = operation;
    try {
      await operation;
    } finally {
      active = undefined;
      activeAbort = undefined;
    }
    return true;
  }

  async function executeClaimed(job: ClaimedJob): Promise<void> {
    try {
      if (
        await dependencies.repository.isCancellationRequested(
          job.id,
          dependencies.workerId,
        )
      ) {
        await dependencies.repository.markCancelled(
          job.id,
          dependencies.workerId,
          now(),
        );
        return;
      }

      const controller = new AbortController();
      activeAbort = controller;
      const timeout = schedule(
        () => controller.abort(new Error('JOB_EXECUTION_TIMEOUT')),
        dependencies.config.executionTimeoutMs,
      );
      try {
        await Promise.race([
          dependencies.handlers[job.type].execute(
            job.payloadRef,
            controller.signal,
          ),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener(
              'abort',
              () => reject(controller.signal.reason),
              { once: true },
            );
          }),
        ]);
      } finally {
        cancelTimer(timeout);
      }

      if (
        await dependencies.repository.isCancellationRequested(
          job.id,
          dependencies.workerId,
        )
      ) {
        await dependencies.repository.markCancelled(
          job.id,
          dependencies.workerId,
          now(),
        );
        return;
      }
      const marked = await dependencies.repository.markSucceeded(
        job.id,
        dependencies.workerId,
        now(),
      );
      if (!marked) {
        report('JOB_LEASE_LOST', job.id);
      }
    } catch (error) {
      const code = safeErrorCode(error);
      const failedAt = now();
      const retryAt = new Date(
        failedAt.getTime() +
          retryDelayMs(
            job.attempts,
            dependencies.config.retryBaseDelayMs,
            dependencies.config.retryMaxDelayMs,
          ),
      );
      const outcome = await dependencies.repository.markFailed({
        job,
        workerId: dependencies.workerId,
        now: failedAt,
        errorCode: code,
        retryAt,
      });
      report(outcome === 'LEASE_LOST' ? 'JOB_LEASE_LOST' : code, job.id);
    }
  }

  function scheduleNext(): void {
    if (!accepting) {
      return;
    }
    timer = schedule(() => {
      timer = undefined;
      void poll();
    }, dependencies.config.pollingIntervalMs);
  }

  async function poll(): Promise<void> {
    if (!accepting) {
      return;
    }
    try {
      const didWork = await runOnce();
      if (accepting && didWork) {
        await poll();
        return;
      }
    } catch (error) {
      report(safeErrorCode(error));
    }
    scheduleNext();
  }

  async function start(): Promise<void> {
    if (accepting) {
      return;
    }
    accepting = true;
    stopPromise = undefined;
    await poll();
  }

  async function stop(): Promise<void> {
    if (stopPromise !== undefined) {
      await stopPromise;
      return;
    }
    stopPromise = (async () => {
      accepting = false;
      if (timer !== undefined) {
        cancelTimer(timer);
        timer = undefined;
      }
      activeAbort?.abort(new Error('JOB_RUNNER_STOPPING'));
      if (active !== undefined) {
        let timeout: TimerHandle | undefined;
        await Promise.race([
          active.then(
            () => undefined,
            () => undefined,
          ),
          new Promise<void>((resolve) => {
            timeout = schedule(resolve, dependencies.config.shutdownTimeoutMs);
          }),
        ]);
        if (timeout !== undefined) {
          cancelTimer(timeout);
        }
      }
    })();
    await stopPromise;
  }

  return {
    get running() {
      return accepting;
    },
    start,
    stop,
    runOnce,
  };
}

export function retryDelayMs(
  attempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === 'JOB_EXECUTION_TIMEOUT') {
    return 'JOB_EXECUTION_TIMEOUT';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'JOB_EXECUTION_ABORTED';
  }
  return 'JOB_EXECUTION_FAILED';
}
