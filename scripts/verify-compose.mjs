import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(
  repoRoot,
  '..',
  'infra',
  'compose',
  'compose.yml',
);
const defaultTimeoutMs = 120_000;

function readOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseEnvFile(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) {
          throw new Error(`Invalid environment line: ${line}`);
        }
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function projectName() {
  const runId = process.env.GITHUB_RUN_ID ?? String(process.pid);
  return `travel-v1-ci-${runId}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-');
}

function composeCommand(envFile, project) {
  return async (...args) => {
    const { stdout, stderr } = await execFileAsync(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--env-file',
        envFile,
        '--file',
        composeFile,
        ...args,
      ],
      {
        cwd: repoRoot,
        timeout: args.includes('--build') ? 300_000 : defaultTimeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    if (stdout.trim() !== '') {
      process.stdout.write(stdout);
    }
    if (stderr.trim() !== '') {
      process.stderr.write(stderr);
    }
    return stdout;
  };
}

async function serviceContainerId(compose, service) {
  const output = await compose('ps', '--quiet', service);
  return output.trim().split(/\s+/u)[0] ?? '';
}

async function serviceHealth(compose, service) {
  const containerId = await serviceContainerId(compose, service);
  if (containerId === '') {
    return 'missing';
  }

  const { stdout } = await execFileAsync(
    'docker',
    ['inspect', '--format', '{{.State.Health.Status}}', containerId],
    { cwd: repoRoot, timeout: 15_000 },
  );
  return stdout.trim();
}

async function waitFor(description, check, timeoutMs = defaultTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

async function expectHttpStatus(port, pathname, status) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
    return response.status === status;
  } catch {
    return false;
  }
}

async function checkEnvironmentIsolation() {
  const dev = parseEnvFile(
    await readFile(path.join(repoRoot, '..', '.env.dev.example'), 'utf8'),
  );
  const staging = parseEnvFile(
    await readFile(path.join(repoRoot, '..', '.env.staging.example'), 'utf8'),
  );
  for (const key of [
    'COMPOSE_PROJECT_NAME',
    'API_PORT',
    'POSTGRES_HOST_PORT',
    'POSTGRES_DB',
  ]) {
    if (
      dev[key] === undefined ||
      staging[key] === undefined ||
      dev[key] === staging[key]
    ) {
      throw new Error(`Dev/Staging isolation failed for ${key}`);
    }
  }
  process.stdout.write(
    'Dev/Staging project, port, database, and volume prefixes are isolated.\n',
  );
}

async function verifyCompose(compose, env) {
  const apiPort = env.API_PORT;
  const databaseUser = env.POSTGRES_USER;
  const databaseName = env.POSTGRES_DB;
  if (
    apiPort === undefined ||
    databaseUser === undefined ||
    databaseName === undefined
  ) {
    throw new Error(
      'Compose test env is missing API_PORT, POSTGRES_USER, or POSTGRES_DB',
    );
  }

  await compose('up', '--build', '--detach');
  await waitFor('API liveness', () =>
    expectHttpStatus(apiPort, '/health/live', 200),
  );
  await waitFor('API readiness', () =>
    expectHttpStatus(apiPort, '/health/ready', 200),
  );
  await waitFor(
    'Worker health',
    async () => (await serviceHealth(compose, 'worker')) === 'healthy',
  );

  const marker = `SYNTHETIC_P0_${Date.now()}`;
  await compose(
    'exec',
    '--no-TTY',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    databaseUser,
    '-d',
    databaseName,
    '-c',
    'CREATE TABLE IF NOT EXISTS p0_compose_validation (marker text PRIMARY KEY);',
  );
  await compose(
    'exec',
    '--no-TTY',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    databaseUser,
    '-d',
    databaseName,
    '-c',
    `INSERT INTO p0_compose_validation(marker) VALUES ('${marker}') ON CONFLICT DO NOTHING;`,
  );

  await compose('stop', 'postgres');
  await waitFor('API liveness during database outage', () =>
    expectHttpStatus(apiPort, '/health/live', 200),
  );
  await waitFor(
    'API readiness failure during database outage',
    () => expectHttpStatus(apiPort, '/health/ready', 503),
    30_000,
  );
  await waitFor(
    'Worker NOT_READY during database outage',
    async () => (await serviceHealth(compose, 'worker')) === 'unhealthy',
    30_000,
  );

  await compose('start', 'postgres');
  await waitFor(
    'PostgreSQL recovery',
    async () => (await serviceHealth(compose, 'postgres')) === 'healthy',
  );
  await waitFor('API readiness recovery', () =>
    expectHttpStatus(apiPort, '/health/ready', 200),
  );
  await waitFor(
    'Worker recovery',
    async () => (await serviceHealth(compose, 'worker')) === 'healthy',
  );

  await compose('stop', 'postgres');
  await compose('rm', '--force', 'postgres');
  await compose('up', '--detach', 'postgres');
  await waitFor(
    'PostgreSQL restart with named volume',
    async () => (await serviceHealth(compose, 'postgres')) === 'healthy',
  );
  const markerOutput = await compose(
    'exec',
    '--no-TTY',
    'postgres',
    'psql',
    '-tA',
    '-U',
    databaseUser,
    '-d',
    databaseName,
    '-c',
    `SELECT marker FROM p0_compose_validation WHERE marker = '${marker}';`,
  );
  if (!markerOutput.split(/\r?\n/u).some((line) => line.trim() === marker)) {
    throw new Error(
      'Synthetic PostgreSQL marker was not preserved across container recreation',
    );
  }

  await compose('stop', '--timeout', '10', 'worker');
  const workerLogs = await compose(
    'logs',
    '--no-color',
    '--tail',
    '200',
    'worker',
  );
  if (
    !workerLogs.includes('"event":"stopping"') ||
    !workerLogs.includes('"signal":"SIGTERM"')
  ) {
    throw new Error(
      'Worker SIGTERM shutdown evidence was not found in the container logs',
    );
  }
  await compose('start', 'worker');
  await waitFor(
    'Worker SIGTERM restart',
    async () => (await serviceHealth(compose, 'worker')) === 'healthy',
  );

  process.stdout.write(
    'Compose verification passed: live/ready, outage/recovery, worker SIGTERM, and named-volume persistence.\n',
  );
}

const envFile = path.resolve(readOption('--env-file'));
const env = parseEnvFile(await readFile(envFile, 'utf8'));
const project = projectName();
const compose = composeCommand(envFile, project);

try {
  await checkEnvironmentIsolation();
  await verifyCompose(compose, env);
} catch (error) {
  process.stderr.write(
    `Compose verification failed: ${error instanceof Error ? error.message : 'UnknownError'}\n`,
  );
  try {
    await compose('ps');
    await compose('logs', '--no-color', '--tail', '300');
  } catch (diagnosticError) {
    process.stderr.write(
      `Compose diagnostics failed: ${diagnosticError instanceof Error ? diagnosticError.message : 'UnknownError'}\n`,
    );
  }
  process.exitCode = 1;
} finally {
  try {
    await compose('down', '--volumes', '--remove-orphans');
  } catch (cleanupError) {
    process.stderr.write(
      `Compose cleanup failed for ${project}: ${cleanupError instanceof Error ? cleanupError.message : 'UnknownError'}\n`,
    );
    process.exitCode = 1;
  }
}
