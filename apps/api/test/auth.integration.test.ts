import {
  AuthService,
  CapturedMailSender,
  deriveMagicLinkToken,
  MagicLinkEmailHandler,
  type MagicLinkMail,
  type MailSender,
} from '@travel/application';
import type { SessionResponse, UserView } from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
  PrismaJobRepository,
  PrismaMagicLinkDeliveryRepository,
  type ManagedPrismaClient,
} from '@travel/persistence';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P1A integration tests');
}

const ADMIN_EMAIL = 'synthetic-admin@synthetic.example.test';
const USER_A_EMAIL = 'synthetic-user-a@synthetic.example.test';
const USER_B_EMAIL = 'synthetic-user-b@synthetic.example.test';
const TOKEN_KEY = 'SYNTHETIC_TEST_MAGIC_LINK_TOKEN_KEY_0123456789abcdef';

describe('P1A auth API with PostgreSQL', () => {
  let managed: ManagedPrismaClient;
  let repository: PrismaAuthRepository;
  let mail: CapturedMailSender;
  let jobRepository: PrismaJobRepository;
  let magicLinkHandler: MagicLinkEmailHandler;
  let app: FastifyInstance;
  let now: Date;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
    repository = new PrismaAuthRepository(managed.client);
    jobRepository = new PrismaJobRepository(managed.client);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    now = new Date('2030-01-01T00:00:00.000Z');
    mail = new CapturedMailSender();
    const authService = new AuthService(
      repository,
      {
        magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
        magicLinkTtlSeconds: 600,
        sessionTtlSeconds: 86_400,
        invitationTtlSeconds: 86_400,
        rateLimitWindowSeconds: 300,
        rateLimitMaxRequests: 50,
        defaultBaseCurrency: 'CNY',
        defaultUiLanguage: 'zh-CN',
        jobMaxAttempts: 5,
      },
      { now: () => now },
    );
    magicLinkHandler = new MagicLinkEmailHandler(
      new PrismaMagicLinkDeliveryRepository(managed.client),
      mail,
      {
        landingUrl: 'https://synthetic.example.test/login/magic',
        tokenKey: TOKEN_KEY,
        tokenTtlSeconds: 600,
      },
      { now: () => now },
    );
    app = buildApi({
      readinessProbe: {
        async check() {
          return { name: 'postgresql', status: 'READY' };
        },
      },
      authService,
    });
    await repository.bootstrapAdmin({
      email: ADMIN_EMAIL,
      normalizedEmail: ADMIN_EMAIL,
      defaultBaseCurrency: 'CNY',
      defaultUiLanguage: 'zh-CN',
    });
  });

  afterAll(async () => {
    await managed.close();
  });

  it('keeps request responses identical for known and unknown emails', async () => {
    const known = await requestMagicLink(ADMIN_EMAIL);
    const unknown = await requestMagicLink(
      'synthetic-unknown@synthetic.example.test',
    );
    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(mail.messages).toHaveLength(0);
    expect(await managed.client.job.count()).toBe(2);
    expect(await managed.client.magicLinkDeliveryRequest.count()).toBe(2);
  });

  it('puts the captured token in the configured landing URL fragment', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    await executeNextJob();
    const message = latestMail(ADMIN_EMAIL);
    const url = new URL(message.magicLink);

    expect(url.origin + url.pathname).toBe(
      'https://synthetic.example.test/login/magic',
    );
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{40,100}$/u);
  });

  it('accepts the consume token only from the POST body', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    await executeNextJob();
    const token = latestToken(ADMIN_EMAIL);
    const queryOnly = await app.inject({
      method: 'POST',
      url: `/auth/magic-link/consume?token=${encodeURIComponent(token)}`,
    });
    expect(queryOnly.statusCode).toBe(400);
    expect(queryOnly.json().error.code).toBe('VALIDATION_ERROR');

    expect((await consume(token)).statusCode).toBe(200);
  });

  it('does not create a session for an uninvited email', async () => {
    await requestMagicLink('synthetic-uninvited@synthetic.example.test');
    await executeNextJob();
    expect(mail.messages).toHaveLength(0);
    const response = await consume('A'.repeat(43));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('keeps raw credentials out of the Job and DeliveryRequest records', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const job = await managed.client.job.findFirstOrThrow();
    const delivery =
      await managed.client.magicLinkDeliveryRequest.findFirstOrThrow();
    expect(job.payloadRef).toBe(delivery.id);
    expect(JSON.stringify(job)).not.toContain('token');
    expect(JSON.stringify(delivery)).not.toContain('#token=');
    expect(await managed.client.magicLinkToken.count()).toBe(0);
  });

  it('retries mail with the same derived token and only one digest record', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const job = await jobRepository.claimNext({
      workerId: 'synthetic-retry-worker',
      now,
      leaseDurationMs: 30_000,
    });
    const flaky = new FailAfterCaptureMailSender();
    const handler = new MagicLinkEmailHandler(
      new PrismaMagicLinkDeliveryRepository(managed.client),
      flaky,
      {
        landingUrl: 'https://synthetic.example.test/login/magic',
        tokenKey: TOKEN_KEY,
        tokenTtlSeconds: 600,
      },
      { now: () => now },
    );

    await expect(handler.execute(job!.payloadRef)).rejects.toThrow(
      /SYNTHETIC_MAIL_FAILURE/u,
    );
    await handler.execute(job!.payloadRef);
    expect(flaky.messages).toHaveLength(2);
    expect(flaky.messages[0]?.magicLink).toBe(flaky.messages[1]?.magicLink);
    expect(await managed.client.magicLinkToken.count()).toBe(1);
  });

  it('rotates an expired delivery token without reviving the old link', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const delivery =
      await managed.client.magicLinkDeliveryRequest.findFirstOrThrow();
    const flaky = new FailAfterCaptureMailSender(2);
    const handler = new MagicLinkEmailHandler(
      new PrismaMagicLinkDeliveryRepository(managed.client),
      flaky,
      {
        landingUrl: 'https://synthetic.example.test/login/magic',
        tokenKey: TOKEN_KEY,
        tokenTtlSeconds: 600,
      },
      { now: () => now },
    );

    await expect(handler.execute(delivery.id)).rejects.toThrow(
      /SYNTHETIC_MAIL_FAILURE/u,
    );
    const tokenA = tokenFromMail(flaky.messages[0]!);

    now = new Date(now.getTime() + 300_000);
    await expect(handler.execute(delivery.id)).rejects.toThrow(
      /SYNTHETIC_MAIL_FAILURE/u,
    );
    expect(tokenFromMail(flaky.messages[1]!)).toBe(tokenA);

    now = new Date(now.getTime() + 301_000);
    await handler.execute(delivery.id);
    const tokenB = tokenFromMail(flaky.messages[2]!);
    expect(tokenB).not.toBe(tokenA);
    expect((await consume(tokenA)).statusCode).toBe(401);
    expect((await consume(tokenB)).statusCode).toBe(200);

    const updated =
      await managed.client.magicLinkDeliveryRequest.findUniqueOrThrow({
        where: { id: delivery.id },
      });
    expect(updated.tokenGeneration).toBe(2);
    expect(await managed.client.magicLinkToken.count()).toBe(1);
  });

  it('serializes concurrent token rotation to one current generation', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const delivery =
      await managed.client.magicLinkDeliveryRequest.findFirstOrThrow();
    const deliveryRepository = new PrismaMagicLinkDeliveryRepository(
      managed.client,
    );
    const prepare = (at: Date) =>
      deliveryRepository.prepareDelivery({
        deliveryRequestId: delivery.id,
        deriveTokenDigest: (generation) =>
          deriveMagicLinkToken(TOKEN_KEY, delivery.id, generation).digest,
        proposedExpiresAt: new Date(at.getTime() + 600_000),
        now: at,
      });

    const first = await prepare(now);
    expect(first).toMatchObject({ status: 'SEND', tokenGeneration: 1 });
    const oldDigest = deriveMagicLinkToken(TOKEN_KEY, delivery.id, 1).digest;

    const afterExpiry = new Date(now.getTime() + 601_000);
    const concurrent = await Promise.all([
      prepare(afterExpiry),
      prepare(afterExpiry),
    ]);
    expect(concurrent).toEqual([
      expect.objectContaining({ status: 'SEND', tokenGeneration: 2 }),
      expect.objectContaining({ status: 'SEND', tokenGeneration: 2 }),
    ]);

    const currentToken = await managed.client.magicLinkToken.findFirstOrThrow();
    expect(currentToken.tokenDigest).toBe(
      deriveMagicLinkToken(TOKEN_KEY, delivery.id, 2).digest,
    );
    expect(currentToken.tokenDigest).not.toBe(oldDigest);
    expect(await managed.client.magicLinkToken.count()).toBe(1);
  });

  it('treats revoked and expired invitations as safe background no-ops', async () => {
    const admin = await login(ADMIN_EMAIL);
    const revoked = await invite(admin.credential, USER_A_EMAIL);
    await managed.client.invitation.update({
      where: { id: revoked.id },
      data: { status: 'REVOKED', revokedAt: now },
    });
    await requestMagicLink(USER_A_EMAIL);
    await executeNextJob();

    const expired = await invite(admin.credential, USER_B_EMAIL);
    await managed.client.invitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(now.getTime() - 1_000) },
    });
    await requestMagicLink(USER_B_EMAIL);
    await executeNextJob();
    expect(
      mail.messages.filter((message) => message.recipient !== ADMIN_EMAIL),
    ).toHaveLength(0);
  });

  it('turns a valid invitation and magic link into a session', async () => {
    const admin = await login(ADMIN_EMAIL);
    await invite(admin.credential, USER_A_EMAIL);
    const user = await login(USER_A_EMAIL);
    const me = await getMe(user.credential);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      email: USER_A_EMAIL,
      role: 'USER',
      preferences: { baseCurrency: 'CNY', uiLanguage: 'zh-CN' },
    });
  });

  it('stores only the magic-link digest', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    await executeNextJob();
    const raw = latestToken(ADMIN_EMAIL);
    const record = await managed.client.magicLinkToken.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    expect(record.tokenDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.tokenDigest).not.toBe(raw);
  });

  it('allows a magic link to be consumed only once', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    await executeNextJob();
    const token = latestToken(ADMIN_EMAIL);
    expect((await consume(token)).statusCode).toBe(200);
    expect((await consume(token)).statusCode).toBe(401);
  });

  it('allows at most one concurrent consume of the same token', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    await executeNextJob();
    const token = latestToken(ADMIN_EMAIL);
    const responses = await Promise.all([consume(token), consume(token)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 401,
    ]);
  });

  it('rejects an expired magic link', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    await executeNextJob();
    const token = latestToken(ADMIN_EMAIL);
    now = new Date(now.getTime() + 601_000);
    expect((await consume(token)).statusCode).toBe(401);
  });

  it('rejects an already consumed magic link', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    await executeNextJob();
    const token = latestToken(ADMIN_EMAIL);
    await consume(token);
    const response = await consume(token);
    expect(response.json().error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('prevents a disabled user from logging in', async () => {
    const { admin, user } = await createUserA();
    await requestMagicLink(USER_A_EMAIL);
    await executeNextJob();
    const pendingToken = latestToken(USER_A_EMAIL);
    await adminPost(admin.credential, `/admin/users/${user.user.id}/disable`);
    expect((await consume(pendingToken)).statusCode).toBe(401);
    const messagesBefore = mail.messages.length;
    expect((await requestMagicLink(USER_A_EMAIL)).statusCode).toBe(202);
    await executeNextJob();
    expect(mail.messages).toHaveLength(messagesBefore);
  });

  it('invalidates existing sessions immediately when a user is disabled', async () => {
    const { admin, user } = await createUserA();
    await adminPost(admin.credential, `/admin/users/${user.user.id}/disable`);
    expect((await getMe(user.credential)).statusCode).toBe(401);
  });

  it('does not revive an old session when a user is re-enabled', async () => {
    const { admin, user } = await createUserA();
    await adminPost(admin.credential, `/admin/users/${user.user.id}/disable`);
    await adminPost(admin.credential, `/admin/users/${user.user.id}/enable`);
    expect((await getMe(user.credential)).statusCode).toBe(401);
    expect((await login(USER_A_EMAIL)).user.id).toBe(user.user.id);
  });

  it('revokes every device session for a selected user', async () => {
    const { admin, user } = await createUserA();
    const second = await login(USER_A_EMAIL);
    await adminPost(
      admin.credential,
      `/admin/users/${user.user.id}/revoke-sessions`,
    );
    expect((await getMe(user.credential)).statusCode).toBe(401);
    expect((await getMe(second.credential)).statusCode).toBe(401);
  });

  it('derives identity from the session and ignores attempted user impersonation', async () => {
    const { admin, user } = await createUserA();
    await invite(admin.credential, USER_B_EMAIL);
    const other = await login(USER_B_EMAIL);
    const response = await app.inject({
      method: 'GET',
      url: `/me?userId=${other.user.id}`,
      headers: bearer(user.credential),
    });
    expect(response.json().id).toBe(user.user.id);
  });

  it('forbids normal users from administrator endpoints', async () => {
    const { user } = await createUserA();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/invitations',
      headers: bearer(user.credential),
      payload: { email: USER_B_EMAIL },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('lets administrators view only minimal account-management fields', async () => {
    const { admin } = await createUserA();
    const response = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: bearer(admin.credential),
    });
    expect(response.statusCode).toBe(200);
    const users = response.json().users as Array<Record<string, unknown>>;
    expect(users).toHaveLength(2);
    expect(Object.keys(users[0] ?? {}).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'role',
      'status',
    ]);
  });

  it('rejects an expired session', async () => {
    const admin = await login(ADMIN_EMAIL);
    await managed.client.session.updateMany({
      data: { expiresAt: new Date(now.getTime() - 1_000) },
    });
    expect((await getMe(admin.credential)).statusCode).toBe(401);
  });

  it('invalidates the current session on logout', async () => {
    const admin = await login(ADMIN_EMAIL);
    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: bearer(admin.credential),
    });
    expect(logout.statusCode).toBe(204);
    expect((await getMe(admin.credential)).statusCode).toBe(401);
  });

  it('allows multiple device sessions for the same active account', async () => {
    const first = await login(ADMIN_EMAIL);
    const second = await login(ADMIN_EMAIL);
    expect(first.credential).not.toBe(second.credential);
    expect((await getMe(first.credential)).statusCode).toBe(200);
    expect((await getMe(second.credential)).statusCode).toBe(200);
  });

  it('keeps currency and UI language as independent preferences', async () => {
    const admin = await login(ADMIN_EMAIL);
    await managed.client.userPreference.update({
      where: { userId: admin.user.id },
      data: { baseCurrency: 'USD' },
    });
    const me = (await getMe(admin.credential)).json() as UserView;
    expect(me.preferences).toEqual({
      baseCurrency: 'USD',
      uiLanguage: 'zh-CN',
    });
  });

  it('applies the committed migration to real PostgreSQL tables', async () => {
    const rows = await managed.client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('User', 'Invitation', 'MagicLinkToken', 'Session', 'UserPreference')
      ORDER BY table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual([
      'Invitation',
      'MagicLinkToken',
      'Session',
      'User',
      'UserPreference',
    ]);
  });

  it('persists rate limits in PostgreSQL', async () => {
    const limitedService = new AuthService(repository, {
      magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
      magicLinkTtlSeconds: 600,
      sessionTtlSeconds: 86_400,
      invitationTtlSeconds: 86_400,
      rateLimitWindowSeconds: 300,
      rateLimitMaxRequests: 1,
      defaultBaseCurrency: 'CNY',
      defaultUiLanguage: 'zh-CN',
      jobMaxAttempts: 5,
    });
    const limitedApp = buildApi({
      readinessProbe: {
        async check() {
          return { name: 'postgresql', status: 'READY' };
        },
      },
      authService: limitedService,
    });
    const payload = { email: 'synthetic-rate-limit@synthetic.example.test' };
    expect(
      (
        await limitedApp.inject({
          method: 'POST',
          url: '/auth/magic-link/request',
          payload,
        })
      ).statusCode,
    ).toBe(202);
    const rejected = await limitedApp.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload,
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json().error.code).toBe('RATE_LIMITED');
    expect(await managed.client.magicLinkRequestBucket.count()).toBe(1);
  });

  it('preserves P0 liveness and readiness behavior', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/health/live' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/health/ready' })).statusCode,
    ).toBe(200);
  });

  async function createUserA() {
    const admin = await login(ADMIN_EMAIL);
    await invite(admin.credential, USER_A_EMAIL);
    const user = await login(USER_A_EMAIL);
    return { admin, user };
  }

  async function invite(credential: string, email: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/invitations',
      headers: bearer(credential),
      payload: { email },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function login(email: string): Promise<SessionResponse> {
    const requested = await requestMagicLink(email);
    expect(requested.statusCode).toBe(202);
    await executeNextJob();
    const response = await consume(latestToken(email));
    expect(response.statusCode).toBe(200);
    return response.json() as SessionResponse;
  }

  async function requestMagicLink(email: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email },
    });
  }

  async function consume(token: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/magic-link/consume',
      payload: { token },
    });
  }

  async function getMe(credential: string) {
    return app.inject({
      method: 'GET',
      url: '/me',
      headers: bearer(credential),
    });
  }

  async function adminPost(credential: string, url: string) {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: bearer(credential),
    });
    expect(response.statusCode).toBe(204);
    return response;
  }

  function latestToken(email: string): string {
    return tokenFromMail(latestMail(email));
  }

  function tokenFromMail(mail: MagicLinkMail): string {
    const match = new URL(mail.magicLink).hash.match(
      /^#token=([A-Za-z0-9_-]{40,100})$/u,
    );
    if (match?.[1] === undefined) {
      throw new Error('Captured SYNTHETIC magic link has no token');
    }
    return decodeURIComponent(match[1]);
  }

  async function executeNextJob(): Promise<void> {
    const job = await jobRepository.claimNext({
      workerId: 'synthetic-api-integration-worker',
      now,
      leaseDurationMs: 30_000,
    });
    expect(job).not.toBeNull();
    await magicLinkHandler.execute(job!.payloadRef);
    expect(
      await jobRepository.markSucceeded(
        job!.id,
        'synthetic-api-integration-worker',
        now,
      ),
    ).toBe(true);
  }

  function latestMail(email: string) {
    const message = [...mail.messages]
      .reverse()
      .find(
        (candidate) =>
          candidate.recipient.toLowerCase() === email.toLowerCase(),
      );
    if (message === undefined) {
      throw new Error(`No SYNTHETIC captured mail for ${email}`);
    }
    return message;
  }
});

function bearer(credential: string): { readonly authorization: string } {
  return { authorization: `Bearer ${credential}` };
}

class FailAfterCaptureMailSender implements MailSender {
  readonly messages: MagicLinkMail[] = [];

  constructor(private remainingFailures = 1) {}

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
    this.messages.push(mail);
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error('SYNTHETIC_MAIL_FAILURE');
    }
  }
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
