import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P5D3 migration tests');
}

const migrationsPath = fileURLToPath(
  new URL('../../../prisma/migrations/', import.meta.url),
);
const migration = '20260923100000_p5d3_flight_monitoring';
const statementByStatementMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P5D3 flight monitoring migration', () => {
  it('preserves populated P5D2 facts without inventing monitor state or notifications', async () => {
    const databaseName = `travel_p5d3_${randomUUID().replaceAll('-', '')}`;
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const targetUrl = new URL(databaseUrl);
      targetUrl.pathname = `/${databaseName}`;
      const target = new Client({ connectionString: targetUrl.toString() });
      await target.connect();
      try {
        const migrationNames = (await readdir(migrationsPath))
          .filter((name) => name < migration)
          .sort();
        for (const name of migrationNames) await applyMigration(target, name);
        await seedPopulatedP5d2(target);
        const before = await counts(target);
        await target.query(
          await readFile(
            `${migrationsPath}/${migration}/migration.sql`,
            'utf8',
          ),
        );
        expect(await counts(target)).toEqual(before);
        expect(
          (
            await target.query(
              `SELECT COUNT(*)::int AS count FROM "FlightMonitorState"`,
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        expect(
          (
            await target.query(`
              SELECT "priority", "changeKinds", "hasDownstreamImpact"
              FROM "NotificationEvent"
              LIMIT 1
            `)
          ).rows[0],
        ).toEqual({
          priority: 'NORMAL',
          changeKinds: [],
          hasDownstreamImpact: false,
        });
      } finally {
        await target.end();
      }
    } finally {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  });
});

async function applyMigration(target: Client, name: string) {
  const sql = await readFile(`${migrationsPath}/${name}/migration.sql`, 'utf8');
  if (!statementByStatementMigrations.has(name)) {
    await target.query(sql);
    return;
  }
  for (const statement of sql
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value !== '')) {
    await target.query(statement);
  }
}

async function seedPopulatedP5d2(client: Client) {
  const snapshot = JSON.stringify({
    provider: 'aerodatabox',
    candidateId: 'aerodatabox:migration-nh53',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2030-01-02',
    status: 'SCHEDULED',
    fetchedAt: '2030-01-01T12:00:00.000Z',
    departure: {
      scheduledUtc: '2030-01-02T12:00:00.000Z',
      timeZone: 'UTC',
    },
    arrival: {
      scheduledUtc: '2030-01-02T14:00:00.000Z',
      timeZone: 'UTC',
    },
  });
  await client.query(`
      INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt") VALUES
        ('00000000-0000-4000-8000-000000000031', 'synthetic-p5d3-migration@synthetic.example.test', 'synthetic-p5d3-migration@synthetic.example.test', CURRENT_TIMESTAMP);
      INSERT INTO "Trip" ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount", "version", "updatedAt") VALUES
        ('10000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', 'SYNTHETIC P5D2', DATE '2030-01-02', 1, 9, CURRENT_TIMESTAMP);
      INSERT INTO "DayOccurrence" ("id", "tripId", "localDate", "sequence", "updatedAt") VALUES
        ('20000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', DATE '2030-01-02', 0, CURRENT_TIMESTAMP);
      INSERT INTO "Place" ("id", "ownerUserId", "name", "latitude", "longitude") VALUES
        ('30000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', 'HND', 35, 139),
        ('30000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000031', 'CTS', 43, 141);
      INSERT INTO "ItineraryNode" ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId", "updatedAt") VALUES
        ('40000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '20000000-0000-4000-8000-000000000031', 'PLACE_VISIT', 0, '30000000-0000-4000-8000-000000000031', CURRENT_TIMESTAMP),
        ('40000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000031', '20000000-0000-4000-8000-000000000031', 'PLACE_VISIT', 1, '30000000-0000-4000-8000-000000000032', CURRENT_TIMESTAMP);
      INSERT INTO "TransportEdge" ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService", "serviceLabel", "source", "provider", "providerRef", "updatedAt") VALUES
        ('50000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000031', '40000000-0000-4000-8000-000000000032', 'FLIGHT', true, 'NH 53', 'MANUAL', 'aerodatabox', 'aerodatabox:migration-nh53', CURRENT_TIMESTAMP);
      INSERT INTO "NotificationEvent" ("id", "ownerUserId", "kind", "dedupeKey", "title", "body", "occurredAt") VALUES
        ('70000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', 'SYNTHETIC', 'p5d3-before', 'Before', 'Before migration', CURRENT_TIMESTAMP);
    `);
  await client.query(
    `INSERT INTO "FlightBinding" ("id", "ownerUserId", "tripId", "transportEdgeId", "provider", "providerFlightRef", "canonicalFlightNumber", "displayFlightNumber", "serviceDate", "selectedSnapshot", "latestSnapshot", "status", "lastRefreshedAt", "updatedAt") VALUES
      ('60000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000031', '50000000-0000-4000-8000-000000000031', 'aerodatabox', 'aerodatabox:migration-nh53', 'NH53', 'NH 53', DATE '2030-01-02', $1::jsonb, $1::jsonb, 'SCHEDULED', '2030-01-01T12:00:00Z', CURRENT_TIMESTAMP)`,
    [snapshot],
  );
}

async function counts(client: Client) {
  return (
    await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "Trip") AS trips,
        (SELECT COUNT(*)::int FROM "ItineraryNode") AS nodes,
        (SELECT COUNT(*)::int FROM "TransportEdge") AS transports,
        (SELECT COUNT(*)::int FROM "FlightBinding") AS bindings,
        (SELECT COUNT(*)::int FROM "NotificationEvent") AS notifications,
        (SELECT version FROM "Trip" LIMIT 1) AS trip_version
    `)
  ).rows[0];
}
