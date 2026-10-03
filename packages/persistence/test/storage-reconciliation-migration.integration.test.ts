import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for audit repair migration tests',
  );
}
const migrationsPath = fileURLToPath(
  new URL('../../../prisma/migrations/', import.meta.url),
);
const migration = '20261002090000_p5_audit_storage_reconciliation';
const splitMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P5 storage reconciliation migration', () => {
  it('applies exactly 24 migrations cleanly and enforces cleanup metadata constraints', async () => {
    const names = (await migrationNames()).filter((name) => name <= migration);
    expect(names).toHaveLength(24);
    await withDatabase('clean', async (client) => {
      for (const name of names) await applyMigration(client, name);
      const columns = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name='StoredObject'`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining([
          'storageDeletedAt',
          'cleanupAttempts',
          'cleanupNextAttemptAt',
          'cleanupLastErrorCode',
        ]),
      );
      await client.query(
        `INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt") VALUES ('00000000-0000-4000-8000-000000000074', 'synthetic-migration@synthetic.example.test', 'synthetic-migration@synthetic.example.test', now())`,
      );
      const insert = `INSERT INTO "StoredObject" ("id", "ownerUserId", "storageKey", "displayName", "mediaType", "declaredByteSize", "cleanupAttempts", "storageDeletedAt") VALUES (gen_random_uuid(), '00000000-0000-4000-8000-000000000074', gen_random_uuid(), 'SYNTHETIC', 'text/plain', 10, $1, $2)`;
      await expect(client.query(insert, [-1, null])).rejects.toMatchObject({
        constraint: 'StoredObject_cleanup_attempts_check',
      });
      await expect(client.query(insert, [0, new Date()])).rejects.toMatchObject(
        { constraint: 'StoredObject_storage_deleted_state_check' },
      ); // PENDING cannot have physical completion.
    });
  });

  it('preserves populated 23-migration logical states without inventing historical cleanup', async () => {
    await withDatabase('populated', async (client) => {
      for (const name of (await migrationNames()).filter(
        (name) => name < migration,
      ))
        await applyMigration(client, name);
      await client.query(
        `INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt") VALUES ('00000000-0000-4000-8000-000000000074', 'synthetic-migration@synthetic.example.test', 'synthetic-migration@synthetic.example.test', now())`,
      );
      for (const [index, state] of [
        'READY',
        'PENDING',
        'PENDING',
        'FAILED',
        'DELETED',
      ].entries()) {
        await client.query(
          `INSERT INTO "StoredObject" ("id", "ownerUserId", "storageKey", "state", "displayName", "mediaType", "declaredByteSize", "byteSize", "sha256", "createdAt", "readyAt", "deletedAt") VALUES (gen_random_uuid(), '00000000-0000-4000-8000-000000000074', gen_random_uuid(), $1::"StoredObjectState", $2, 'text/plain', 10, $3, $4, $5, $6, $7)`,
          [
            state,
            'SYNTHETIC ' + index,
            state === 'READY' ? 10 : null,
            state === 'READY' ? 'a'.repeat(64) : null,
            index === 2 ? new Date('2000-01-01Z') : new Date(),
            state === 'READY' ? new Date() : null,
            state === 'DELETED' ? new Date() : null,
          ],
        );
      }
      const before = (
        await client.query(
          `SELECT * FROM "StoredObject" ORDER BY "displayName"`,
        )
      ).rows;
      await applyMigration(client, migration);
      const after = (
        await client.query(
          `SELECT * FROM "StoredObject" ORDER BY "displayName"`,
        )
      ).rows;
      expect(after).toEqual(
        before.map((row) => ({
          ...row,
          storageDeletedAt: null,
          cleanupAttempts: 0,
          cleanupNextAttemptAt: null,
          cleanupLastErrorCode: null,
        })),
      );
    });
  });
});

async function migrationNames(): Promise<readonly string[]> {
  return (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function applyMigration(client: Client, name: string): Promise<void> {
  const sql = await readFile(`${migrationsPath}/${name}/migration.sql`, 'utf8');
  if (!splitMigrations.has(name)) {
    await client.query(sql);
    return;
  }
  for (const statement of sql
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)) {
    await client.query(statement);
  }
}

async function withDatabase(
  suffix: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const name = `travel_audit_4_${suffix}_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${name}`;
    const target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    try {
      await run(target);
    } finally {
      await target.end();
    }
  } finally {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
}
