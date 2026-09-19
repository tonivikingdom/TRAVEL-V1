import { createPrismaClient } from '../packages/persistence/src/index.js';

import { countP5bSyntheticUsers, resetP5bSyntheticData } from './p5b-reset.js';
import { evaluateResetGuard } from './p5b-support.js';

const databaseUrl = process.env.DATABASE_URL;
const appEnv = process.env.APP_ENV;
const confirmed = process.argv.includes('--confirm-synthetic-p5b-reset');
const allowStaging = process.argv.includes('--allow-staging');

if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('DATABASE_URL is required');
}

const guard = evaluateResetGuard({ appEnv, confirmed, allowStaging });
if (!guard.allowed) throw new Error(guard.reason);

const parsed = new URL(databaseUrl);
const managed = createPrismaClient(databaseUrl);
try {
  const matchedUsers = await countP5bSyntheticUsers(managed.client);
  const target = {
    appEnv,
    databaseHost: parsed.hostname,
    databaseName: parsed.pathname.replace(/^\//u, ''),
    matchingSyntheticUsers: matchedUsers,
    dryRun: guard.dryRun,
  };
  process.stdout.write(
    `${JSON.stringify({ event: 'p5b_reset_target', ...target })}\n`,
  );
  if (guard.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ event: 'p5b_reset_dry_run', deletedUsers: 0 })}\n`,
    );
  } else {
    const result = await resetP5bSyntheticData(managed.client);
    process.stdout.write(
      `${JSON.stringify({ event: 'p5b_reset_complete', ...result })}\n`,
    );
  }
} finally {
  await managed.close();
}
