import { readFile } from 'node:fs/promises';

const heartbeatFile =
  process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/travel-worker-heartbeat.json';
const maximumAgeMs = Number.parseInt(
  process.env.WORKER_HEARTBEAT_MAX_AGE_MS ?? '30000',
  10,
);

try {
  const heartbeat = JSON.parse(await readFile(heartbeatFile, 'utf8'));
  const ageMs = Date.now() - Date.parse(heartbeat.observedAt);

  if (
    heartbeat.status !== 'READY' ||
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs > maximumAgeMs
  ) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}
