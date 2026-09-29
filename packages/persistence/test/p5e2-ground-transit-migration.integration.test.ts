import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('TEST_DATABASE_URL is required for P5E2 migration tests');
const migrationsPath = fileURLToPath(
  new URL('../../../prisma/migrations/', import.meta.url),
);
const migration = '20260929100000_p5e2_ground_transit_execution_foundation';
const splitMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P5E2 ground transit migration', () => {
  it('deploys the complete chain into a clean database', async () => {
    await withDatabase('clean', async (client) => {
      for (const name of await migrationNames())
        await applyMigration(client, name);
      expect(await count(client, 'GroundTransitLegExecution')).toBe(0);
      expect(await count(client, 'GroundTransitObservation')).toBe(0);
      expect(await count(client, 'GroundTransitStateTransition')).toBe(0);
    });
  });

  it('preserves populated main facts, capability opt-in, and pre-P5E2 jobs without backfill', async () => {
    await withDatabase('populated', async (client) => {
      for (const name of (await migrationNames()).filter(
        (name) => name < migration,
      )) {
        await applyMigration(client, name);
      }
      await client.query(`
        INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt") VALUES
          ('00000000-0000-4000-8000-000000000072', 'synthetic-p5e2-migration@synthetic.example.test', 'synthetic-p5e2-migration@synthetic.example.test', CURRENT_TIMESTAMP);
        INSERT INTO "Trip" ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount", "version", "updatedAt") VALUES
          ('10000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000072', 'SYNTHETIC P5E2 migration', DATE '2030-01-02', 1, 17, CURRENT_TIMESTAMP);
        INSERT INTO "DayOccurrence" ("id", "tripId", "localDate", "sequence", "updatedAt") VALUES
          ('20000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000072', DATE '2030-01-02', 0, CURRENT_TIMESTAMP);
        INSERT INTO "Place" ("id", "ownerUserId", "name", "latitude", "longitude") VALUES
          ('30000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000072', 'SYNTHETIC stop', 35, 139);
        INSERT INTO "ItineraryNode" ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId", "updatedAt") VALUES
          ('40000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000072', '20000000-0000-4000-8000-000000000072', 'PLACE_VISIT', 0, '30000000-0000-4000-8000-000000000072', CURRENT_TIMESTAMP);
        INSERT INTO "TemporalValue" ("id", "nodeId", "layer", "pointKind", "instant", "timeZone", "sourceKind", "sourceRef", "observedAt", "updatedAt") VALUES
          ('60000000-0000-4000-8000-000000000072', '40000000-0000-4000-8000-000000000072', 'ACTUAL', 'ARRIVAL', '2030-01-02T10:00:00Z', 'Asia/Tokyo', 'EXECUTION_OBSERVATION', 'execution:synthetic', '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
        INSERT INTO "TripAssistanceCapability" ("id", "ownerUserId", "tripId", "kind", "state", "revision", "enabledAt", "updatedAt") VALUES
          ('b0000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000072', '10000000-0000-4000-8000-000000000072', 'LOCATION_ASSISTANCE', 'ENABLED', 2, '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
        INSERT INTO "Job" ("id", "type", "runAt", "maxAttempts", "uniqueKey", "payloadRef", "updatedAt") VALUES
          ('d0000000-0000-4000-8000-000000000072', 'FLIGHT_MONITOR', '2030-01-02T11:00:00Z', 5, 'synthetic:p5e2-migration', '10000000-0000-4000-8000-000000000072', CURRENT_TIMESTAMP);
      `);
      await applyMigration(client, migration);
      const trip = await client.query(
        `SELECT "version" FROM "Trip" WHERE "id"='10000000-0000-4000-8000-000000000072'`,
      );
      expect(trip.rows[0].version).toBe(17);
      expect(await count(client, 'DayOccurrence')).toBe(1);
      expect(await count(client, 'ItineraryNode')).toBe(1);
      expect(await count(client, 'TemporalValue')).toBe(1);
      expect(await count(client, 'Job')).toBe(1);
      expect(await count(client, 'TripAssistanceCapability')).toBe(1);
      expect(await count(client, 'GroundTransitLegExecution')).toBe(0);
      expect(await count(client, 'GroundTransitObservation')).toBe(0);
      const facts = await client.query(
        `SELECT "layer", "instant" FROM "TemporalValue"`,
      );
      expect(facts.rows[0]).toMatchObject({
        layer: 'ACTUAL',
        instant: new Date('2030-01-02T10:00:00Z'),
      });
      const capabilities = await client.query(
        `SELECT "kind", "revision" FROM "TripAssistanceCapability"`,
      );
      expect(capabilities.rows).toEqual([
        { kind: 'LOCATION_ASSISTANCE', revision: 2 },
      ]);
    });
  });
});

async function migrationNames() {
  return (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function applyMigration(client: Client, name: string) {
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
) {
  const name = `travel_p5e2_${suffix}_${randomUUID().replaceAll('-', '')}`;
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

async function count(client: Client, table: string) {
  return (await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`))
    .rows[0].count as number;
}
