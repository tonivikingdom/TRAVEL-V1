import {
  createPrismaClient,
  PrismaJobRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P1B1 integration tests');
}

const NOW = new Date('2030-01-01T00:00:00.000Z');

describe('PostgreSQL persistent Job queue', () => {
  let managed: ManagedPrismaClient;
  let repository: PrismaJobRepository;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
    repository = new PrismaJobRepository(managed.client);
  });

  beforeEach(async () => {
    await managed.client.job.deleteMany();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('claims a due job and atomically establishes its lease', async () => {
    const created = await createJob();
    const claimed = await claim('worker-a');
    expect(claimed).toMatchObject({
      id: created.id,
      attempts: 1,
      leaseOwner: 'worker-a',
    });
    expect(
      (
        await managed.client.job.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).status,
    ).toBe('RUNNING');
  });

  it('does not claim a future job', async () => {
    await createJob({ runAt: new Date(NOW.getTime() + 60_000) });
    expect(await claim('worker-a')).toBeNull();
  });

  it('allows only one of concurrent workers to claim the same job', async () => {
    await createJob();
    const results = await Promise.all([claim('worker-a'), claim('worker-b')]);
    expect(results.filter((value) => value !== null)).toHaveLength(1);
  });

  it('does not claim a job while another lease is valid', async () => {
    await createJob();
    expect(await claim('worker-a')).not.toBeNull();
    expect(
      await claim('worker-b', new Date(NOW.getTime() + 10_000)),
    ).toBeNull();
  });

  it('recovers a RUNNING job after its lease expires', async () => {
    await createJob();
    await claim('worker-a');
    const recovered = await claim('worker-b', new Date(NOW.getTime() + 31_000));
    expect(recovered).toMatchObject({ attempts: 2, leaseOwner: 'worker-b' });
  });

  it('never claims a succeeded job again', async () => {
    await createJob();
    const claimed = await claim('worker-a');
    expect(claimed).not.toBeNull();
    expect(await repository.markSucceeded(claimed!.id, 'worker-a', NOW)).toBe(
      true,
    );
    expect(
      await claim('worker-b', new Date(NOW.getTime() + 60_000)),
    ).toBeNull();
  });

  it('reschedules a failed attempt at the supplied deterministic retry time', async () => {
    await createJob({ maxAttempts: 3 });
    const claimed = await claim('worker-a');
    const retryAt = new Date(NOW.getTime() + 2_000);
    expect(
      await repository.markFailed({
        job: claimed!,
        workerId: 'worker-a',
        now: NOW,
        errorCode: 'SYNTHETIC_PROVIDER_FAILURE',
        retryAt,
      }),
    ).toBe('RETRY_SCHEDULED');
    const stored = await managed.client.job.findUniqueOrThrow({
      where: { id: claimed!.id },
    });
    expect(stored).toMatchObject({
      status: 'QUEUED',
      runAt: retryAt,
      lastErrorCode: 'SYNTHETIC_PROVIDER_FAILURE',
    });
    expect(await claim('worker-b', new Date(retryAt.getTime() - 1))).toBeNull();
    expect(await claim('worker-b', retryAt)).not.toBeNull();
  });

  it('moves the last failed attempt to FAILED', async () => {
    await createJob({ maxAttempts: 1 });
    const claimed = await claim('worker-a');
    expect(
      await repository.markFailed({
        job: claimed!,
        workerId: 'worker-a',
        now: NOW,
        errorCode: 'contains unsafe detail: password=secret',
        retryAt: new Date(NOW.getTime() + 1_000),
      }),
    ).toBe('FAILED');
    const stored = await managed.client.job.findUniqueOrThrow({
      where: { id: claimed!.id },
    });
    expect(stored.status).toBe('FAILED');
    expect(stored.lastErrorCode).toMatch(/^[A-Z0-9_]{1,64}$/u);
  });

  it('cancels a queued job and never claims it', async () => {
    const created = await createJob();
    expect(await repository.cancel(created.id, NOW)).toBe('CANCELLED');
    expect(await claim('worker-a')).toBeNull();
  });

  it('uses cooperative cancellation for a running job', async () => {
    await createJob();
    const claimed = await claim('worker-a');
    expect(await repository.cancel(claimed!.id, NOW)).toBe('REQUESTED');
    expect(
      await repository.isCancellationRequested(claimed!.id, 'worker-a'),
    ).toBe(true);
    expect(await repository.markCancelled(claimed!.id, 'worker-a', NOW)).toBe(
      true,
    );
  });

  it('keeps jobs durable across repository and client recreation', async () => {
    const created = await createJob();
    const second = createPrismaClient(databaseUrl);
    try {
      const recovered = await new PrismaJobRepository(second.client).claimNext({
        workerId: 'worker-after-restart',
        now: NOW,
        leaseDurationMs: 30_000,
      });
      expect(recovered?.id).toBe(created.id);
    } finally {
      await second.close();
    }
  });

  it('stores only a typed payload reference, never an arbitrary token payload', async () => {
    const created = await createJob();
    const columns = await managed.client.$queryRaw<
      Array<{ column_name: string }>
    >`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Job'
      ORDER BY column_name
    `;
    expect(columns.map((row) => row.column_name)).toContain('payloadRef');
    expect(columns.map((row) => row.column_name)).not.toContain('payload');
    expect(created.payloadRef).toMatch(/^[0-9a-f-]{36}$/u);
  });

  async function createJob(
    overrides: { runAt?: Date; maxAttempts?: number } = {},
  ) {
    return managed.client.job.create({
      data: {
        type: 'MAGIC_LINK_EMAIL',
        runAt: overrides.runAt ?? NOW,
        maxAttempts: overrides.maxAttempts ?? 3,
        uniqueKey: `synthetic-job-${crypto.randomUUID()}`,
        payloadRef: crypto.randomUUID(),
      },
    });
  }

  function claim(workerId: string, now = NOW) {
    return repository.claimNext({ workerId, now, leaseDurationMs: 30_000 });
  }
});
