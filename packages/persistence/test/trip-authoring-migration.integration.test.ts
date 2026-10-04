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
const migration = '20261003090000_p6a2_trip_authoring_receipts';
const splitMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P6A-2 additive authoring receipt migration', () => {
  it('applies 25 clean migrations with owner-scoped receipt uniqueness', async () => {
    const names = (await migrationNames()).filter((n) => n <= migration);
    expect(names).toHaveLength(25);
    await withDatabase('clean', async (client) => {
      for (const name of names) await applyMigration(client, name);
      const columns = (
        await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name='TripAuthoringReceipt'`,
        )
      ).rows;
      expect(columns.map((r) => r.column_name)).toEqual(
        expect.arrayContaining([
          'tripId',
          'ownerUserId',
          'requestHash',
          'result',
          'baseTripVersion',
          'resultingTripVersion',
        ]),
      );
      expect(
        (
          await client.query(
            `SELECT indexname FROM pg_indexes WHERE tablename='TripAuthoringReceipt'`,
          )
        ).rows.map((r) => r.indexname),
      ).toContain('TripAuthoringReceipt_ownerUserId_idempotencyKey_key');
    });
  });
  it('preserves populated 24-migration facts exactly and permits Trip deletion without receipt history FK cycles', async () => {
    await withDatabase('populated', async (client) => {
      const names = (await migrationNames()).filter((n) => n < migration);
      expect(names).toHaveLength(24);
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
      const tables = ['User', 'Trip', 'DayOccurrence', 'ItineraryNode'];
      const before = await Promise.all(
        tables.map((t) => client.query(`SELECT * FROM "${t}" ORDER BY id`)),
      );
      await applyMigration(client, migration);
      for (const [i, t] of tables.entries())
        expect(
          (await client.query(`SELECT * FROM "${t}" ORDER BY id`)).rows,
        ).toEqual(before[i]!.rows);
      await client.query(
        `INSERT INTO "TripAuthoringReceipt" (id,"ownerUserId","tripId","idempotencyKey","requestHash","baseTripVersion","resultingTripVersion",result) VALUES ($1,$2,$3,'SYNTHETIC-key',$4,1,2,'{}')`,
        [randomUUID(), owner, trip, 'a'.repeat(64)],
      );
      await expect(
        client.query(
          `INSERT INTO "TripAuthoringReceipt" (id,"ownerUserId","tripId","idempotencyKey","requestHash","baseTripVersion","resultingTripVersion",result) VALUES ($1,$2,$3,'SYNTHETIC-key',$4,1,2,'{}')`,
          [randomUUID(), owner, trip, 'a'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query(`DELETE FROM "Trip" WHERE id=$1`, [trip]);
      expect(
        (await client.query(`SELECT * FROM "TripAuthoringReceipt"`)).rows,
      ).toHaveLength(0);
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
  const name = `travel_p6a2_${suffix}_${randomUUID().replaceAll('-', '')}`;
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
