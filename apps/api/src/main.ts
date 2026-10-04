import {
  TripImpactService,
  PlaceSearchService,
  StaticBackupService,
  InTripReadService,
  AssistanceCapabilityService,
  AuthService,
  ExecutionLocationService,
  ExecutionRiskService,
  FlightMonitoringService,
  GroundTransitService,
  ExternalExecutionOriginService,
  GroundTransitRouteReevaluationService,
  FlightService,
  NotificationService,
  RouteAdoptionService,
  RoutePreviewService,
  RouteQueryService,
  RouteUndoService,
  TripService,
} from '@travel/application';
import {
  PrismaStaticBackupRepository,
  PrismaInTripReadRepository,
  createPostgresReadiness,
  createPrismaClient,
  PrismaAuthRepository,
  PrismaAssistanceCapabilityRepository,
  PrismaExecutionLocationRepository,
  PrismaExecutionRiskRepository,
  PrismaFlightRepository,
  PrismaFlightMonitoringRepository,
  PrismaGroundTransitRepository,
  PrismaExternalExecutionOriginRepository,
  PrismaGroundTransitRouteProgressRepository,
  PrismaNotificationRepository,
  PrismaRoutePlanningRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import {
  createPlaceSearchProvider,
  createRegionalProviders,
  mapProviderProjection,
  createDevelopmentSyntheticRouteProvider,
  createDevelopmentSyntheticGroundTransitRouteProvider,
  AeroDataBoxFlightProvider,
  GoogleConsumerExperimentalRouteProvider,
  readFlightProviderConfig,
  readRouteProviderConfig,
  UnconfiguredFlightProvider,
  SyntheticFlightProvider,
  createGroundTransitProvider,
  createGroundTransitHubResolver,
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
let assistanceCapabilityService: AssistanceCapabilityService | undefined;
let notificationService: NotificationService | undefined;
let executionLocationService: ExecutionLocationService | undefined;
let executionRiskService: ExecutionRiskService | undefined;
let flightService: FlightService | undefined;
let flightMonitoringService: FlightMonitoringService | undefined;
let externalExecutionOriginService: ExternalExecutionOriginService | undefined;
let groundTransitService: GroundTransitService | undefined;
let groundTransitRouteReevaluationService:
  GroundTransitRouteReevaluationService | undefined;
let routeQueryService: RouteQueryService | undefined;
let routePreviewService: RoutePreviewService | undefined;
let routeAdoptionService: RouteAdoptionService | undefined;
let routeUndoService: RouteUndoService | undefined;
let placeSearchService: PlaceSearchService | undefined;
let staticBackupService: StaticBackupService | undefined;
let tripImpactService: TripImpactService | undefined;
let inTripReadService: InTripReadService | undefined;
let tripService: TripService | undefined;

if (databaseUrl !== undefined && databaseUrl.trim() !== '') {
  const authConfig = readAuthRuntimeConfig(process.env);
  managedPrisma = createPrismaClient(databaseUrl);
  authService = new AuthService(
    new PrismaAuthRepository(managedPrisma.client),
    authConfig.service,
  );
  assistanceCapabilityService = new AssistanceCapabilityService(
    new PrismaAssistanceCapabilityRepository(managedPrisma.client),
  );
  notificationService = new NotificationService(
    new PrismaNotificationRepository(managedPrisma.client),
  );
  staticBackupService = new StaticBackupService(
    new PrismaStaticBackupRepository(managedPrisma.client),
  );
  inTripReadService = new InTripReadService(
    new PrismaInTripReadRepository(managedPrisma.client),
  );
  const tripRepository = new PrismaTripRepository(managedPrisma.client);
  placeSearchService = new PlaceSearchService(
    createPlaceSearchProvider(process.env),
    new TripService(tripRepository),
  );
  const groundTransitRepository = new PrismaGroundTransitRepository(
    managedPrisma.client,
  );
  executionRiskService = new ExecutionRiskService(
    tripRepository,
    new PrismaExecutionRiskRepository(managedPrisma.client),
    { groundTransitRepository },
  );
  const flightProviderConfig = readFlightProviderConfig(process.env);
  const flightProvider =
    flightProviderConfig.provider === 'synthetic' &&
    flightProviderConfig.syntheticScheduledUtc !== null &&
    flightProviderConfig.syntheticObservedAt !== null
      ? new SyntheticFlightProvider({
          scheduledUtc: flightProviderConfig.syntheticScheduledUtc,
          observedAt: flightProviderConfig.syntheticObservedAt,
          refreshMode: flightProviderConfig.syntheticRefreshMode,
          failFirstRefresh: flightProviderConfig.syntheticFailFirst,
        })
      : flightProviderConfig.provider === 'aerodatabox' &&
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
  groundTransitService = new GroundTransitService(
    groundTransitRepository,
    createGroundTransitProvider(process.env),
    () => new Date(),
    executionRiskService,
  );
  externalExecutionOriginService = new ExternalExecutionOriginService(
    new PrismaExternalExecutionOriginRepository(managedPrisma.client),
    createGroundTransitHubResolver(process.env),
  );
  groundTransitRouteReevaluationService =
    new GroundTransitRouteReevaluationService(
      tripRepository,
      groundTransitRepository,
      new PrismaGroundTransitRouteProgressRepository(managedPrisma.client),
      () => new Date(),
      externalExecutionOriginService,
    );
  tripImpactService = new TripImpactService(
    tripRepository,
    groundTransitRepository,
    groundTransitService,
    groundTransitRouteReevaluationService,
    inTripReadService,
  );
  executionLocationService = new ExecutionLocationService(
    new PrismaExecutionLocationRepository(managedPrisma.client),
    executionRiskService,
    flightMonitoringService,
    {},
    groundTransitService,
  );
  const planningRepository = new PrismaRoutePlanningRepository(
    managedPrisma.client,
  );
  const routePlanningConfig = readRoutePlanningConfig(process.env);
  const routeProviderConfig = readRouteProviderConfig({
    ...process.env,
    ROUTE_PROVIDER: process.env.ROUTE_PROVIDER ?? 'regional',
  });
  const routeProvider =
    routeProviderConfig.provider === 'regional'
      ? createRegionalProviders(process.env).routes
      : routeProviderConfig.provider === 'synthetic'
        ? process.env.SYNTHETIC_GROUND_TRANSIT_ROUTE === 'true'
          ? ['development', 'test'].includes(process.env.APP_ENV ?? '') &&
            process.env.SYNTHETIC_CI_ONLY === 'true'
            ? createDevelopmentSyntheticGroundTransitRouteProvider()
            : (() => {
                throw new Error(
                  'Synthetic ground transit route requires Dev/Test and SYNTHETIC_CI_ONLY=true',
                );
              })()
          : createDevelopmentSyntheticRouteProvider()
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
      externalOrigins: new PrismaExternalExecutionOriginRepository(
        managedPrisma.client,
      ),
      candidateSnapshotTtlSeconds:
        routePlanningConfig.candidateSnapshotTtlSeconds,
    },
  );
  routePreviewService = new RoutePreviewService(
    tripRepository,
    planningRepository,
    {
      previewTtlSeconds: routePlanningConfig.previewTtlSeconds,
      externalOrigins: new PrismaExternalExecutionOriginRepository(
        managedPrisma.client,
      ),
    },
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
  regionalMapProjection: mapProviderProjection,
  ...(placeSearchService ? { placeSearchService } : {}),
  readinessProbe: managedProbe.probe,
  ...(tripImpactService ? { tripImpactService } : {}),
  ...(staticBackupService ? { staticBackupService } : {}),
  ...(inTripReadService ? { inTripReadService } : {}),
  ...(authService === undefined ? {} : { authService }),
  ...(assistanceCapabilityService === undefined
    ? {}
    : { assistanceCapabilityService }),
  ...(notificationService === undefined ? {} : { notificationService }),
  ...(executionLocationService === undefined
    ? {}
    : { executionLocationService }),
  ...(executionRiskService === undefined ? {} : { executionRiskService }),
  ...(flightService === undefined ? {} : { flightService }),
  ...(flightMonitoringService === undefined ? {} : { flightMonitoringService }),
  ...(groundTransitService === undefined ? {} : { groundTransitService }),
  ...(externalExecutionOriginService === undefined
    ? {}
    : { externalExecutionOriginService }),
  ...(groundTransitRouteReevaluationService === undefined
    ? {}
    : { groundTransitRouteReevaluationService }),
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
