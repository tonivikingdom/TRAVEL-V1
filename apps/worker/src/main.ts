import { writeFile } from 'node:fs/promises';

import { createPostgresReadiness } from '@travel/persistence';

import { createWorkerHeartbeat } from './heartbeat.js';

const heartbeatFile =
  process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/travel-worker-heartbeat.json';
const intervalMs = Number.parseInt(
  process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? '10000',
  10,
);
const managedProbe = createPostgresReadiness(process.env.DATABASE_URL);
let stopping = false;
let timer: NodeJS.Timeout | undefined;

async function heartbeat(): Promise<void> {
  const database = await managedProbe.probe.check();
  const payload = createWorkerHeartbeat(database, new Date());

  await writeFile(heartbeatFile, JSON.stringify(payload), {
    encoding: 'utf8',
    flag: 'w',
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }

  stopping = true;
  if (timer !== undefined) {
    clearInterval(timer);
  }
  process.stdout.write(
    `${JSON.stringify({ service: 'worker', event: 'stopping', signal })}\n`,
  );
  await managedProbe.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stop(signal);
  });
}

try {
  await heartbeat();
  timer = setInterval(() => {
    void heartbeat().catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          service: 'worker',
          event: 'heartbeat_failed',
          error: error instanceof Error ? error.name : 'UnknownError',
        })}\n`,
      );
    });
  }, intervalMs);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      service: 'worker',
      event: 'startup_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    })}\n`,
  );
  await managedProbe.close();
  process.exitCode = 1;
}
