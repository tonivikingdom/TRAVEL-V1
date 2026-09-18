import {
  ApplicationError,
  AuthService,
  isApplicationError,
} from '@travel/application';
import type {
  ApiErrorResponse,
  LivenessResponse,
  ReadinessResponse,
} from '@travel/contracts';
import type { ReadinessProbe } from '@travel/persistence';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import {
  OpaqueBearerCredentialTransport,
  type CredentialTransport,
} from './credential-transport.js';

export interface ApiDependencies {
  readonly readinessProbe: ReadinessProbe;
  readonly authService?: AuthService;
  readonly credentialTransport?: CredentialTransport;
}

export function buildApi(dependencies: ApiDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const credentialTransport =
    dependencies.credentialTransport ?? new OpaqueBearerCredentialTransport();

  app.setErrorHandler((error, request, reply) => {
    const applicationError = normalizeError(error);
    const response: ApiErrorResponse = {
      error: {
        code: applicationError.code,
        message: applicationError.message,
        requestId: request.id,
        retryable: applicationError.retryable,
      },
    };
    return reply.code(applicationError.httpStatus).send(response);
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

  app.post('/auth/magic-link/request', async (request, reply) => {
    const response = await requireAuthService(dependencies).requestMagicLink(
      requiredBodyString(request.body, 'email'),
    );
    return reply.code(202).send(response);
  });

  app.post('/auth/magic-link/consume', async (request, reply) => {
    const token = requiredBodyString(request.body, 'token');
    const response =
      await requireAuthService(dependencies).consumeMagicLink(token);
    return reply.code(200).send(response);
  });

  app.post('/auth/logout', async (request, reply) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    await requireAuthService(dependencies).logout(authenticated.sessionDigest);
    return reply.code(204).send();
  });

  app.get('/me', async (request) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    return authenticated.user;
  });

  app.post('/admin/invitations', async (request, reply) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    const invitation = await requireAuthService(dependencies).createInvitation(
      authenticated.actor,
      requiredBodyString(request.body, 'email'),
    );
    return reply.code(201).send(invitation);
  });

  app.get('/admin/users', async (request) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    return {
      users: await requireAuthService(dependencies).listUsers(
        authenticated.actor,
      ),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/disable',
    async (request, reply) => {
      const authenticated = await authenticate(
        dependencies,
        credentialTransport,
        request,
      );
      await requireAuthService(dependencies).disableUser(
        authenticated.actor,
        request.params.id,
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/enable',
    async (request, reply) => {
      const authenticated = await authenticate(
        dependencies,
        credentialTransport,
        request,
      );
      await requireAuthService(dependencies).enableUser(
        authenticated.actor,
        request.params.id,
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/revoke-sessions',
    async (request, reply) => {
      const authenticated = await authenticate(
        dependencies,
        credentialTransport,
        request,
      );
      await requireAuthService(dependencies).revokeUserSessions(
        authenticated.actor,
        request.params.id,
      );
      return reply.code(204).send();
    },
  );

  return app;
}

async function authenticate(
  dependencies: ApiDependencies,
  credentialTransport: CredentialTransport,
  request: FastifyRequest,
) {
  return requireAuthService(dependencies).authenticate(
    credentialTransport.extract(request),
  );
}

function requireAuthService(dependencies: ApiDependencies): AuthService {
  if (dependencies.authService === undefined) {
    throw new ApplicationError(
      'SERVICE_UNAVAILABLE',
      '登录服务尚未连接数据库。',
      503,
      true,
    );
  }
  return dependencies.authService;
}

function requiredBodyString(body: unknown, key: string): string {
  if (!isRecord(body) || typeof body[key] !== 'string') {
    throw new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
  }
  return body[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeError(error: unknown): ApplicationError {
  if (isApplicationError(error)) {
    return error;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    error.statusCode === 400
  ) {
    return new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
  }
  return new ApplicationError(
    'SERVICE_UNAVAILABLE',
    '服务暂时不可用，请稍后重试。',
    503,
    true,
  );
}
