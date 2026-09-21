import type {
  ClaimedJob,
  JobRepository,
  JobStatus,
  JobType,
} from '@travel/application';

import { Prisma, type PrismaClient } from './generated/prisma/client.js';

interface ClaimedJobRow {
  readonly id: string;
  readonly type: JobType;
  readonly payloadRef: string;
  readonly capabilityRevision: number | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseUntil: Date;
}

export class PrismaJobRepository implements JobRepository {
  constructor(private readonly client: PrismaClient) {}

  async claimNext(input: {
    readonly workerId: string;
    readonly now: Date;
    readonly leaseDurationMs: number;
  }): Promise<ClaimedJob | null> {
    assertWorkerId(input.workerId);
    if (
      !Number.isSafeInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1_000 ||
      input.leaseDurationMs > 3_600_000
    ) {
      throw new Error('Job lease duration must be between 1 second and 1 hour');
    }
    const leaseUntil = new Date(input.now.getTime() + input.leaseDurationMs);
    const rows = await this.client.$queryRaw<ClaimedJobRow[]>(Prisma.sql`
      WITH candidate AS (
        SELECT "id"
        FROM "Job"
        WHERE (
          ("status" = 'QUEUED'::"JobStatus" AND "runAt" <= ${input.now})
          OR (
            "status" = 'RUNNING'::"JobStatus"
            AND "leaseUntil" <= ${input.now}
          )
        )
          AND "attempts" < "maxAttempts"
        ORDER BY "runAt" ASC, "createdAt" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "Job" AS job
      SET "status" = 'RUNNING'::"JobStatus",
          "leaseOwner" = ${input.workerId},
          "leaseUntil" = ${leaseUntil},
          "attempts" = job."attempts" + 1,
          "updatedAt" = ${input.now}
      FROM candidate
      WHERE job."id" = candidate."id"
      RETURNING job."id", job."type", job."payloadRef", job."capabilityRevision", job."attempts",
                job."maxAttempts", job."leaseOwner", job."leaseUntil"
    `);
    return rows[0] ?? null;
  }

  async markSucceeded(
    jobId: string,
    workerId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.client.job.updateMany({
      where: {
        id: jobId,
        status: 'RUNNING',
        leaseOwner: workerId,
        leaseUntil: { gt: now },
      },
      data: {
        status: 'SUCCEEDED',
        leaseOwner: null,
        leaseUntil: null,
        completedAt: now,
        lastErrorCode: null,
      },
    });
    return result.count === 1;
  }

  async markFailed(input: {
    readonly job: ClaimedJob;
    readonly workerId: string;
    readonly now: Date;
    readonly errorCode: string;
    readonly retryAt: Date;
  }): Promise<'RETRY_SCHEDULED' | 'FAILED' | 'LEASE_LOST'> {
    const terminal = input.job.attempts >= input.job.maxAttempts;
    const status: JobStatus = terminal ? 'FAILED' : 'QUEUED';
    const result = await this.client.job.updateMany({
      where: {
        id: input.job.id,
        status: 'RUNNING',
        leaseOwner: input.workerId,
        leaseUntil: { gt: input.now },
      },
      data: {
        status,
        leaseOwner: null,
        leaseUntil: null,
        runAt: terminal ? input.now : input.retryAt,
        completedAt: terminal ? input.now : null,
        lastErrorCode: sanitizeErrorCode(input.errorCode),
      },
    });
    if (result.count !== 1) {
      return 'LEASE_LOST';
    }
    return terminal ? 'FAILED' : 'RETRY_SCHEDULED';
  }

  async cancel(
    jobId: string,
    now: Date,
  ): Promise<'CANCELLED' | 'REQUESTED' | 'TERMINAL' | 'NOT_FOUND'> {
    const cancelled = await this.client.job.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: {
        status: 'CANCELLED',
        cancelRequested: true,
        cancelledAt: now,
        completedAt: now,
        leaseOwner: null,
        leaseUntil: null,
      },
    });
    if (cancelled.count === 1) {
      return 'CANCELLED';
    }

    const requested = await this.client.job.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { cancelRequested: true },
    });
    if (requested.count === 1) {
      return 'REQUESTED';
    }

    const job = await this.client.job.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    return job === null ? 'NOT_FOUND' : 'TERMINAL';
  }

  async isCancellationRequested(
    jobId: string,
    workerId: string,
  ): Promise<boolean> {
    const job = await this.client.job.findFirst({
      where: { id: jobId, status: 'RUNNING', leaseOwner: workerId },
      select: { cancelRequested: true },
    });
    return job?.cancelRequested ?? true;
  }

  async markCancelled(
    jobId: string,
    workerId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.client.job.updateMany({
      where: {
        id: jobId,
        status: 'RUNNING',
        leaseOwner: workerId,
        cancelRequested: true,
      },
      data: {
        status: 'CANCELLED',
        leaseOwner: null,
        leaseUntil: null,
        cancelledAt: now,
        completedAt: now,
      },
    });
    return result.count === 1;
  }
}

function assertWorkerId(workerId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(workerId)) {
    throw new Error('Worker id contains unsupported characters');
  }
}

function sanitizeErrorCode(value: string): string {
  const sanitized = value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
  return (sanitized || 'JOB_EXECUTION_FAILED').slice(0, 64);
}
