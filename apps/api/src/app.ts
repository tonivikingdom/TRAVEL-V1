import type { LivenessResponse, ReadinessResponse } from '@travel/contracts';
import type { ReadinessProbe } from '@travel/persistence';
import Fastify, { type FastifyInstance } from 'fastify';

export interface ApiDependencies {
  readonly readinessProbe: ReadinessProbe;
}

export function buildApi(dependencies: ApiDependencies): FastifyInstance {
  const app = Fastify({
    logger: false,
  });

  app.get('/health/live', async (): Promise<LivenessResponse> => ({
    service: 'api',
    status: 'UP',
  }));

  app.get('/health/ready', async (_request, reply) => {
    const database = await dependencies.readinessProbe.check();
    const ready = database.status === 'READY';
    const response: ReadinessResponse = {
      service: 'api',
      status: ready ? 'READY' : 'NOT_READY',
      dependencies: [database],
    };

    return reply.code(ready ? 200 : 503).send(response);
  });

  return app;
}
