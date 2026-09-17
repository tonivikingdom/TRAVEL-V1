import { createPostgresReadiness } from '@travel/persistence';

import { buildApi } from './app.js';

const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.API_PORT ?? '3000', 10);
const managedProbe = createPostgresReadiness(process.env.DATABASE_URL);
const app = buildApi({
  readinessProbe: managedProbe.probe,
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, 'api shutdown requested');
  await app.close();
  await managedProbe.close();
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
  await managedProbe.close();
  process.exitCode = 1;
}
