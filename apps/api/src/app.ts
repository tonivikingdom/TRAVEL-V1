import {
  ApplicationError,
  AuthService,
  NotificationService,
  TripService,
  isApplicationError,
} from '@travel/application';
import type {
  ApiErrorResponse,
  LivenessResponse,
  PlaceInput,
  ReadinessResponse,
  TransportMode,
  TripCommandInput,
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
  readonly notificationService?: NotificationService;
  readonly tripService?: TripService;
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

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/notifications',
    async (request) => {
      const authenticated = await authenticate(
        dependencies,
        credentialTransport,
        request,
      );
      const limit = optionalPositiveInteger(request.query.limit);
      return requireNotificationService(dependencies).listNotifications(
        authenticated.actor,
        {
          ...(limit === undefined ? {} : { limit }),
          ...(request.query.cursor === undefined
            ? {}
            : { cursor: request.query.cursor }),
        },
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    '/notifications/:id/dismiss',
    async (request) => {
      const authenticated = await authenticate(
        dependencies,
        credentialTransport,
        request,
      );
      return requireNotificationService(dependencies).dismissNotification(
        authenticated.actor,
        request.params.id,
      );
    },
  );

  app.post('/trips', async (request, reply) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    const body = requiredRecord(request.body);
    const trip = await requireTripService(dependencies).createTrip(
      authenticated.actor,
      {
        name: requiredString(body, 'name'),
        planningAnchorDate: requiredString(body, 'planningAnchorDate'),
        defaultPeopleCount: requiredNumber(body, 'defaultPeopleCount'),
      },
    );
    return reply.code(201).send(trip);
  });

  app.get('/trips', async (request) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    return {
      trips: await requireTripService(dependencies).listTrips(
        authenticated.actor,
      ),
    };
  });

  app.get<{ Params: { id: string } }>('/trips/:id', async (request) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    return requireTripService(dependencies).getTrip(
      authenticated.actor,
      request.params.id,
    );
  });

  app.patch<{ Params: { id: string } }>('/trips/:id', async (request) => {
    const authenticated = await authenticate(
      dependencies,
      credentialTransport,
      request,
    );
    const body = requiredRecord(request.body);
    return requireTripService(dependencies).updateTrip(
      authenticated.actor,
      request.params.id,
      {
        baseTripVersion: requiredNumber(body, 'baseTripVersion'),
        ...(hasOwn(body, 'name') ? { name: requiredString(body, 'name') } : {}),
        ...(hasOwn(body, 'planningAnchorDate')
          ? {
              planningAnchorDate: requiredString(body, 'planningAnchorDate'),
            }
          : {}),
        ...(hasOwn(body, 'defaultPeopleCount')
          ? {
              defaultPeopleCount: requiredNumber(body, 'defaultPeopleCount'),
            }
          : {}),
      },
    );
  });

  app.post<{ Params: { id: string } }>(
    '/trips/:id/commands',
    async (request) => {
      const authenticated = await authenticate(
        dependencies,
        credentialTransport,
        request,
      );
      const body = requiredRecord(request.body);
      return requireTripService(dependencies).executeCommand(
        authenticated.actor,
        request.params.id,
        requiredNumber(body, 'baseTripVersion'),
        parseTripCommand(body.command),
      );
    },
  );

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

function requireNotificationService(
  dependencies: ApiDependencies,
): NotificationService {
  if (dependencies.notificationService === undefined) {
    throw new ApplicationError(
      'SERVICE_UNAVAILABLE',
      '通知服务尚未连接数据库。',
      503,
      true,
    );
  }
  return dependencies.notificationService;
}

function requireTripService(dependencies: ApiDependencies): TripService {
  if (dependencies.tripService === undefined) {
    throw new ApplicationError(
      'SERVICE_UNAVAILABLE',
      '行程服务尚未连接数据库。',
      503,
      true,
    );
  }
  return dependencies.tripService;
}

