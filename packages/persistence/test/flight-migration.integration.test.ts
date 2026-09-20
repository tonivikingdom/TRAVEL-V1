import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P5D2 migration tests');
}

const migrationsPath = fileURLToPath(
  new URL('../../../prisma/migrations/', import.meta.url),
);
const flightMigration = '20260922130000_p5d2_flight_binding';

describe('P5D2 FlightBinding migration', () => {
  it('migrates a populated P5D1 database without changing existing facts or inventing bindings', async () => {
    const databaseName = `travel_p5d2_${randomUUID().replaceAll('-', '')}`;
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
          .filter((name) => name < flightMigration)
          .sort();
        for (const name of migrationNames) {
          await target.query(
            await readFile(`${migrationsPath}/${name}/migration.sql`, 'utf8'),
          );
        }
        await seedPopulatedP5d1(target);
        const before = await counts(target);
        await target.query(
          await readFile(
            `${migrationsPath}/${flightMigration}/migration.sql`,
            'utf8',
          ),
        );
        expect(await counts(target)).toEqual(before);
        expect(
          (
            await target.query(
              `SELECT COUNT(*)::int AS count FROM "FlightBinding"`,
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        expect(
          await target.query(
            `SELECT '"FlightBinding"'::regclass::text AS table_name`,
          ),
        ).toMatchObject({ rows: [{ table_name: '"FlightBinding"' }] });
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

async function seedPopulatedP5d1(client: Client) {
  await client.query(`
    INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt") VALUES
      ('00000000-0000-4000-8000-000000000001', 'synthetic-p5d2-migration@synthetic.example.test', 'synthetic-p5d2-migration@synthetic.example.test', CURRENT_TIMESTAMP);
    INSERT INTO "Trip" ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount", "version", "updatedAt") VALUES
      ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'SYNTHETIC P5D1', DATE '2030-01-01', 1, 7, CURRENT_TIMESTAMP);
    INSERT INTO "DayOccurrence" ("id", "tripId", "localDate", "sequence", "updatedAt") VALUES
      ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', DATE '2030-01-01', 0, CURRENT_TIMESTAMP);
    INSERT INTO "Place" ("id", "ownerUserId", "name", "latitude", "longitude") VALUES
      ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Origin', 35, 139),
      ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Destination', 36, 140);
    INSERT INTO "ItineraryNode" ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId", "updatedAt") VALUES
      ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'PLACE_VISIT', 0, '30000000-0000-4000-8000-000000000001', CURRENT_TIMESTAMP),
      ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'PLACE_VISIT', 1, '30000000-0000-4000-8000-000000000002', CURRENT_TIMESTAMP);
    INSERT INTO "TransportEdge" ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService", "source", "updatedAt") VALUES
      ('50000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'FLIGHT', true, 'MANUAL', CURRENT_TIMESTAMP);
    INSERT INTO "TemporalValue" ("id", "transportEdgeId", "layer", "pointKind", "instant", "timeZone", "sourceKind", "updatedAt") VALUES
      ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'ACTUAL', 'DEPARTURE', '2030-01-01T09:00:00Z', 'UTC', 'PROVIDER_OBSERVATION', CURRENT_TIMESTAMP);
    INSERT INTO "DateOwnership" ("ownerUserId", "localDate", "tripId") VALUES
      ('00000000-0000-4000-8000-000000000001', DATE '2030-01-01', '10000000-0000-4000-8000-000000000001');
  `);
}

async function counts(client: Client) {
  return (
    await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "Trip") AS trips,
        (SELECT COUNT(*)::int FROM "DayOccurrence") AS occurrences,
        (SELECT COUNT(*)::int FROM "ItineraryNode") AS nodes,
        (SELECT COUNT(*)::int FROM "TransportEdge") AS transports,
        (SELECT COUNT(*)::int FROM "TemporalValue") AS temporal_values,
        (SELECT COUNT(*)::int FROM "DateOwnership") AS ownerships,
        (SELECT version FROM "Trip" LIMIT 1) AS trip_version
    `)
  ).rows[0];
}
