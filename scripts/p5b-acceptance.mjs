import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { aggregateObservations, redactSecrets } from './p5b-support.ts';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const composeFile = path.join(repoRoot, 'infra', 'compose', 'compose.yml');
const timeoutMs = 180_000;
const userEmails = Array.from(
  { length: 5 },
  (_, index) =>
    `synthetic-p5b-user-${String(index + 1).padStart(2, '0')}@synthetic.example.test`,
);
const adminEmail = 'synthetic-p5b-admin@synthetic.example.test';
const observations = [];
let isolationFailures = 0;

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseEnv(contents) {
  return Object.fromEntries(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator <= 0) throw new Error('Invalid acceptance environment');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function projectName() {
  const run = process.env.GITHUB_RUN_ID ?? String(process.pid);
  return `travel-v1-p5b-${run}`.toLowerCase().replace(/[^a-z0-9-]/gu, '-');
}

function composeFor(envFile, project) {
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
        timeout: args.includes('--build') ? 600_000 : timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (stderr.trim() !== '' && !args.includes('logs')) {
      process.stderr.write(redactSecrets(stderr));
    }
    return stdout;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(scenario, check, deadlineMs = timeoutMs) {
  const deadline = Date.now() + deadlineMs;
  let actual = 'condition remained false';
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result === true) return;
      actual = typeof result === 'string' ? result : actual;
    } catch (error) {
      actual =
        error instanceof Error ? redactSecrets(error.message) : 'unknown error';
    }
    await sleep(1_000);
  }
  throw new Error(
    JSON.stringify({
      scenario,
      expected: 'condition satisfied before deadline',
      actual,
    }),
  );
}

