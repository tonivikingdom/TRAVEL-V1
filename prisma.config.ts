import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Validation and client generation do not need a live database.
    url: process.env.DATABASE_URL ?? '',
  },
});
