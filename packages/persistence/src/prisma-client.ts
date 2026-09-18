import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

export interface ManagedPrismaClient {
  readonly client: PrismaClient;
  close(): Promise<void>;
}

export function createPrismaClient(
  connectionString: string,
): ManagedPrismaClient {
  if (connectionString.trim() === '') {
    throw new Error('A non-empty PostgreSQL connection string is required');
  }

  const adapter = new PrismaPg({
    connectionString,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: 5,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  const client = new PrismaClient({ adapter });
  let closePromise: Promise<void> | undefined;

  return {
    client,
    async close(): Promise<void> {
      closePromise ??= client.$disconnect();
      await closePromise;
    },
  };
}

export { PrismaClient };