async function fetchWithDeadline(url, init = {}, requestTimeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function apiRequest(baseUrl, pathname, options = {}) {
  const started = performance.now();
  try {
    const response = await fetchWithDeadline(`${baseUrl}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.credential === undefined
          ? {}
          : { authorization: `Bearer ${options.credential}` }),
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    const payload = text === '' ? null : JSON.parse(text);
    if (options.observe === true) {
      observations.push({
        ok: response.ok,
        status: response.status,
        latencyMs: performance.now() - started,
        networkFailure: false,
      });
    }
    return { response, payload };
  } catch (error) {
    if (options.observe === true) {
      observations.push({
        ok: false,
        status: null,
        latencyMs: performance.now() - started,
        networkFailure: true,
      });
    }
    throw error;
  }
}

async function requireApi(baseUrl, pathname, options = {}) {
  const { response, payload } = await apiRequest(baseUrl, pathname, options);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? 'GET'} ${pathname} expected success, got ${response.status}/${payload?.error?.code ?? 'UNKNOWN'}`,
    );
  }
  return payload;
}

async function expectPrivateNotFound(baseUrl, pathname, options = {}) {
  const { response, payload } = await apiRequest(baseUrl, pathname, options);
  if (response.status !== 404 || payload?.error?.code !== 'NOT_FOUND') {
    isolationFailures += 1;
    throw new Error(
      `${options.method ?? 'GET'} ${pathname} leaked a private resource as ${response.status}/${payload?.error?.code ?? 'UNKNOWN'}`,
    );
  }
}

async function capturedToken(compose, email) {
  let token;
  await waitFor(`captured Magic Link for ${email}`, async () => {
    let output;
    try {
      output = await compose(
        'exec',
        '--no-TTY',
        'worker',
        'cat',
        '/tmp/travel-mail-capture/messages.ndjson',
      );
    } catch {
      return false;
    }
    const messages = output
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const message = [...messages]
      .reverse()
      .find((item) => item.recipient === email);
    if (message === undefined) return false;
    const url = new URL(message.magicLink);
    token = url.hash.match(/^#token=([A-Za-z0-9_-]{40,100})$/u)?.[1];
    return token !== undefined && !url.searchParams.has('token');
  });
  return token;
}

async function login(baseUrl, compose, email) {
  const requested = await apiRequest(baseUrl, '/auth/magic-link/request', {
    method: 'POST',
    body: { email },
  });
  if (requested.response.status !== 202) {
    throw new Error(`Magic Link request failed for ${email}`);
  }
  const token = await capturedToken(compose, email);
  const session = await requireApi(baseUrl, '/auth/magic-link/consume', {
    method: 'POST',
    body: { token },
  });
  const me = await requireApi(baseUrl, '/me', {
    credential: session.credential,
  });
  if (me.email !== email)
    throw new Error(`Session identity mismatch for ${email}`);
  return { credential: session.credential, user: me };
}

async function sql(compose, env, statement) {
  return (
    await compose(
      'exec',
      '--no-TTY',
      'postgres',
      'psql',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      env.POSTGRES_USER,
      '-d',
      env.POSTGRES_DB,
      '-c',
      statement,
    )
  ).trim();
}

async function initializeTrip(baseUrl, session, index) {
  const day = `2035-02-${String(index + 1).padStart(2, '0')}`;
  let trip = await requireApi(baseUrl, '/trips', {
    method: 'POST',
    credential: session.credential,
    body: {
      name: `SYNTHETIC P5B Trip ${index + 1}`,
      planningAnchorDate: day,
      defaultPeopleCount: 1,
    },
  });
  trip = await requireApi(baseUrl, `/trips/${trip.id}/commands`, {
    method: 'POST',
    credential: session.credential,
    body: {
      baseTripVersion: trip.version,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay: { type: 'NEW', localDate: day, sequence: 0 },
        position: 0,
        place: {
          type: 'CUSTOM',
          name: `SYNTHETIC P5B Origin ${index + 1}`,
          latitude: 35.67 + index / 100,
          longitude: 139.65 + index / 100,
        },
      },
    },
  });
  trip = await requireApi(baseUrl, `/trips/${trip.id}/commands`, {
    method: 'POST',
    credential: session.credential,
    body: {
      baseTripVersion: trip.version,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay: {
          type: 'EXISTING',
          dayOccurrenceId: trip.days[0].dayOccurrenceId,
        },
        position: 1,
        place: {
          type: 'CUSTOM',
          name: `SYNTHETIC P5B Destination ${index + 1}`,
          latitude: 35.68 + index / 100,
          longitude: 139.68 + index / 100,
        },
      },
    },
  });
  const [fromNode, toNode] = trip.days[0].nodes;
  trip = await requireApi(baseUrl, `/trips/${trip.id}/commands`, {
    method: 'POST',
    credential: session.credential,
    body: {
      baseTripVersion: trip.version,
      command: {
        type: 'SET_TIME_INTENT',
        nodeId: toNode.id,
        pointKind: 'ARRIVAL',
        operator: 'NOT_AFTER',
        instant: `${day}T23:00:00Z`,
        timeZone: 'UTC',
        locked: false,
      },
    },
  });
  await requireApi(baseUrl, `/trips/${trip.id}/schedule/evaluate`, {
    method: 'POST',
    credential: session.credential,
    body: { basisVersion: trip.version },
  });
  const route = await requireApi(baseUrl, `/trips/${trip.id}/routes/query`, {
    method: 'POST',
    credential: session.credential,
    body: {
      basisVersion: trip.version,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      hint: { type: 'DEPART_AT', instant: `${day}T10:00:00Z`, timeZone: 'UTC' },
    },
  });
  const preview = await requireApi(baseUrl, `/trips/${trip.id}/previews`, {
    method: 'POST',
    credential: session.credential,
    body: {
      basisVersion: trip.version,
      candidateSnapshotId: route.candidates[0].candidateSnapshotId,
    },
  });
  return { trip, fromNode, toNode, preview, route };
}

