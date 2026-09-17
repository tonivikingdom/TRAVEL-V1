import type { DependencyHealth } from '@travel/contracts';
import { Pool } from 'pg';

export interface ReadinessProbe {
  check(): Promise<DependencyHealth>;
}

export interface ManagedReadinessProbe {
  readonly probe: ReadinessProbe;
  close(): Promise<void>;
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
  constructor(private readonly pool: Pool) {}

  async check(): Promise<DependencyHealth> {
    try {
      const result = await this.pool.query<{ readonly ok: number }>(
        'SELECT 1 AS ok',
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

export function createPostgresReadiness(
  connectionString: string | undefined,
): ManagedReadinessProbe {
  if (connectionString === undefined || connectionString.trim() === '') {
    return {
      probe: new MisconfiguredPostgresProbe(),
      async close(): Promise<void> {},
    };
  }

  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 2_000,
    max: 2,
  });

  return {
    probe: new PostgresReadinessProbe(pool),
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
