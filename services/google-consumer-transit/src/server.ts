import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { parseQuery, PROVIDER, TransitError, type Query } from './contract.js';
import type { Config } from './config.js';
import { BrowserClient, type TransitClient } from './browser.js';

export function buildServer(
  config: Config,
  client: TransitClient = new BrowserClient(config),
) {
  const app = Fastify({ logger: false, bodyLimit: 16_384 });
  let busy = false;
  const controllers = new Set<AbortController>();
  app.setErrorHandler((error, request, reply) => {
    const status =
      error && typeof error === 'object' && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const classified =
      error instanceof TransitError
        ? error
        : new TransitError(
            status === 400 || status === 413
              ? 'VALIDATION_ERROR'
              : 'UPSTREAM_ERROR',
          );
    return reply.code(classified.statusCode).send({
      status: 'ERROR',
      requestId: request.id,
      error: {
        code: classified.code,
        message: classified.code,
        stage: classified.stage,
      },
    });
  });
  app.get('/health', () => ({
    status: 'OK',
    provider: PROVIDER,
    enabled: config.enabled,
    busy,
    version: '0.1.0',
    implementation: 'REBUILT_COMPATIBLE_IMPLEMENTATION',
    supportedTimeModes: config.supportedModes,
  }));
  app.post('/v1/transit/search', async (request, reply) => {
    const actual = createHash('sha256')
      .update(request.headers.authorization ?? '')
      .digest();
    const expected = createHash('sha256')
      .update(`Bearer ${config.token}`)
      .digest();
    if (!timingSafeEqual(actual, expected))
      throw new TransitError('UNAUTHORIZED');
    if (!config.enabled) throw new TransitError('PROVIDER_DISABLED');
    const query: Query = parseQuery(request.body);
    if (!config.supportedModes.includes(query.timeMode))
      throw new TransitError('UNSUPPORTED_MODE');
    if (busy) throw new TransitError('BUSY');
    busy = true;
    const controller = new AbortController();
    controllers.add(controller);
    const cancelled = () => {
      if (!reply.raw.writableEnded)
        controller.abort(new TransitError('REQUEST_CANCELLED'));
    };
    const timeout = setTimeout(
      () => controller.abort(new TransitError('UPSTREAM_TIMEOUT')),
      config.timeoutMs,
    );
    request.raw.on('aborted', cancelled);
    reply.raw.on('close', cancelled);
    try {
      return await client.search(query, controller.signal);
    } finally {
      clearTimeout(timeout);
      request.raw.off('aborted', cancelled);
      reply.raw.off('close', cancelled);
      controllers.delete(controller);
      busy = false;
    }
  });
  app.addHook('preClose', async () => {
    for (const c of controllers) c.abort(new TransitError('REQUEST_CANCELLED'));
    await client.close();
  });
  return app;
}