async function verifyIsolation(baseUrl, admin, users, scenarios) {
  const attacker = users[0];
  const victimScenario = scenarios[1];
  await expectPrivateNotFound(baseUrl, `/trips/${victimScenario.trip.id}`, {
    credential: attacker.credential,
  });
  await expectPrivateNotFound(
    baseUrl,
    `/trips/${victimScenario.trip.id}/commands`,
    {
      method: 'POST',
      credential: attacker.credential,
      body: {
        baseTripVersion: victimScenario.trip.version,
        command: { type: 'DELETE_NODE', nodeId: victimScenario.fromNode.id },
      },
    },
  );
  await expectPrivateNotFound(
    baseUrl,
    `/trips/${victimScenario.trip.id}/temporal-values`,
    {
      method: 'POST',
      credential: attacker.credential,
      body: {
        baseTripVersion: victimScenario.trip.version,
        subject: { type: 'NODE', nodeId: victimScenario.fromNode.id },
        value: {
          layer: 'PLANNED',
          pointKind: 'ARRIVAL',
          instant: '2035-02-02T09:00:00Z',
          timeZone: 'UTC',
          sourceKind: 'USER_VALUE',
        },
      },
    },
  );
  await expectPrivateNotFound(
    baseUrl,
    `/trips/${victimScenario.trip.id}/transport-history`,
    { credential: attacker.credential },
  );
  await expectPrivateNotFound(
    baseUrl,
    `/trips/${victimScenario.trip.id}/routes/query`,
    {
      method: 'POST',
      credential: attacker.credential,
      body: {
        basisVersion: victimScenario.trip.version,
        fromNodeId: victimScenario.fromNode.id,
        toNodeId: victimScenario.toNode.id,
      },
    },
  );
  await expectPrivateNotFound(
    baseUrl,
    `/trips/${victimScenario.trip.id}/previews/${victimScenario.preview.previewId}`,
    { credential: attacker.credential },
  );
  await expectPrivateNotFound(
    baseUrl,
    `/trips/${victimScenario.trip.id}/operations/${victimScenario.adoption.operationReceipt.id}/undo`,
    {
      method: 'POST',
      credential: attacker.credential,
      body: {
        baseTripVersion: victimScenario.adoption.trip.version,
        idempotencyKey: 'synthetic-p5b-cross-owner-undo',
      },
    },
  );
  await expectPrivateNotFound(baseUrl, `/trips/${victimScenario.trip.id}`, {
    credential: admin.credential,
  });
}

async function verifyVersionConflict(baseUrl, user, scenario) {
  const latest = await requireApi(baseUrl, `/trips/${scenario.trip.id}`, {
    credential: user.credential,
  });
  const mutation = (name) =>
    apiRequest(baseUrl, `/trips/${latest.id}`, {
      method: 'PATCH',
      credential: user.credential,
      body: { baseTripVersion: latest.version, name },
    });
  const results = await Promise.all([
    mutation('SYNTHETIC P5B concurrent A'),
    mutation('SYNTHETIC P5B concurrent B'),
  ]);
  const success = results.filter((item) => item.response.ok);
  const conflict = results.filter(
    (item) =>
      item.response.status === 409 &&
      item.payload?.error?.code === 'VERSION_CONFLICT',
  );
  if (success.length !== 1 || conflict.length !== 1) {
    throw new Error('VERSION_CONFLICT E2E did not produce exactly one winner');
  }
  const finalTrip = await requireApi(baseUrl, `/trips/${latest.id}`, {
    credential: user.credential,
  });
  if (finalTrip.version !== latest.version + 1) {
    throw new Error('Concurrent mutation changed Trip version more than once');
  }
}

