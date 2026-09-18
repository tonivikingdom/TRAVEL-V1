import type { DependencyHealth } from '@travel/contracts';
import { Pool, type PoolConfig } from 'pg';

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface ReadinessProbe {
  check(): Promise<DependencyHealth>;
}

export interface ManagedReadinessProbe {
  readonly probe: ReadinessProbe;
  close(): Promise<void>;
}

export interface PostgresBackgroundError {
  readonly name: string;
}

export interface PostgresReadinessOptions {
  /** Optional label used by isolated tests to identify their own connections. */
  readonly applicationName?: string;
  /** Receives only a sanitized error name; the original error is never exposed. */
  readonly onBackgroundError?: (error: PostgresBackgroundError) => void;
  readonly connectionTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
}

class MisconfiguredPostgresProbe implements ReadinessProbe {
  async check(): Promise<DependencyHealth> {
    return {
      name: 'postgresql',
      status: 'MISCONFIGURED',
    };
  }
}

class PostgresReadinessProbe implements ReadinessProbe {
  constructor(
    private readonly pool: Pool,
    private readonly queryTimeoutMs: number,
  ) {}

  async check(): Promise<DependencyHealth> {
    try {
      const result = await withTimeout(
        this.pool.query<{ readonly ok: number }>('SELECT 1 AS ok'),
        this.queryTimeoutMs,
      );

      return {
        name: 'postgresql',
        status: result.rows[0]?.ok === 1 ? 'READY' : 'UNAVAILABLE',
      };
    } catch {
      return {
        name: 'postgresql',
        status: 'UNAVAILABLE',
      };
    }
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function sanitizeBackgroundError(error: unknown): PostgresBackgroundError {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
  };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('PostgreSQL readiness operation timed out');
      error.name = 'PostgresReadinessTimeoutError';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

export function createPostgresReadiness(
  connectionString: string | undefined,
  options: PostgresReadinessOptions = {},
): ManagedReadinessProbe {
  if (connectionString === undefined || connectionString.trim() === '') {
    return {
      probe: new MisconfiguredPostgresProbe(),
      async close(): Promise<void> {},
    };
  }

  const connectionTimeoutMs = positiveTimeout(
    options.connectionTimeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const queryTimeoutMs = positiveTimeout(
    options.queryTimeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const poolConfig: PoolConfig = {
    connectionString,
    connectionTimeoutMillis: connectionTimeoutMs,
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    max: 2,
  };

  if (options.applicationName !== undefined) {
    poolConfig.application_name = options.applicationName;
  }

  const pool = new Pool(poolConfig);
  pool.on('error', (error: unknown) => {
    const sanitized = sanitizeBackgroundError(error);
    try {
      options.onBackgroundError?.(sanitized);
      if (options.onBackgroundError === undefined) {
        process.stderr.write(
          `${JSON.stringify({
            service: 'persistence',
            event: 'postgres_pool_error',
            error: sanitized.name,
          })}\n`,
        );
      }
    } catch {
      // A logging/observation hook must never turn a pool event into an uncaught error.
    }
  });

  let closePromise: Promise<void> | undefined;

  return {
    probe: new PostgresReadinessProbe(pool, queryTimeoutMs),
    async close(): Promise<void> {
      closePromise ??= pool.end();
      await closePromise;
    },
  };
}
