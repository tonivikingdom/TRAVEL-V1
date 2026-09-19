import {
  AuthService,
  digestOpaqueToken,
  NotificationService,
} from '@travel/application';
import { randomUUID } from 'node:crypto';
import type { NotificationListResponse } from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaNotificationRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import type { FastifyInstance } from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { buildApi } from '../src/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P1B2 integration tests');
}

const NOW = new Date('2030-02-01T00:00:00.000Z');

describe('private NotificationEvent API with PostgreSQL', () => {
  let managed: ManagedPrismaClient;
  let notificationService: NotificationService;
  let app: FastifyInstance;
  let userA: SyntheticIdentity;
  let userB: SyntheticIdentity;
  let admin: SyntheticIdentity;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    const authRepository = new PrismaAuthRepository(managed.client);
    const notificationRepository = new PrismaNotificationRepository(
      managed.client,
    );
    notificationService = new NotificationService(notificationRepository, {
      now: () => NOW,
    });
    [userA, userB, admin] = await Promise.all([
      createIdentity(
        managed,
        'synthetic-notification-a@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-notification-b@synthetic.example.test',
        'USER',
      ),
      createIdentity(
        managed,
        'synthetic-notification-admin@synthetic.example.test',
        'ADMIN',
      ),
    ]);
    app = buildApi({
      readinessProbe: {
        async check() {
          return { name: 'postgresql', status: 'READY' };
        },
      },
      authService: new AuthService(authRepository, authConfig()),
      notificationService,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await managed.close();
  });

  it('deduplicates the same owner and dedupeKey', async () => {
    const first = await createNotification(userA.userId, 'synthetic:dedupe');
    const repeated = await createNotification(userA.userId, 'synthetic:dedupe');
    expect(repeated.id).toBe(first.id);
    expect(await managed.client.notificationEvent.count()).toBe(1);
  });

  it('allows different owners to use the same dedupeKey', async () => {
    await createNotification(userA.userId, 'synthetic:shared-key');
    await createNotification(userB.userId, 'synthetic:shared-key');
    expect(await managed.client.notificationEvent.count()).toBe(2);
  });

  it('returns only the current user notifications, including for ADMIN', async () => {
    await createNotification(userA.userId, 'synthetic:a');
    await createNotification(userB.userId, 'synthetic:b');
    await createNotification(admin.userId, 'synthetic:admin');

    expect((await list(userA)).notifications.map((item) => item.title)).toEqual(
      ['SYNTHETIC synthetic:a'],
    );
    expect((await list(admin)).notifications.map((item) => item.title)).toEqual(
      ['SYNTHETIC synthetic:admin'],
    );
  });

  it('prevents a user from dismissing another owner notification', async () => {
    const notification = await createNotification(
      userB.userId,
      'synthetic:private',
    );
    const response = await dismiss(userA, notification.id);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    expect(
      (
        await managed.client.notificationEvent.findUniqueOrThrow({
          where: { id: notification.id },
        })
      ).dismissedAt,
    ).toBeNull();
  });

  it('dismisses idempotently and keeps dismissed events in the default list', async () => {
    const notification = await createNotification(
      userA.userId,
      'synthetic:dismiss',
    );
    const first = await dismiss(userA, notification.id);
    const second = await dismiss(userA, notification.id);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().dismissedAt).toBe(first.json().dismissedAt);
    expect((await list(userA)).notifications[0]?.dismissedAt).not.toBeNull();
  });

  it('uses stable newest-first cursor pagination', async () => {
    for (const index of [1, 2, 3, 4, 5]) {
      await notificationService.createNotification({
        ownerUserId: userA.userId,
        kind: 'SYNTHETIC_TEST',
        dedupeKey: `synthetic:page:${index}`,
        title: `SYNTHETIC ${index}`,
        body: 'SYNTHETIC pagination notification',
        occurredAt: new Date(NOW.getTime() + index * 1_000),
      });
      await managed.client.notificationEvent.updateMany({
        where: {
          ownerUserId: userA.userId,
          dedupeKey: `synthetic:page:${index}`,
        },
        data: { createdAt: new Date(NOW.getTime() + index * 1_000) },
      });
    }
    const first = await list(userA, '?limit=2');
    const second = await list(
      userA,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    const third = await list(
      userA,
      `?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`,
    );
    expect(
      [
        ...first.notifications,
        ...second.notifications,
        ...third.notifications,
      ].map((item) => item.title),
    ).toEqual([
      'SYNTHETIC 5',
      'SYNTHETIC 4',
      'SYNTHETIC 3',
      'SYNTHETIC 2',
      'SYNTHETIC 1',
    ]);
    expect(third.nextCursor).toBeNull();
  });

  it('persists notifications across repository and client recreation', async () => {
    await createNotification(userA.userId, 'synthetic:restart');
    const second = createPrismaClient(databaseUrl);
    try {
      const service = new NotificationService(
        new PrismaNotificationRepository(second.client),
      );
      const result = await service.listNotifications(userA.actor, {});
      expect(result.notifications[0]?.title).toBe(
        'SYNTHETIC synthetic:restart',
      );
    } finally {
      await second.close();
    }
  });

  it('rejects notification reads after the P1A session is revoked', async () => {
    await managed.client.session.updateMany({
      where: { userId: userA.userId },
      data: { revokedAt: NOW },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: bearer(userA.credential),
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not expose a public notification creation endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/notifications',
      headers: bearer(userA.credential),
      payload: { title: 'SYNTHETIC client-created notification' },
    });
    expect(response.statusCode).toBe(404);
  });

  async function createNotification(ownerUserId: string, dedupeKey: string) {
    return notificationService.createNotification({
      ownerUserId,
      kind: 'SYNTHETIC_TEST',
      dedupeKey,
      title: `SYNTHETIC ${dedupeKey}`,
      body: 'SYNTHETIC notification body',
      occurredAt: NOW,
    });
  }

  async function list(
    identity: SyntheticIdentity,
    query = '',
  ): Promise<NotificationListResponse> {
    const response = await app.inject({
      method: 'GET',
      url: `/notifications${query}`,
      headers: bearer(identity.credential),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as NotificationListResponse;
  }

  function dismiss(identity: SyntheticIdentity, notificationId: string) {
    return app.inject({
      method: 'POST',
      url: `/notifications/${notificationId}/dismiss`,
      headers: bearer(identity.credential),
    });
  }
});

interface SyntheticIdentity {
  readonly userId: string;
  readonly credential: string;
  readonly actor: {
    readonly userId: string;
    readonly email: string;
    readonly role: 'ADMIN' | 'USER';
    readonly status: 'ACTIVE';
  };
}

async function createIdentity(
  managed: ManagedPrismaClient,
  email: string,
  role: 'ADMIN' | 'USER',
): Promise<SyntheticIdentity> {
  const credential = `SYNTHETIC_${randomUUID().replaceAll('-', '')}`;
  const user = await managed.client.user.create({
    data: {
      email,
      normalizedEmail: email,
      role,
      preference: {
        create: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' },
      },
      sessions: {
        create: {
          tokenDigest: digestOpaqueToken(credential),
          expiresAt: new Date(NOW.getTime() + 86_400_000),
        },
      },
    },
  });
  return {
    userId: user.id,
    credential,
    actor: { userId: user.id, email, role, status: 'ACTIVE' },
  };
}

function bearer(credential: string) {
  return { authorization: `Bearer ${credential}` };
}

function authConfig() {
  return {
    magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
    magicLinkTtlSeconds: 600,
    sessionTtlSeconds: 86_400,
    invitationTtlSeconds: 86_400,
    rateLimitWindowSeconds: 300,
    rateLimitMaxRequests: 50,
    defaultBaseCurrency: 'CNY',
    defaultUiLanguage: 'zh-CN',
    jobMaxAttempts: 5,
  };
}

async function resetSyntheticData(managed: ManagedPrismaClient): Promise<void> {
  await managed.client.outboxEvent.deleteMany();
  await managed.client.operationReceipt.deleteMany();
  await managed.client.transportEdgeHistoryTimeValue.deleteMany();
  await managed.client.transportEdgeHistory.deleteMany();
  await managed.client.temporalValue.deleteMany();
  await managed.client.transportEdge.deleteMany();
  await managed.client.itineraryNode.deleteMany({
    where: { source: 'ROUTE_GENERATED' },
  });
  await managed.client.adoptedRoute.deleteMany();
  await managed.client.itineraryNode.deleteMany();
  await managed.client.dateOwnership.deleteMany();
  await managed.client.trip.deleteMany();
  await managed.client.place.deleteMany();
  await managed.client.notificationEvent.deleteMany();
  await managed.client.storedObject.deleteMany();
  await managed.client.magicLinkRequestBucket.deleteMany();
  await managed.client.job.deleteMany();
  await managed.client.session.deleteMany();
  await managed.client.magicLinkToken.deleteMany();
  await managed.client.magicLinkDeliveryRequest.deleteMany();
  await managed.client.userPreference.deleteMany();
  await managed.client.invitation.deleteMany();
  await managed.client.user.deleteMany();
}
