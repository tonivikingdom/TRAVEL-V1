import {
  AuthService,
  ExecutionLocationService,
  ExecutionRiskService,
  FlightMonitoringService,
  FlightService,
  NotificationService,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  RouteUndoService,
  TripService,
} from '@travel/application';
import {
  createPostgresReadiness,
  createPrismaClient,
  PrismaAuthRepository,
  PrismaExecutionLocationRepository,
  PrismaExecutionRiskRepository,
  PrismaFlightRepository,
  PrismaFlightMonitoringRepository,
  PrismaNotificationRepository,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import {
  createDevelopmentSyntheticRouteProvider,
  AeroDataBoxFlightProvider,
  GoogleConsumerExperimentalRouteProvider,
  readFlightProviderConfig,
  readRouteProviderConfig,
  UnconfiguredFlightProvider,
  UnconfiguredRouteProvider,
} from '@travel/providers';

import { buildApi } from './app.js';
import { readAuthRuntimeConfig } from './auth-config.js';
import { readRoutePlanningConfig } from './route-planning-config.js';

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.API_PORT ?? '3000', 10);
const databaseUrl = process.env.DATABASE_URL;
const managedProbe = createPostgresReadiness(databaseUrl);
let managedPrisma: ManagedPrismaClient | undefined;
let authService: AuthService | undefined;
let notificationService: NotificationService | undefined;
let executionLocationService: ExecutionLocationService | undefined;
let executionRiskService: ExecutionRiskService | undefined;
let flightService: FlightService | undefined;
let flightMonitoringService: FlightMonitoringService | undefined;
let routeQueryService: RouteQueryService | undefined;
let routePreviewService: RoutePreviewService | undefined;
let routeAdoptionService: RouteAdoptionService | undefined;
let routeUndoService: RouteUndoService | undefined;
let tripService: TripService | undefined;

if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
  const authConfig = readAuthRuntimeConfig(process.env);
  managedPrisma = createPrismaClient(databaseUrl);
  authService = new AuthService(
    new PrismaAuthRepository(managedPrisma.client),
    authConfig.service,
  );
  notificationService = new NotificationService(
    new PrismaNotificationRepository(managedPrisma.client),
  );
  const tripRepository = new PrismaTripRepository(managedPrisma.client);
  executionRiskService = new ExecutionRiskService(
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
  flightService = new FlightService(
    flightProvider,
    new PrismaFlightRepository(managedPrisma.client),
    executionRiskService,
  );
  flightMonitoringService = new FlightMonitoringService(
    flightService,
    new PrismaFlightMonitoringRepository(managedPrisma.client),
  );
  executionLocationService = new ExecutionLocationService(
    new PrismaExecutionLocationRepository(managedPrisma.client),
    executionRiskService,
    flightMonitoringService,
  );
  const planningRepository = new PrismaRoutePlanningRepository(
    managedPrisma.client,
  );
  const routePlanningConfig = readRoutePlanningConfig(process.env);
  const routeProviderConfig = readRouteProviderConfig(process.env);
  const routeProvider =
    routeProviderConfig.provider === 'synthetic'
      ? createDevelopmentSyntheticRouteProvider()
      : routeProviderConfig.provider === 'google_consumer_experimental'
        ? new GoogleConsumerExperimentalRouteProvider({
            baseUrl: routeProviderConfig.baseUrl,
            token: routeProviderConfig.token,
            timeoutMs: routeProviderConfig.timeoutMs,
          })
        : new UnconfiguredRouteProvider();
  routeQueryService = new RouteQueryService(
    tripRepository,
    routeProvider,
    planningRepository,
    {
      candidateSnapshotTtlSeconds:
        routePlanningConfig.candidateSnapshotTtlSeconds,
    },
  );
  routePreviewService = new RoutePreviewService(
    tripRepository,
    planningRepository,
    { previewTtlSeconds: routePlanningConfig.previewTtlSeconds },
  );
  tripService = new TripService(tripRepository);
  routeAdoptionService = new RouteAdoptionService(
    planningRepository,
    tripService,
    { undoWindowSeconds: routePlanningConfig.undoWindowSeconds },
  );
  routeUndoService = new RouteUndoService(planningRepository, tripService);
}

const app = buildApi({
  readinessProbe: managedProbe.probe,
  ...(authService === undefined ? {} : { authService }),
  ...(notificationService === undefined ? {} : { notificationService }),
  ...(executionLocationService === undefined
    ? {}
    : { executionLocationService }),
  ...(executionRiskService === undefined ? {} : { executionRiskService }),
  ...(flightService === undefined ? {} : { flightService }),
  ...(flightMonitoringService === undefined ? {} : { flightMonitoringService }),
  ...(routeQueryService === undefined ? {} : { routeQueryService }),
  ...(routePreviewService === undefined ? {} : { routePreviewService }),
  ...(routeAdoptionService === undefined ? {} : { routeAdoptionService }),
  ...(routeUndoService === undefined ? {} : { routeUndoService }),
  ...(tripService === undefined ? {} : { tripService }),
});
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info({ signal }, 'api shutdown requested');
  await app.close();
  await Promise.all([managedProbe.close(), managedPrisma?.close()]);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await Promise.all([managedProbe.close(), managedPrisma?.close()]);
  process.exitCode = 1;
}
