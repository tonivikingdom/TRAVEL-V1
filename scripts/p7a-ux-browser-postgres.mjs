/** SYNTHETIC real API + Worker + Web acceptance. Never resets an existing database. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

if (process.env.P7A_LOCAL_ENV_FILE) loadEnvFile(process.env.P7A_LOCAL_ENV_FILE);
const source = new URL(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);
assert(['127.0.0.1', 'localhost'].includes(source.hostname));
assert(['development', 'test', undefined].includes(process.env.APP_ENV));
const require = createRequire(
  new URL('../packages/persistence/package.json', import.meta.url),
);
const { Client } = require('pg');
const admin = new Client({ connectionString: source.href });
await admin.connect();
try {
  const found = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname='travel_p7a_ux_round1_test'",
  );
  if (!found.rowCount)
    await admin.query('CREATE DATABASE travel_p7a_ux_round1_test');
} finally {
  await admin.end();
}
source.pathname = '/travel_p7a_ux_round1_test';
const evidence = resolve(
  process.env.P7A_UX_EVIDENCE_DIR ??
    'docs/status/assets/p7a-ux-round1/real-api',
);
const runtime = resolve(
  process.env.P7A_UX_RUNTIME_DIR ?? 'test-results/p7a-ux-runtime',
);
await mkdir(evidence, { recursive: true });
await mkdir(runtime, { recursive: true });
const env = {
  ...process.env,
  APP_ENV: 'test',
  DATABASE_URL: source.href,
  TEST_DATABASE_URL: source.href,
  SYNTHETIC_CI_ONLY: 'true',
  API_HOST: '127.0.0.1',
  API_PORT: '43160',
  AUTH_MAGIC_LINK_LANDING_URL: 'http://127.0.0.1:5175/login/magic',
  MAGIC_LINK_TOKEN_KEY: 'SYNTHETIC_P7A_UX_MAGIC_KEY_0123456789abcdef',
  MAIL_PROVIDER: 'capture',
  MAIL_CAPTURE_FILE: resolve(runtime, 'mail.ndjson'),
  OBJECT_STORAGE_ROOT: resolve(runtime, 'objects'),
  WORKER_HEARTBEAT_FILE: resolve(runtime, 'heartbeat.json'),
  WORKER_ID: 'SYNTHETIC_P7A_UX',
  WORKER_HEARTBEAT_INTERVAL_MS: '1000',
  JOB_POLL_INTERVAL_MS: '100',
  JOB_LEASE_DURATION_MS: '10000',
  JOB_EXECUTION_TIMEOUT_MS: '3000',
  ROUTE_PROVIDER: 'synthetic',
  PLACE_SEARCH_PROVIDER: 'synthetic',
  FLIGHT_PROVIDER: 'synthetic',
  SYNTHETIC_FLIGHT_SCHEDULED_UTC: '2030-10-10T01:00:00Z',
  SYNTHETIC_FLIGHT_OBSERVED_AT: '2030-10-01T00:00:00Z',
  FLIGHT_LIVE_API_ENABLED: 'false',
  MAP_PROVIDER: 'none',
  GOOGLE_CONSUMER_TRANSIT_ENABLED: 'false',
  GOOGLE_LIVE_API_ENABLED: 'false',
  BAIDU_LIVE_API_ENABLED: 'false',
  ROUTE_UNDO_WINDOW_SECONDS: '600',
  WEB_API_ORIGIN: 'http://127.0.0.1:43160',
  ADMIN_BOOTSTRAP_ALLOWED: 'true',
  BOOTSTRAP_ADMIN_EMAIL: 'synthetic-p7a@synthetic.example.test',
  P7A_UX_EVIDENCE_DIR: evidence,
};
async function run(args) {
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  assert.equal(
    await new Promise((r) => child.on('exit', r)),
    0,
    'Task command failed',
  );
}
await run(['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
await run(['--import', 'tsx', 'scripts/bootstrap-admin.ts']);
const children = [];
function start(args, cwd = process.cwd()) {
  const log = createWriteStream(
    resolve(runtime, `service-${children.length}.log`),
  );
  const child = spawn(process.execPath, args, {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
}
async function wait(check) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await check()) return;
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Task service startup timeout');
}
try {
  start(['apps/api/dist/main.js']);
  start(['apps/worker/dist/main.js']);
  start(
    [
      resolve('apps/web/node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      '5175',
    ],
    resolve('apps/web'),
  );
  await wait(
    async () => (await fetch('http://127.0.0.1:43160/health/ready')).ok,
  );
  await wait(async () => (await fetch('http://127.0.0.1:5175')).ok);
  await wait(
    async () =>
      JSON.parse(await readFile(env.WORKER_HEARTBEAT_FILE, 'utf8')).status ===
      'READY',
  );
  await run(['scripts/p7a-ux-flow.mjs']);
} finally {
  // Stop only the three exact child processes started by this script; retain DB evidence.
  for (const child of children) child.kill();
}
