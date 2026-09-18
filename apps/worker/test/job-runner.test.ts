import type { ClaimedJob, JobRepository } from '@travel/application';
import { describe, expect, it } from 'vitest';

import { createJobRunner, retryDelayMs } from '../src/job-runner.js';

const JOB: ClaimedJob = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'MAGIC_LINK_EMAIL',
  payloadRef: '22222222-2222-4222-8222-222222222222',
  attempts: 1,
  maxAttempts: 3,
  leaseOwner: 'worker-test',
  leaseUntil: new Date('2030-01-01T00:01:00.000Z'),
};

describe('job retry policy', () => {
  it('uses deterministic exponential backoff with a hard cap', () => {
    expect(retryDelayMs(1, 1_000, 5_000)).toBe(1_000);
    expect(retryDelayMs(2, 1_000, 5_000)).toBe(2_000);
    expect(retryDelayMs(3, 1_000, 5_000)).toBe(4_000);
    expect(retryDelayMs(4, 1_000, 5_000)).toBe(5_000);
  });
});

describe('job runner lifecycle', () => {
  it('does not claim new jobs after shutdown', async () => {
    const fake = new FakeJobRepository([]);
    let scheduled: (() => void) | undefined;
    const runner = createJobRunner({
      repository: fake,
      handlers: { MAGIC_LINK_EMAIL: { execute: async () => undefined } },
      workerId: 'worker-test',
      config: config(),
      setTimeout(callback) {
        scheduled = callback;
        return {} as ReturnType<typeof setTimeout>;
      },
      clearTimeout() {},
    });

    await runner.start();
    expect(fake.claims).toBe(1);
    await runner.stop();
    scheduled?.();
    await Promise.resolve();
    expect(fake.claims).toBe(1);
  });

  it('marks successful work and never overlaps its own handler', async () => {
    const fake = new FakeJobRepository([JOB]);
    let active = 0;
    let maximumActive = 0;
    const runner = createJobRunner({
      repository: fake,
      handlers: {
        MAGIC_LINK_EMAIL: {
          async execute() {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await Promise.resolve();
            active -= 1;
          },
        },
      },
      workerId: 'worker-test',
      config: config(),
    });

    await runner.start();
    await runner.stop();
    expect(maximumActive).toBe(1);
    expect(fake.succeeded).toEqual([JOB.id]);
  });

  it('records a safe error code and retry time after handler failure', async () => {
    const fake = new FakeJobRepository([JOB]);
    const runner = createJobRunner({
      repository: fake,
      handlers: {
        MAGIC_LINK_EMAIL: {
          async execute() {
            throw new Error('provider response contains secret');
          },
        },
      },
      workerId: 'worker-test',
      config: config(),
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });

    await runner.start();
    await runner.stop();
    expect(fake.failed).toMatchObject({
      errorCode: 'JOB_EXECUTION_FAILED',
      retryAt: new Date('2030-01-01T00:00:01.000Z'),
    });
  });

  it('cooperatively cancels a claimed job before invoking its handler', async () => {
    const fake = new FakeJobRepository([JOB]);
    fake.cancelRequested = true;
    let executed = 0;
    const runner = createJobRunner({
      repository: fake,
      handlers: {
        MAGIC_LINK_EMAIL: {
          async execute() {
            executed += 1;
          },
        },
      },
      workerId: 'worker-test',
      config: config(),
    });
    await runner.start();
    await runner.stop();
    expect(executed).toBe(0);
    expect(fake.cancelled).toEqual([JOB.id]);
  });
});

function config() {
  return {
    leaseDurationMs: 30_000,
    pollingIntervalMs: 60_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 60_000,
    executionTimeoutMs: 10_000,
    shutdownTimeoutMs: 1_000,
  };
}

class FakeJobRepository implements JobRepository {
  readonly succeeded: string[] = [];
  readonly cancelled: string[] = [];
  claims = 0;
  cancelRequested = false;
  failed:
    | {
        readonly errorCode: string;
        readonly retryAt: Date;
      }
    | undefined;

  constructor(private readonly queue: ClaimedJob[]) {}

  async claimNext(): Promise<ClaimedJob | null> {
    this.claims += 1;
    return this.queue.shift() ?? null;
  }

  async markSucceeded(jobId: string): Promise<boolean> {
    this.succeeded.push(jobId);
    return true;
  }

  async markFailed(input: {
    readonly errorCode: string;
    readonly retryAt: Date;
  }): Promise<'RETRY_SCHEDULED'> {
    this.failed = input;
    return 'RETRY_SCHEDULED';
  }

  async cancel(): Promise<'CANCELLED'> {
    return 'CANCELLED';
  }

  async isCancellationRequested(): Promise<boolean> {
    return this.cancelRequested;
  }

  async markCancelled(jobId: string): Promise<boolean> {
    this.cancelled.push(jobId);
    return true;
  }
}