async function verifyBasicLoad(baseUrl, users, scenarios) {
  await Promise.all(
    users.flatMap((user, index) =>
      Array.from({ length: 10 }, async () => {
        await Promise.all([
          apiRequest(baseUrl, '/me', {
            credential: user.credential,
            observe: true,
          }),
          apiRequest(baseUrl, `/trips/${scenarios[index].trip.id}`, {
            credential: user.credential,
            observe: true,
          }),
          apiRequest(
            baseUrl,
            `/trips/${scenarios[index].trip.id}/schedule/evaluate`,
            {
              method: 'POST',
              credential: user.credential,
              body: { basisVersion: scenarios[index].trip.version },
              observe: true,
            },
          ),
          apiRequest(baseUrl, '/notifications?limit=20', {
            credential: user.credential,
            observe: true,
          }),
        ]);
      }),
    ),
  );
  const aggregate = aggregateObservations(observations);
  if (aggregate.unexpected5xx !== 0 || aggregate.networkFailures !== 0) {
    throw new Error(
      'Basic concurrency observation contained 5xx or network failures',
    );
  }
  if (aggregate.success !== aggregate.requests) {
    throw new Error(
      'Basic concurrency observation contained unexpected non-success responses',
    );
  }
  return aggregate;
}

async function runAcceptance(compose, unavailableCompose, env, baseUrl) {
  await compose('up', '--build', '--detach');
  await waitFor('API ready', async () => {
    const result = await apiRequest(baseUrl, '/health/ready');
    return result.response.status === 200;
  });
  await compose(
    'exec',
    '--no-TTY',
    '-e',
    'ADMIN_BOOTSTRAP_ALLOWED=true',
    '-e',
    `BOOTSTRAP_ADMIN_EMAIL=${adminEmail}`,
    'api',
    'pnpm',
    'bootstrap:admin',
  );
  const admin = await login(baseUrl, compose, adminEmail);
  for (const email of userEmails) {
    await requireApi(baseUrl, '/admin/invitations', {
      method: 'POST',
      credential: admin.credential,
      body: { email },
    });
  }

  const users = [];
  for (const email of userEmails.slice(0, 4))
    users.push(await login(baseUrl, compose, email));
  await compose('stop', '--timeout', '10', 'worker');
  const recoveryEmail = userEmails[4];
  const recoveryRequest = await apiRequest(
    baseUrl,
    '/auth/magic-link/request',
    {
      method: 'POST',
      body: { email: recoveryEmail },
    },
  );
  if (recoveryRequest.response.status !== 202)
    throw new Error('Recovery Magic Link was not queued');
  if ((await apiRequest(baseUrl, '/health/live')).response.status !== 200) {
    throw new Error('API stopped while Worker was unavailable');
  }
  await compose('start', 'worker');
  const recoveryToken = await capturedToken(compose, recoveryEmail);
  const recoverySession = await requireApi(
    baseUrl,
    '/auth/magic-link/consume',
    {
      method: 'POST',
      body: { token: recoveryToken },
    },
  );
  users.push({
    credential: recoverySession.credential,
    user: await requireApi(baseUrl, '/me', {
      credential: recoverySession.credential,
    }),
  });

  const scenarios = [];
  for (let index = 0; index < users.length; index += 1) {
    scenarios.push(await initializeTrip(baseUrl, users[index], index));
  }

  for (const index of [0, 1]) {
    const scenario = scenarios[index];
    const key = `synthetic-p5b-adopt-${index}`;
    const adoption = await requireApi(
      baseUrl,
      `/trips/${scenario.trip.id}/previews/${scenario.preview.previewId}/adopt`,
      {
        method: 'POST',
        credential: users[index].credential,
        body: {
          baseTripVersion: scenario.preview.basisVersion,
          idempotencyKey: key,
        },
      },
    );
    const replay = await requireApi(
      baseUrl,
      `/trips/${scenario.trip.id}/previews/${scenario.preview.previewId}/adopt`,
      {
        method: 'POST',
        credential: users[index].credential,
        body: {
          baseTripVersion: scenario.preview.basisVersion,
          idempotencyKey: key,
        },
      },
    );
    if (
      adoption.operationReceipt.id !== replay.operationReceipt.id ||
      adoption.trip.version !== replay.trip.version
    ) {
      throw new Error('Adopt replay was not idempotent');
    }
    scenario.adoption = adoption;
    scenario.trip = adoption.trip;
  }
  const undoScenario = scenarios[0];
  const undoKey = 'synthetic-p5b-undo-0';
  const undo = await requireApi(
    baseUrl,
    `/trips/${undoScenario.trip.id}/operations/${undoScenario.adoption.operationReceipt.id}/undo`,
    {
      method: 'POST',
      credential: users[0].credential,
      body: {
        baseTripVersion: undoScenario.trip.version,
        idempotencyKey: undoKey,
      },
    },
  );
  const undoReplay = await requireApi(
    baseUrl,
    `/trips/${undoScenario.trip.id}/operations/${undoScenario.adoption.operationReceipt.id}/undo`,
    {
      method: 'POST',
      credential: users[0].credential,
      body: {
        baseTripVersion: undoScenario.trip.version,
        idempotencyKey: undoKey,
      },
    },
  );
  if (
    undo.operationReceipt.id !== undoReplay.operationReceipt.id ||
    undo.trip.version !== undoReplay.trip.version
  ) {
    throw new Error('Undo replay was not idempotent');
  }
  undoScenario.trip = undo.trip;

  const routeEvidence = await sql(
    compose,
    env,
    `SELECT (SELECT count(*) FROM "OperationReceipt" WHERE "tripId" = '${undoScenario.trip.id}' AND "operationType" = 'ROUTE_ADOPT') || ':' || (SELECT count(*) FROM "OperationReceipt" WHERE "tripId" = '${undoScenario.trip.id}' AND "operationType" = 'ROUTE_UNDO') || ':' || (SELECT count(*) FROM "OutboxEvent" WHERE "tripId" = '${undoScenario.trip.id}' AND "type" = 'ROUTE_ADOPTED') || ':' || (SELECT count(*) FROM "OutboxEvent" WHERE "tripId" = '${undoScenario.trip.id}' AND "type" = 'ROUTE_UNDONE');`,
  );
  if (routeEvidence !== '1:1:1:1')
    throw new Error('Adopt/Undo replay duplicated durable evidence');

  await verifyIsolation(baseUrl, admin, users, scenarios);
  await verifyVersionConflict(baseUrl, users[2], scenarios[2]);
  scenarios[2].trip = await requireApi(
    baseUrl,
    `/trips/${scenarios[2].trip.id}`,
    {
      credential: users[2].credential,
    },
  );

  await unavailableCompose.command(
    'up',
    '--detach',
    '--no-deps',
    '--force-recreate',
    'api',
  );
  await waitFor(
    'unconfigured-provider API ready',
    async () =>
      (await apiRequest(baseUrl, '/health/ready')).response.status === 200,
  );
  const unaffectedTrip = scenarios[3];
  await requireApi(baseUrl, `/trips/${unaffectedTrip.trip.id}`, {
    credential: users[3].credential,
  });
  unaffectedTrip.trip = await requireApi(
    baseUrl,
    `/trips/${unaffectedTrip.trip.id}/commands`,
    {
      method: 'POST',
      credential: users[3].credential,
      body: {
        baseTripVersion: unaffectedTrip.trip.version,
        command: {
          type: 'ADD_FREE_ACTION',
          targetDay: {
            type: 'EXISTING',
            dayOccurrenceId: unaffectedTrip.trip.days[0].dayOccurrenceId,
          },
          position: 2,
          note: 'SYNTHETIC provider outage check',
        },
      },
    },
  );
  const unavailable = await apiRequest(
    baseUrl,
    `/trips/${unaffectedTrip.trip.id}/routes/query`,
    {
      method: 'POST',
      credential: users[3].credential,
      body: {
        basisVersion: unaffectedTrip.trip.version,
        fromNodeId: unaffectedTrip.fromNode.id,
        toNodeId: unaffectedTrip.toNode.id,
      },
    },
  );
  if (
    unavailable.response.status !== 503 ||
    !['PROVIDER_UNAVAILABLE', 'ROUTE_PROVIDER_UNCONFIGURED'].includes(
      unavailable.payload?.error?.code,
    )
  ) {
    throw new Error(
      'Provider outage was not classified as a local Route Query failure',
    );
  }
  await compose('up', '--detach', '--no-deps', '--force-recreate', 'api');
  await waitFor(
    'synthetic-provider API recovery',
    async () =>
      (await apiRequest(baseUrl, '/health/ready')).response.status === 200,
  );

  await compose('stop', 'postgres');
  await waitFor(
    'API live during PostgreSQL outage',
    async () =>
      (await apiRequest(baseUrl, '/health/live')).response.status === 200,
    30_000,
  );
  await waitFor(
    'API not ready during PostgreSQL outage',
    async () =>
      (await apiRequest(baseUrl, '/health/ready')).response.status === 503,
    30_000,
  );
  await compose('start', 'postgres');
  await waitFor(
    'API ready after PostgreSQL recovery',
    async () =>
      (await apiRequest(baseUrl, '/health/ready')).response.status === 200,
  );
  await requireApi(baseUrl, `/trips/${scenarios[0].trip.id}`, {
    credential: users[0].credential,
  });

  for (let index = 0; index < scenarios.length; index += 1) {
    scenarios[index].trip = await requireApi(
      baseUrl,
      `/trips/${scenarios[index].trip.id}`,
      {
        credential: users[index].credential,
      },
    );
  }
  const aggregate = await verifyBasicLoad(baseUrl, users, scenarios);
  return {
    status: 'PASS',
    users: users.length,
    ...aggregate,
    isolationFailures,
  };
}

