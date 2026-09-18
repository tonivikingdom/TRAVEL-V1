import { AuthService, CapturedMailSender } from '@travel/application';
import type { SessionResponse, UserView } from '@travel/contracts';
import {
  createPrismaClient,
  PrismaAuthRepository,
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

describe('P1A auth API with PostgreSQL', () => {
  let managed: ManagedPrismaClient;
  let repository: PrismaAuthRepository;
  let mail: CapturedMailSender;
  let app: FastifyInstance;
  let now: Date;

  beforeAll(() => {
    managed = createPrismaClient(databaseUrl);
    repository = new PrismaAuthRepository(managed.client);
  });

  beforeEach(async () => {
    await resetSyntheticData(managed);
    now = new Date('2030-01-01T00:00:00.000Z');
    mail = new CapturedMailSender();
    const authService = new AuthService(
      repository,
      mail,
      {
        magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
        magicLinkTtlSeconds: 600,
        sessionTtlSeconds: 86_400,
        invitationTtlSeconds: 86_400,
        rateLimitWindowSeconds: 300,
        rateLimitMaxRequests: 50,
        defaultBaseCurrency: 'CNY',
        defaultUiLanguage: 'zh-CN',
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
  });

  it('puts the captured token in the configured landing URL fragment', async () => {
    await requestMagicLink(ADMIN_EMAIL);
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
    expect(mail.messages).toHaveLength(0);
    const response = await consume('A'.repeat(43));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
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
    const raw = latestToken(ADMIN_EMAIL);
    const record = await managed.client.magicLinkToken.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    expect(record.tokenDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.tokenDigest).not.toBe(raw);
  });

  it('allows a magic link to be consumed only once', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const token = latestToken(ADMIN_EMAIL);
    expect((await consume(token)).statusCode).toBe(200);
    expect((await consume(token)).statusCode).toBe(401);
  });

  it('allows at most one concurrent consume of the same token', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const token = latestToken(ADMIN_EMAIL);
    const responses = await Promise.all([consume(token), consume(token)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 401,
    ]);
  });

  it('rejects an expired magic link', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const token = latestToken(ADMIN_EMAIL);
    now = new Date(now.getTime() + 601_000);
    expect((await consume(token)).statusCode).toBe(401);
  });

  it('rejects an already consumed magic link', async () => {
    await requestMagicLink(ADMIN_EMAIL);
    const token = latestToken(ADMIN_EMAIL);
    await consume(token);
    const response = await consume(token);
    expect(response.json().error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('prevents a disabled user from logging in', async () => {
    const { admin, user } = await createUserA();
    await requestMagicLink(USER_A_EMAIL);
    const pendingToken = latestToken(USER_A_EMAIL);
    await adminPost(admin.credential, `/admin/users/${user.user.id}/disable`);
    expect((await consume(pendingToken)).statusCode).toBe(401);
    const messagesBefore = mail.messages.length;
    expect((await requestMagicLink(USER_A_EMAIL)).statusCode).toBe(202);
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
    const limitedMail = new CapturedMailSender();
    const limitedService = new AuthService(repository, limitedMail, {
      magicLinkLandingUrl: 'https://synthetic.example.test/login/magic',
      magicLinkTtlSeconds: 600,
      sessionTtlSeconds: 86_400,
      invitationTtlSeconds: 86_400,
      rateLimitWindowSeconds: 300,
      rateLimitMaxRequests: 1,
      defaultBaseCurrency: 'CNY',
      defaultUiLanguage: 'zh-CN',
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
    const match = new URL(latestMail(email).magicLink).hash.match(
      /^#token=([A-Za-z0-9_-]{40,100})$/u,
    );
    if (match?.[1] === undefined) {
      throw new Error('Captured SYNTHETIC magic link has no token');
    }
    return decodeURIComponent(match[1]);
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

async function resetSyntheticData(managed: ManagedPrismaClient): Promise<void> {
  await managed.client.magicLinkRequestBucket.deleteMany();
  await managed.client.session.deleteMany();
  await managed.client.magicLinkToken.deleteMany();
  await managed.client.userPreference.deleteMany();
  await managed.client.invitation.deleteMany();
  await managed.client.user.deleteMany();
}
