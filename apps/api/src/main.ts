import {
  AuthService,
  NotificationService,
  TripService,
} from '@travel/application';
import {
  createPostgresReadiness,
  createPrismaClient,
  PrismaAuthRepository,
  PrismaNotificationRepository,
  PrismaTripRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';

import { buildApi } from './app.js';
import { readAuthRuntimeConfig } from './auth-config.js';

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.API_PORT ?? '3000', 10);
const databaseUrl = process.env.DATABASE_URL;
const managedProbe = createPostgresReadiness(databaseUrl);
let managedPrisma: ManagedPrismaClient | undefined;
let authService: AuthService | undefined;
let notificationService: NotificationService | undefined;
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
  tripService = new TripService(new PrismaTripRepository(managedPrisma.client));
}

const app = buildApi({
  readinessProbe: managedProbe.probe,
  ...(authService === undefined ? {} : { authService }),
  ...(notificationService === undefined ? {} : { notificationService }),
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
