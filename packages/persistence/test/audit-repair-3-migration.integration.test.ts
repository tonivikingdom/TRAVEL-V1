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
const migration = '20260928100000_p5_audit_repair_3';
const splitMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P5 audit repair 3 migration', () => {
  it('deploys the full migration chain into a clean database', async () => {
    await withDatabase('clean', async (client) => {
      for (const name of await migrationNames())
        await applyMigration(client, name);
      expect(await count(client, 'ExecutionEvent')).toBe(0);
      expect(await count(client, 'NotificationEvent')).toBe(0);
    });
  });

  it('preserves populated main facts and does not invent legacy evidence', async () => {
    await withDatabase('populated', async (client) => {
      for (const name of (await migrationNames()).filter(
        (name) => name < migration,
      )) {
        await applyMigration(client, name);
      }
      await client.query(`
        INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt") VALUES
          ('00000000-0000-4000-8000-000000000063', 'synthetic-audit-repair-3@synthetic.example.test', 'synthetic-audit-repair-3@synthetic.example.test', CURRENT_TIMESTAMP);
        INSERT INTO "Trip" ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount", "version", "updatedAt") VALUES
          ('10000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', 'SYNTHETIC audit repair migration', DATE '2030-01-02', 1, 17, CURRENT_TIMESTAMP);
        INSERT INTO "DayOccurrence" ("id", "tripId", "localDate", "sequence", "updatedAt") VALUES
          ('20000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', DATE '2030-01-02', 0, CURRENT_TIMESTAMP);
        INSERT INTO "Place" ("id", "ownerUserId", "name", "latitude", "longitude") VALUES
          ('30000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', 'SYNTHETIC place', 35, 139),
          ('30000000-0000-4000-8000-000000000064', '00000000-0000-4000-8000-000000000063', 'SYNTHETIC destination', 43, 141);
        INSERT INTO "ItineraryNode" ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId", "updatedAt") VALUES
          ('40000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', '20000000-0000-4000-8000-000000000063', 'PLACE_VISIT', 0, '30000000-0000-4000-8000-000000000063', CURRENT_TIMESTAMP),
          ('40000000-0000-4000-8000-000000000064', '10000000-0000-4000-8000-000000000063', '20000000-0000-4000-8000-000000000063', 'PLACE_VISIT', 1, '30000000-0000-4000-8000-000000000064', CURRENT_TIMESTAMP);
        INSERT INTO "TransportEdge" ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService", "source", "updatedAt") VALUES
          ('80000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', '40000000-0000-4000-8000-000000000063', '40000000-0000-4000-8000-000000000064', 'FLIGHT', true, 'MANUAL', CURRENT_TIMESTAMP);
        INSERT INTO "ExecutionEvent" ("id", "ownerUserId", "tripId", "nodeId", "type", "source", "occurredAt") VALUES
          ('50000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', '40000000-0000-4000-8000-000000000063', 'ARRIVAL', 'LOCATION', '2030-01-02T10:00:00Z');
        INSERT INTO "TemporalValue" ("id", "nodeId", "layer", "pointKind", "instant", "timeZone", "sourceKind", "sourceRef", "observedAt", "updatedAt") VALUES
          ('60000000-0000-4000-8000-000000000063', '40000000-0000-4000-8000-000000000063', 'ACTUAL', 'ARRIVAL', '2030-01-02T10:00:00Z', 'Asia/Tokyo', 'EXECUTION_OBSERVATION', 'execution:synthetic', '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
        INSERT INTO "NotificationEvent" ("id", "ownerUserId", "kind", "dedupeKey", "title", "body", "occurredAt") VALUES
          ('70000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', 'EXECUTION_RISK', 'synthetic:audit-repair-3', 'SYNTHETIC', 'SYNTHETIC notification', '2030-01-02T10:00:00Z');
        INSERT INTO "ExecutionRisk" ("id", "ownerUserId", "tripId", "fingerprint", "kind", "severity", "sourceTransportEdgeId", "firstSeenAt", "lastSeenAt", "evaluationBasisTripVersion", "lastEvidenceHash", "evidenceRefs", "updatedAt") VALUES
          ('90000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'PROTECTED_TIME_AT_RISK', 'EXECUTABLE_RISK', '80000000-0000-4000-8000-000000000063', '2030-01-02T10:00:00Z', '2030-01-02T10:00:00Z', 17, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '["transport:80000000-0000-4000-8000-000000000063"]', CURRENT_TIMESTAMP);
        INSERT INTO "FlightBinding" ("id", "ownerUserId", "tripId", "transportEdgeId", "provider", "providerFlightRef", "canonicalFlightNumber", "displayFlightNumber", "serviceDate", "selectedSnapshot", "latestSnapshot", "status", "lastRefreshedAt", "updatedAt") VALUES
          ('a0000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', '80000000-0000-4000-8000-000000000063', 'aerodatabox', 'synthetic:audit-repair-3', 'SY63', 'SY 63', DATE '2030-01-02', '{}', '{}', 'SCHEDULED', '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
        INSERT INTO "TripAssistanceCapability" ("id", "ownerUserId", "tripId", "kind", "state", "revision", "enabledAt", "updatedAt") VALUES
          ('b0000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', 'LOCATION_ASSISTANCE', 'ENABLED', 2, '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
        INSERT INTO "FlightMonitoringCapability" ("id", "ownerUserId", "tripId", "flightBindingId", "state", "revision", "enabledAt", "updatedAt") VALUES
          ('c0000000-0000-4000-8000-000000000063', '00000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', 'a0000000-0000-4000-8000-000000000063', 'ENABLED', 3, '2030-01-02T10:00:00Z', CURRENT_TIMESTAMP);
        INSERT INTO "Job" ("id", "type", "runAt", "maxAttempts", "uniqueKey", "payloadRef", "capabilityRevision", "updatedAt") VALUES
          ('d0000000-0000-4000-8000-000000000063', 'FLIGHT_MONITOR', '2030-01-02T11:00:00Z', 5, 'synthetic:audit-repair-3', 'a0000000-0000-4000-8000-000000000063', 3, CURRENT_TIMESTAMP);
      `);
      await client.query(
        `UPDATE "ExecutionEvent" SET "undoneAt"='2030-01-02T11:00:00Z' WHERE "id"='50000000-0000-4000-8000-000000000063'`,
      );
      await applyMigration(client, migration);
      const rows = await client.query(`
        SELECT t."version", e."source", e."undoneAt", e."evidenceReliability",
               e."evidencePolicyVersion", e."evidenceReasonCodes", v."layer", v."instant",
               n."presentationActive", n."presentationGroupKey"
        FROM "Trip" t
        JOIN "ExecutionEvent" e ON e."tripId"=t."id"
        JOIN "TemporalValue" v ON v."nodeId"=e."nodeId"
        JOIN "NotificationEvent" n ON n."ownerUserId"=t."ownerUserId"
      `);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        version: 17,
        source: 'LOCATION',
        evidenceReliability: null,
        evidencePolicyVersion: null,
        evidenceReasonCodes: null,
        layer: 'ACTUAL',
        presentationActive: true,
        presentationGroupKey: null,
      });
      expect(rows.rows[0].undoneAt).not.toBeNull();
      expect(rows.rows[0].instant).toEqual(new Date('2030-01-02T10:00:00Z'));
      expect(await count(client, 'ExecutionEvent')).toBe(1);
      expect(await count(client, 'NotificationEvent')).toBe(1);
      expect(await count(client, 'ExecutionRisk')).toBe(1);
      expect(await count(client, 'FlightBinding')).toBe(1);
      expect(await count(client, 'Job')).toBe(1);
      expect(await count(client, 'TripAssistanceCapability')).toBe(1);
      expect(await count(client, 'FlightMonitoringCapability')).toBe(1);
      await expect(
        client.query(`
        INSERT INTO "ExecutionEvent" ("ownerUserId", "tripId", "nodeId", "type", "source", "occurredAt", "evidenceReliability", "evidencePolicyVersion", "evidenceReasonCodes", "evidenceCompetingNodeIds") VALUES
          ('00000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000063', '40000000-0000-4000-8000-000000000063', 'ARRIVAL', 'LOCATION', '2030-01-02T12:00:00Z', 'WEAK', 'execution-location-v2', '["MULTIPLE_CANDIDATES"]', '[]');
      `),
      ).rejects.toThrow();
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
  const name = `travel_audit_3_${suffix}_${randomUUID().replaceAll('-', '')}`;
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

async function count(client: Client, table: string): Promise<number> {
  return (await client.query(`SELECT COUNT(*)::int AS count FROM "${table}"`))
    .rows[0].count as number;
}
