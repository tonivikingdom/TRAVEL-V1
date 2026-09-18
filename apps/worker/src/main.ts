import { writeFile } from 'node:fs/promises';

import { createPostgresReadiness } from '@travel/persistence';

import { createWorkerHeartbeat } from './heartbeat.js';
import { createWorkerRuntime } from './runtime.js';

const heartbeatFile =
  process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/travel-worker-heartbeat.json';
const intervalMs = Number.parseInt(
  process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? '10000',
  10,
);
const managedProbe = createPostgresReadiness(process.env.DATABASE_URL);

async function heartbeat(): Promise<void> {
  const database = await managedProbe.probe.check();
  const payload = createWorkerHeartbeat(database, new Date());

  await writeFile(heartbeatFile, JSON.stringify(payload), {
    encoding: 'utf8',
    flag: 'w',
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const runtime = createWorkerRuntime({
  heartbeat,
  close: () => managedProbe.close(),
  intervalMs,
  onStopping: (signal) => {
    process.stdout.write(
      `${JSON.stringify({ service: 'worker', event: 'stopping', signal })}\n`,
    );
  },
  onHeartbeatError: (error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        service: 'worker',
        event: 'heartbeat_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      })}\n`,
    );
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void runtime.stop(signal).catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          service: 'worker',
          event: 'shutdown_failed',
          error: error instanceof Error ? error.name : 'UnknownError',
        })}\n`,
      );
      process.exitCode = 1;
    });
  });
}

try {
  await runtime.start();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      service: 'worker',
      event: 'startup_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    })}\n`,
  );
  process.exitCode = 1;
}
