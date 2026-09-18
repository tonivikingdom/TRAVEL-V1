import { ApplicationError } from '../packages/application/src/index.js';
import {
  createPrismaClient,
  PrismaAuthRepository,
} from '../packages/persistence/src/index.js';

const allowed = process.env.ADMIN_BOOTSTRAP_ALLOWED === 'true';
const environment = process.env.APP_ENV;
const databaseUrl = process.env.DATABASE_URL;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();

if (
  !allowed ||
  !['development', 'test', 'staging'].includes(environment ?? '')
) {
  throw new Error(
    'Admin bootstrap requires ADMIN_BOOTSTRAP_ALLOWED=true and APP_ENV=development, test, or staging',
  );
}
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('DATABASE_URL is required for admin bootstrap');
}
if (email === undefined || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
  throw new Error('BOOTSTRAP_ADMIN_EMAIL must be a valid email address');
}
if (environment === 'test' && !email.toLowerCase().includes('synthetic')) {
  throw new Error('Test bootstrap email must be explicitly SYNTHETIC');
}

const managed = createPrismaClient(databaseUrl);
try {
  const repository = new PrismaAuthRepository(managed.client);
  const result = await repository.bootstrapAdmin({
    email,
    normalizedEmail: email.toLowerCase(),
    defaultBaseCurrency: process.env.DEFAULT_BASE_CURRENCY ?? 'CNY',
    defaultUiLanguage: process.env.DEFAULT_UI_LANGUAGE ?? 'zh-CN',
  });
  process.stdout.write(
    `${JSON.stringify({ event: 'admin_bootstrap', created: result.created, userId: result.userId })}\n`,
  );
} catch (error) {
  if (error instanceof ApplicationError) {
    process.stderr.write(
      `${JSON.stringify({ event: 'admin_bootstrap_rejected', code: error.code })}\n`,
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await managed.close();
}