function requiredBodyString(body: unknown, key: string): string {
  if (!isRecord(body) || typeof body[key] !== 'string') {
    throw new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
  }
  return body[key];
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== 'string') {
    throw new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
  }
  return body[key];
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  if (typeof body[key] !== 'number') {
    throw new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
  }
  return body[key];
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== 'boolean') {
    throw new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
  }
  return body[key];
}

function optionalNullableString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new ApplicationError('VALIDATION_ERROR', '请求格式无效。', 400);
}

function parseTripCommand(value: unknown): TripCommandInput {
  const command = requiredRecord(value);
  const type = requiredString(command, 'type');
  switch (type) {
    case 'ADD_PLACE_VISIT':
      return {
        type,
        localDate: requiredString(command, 'localDate'),
        position: requiredNumber(command, 'position'),
        place: parsePlaceInput(command.place),
        ...(hasOwn(command, 'note')
          ? { note: optionalNullableString(command, 'note') }
          : {}),
      };
    case 'ADD_FREE_ACTION':
      return {
        type,
        localDate: requiredString(command, 'localDate'),
        position: requiredNumber(command, 'position'),
        ...(hasOwn(command, 'note')
          ? { note: optionalNullableString(command, 'note') }
          : {}),
      };
    case 'DELETE_NODE':
      return { type, nodeId: requiredString(command, 'nodeId') };
    case 'MOVE_NODE_WITHIN_DAY':
      return {
        type,
        nodeId: requiredString(command, 'nodeId'),
        position: requiredNumber(command, 'position'),
      };
    case 'REPLACE_PLACE':
      return {
        type,
        nodeId: requiredString(command, 'nodeId'),
        place: parsePlaceInput(command.place),
      };
    case 'SET_MANUAL_TRANSPORT':
      return {
        type,
        fromNodeId: requiredString(command, 'fromNodeId'),
        toNodeId: requiredString(command, 'toNodeId'),
        mode: parseTransportMode(requiredString(command, 'mode')),
        fixedService: requiredBoolean(command, 'fixedService'),
        ...(hasOwn(command, 'serviceLabel')
          ? {
              serviceLabel: optionalNullableString(command, 'serviceLabel'),
            }
          : {}),
        ...(hasOwn(command, 'note')
          ? { note: optionalNullableString(command, 'note') }
          : {}),
      };
    case 'CLEAR_TRANSPORT':
      return {
        type,
        transportEdgeId: requiredString(command, 'transportEdgeId'),
      };
    default:
      throw new ApplicationError('VALIDATION_ERROR', '不支持的行程命令。', 400);
  }
}

function parseTransportMode(value: string): TransportMode {
  switch (value) {
    case 'WALKING':
    case 'DRIVING':
    case 'TAXI':
    case 'RAIL':
    case 'BUS':
    case 'FERRY':
    case 'FLIGHT':
    case 'OTHER':
      return value;
    default:
      throw new ApplicationError('VALIDATION_ERROR', '交通方式无效。', 400);
  }
}

function parsePlaceInput(value: unknown): PlaceInput {
  const place = requiredRecord(value);
  const type = requiredString(place, 'type');
  if (type === 'EXISTING') {
    return { type, placeId: requiredString(place, 'placeId') };
  }
  if (type === 'CUSTOM') {
    return {
      type,
      name: requiredString(place, 'name'),
      latitude: requiredNumber(place, 'latitude'),
      longitude: requiredNumber(place, 'longitude'),
      ...(hasOwn(place, 'address')
        ? { address: optionalNullableString(place, 'address') }
        : {}),
    };
  }
  throw new ApplicationError('VALIDATION_ERROR', '不支持的地点输入。', 400);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalPositiveInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new ApplicationError('VALIDATION_ERROR', '分页大小无效。', 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApplicationError('VALIDATION_ERROR', '分页大小无效。', 400);
  }
  return parsed;
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
