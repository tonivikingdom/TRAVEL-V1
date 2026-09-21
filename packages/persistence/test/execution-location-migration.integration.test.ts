import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for P5E1 migration tests');
}

const migrationsPath = fileURLToPath(
  new URL('../../../prisma/migrations/', import.meta.url),
);
const migration = '20260924100000_p5e1_execution_location';
const statementByStatementMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P5E1 execution-location migration', () => {
  it('preserves populated P5D3 facts without inventing execution observations', async () => {
    const databaseName = `travel_p5e1_${randomUUID().replaceAll('-', '')}`;
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
        await seedPopulatedP5d3(target);
        const before = await counts(target);
        await target.query(
          await readFile(
            `${migrationsPath}/${migration}/migration.sql`,
            'utf8',
          ),
        );
        expect(await counts(target)).toEqual(before);
        for (const table of [
          'ExecutionEvent',
          'ExecutionLocationState',
          'NodeExecutionState',
        ]) {
          expect(
            (
              await target.query(
                `SELECT COUNT(*)::int AS count FROM "${table}"`,
              )
            ).rows[0],
          ).toEqual({ count: 0 });
        }
        expect(
          (
            await target.query(`
              SELECT "version" FROM "Trip"
              WHERE "id" = '10000000-0000-4000-8000-000000000041'
            `)
          ).rows[0],
        ).toEqual({ version: 11 });
        expect(
          (
            await target.query(`
              SELECT "instant", "sourceKind"
              FROM "TemporalValue"
              WHERE "id" = '70000000-0000-4000-8000-000000000041'
            `)
          ).rows[0],
        ).toMatchObject({ sourceKind: 'PROVIDER_OBSERVATION' });
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

async function seedPopulatedP5d3(client: Client) {
  const snapshot = JSON.stringify({
    provider: 'aerodatabox',
    candidateId: 'aerodatabox:p5e1-migration',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2030-01-02',
    status: 'DELAYED',
    fetchedAt: '2030-01-01T12:00:00.000Z',
    departure: {
      airportIata: 'HND',
      scheduledUtc: '2030-01-02T12:00:00.000Z',
      revisedUtc: '2030-01-02T12:20:00.000Z',
      timeZone: 'Asia/Tokyo',
    },
    arrival: {
      airportIata: 'CTS',
      scheduledUtc: '2030-01-02T14:00:00.000Z',
      timeZone: 'Asia/Tokyo',
    },
  });
  await client.query(`
    INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt") VALUES
      ('00000000-0000-4000-8000-000000000041', 'synthetic-p5e1-migration@synthetic.example.test', 'synthetic-p5e1-migration@synthetic.example.test', CURRENT_TIMESTAMP);
    INSERT INTO "Trip" ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount", "version", "updatedAt") VALUES
      ('10000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000041', 'SYNTHETIC P5D3', DATE '2030-01-02', 1, 11, CURRENT_TIMESTAMP);
    INSERT INTO "DayOccurrence" ("id", "tripId", "localDate", "sequence", "updatedAt") VALUES
      ('20000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', DATE '2030-01-02', 0, CURRENT_TIMESTAMP);
    INSERT INTO "Place" ("id", "ownerUserId", "name", "latitude", "longitude") VALUES
      ('30000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000041', 'HND', 35, 139),
      ('30000000-0000-4000-8000-000000000042', '00000000-0000-4000-8000-000000000041', 'CTS', 43, 141);
    INSERT INTO "ItineraryNode" ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId", "updatedAt") VALUES
      ('40000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '20000000-0000-4000-8000-000000000041', 'PLACE_VISIT', 0, '30000000-0000-4000-8000-000000000041', CURRENT_TIMESTAMP),
      ('40000000-0000-4000-8000-000000000042', '10000000-0000-4000-8000-000000000041', '20000000-0000-4000-8000-000000000041', 'PLACE_VISIT', 1, '30000000-0000-4000-8000-000000000042', CURRENT_TIMESTAMP);
    INSERT INTO "TransportEdge" ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService", "serviceLabel", "source", "provider", "providerRef", "updatedAt") VALUES
      ('50000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '40000000-0000-4000-8000-000000000041', '40000000-0000-4000-8000-000000000042', 'FLIGHT', true, 'NH 53', 'MANUAL', 'aerodatabox', 'aerodatabox:p5e1-migration', CURRENT_TIMESTAMP);
    INSERT INTO "TemporalValue" ("id", "nodeId", "layer", "pointKind", "instant", "timeZone", "sourceKind", "sourceRef", "observedAt", "updatedAt") VALUES
      ('70000000-0000-4000-8000-000000000041', '40000000-0000-4000-8000-000000000041', 'ACTUAL', 'ARRIVAL', '2030-01-02T10:00:00Z', 'Asia/Tokyo', 'PROVIDER_OBSERVATION', 'flight:p5d3', '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
  `);
  await client.query(
    `INSERT INTO "FlightBinding" ("id", "ownerUserId", "tripId", "transportEdgeId", "provider", "providerFlightRef", "canonicalFlightNumber", "displayFlightNumber", "serviceDate", "selectedSnapshot", "latestSnapshot", "status", "lastRefreshedAt", "updatedAt") VALUES
      ('60000000-0000-4000-8000-000000000041', '00000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000041', '50000000-0000-4000-8000-000000000041', 'aerodatabox', 'aerodatabox:p5e1-migration', 'NH53', 'NH 53', DATE '2030-01-02', $1::jsonb, $1::jsonb, 'DELAYED', '2030-01-01T12:00:00Z', CURRENT_TIMESTAMP)`,
    [snapshot],
  );
  await client.query(`
    INSERT INTO "FlightMonitorState" (
      "flightBindingId", "mode", "lastSuccessfulMonitorRefreshAt",
      "lastDecisionFetchedAt", "lastDecisionSnapshot", "updatedAt"
    ) VALUES (
      '60000000-0000-4000-8000-000000000041', 'DELAYED',
      '2030-01-01T12:00:00Z', '2030-01-01T12:00:00Z',
      '${snapshot.replaceAll("'", "''")}'::jsonb, CURRENT_TIMESTAMP
    )
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
        (SELECT COUNT(*)::int FROM "FlightBinding") AS flight_bindings,
        (SELECT COUNT(*)::int FROM "FlightMonitorState") AS monitor_states
    `)
  ).rows[0];
}
