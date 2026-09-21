import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error(
    'TEST_DATABASE_URL is required for assistance migration tests',
  );
}

const migrationsPath = fileURLToPath(
  new URL('../../../prisma/migrations/', import.meta.url),
);
const migration = '20260926100000_p5_assistance_capability_lifecycle';
const statementByStatementMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('assistance capability lifecycle migration', () => {
  it('deploys every migration into a clean database', async () => {
    await withDatabase('clean', async (target) => {
      for (const name of await migrationNames())
        await applyMigration(target, name);
      expect(await tableCount(target, 'TripAssistanceCapability')).toBe(0);
      expect(await tableCount(target, 'FlightMonitoringCapability')).toBe(0);
      expect(await tableCount(target, 'TripAssistanceReceipt')).toBe(0);
      expect(await tableCount(target, 'FlightAssistanceReceipt')).toBe(0);
    });
  });

  it('preserves populated main data without inventing opt-in authorization', async () => {
    await withDatabase('populated', async (target) => {
      for (const name of (await migrationNames()).filter(
        (name) => name < migration,
      )) {
        await applyMigration(target, name);
      }
      await seedPopulatedMain(target);
      const before = await counts(target);

      await applyMigration(target, migration);

      expect(await counts(target)).toEqual(before);
      expect(await tableCount(target, 'TripAssistanceCapability')).toBe(0);
      expect(await tableCount(target, 'FlightMonitoringCapability')).toBe(0);
      expect(
        (
          await target.query(`
            SELECT "capabilityRevision"
            FROM "Job"
            WHERE "uniqueKey" = 'synthetic:legacy-monitor-job'
          `)
        ).rows[0],
      ).toEqual({ capabilityRevision: null });
      expect(
        (
          await target.query(`
            SELECT "version" FROM "Trip"
            WHERE "id" = '10000000-0000-4000-8000-000000000061'
          `)
        ).rows[0],
      ).toEqual({ version: 13 });
      expect(
        (
          await target.query(`
            SELECT "instant", "sourceKind" FROM "TemporalValue"
            WHERE "id" = '70000000-0000-4000-8000-000000000061'
          `)
        ).rows[0],
      ).toMatchObject({ sourceKind: 'EXECUTION_OBSERVATION' });
    });
  });
});

async function migrationNames(): Promise<readonly string[]> {
  return (await readdir(migrationsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function applyMigration(target: Client, name: string): Promise<void> {
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

async function withDatabase(
  suffix: string,
  run: (target: Client) => Promise<void>,
): Promise<void> {
  const databaseName = `travel_assistance_${suffix}_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${databaseName}`;
    const target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    try {
      await run(target);
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
}

async function seedPopulatedMain(client: Client): Promise<void> {
  const snapshot = JSON.stringify({
    provider: 'aerodatabox',
    candidateId: 'aerodatabox:assistance-migration',
    canonicalFlightNumber: 'NH53',
    displayFlightNumber: 'NH 53',
    serviceDate: '2030-01-02',
    status: 'SCHEDULED',
    fetchedAt: '2030-01-01T12:00:00.000Z',
    departure: {
      airportIata: 'HND',
      scheduledUtc: '2030-01-02T12:00:00.000Z',
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
      ('00000000-0000-4000-8000-000000000061', 'synthetic-assistance-migration@synthetic.example.test', 'synthetic-assistance-migration@synthetic.example.test', CURRENT_TIMESTAMP);
    INSERT INTO "Trip" ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount", "version", "updatedAt") VALUES
      ('10000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000061', 'SYNTHETIC ASSISTANCE', DATE '2030-01-02', 1, 13, CURRENT_TIMESTAMP);
    INSERT INTO "DayOccurrence" ("id", "tripId", "localDate", "sequence", "updatedAt") VALUES
      ('20000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', DATE '2030-01-02', 0, CURRENT_TIMESTAMP);
    INSERT INTO "Place" ("id", "ownerUserId", "name", "latitude", "longitude") VALUES
      ('30000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000061', 'HND', 35, 139),
      ('30000000-0000-4000-8000-000000000062', '00000000-0000-4000-8000-000000000061', 'CTS', 43, 141);
    INSERT INTO "ItineraryNode" ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId", "updatedAt") VALUES
      ('40000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '20000000-0000-4000-8000-000000000061', 'PLACE_VISIT', 0, '30000000-0000-4000-8000-000000000061', CURRENT_TIMESTAMP),
      ('40000000-0000-4000-8000-000000000062', '10000000-0000-4000-8000-000000000061', '20000000-0000-4000-8000-000000000061', 'PLACE_VISIT', 1, '30000000-0000-4000-8000-000000000062', CURRENT_TIMESTAMP);
    INSERT INTO "TransportEdge" ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService", "serviceLabel", "source", "provider", "providerRef", "updatedAt") VALUES
      ('50000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000062', 'FLIGHT', true, 'NH 53', 'MANUAL', 'aerodatabox', 'aerodatabox:assistance-migration', CURRENT_TIMESTAMP);
    INSERT INTO "TemporalValue" ("id", "nodeId", "layer", "pointKind", "instant", "timeZone", "sourceKind", "sourceRef", "observedAt", "updatedAt") VALUES
      ('70000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000061', 'ACTUAL', 'ARRIVAL', '2030-01-02T10:00:00Z', 'Asia/Tokyo', 'EXECUTION_OBSERVATION', 'execution:synthetic', '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
  `);
  await client.query(
    `INSERT INTO "FlightBinding" ("id", "ownerUserId", "tripId", "transportEdgeId", "provider", "providerFlightRef", "canonicalFlightNumber", "displayFlightNumber", "serviceDate", "selectedSnapshot", "latestSnapshot", "status", "lastRefreshedAt", "updatedAt") VALUES
      ('60000000-0000-4000-8000-000000000061', '00000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000061', 'aerodatabox', 'aerodatabox:assistance-migration', 'NH53', 'NH 53', DATE '2030-01-02', $1::jsonb, $1::jsonb, 'SCHEDULED', '2030-01-01T12:00:00Z', CURRENT_TIMESTAMP)`,
    [snapshot],
  );
  await client.query(`
    INSERT INTO "FlightMonitorState" ("flightBindingId", "mode", "updatedAt") VALUES
      ('60000000-0000-4000-8000-000000000061', 'NORMAL', CURRENT_TIMESTAMP);
    INSERT INTO "Job" ("id", "type", "runAt", "maxAttempts", "uniqueKey", "payloadRef", "updatedAt") VALUES
      ('80000000-0000-4000-8000-000000000061', 'FLIGHT_MONITOR', '2030-01-01T13:00:00Z', 5, 'synthetic:legacy-monitor-job', '60000000-0000-4000-8000-000000000061', CURRENT_TIMESTAMP);
  `);
}

async function tableCount(client: Client, table: string): Promise<number> {
  return (await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`))
    .rows[0].count as number;
}

async function counts(client: Client) {
  return (
    await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "Trip") AS trips,
        (SELECT COUNT(*)::int FROM "ItineraryNode") AS nodes,
        (SELECT COUNT(*)::int FROM "TemporalValue") AS temporal_values,
        (SELECT COUNT(*)::int FROM "FlightBinding") AS flight_bindings,
        (SELECT COUNT(*)::int FROM "FlightMonitorState") AS monitor_states,
        (SELECT COUNT(*)::int FROM "Job") AS jobs
    `)
  ).rows[0];
}