const envFile = path.resolve(option('--env-file'));
const env = parseEnv(await readFile(envFile, 'utf8'));
for (const required of ['API_PORT', 'POSTGRES_DB', 'POSTGRES_USER']) {
  if (env[required] === undefined) throw new Error(`Missing ${required}`);
}
if (
  env.APP_ENV !== 'test' ||
  env.MAIL_PROVIDER !== 'capture' ||
  env.ROUTE_PROVIDER !== 'synthetic'
) {
  throw new Error(
    'P5B acceptance requires APP_ENV=test and explicit synthetic providers',
  );
}
const project = projectName();
const compose = composeFor(envFile, project);
const temp = await mkdtemp(path.join(tmpdir(), 'travel-p5b-'));
const unavailableEnvFile = path.join(temp, 'unavailable.env');
await writeFile(
  unavailableEnvFile,
  (await readFile(envFile, 'utf8')).replace(
    /^ROUTE_PROVIDER=.*$/mu,
    'ROUTE_PROVIDER=unconfigured',
  ),
  'utf8',
);
const unavailableCommand = composeFor(unavailableEnvFile, project);
const baseUrl = `http://127.0.0.1:${env.API_PORT}`;

try {
  const summary = await runAcceptance(
    compose,
    { command: unavailableCommand, envFile: unavailableEnvFile },
    env,
    baseUrl,
  );
  process.stdout.write(
    `P5B acceptance PASS: ${summary.users} users, ${summary.requests} observed requests, 0 isolation failures, 0 unexpected 5xx, 0 network failures.\n`,
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  const message =
    error instanceof Error
      ? redactSecrets(error.message)
      : 'Unknown acceptance failure';
  process.stderr.write(`P5B acceptance FAIL: ${message}\n`);
  process.stderr.write(
    `${JSON.stringify({ status: 'FAIL', scenario: 'p5b-acceptance', error: message })}\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    await compose('down', '--volumes', '--remove-orphans');
  } catch (error) {
    process.stderr.write(
      `P5B cleanup warning: ${redactSecrets(error instanceof Error ? error.message : 'unknown')}\n`,
    );
    process.exitCode = 1;
  }
  await rm(temp, { recursive: true, force: true });
}
