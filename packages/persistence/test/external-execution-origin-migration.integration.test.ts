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
const migration = '20260930130000_p5e2_external_execution_origin';
const splitMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P5E2 5A external execution origin migration', () => {
  it('applies exactly 21 migrations on clean PostgreSQL 17', async () => {
    await withDatabase('external_clean', async (client) => {
      const names = await migrationNames();
      expect(names).toHaveLength(21);
      for (const name of names) await applyMigration(client, name);
      expect(await count(client, 'ExternalExecutionOrigin')).toBe(0);
      expect(await count(client, 'ExternalExecutionOriginReceipt')).toBe(0);
      const foreignKeys =
        await client.query(`SELECT confrelid::regclass::text AS target, confdeltype AS deletion
        FROM pg_constraint WHERE contype='f' AND conrelid='"ExternalExecutionOrigin"'::regclass`);
      expect(foreignKeys.rows).toHaveLength(2);
      expect(
        foreignKeys.rows.every(
          (row) =>
            ['"User"', '"Trip"'].includes(row.target) && row.deletion === 'c',
        ),
      ).toBe(true);
    });
  });
  it('preserves populated baseline route/receipts, user execution and ground observation history', async () => {
    await withDatabase('external_populated', async (client) => {
      const beforeNames = (await migrationNames()).filter(
        (name) => name < migration,
      );
      expect(beforeNames).toHaveLength(20);
      for (const name of beforeNames) await applyMigration(client, name);
      await seedP4b2Data(client);
      await client.query(`
        INSERT INTO "ExecutionEvent" ("id","ownerUserId","tripId","nodeId","type","source","occurredAt") VALUES
        ('a0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','ARRIVAL','MANUAL','2030-01-01T00:00:00Z');
        INSERT INTO "TemporalValue" ("id","nodeId","layer","pointKind","instant","timeZone","sourceKind","sourceRef","updatedAt") VALUES
        ('a1000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','ACTUAL','ARRIVAL','2030-01-01T00:00:00Z','UTC','USER_VALUE','execution-event:a0000000-0000-4000-8000-000000000001',CURRENT_TIMESTAMP);
        INSERT INTO "TripAssistanceCapability" ("id","ownerUserId","tripId","kind","state","revision","enabledAt","updatedAt") VALUES
        ('b0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','GROUND_TRANSIT_MONITORING','ENABLED',2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO "GroundTransitLegExecution" ("id","tripId","adoptedRouteId","transportEdgeId","legIndex","provider","mode","serviceClass","baseline","latestFetchedAt","latestObservationId","latestObservationHash","latestObservation","updatedAt") VALUES
        ('c0000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',0,'SYNTHETIC','RAIL','FIXED_SERVICE','{"fixture":"SYNTHETIC baseline history"}','2030-01-01T00:00:00Z','SYNTHETIC:accepted','${'d'.repeat(64)}','{"fixture":"SYNTHETIC observation"}',CURRENT_TIMESTAMP);
        INSERT INTO "GroundTransitObservation" ("id","legExecutionId","observationIdentity","fetchedAt","factsHash","facts") VALUES
        ('d0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','SYNTHETIC:accepted','2030-01-01T00:00:00Z','${'d'.repeat(64)}','{"fixture":"SYNTHETIC observation"}');
        INSERT INTO "GroundTransitStateTransition" ("id","legExecutionId","fromState","toState","source","evidenceRef","occurredAt") VALUES
        ('e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','PENDING','IN_PROGRESS','DERIVED_LOCATION','SYNTHETIC:evidence','2030-01-01T00:00:00Z');
      `);
      const tables = [
        'User',
        'Trip',
        'Place',
        'ItineraryNode',
        'DayOccurrence',
        'TransportEdge',
        'TemporalValue',
        'RouteCandidateSnapshot',
        'RoutePreview',
        'AdoptedRoute',
        'OperationReceipt',
        'OutboxEvent',
        'ExecutionEvent',
        'TripAssistanceCapability',
        'GroundTransitLegExecution',
        'GroundTransitObservation',
        'GroundTransitStateTransition',
      ];
      const snapshot = async () =>
        Promise.all(
          tables.map(
            async (table) =>
              (
                await client.query(
                  `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM "${table}" t`,
                )
              ).rows[0],
          ),
        );
      const before = await snapshot();
      await applyMigration(client, migration);
      expect(await snapshot()).toEqual(before);
      expect(await count(client, 'ExternalExecutionOrigin')).toBe(0);
      expect(await count(client, 'ExternalExecutionOriginReceipt')).toBe(0);
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

async function seedP4b2Data(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "User" ("id", "email", "normalizedEmail", "updatedAt")
    VALUES ('00000000-0000-4000-8000-000000000001',
            'p4b3@synthetic.example.test',
            'p4b3@synthetic.example.test', CURRENT_TIMESTAMP);

    INSERT INTO "Trip"
      ("id", "ownerUserId", "name", "planningAnchorDate",
       "defaultPeopleCount", "version", "effectiveStartDate",
       "effectiveEndDate", "updatedAt")
    VALUES ('10000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001',
            'SYNTHETIC P4B2 populated', '2030-01-01', 1, 4,
            '2030-01-01', '2030-01-01', CURRENT_TIMESTAMP);

    INSERT INTO "DateOwnership" ("ownerUserId", "localDate", "tripId")
    VALUES ('00000000-0000-4000-8000-000000000001', '2030-01-01',
            '10000000-0000-4000-8000-000000000001');

    INSERT INTO "DayOccurrence"
      ("id", "tripId", "localDate", "sequence", "updatedAt")
    VALUES ('20000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001', '2030-01-01', 0,
            CURRENT_TIMESTAMP);

    INSERT INTO "Place" ("id", "ownerUserId", "name", "latitude", "longitude")
    VALUES
      ('40000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000001', 'From', 35, 139),
      ('40000000-0000-4000-8000-000000000002',
       '00000000-0000-4000-8000-000000000001', 'To', 36, 140);

    INSERT INTO "ItineraryNode"
      ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId", "updatedAt")
    VALUES
      ('30000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001', 'PLACE_VISIT', 0,
       '40000000-0000-4000-8000-000000000001', CURRENT_TIMESTAMP),
      ('30000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001', 'PLACE_VISIT', 1,
       '40000000-0000-4000-8000-000000000002', CURRENT_TIMESTAMP);

    INSERT INTO "RouteCandidateSnapshot"
      ("id", "ownerUserId", "tripId", "basisVersion", "fromNodeId",
       "toNodeId", "provider", "observedAt", "candidatePayload",
       "candidateHash", "queryTimeCondition", "createdAt", "expiresAt")
    VALUES ('60000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001', 3,
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002', 'SYNTHETIC',
            '2030-01-01T00:00:00Z', '{"candidateId":"candidate-1"}'::jsonb,
            '${'a'.repeat(64)}', '{}'::jsonb,
            '2030-01-01T00:00:00Z', '2030-01-01T00:15:00Z');

    INSERT INTO "RoutePreview"
      ("id", "ownerUserId", "tripId", "basisVersion", "candidateSnapshotId",
       "candidateHash", "policyVersion", "previewPayload", "previewHash",
       "createdAt", "expiresAt")
    VALUES ('70000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001', 3,
            '60000000-0000-4000-8000-000000000001', '${'a'.repeat(64)}',
            'route-adoption-preview-v2', '{}'::jsonb, '${'b'.repeat(64)}',
            '2030-01-01T00:00:00Z', '2030-01-01T00:10:00Z');

    INSERT INTO "AdoptedRoute"
      ("id", "tripId", "anchorFromNodeId", "anchorToNodeId",
       "sourcePreviewId", "candidateSnapshotId", "candidateHash",
       "policyVersion", "status", "createdAt")
    VALUES ('75000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002',
            '70000000-0000-4000-8000-000000000001',
            '60000000-0000-4000-8000-000000000001', '${'a'.repeat(64)}',
            'route-adoption-preview-v2', 'ACTIVE', '2030-01-01T00:00:00Z');

    INSERT INTO "TransportEdge"
      ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService",
       "source", "adoptedRouteId", "provider", "updatedAt")
    VALUES ('50000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002', 'RAIL', TRUE,
            'ADOPTED_ROUTE', '75000000-0000-4000-8000-000000000001',
            'SYNTHETIC', CURRENT_TIMESTAMP);

    INSERT INTO "TemporalValue"
      ("id", "transportEdgeId", "layer", "pointKind", "instant", "timeZone",
       "sourceKind", "updatedAt")
    VALUES ('55000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000001', 'PLANNED', 'DEPARTURE',
            '2030-01-01T00:00:00Z', 'UTC', 'ADOPTED_TRANSPORT_FACT',
            CURRENT_TIMESTAMP);

    INSERT INTO "OperationReceipt"
      ("id", "ownerUserId", "tripId", "operationType", "idempotencyKey",
       "requestHash", "baseTripVersion", "resultingTripVersion", "previewId",
       "adoptedRouteId", "delta", "createdAt")
    VALUES ('80000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001', 'ROUTE_ADOPT',
            'synthetic-legacy-adopt', '${'c'.repeat(64)}', 3, 4,
            '70000000-0000-4000-8000-000000000001',
            '75000000-0000-4000-8000-000000000001',
            '{"schemaVersion":"route-adopt-delta-v1"}'::jsonb,
            '2030-01-01T00:00:00Z');

    INSERT INTO "OutboxEvent"
      ("id", "type", "aggregateType", "aggregateId", "tripId",
       "operationReceiptId", "payload", "createdAt")
    VALUES ('90000000-0000-4000-8000-000000000001', 'ROUTE_ADOPTED',
            'AdoptedRoute', '75000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '80000000-0000-4000-8000-000000000001', '{}'::jsonb,
            '2030-01-01T00:00:00Z');
  `);
}
