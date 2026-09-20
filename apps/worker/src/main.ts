import { writeFile } from 'node:fs/promises';

import {
  ExecutionRiskService,
  FlightMonitoringService,
  FlightService,
  MagicLinkEmailHandler,
  UnconfiguredMailSender,
} from '@travel/application';
import {
  createPostgresReadiness,
  createPrismaClient,
  PrismaJobRepository,
  PrismaExecutionRiskRepository,
  PrismaFlightMonitoringRepository,
  PrismaFlightRepository,
  PrismaMagicLinkDeliveryRepository,
  PrismaTripRepository,
} from '@travel/persistence';
import {
  AeroDataBoxFlightProvider,
  readFlightProviderConfig,
  UnconfiguredFlightProvider,
} from '@travel/providers';

import { readWorkerConfig } from './config.js';
import { FileCapturedMailSender } from './file-captured-mail-sender.js';
import { createWorkerHeartbeat } from './heartbeat.js';
import { createJobRunner } from './job-runner.js';
import { createWorkerRuntime } from './runtime.js';

const config = readWorkerConfig(process.env);
const managedProbe = createPostgresReadiness(config.databaseUrl);
const managedPrisma = createPrismaClient(config.databaseUrl);
const jobRepository = new PrismaJobRepository(managedPrisma.client);
const tripRepository = new PrismaTripRepository(managedPrisma.client);
const executionRiskService = new ExecutionRiskService(
  tripRepository,
  new PrismaExecutionRiskRepository(managedPrisma.client),
);
const flightProviderConfig = readFlightProviderConfig(process.env);
const flightProvider =
  flightProviderConfig.provider === 'aerodatabox' &&
  flightProviderConfig.liveApiEnabled &&
  flightProviderConfig.apiKey !== null
    ? new AeroDataBoxFlightProvider(flightProviderConfig.apiKey, {
        host: flightProviderConfig.host,
      })
    : new UnconfiguredFlightProvider();
const flightMonitoringRepository = new PrismaFlightMonitoringRepository(
  managedPrisma.client,
);
const flightMonitoringService = new FlightMonitoringService(
  new FlightService(
    flightProvider,
    new PrismaFlightRepository(managedPrisma.client),
    executionRiskService,
  ),
  flightMonitoringRepository,
);
const mailSender =
  config.mailProvider === 'capture'
    ? new FileCapturedMailSender(config.mailCaptureFile)
    : new UnconfiguredMailSender();
const magicLinkHandler = new MagicLinkEmailHandler(
  new PrismaMagicLinkDeliveryRepository(managedPrisma.client),
  mailSender,
  {
    landingUrl: config.magicLinkLandingUrl,
    tokenKey: config.magicLinkTokenKey,
    tokenTtlSeconds: config.magicLinkTtlSeconds,
  },
);
const jobRunner = createJobRunner({
  repository: jobRepository,
  handlers: {
    MAGIC_LINK_EMAIL: {
      execute: (payloadRef, signal) =>
        magicLinkHandler.execute(payloadRef, signal),
    },
    FLIGHT_MONITOR: {
      execute: (payloadRef, signal) =>
        flightMonitoringService.executeJob(payloadRef, signal),
    },
  },
  workerId: config.workerId,
  config: config.runner,
  onError(event) {
    process.stderr.write(
      `${JSON.stringify({ service: 'worker', event: 'job_error', ...event })}\n`,
    );
  },
});

async function heartbeat(): Promise<void> {
  await flightMonitoringService.ensureEligibleMonitoring();
  const database = await managedProbe.probe.check();
  const payload = createWorkerHeartbeat(database, new Date());

  await writeFile(config.heartbeatFile, JSON.stringify(payload), {
    encoding: 'utf8',
    flag: 'w',
  });
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const runtime = createWorkerRuntime({
  heartbeat,
  startJobs: () => jobRunner.start(),
  stopJobs: () => jobRunner.stop(),
  close: async () => {
    await Promise.all([managedProbe.close(), managedPrisma.close()]);
  },
  intervalMs: config.heartbeatIntervalMs,
  shutdownTimeoutMs: config.runner.shutdownTimeoutMs,
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
