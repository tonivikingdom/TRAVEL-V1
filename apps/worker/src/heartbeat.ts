import type { DependencyHealth } from '@travel/contracts';

export interface WorkerHeartbeat {
  readonly service: 'worker';
  readonly status: 'READY' | 'NOT_READY';
  readonly observedAt: string;
  readonly dependencies: readonly DependencyHealth[];
}

export function createWorkerHeartbeat(
  database: DependencyHealth,
  observedAt: Date,
): WorkerHeartbeat {
  return {
    service: 'worker',
    status: database.status === 'READY' ? 'READY' : 'NOT_READY',
    observedAt: observedAt.toISOString(),
    dependencies: [database],
  };
}
