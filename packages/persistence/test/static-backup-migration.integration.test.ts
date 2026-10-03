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
const migration = '20261003100000_p6b2_static_backup';
const splitMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P6B-2 SYNTHETIC additive backup migration', () => {
  it('deploys 26 clean migrations and enforces owner-trip FK and idempotency', async () => {
    const names = await migrationNames();
    expect(names).toHaveLength(26);
    await withDatabase('clean', async (client) => {
      for (const name of names) await applyMigration(client, name);
      const owner = randomUUID(),
        stranger = randomUUID(),
        trip = randomUUID();
      for (const id of [owner, stranger])
        await client.query(
          `INSERT INTO "User" (id,email,"normalizedEmail","updatedAt") VALUES ($1,$2,$2,now())`,
          [id, `SYNTHETIC-${id}@synthetic.example.test`],
        );
      await client.query(
        `INSERT INTO "Trip" (id,"ownerUserId",name,"planningAnchorDate","defaultPeopleCount","updatedAt") VALUES ($1,$2,'SYNTHETIC','2031-10-01',1,now())`,
        [trip, owner],
      );
      const insert = `INSERT INTO "TripStaticBackup" (id,"ownerUserId","tripId","tripVersion","idempotencyKey",artifact) VALUES ($1,$2,$3,1,'SYNTHETIC-key','{}')`;
      await client.query(insert, [randomUUID(), owner, trip]);
      await expect(
        client.query(insert, [randomUUID(), owner, trip]),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        client.query(insert, [randomUUID(), stranger, trip]),
      ).rejects.toMatchObject({ code: '23503' });
      await client.query(`DELETE FROM "Trip" WHERE id=$1`, [trip]);
      expect(
        (await client.query(`SELECT * FROM "TripStaticBackup"`)).rows,
      ).toHaveLength(0);
    });
  });
  it('preserves populated 25-migration Trip/authoring/date/notes and all tables exactly during 25→26', async () => {
    await withDatabase('populated', async (client) => {
      const names = (await migrationNames()).filter((n) => n < migration);
      expect(names).toHaveLength(25);
      for (const name of names) await applyMigration(client, name);
      const owner = randomUUID(),
        trip = randomUUID(),
        day = randomUUID(),
        node = randomUUID();
      await client.query(
        `INSERT INTO "User" (id,email,"normalizedEmail","updatedAt") VALUES ($1,'SYNTHETIC@synthetic.example.test','SYNTHETIC@synthetic.example.test',now())`,
        [owner],
      );
      await client.query(
        `INSERT INTO "Trip" (id,"ownerUserId",name,"planningAnchorDate","defaultPeopleCount","updatedAt") VALUES ($1,$2,'SYNTHETIC','2031-10-01',1,now())`,
        [trip, owner],
      );
      await client.query(
        `INSERT INTO "DayOccurrence" (id,"tripId","localDate",sequence,"updatedAt") VALUES ($1,$2,'2031-10-01',0,now())`,
        [day, trip],
      );
      await client.query(
        `INSERT INTO "ItineraryNode" (id,"tripId",kind,"dayOccurrenceId",position,note,"updatedAt") VALUES ($1,$2,'FREE_ACTION',$3,0,'SYNTHETIC activity',now())`,
        [node, trip, day],
      );
      await client.query(
        `INSERT INTO "TripAuthoringReceipt" (id,"ownerUserId","tripId","idempotencyKey","requestHash","baseTripVersion","resultingTripVersion",result) VALUES ($1,$2,$3,'SYNTHETIC-key',$4,1,2,'{}')`,
        [randomUUID(), owner, trip, 'a'.repeat(64)],
      );
      const tables = (
        await client.query(
          `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
        )
      ).rows.map((r) => r.tablename as string);
      const before = await Promise.all(
        tables.map((t) => client.query(`SELECT * FROM "${t}"`)),
      );
      await applyMigration(client, migration);
      for (const [i, t] of tables.entries())
        expect((await client.query(`SELECT * FROM "${t}"`)).rows).toEqual(
          before[i]!.rows,
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
  const name = `travel_p6b2_${suffix}_${randomUUID().replaceAll('-', '')}`;
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
