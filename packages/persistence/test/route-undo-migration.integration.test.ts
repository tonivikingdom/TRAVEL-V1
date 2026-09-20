import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('TEST_DATABASE_URL is required for migration tests');
}

const migrationsPath = fileURLToPath(
  new URL('../../../prisma/migrations/', import.meta.url),
);
const p4b2Migration = '20260920110000_p4b2_route_adoption';
const p4b3Migration = '20260920150000_p4b3_route_undo';
const p5cMigration = '20260921100000_p5c_planning_policy';

describe('P4B3 route Undo migration', () => {
  it('applies every migration to a clean database', async () => {
    await withDatabase('clean', async (target) => {
      await applyMigrations(target);
      const enums = await target.query<{ value: string }>(`
        SELECT enumlabel AS value
        FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname IN (
          'AdoptedRouteStatus', 'OperationType', 'OutboxEventType'
        )
      `);
      expect(enums.rows.map((row) => row.value)).toEqual(
        expect.arrayContaining(['UNDONE', 'ROUTE_UNDO', 'ROUTE_UNDONE']),
      );
      const index = await target.query<{ definition: string }>(`
        SELECT pg_get_indexdef(indexrelid) AS definition
        FROM pg_index
        WHERE indexrelid = '"AdoptedRoute_active_corridor_key"'::regclass
      `);
      expect(index.rows[0]?.definition).toContain(
        '"AdoptedRoute_active_corridor_key"',
      );
      expect(index.rows[0]?.definition).toContain('WHERE');
      expect(index.rows[0]?.definition).toContain("'ACTIVE'");
    });
  });

  it('preserves populated P4B2 facts and makes legacy receipts explicitly unavailable', async () => {
    await withDatabase('populated', async (target) => {
      await applyMigrations(target, p4b3Migration);
      await seedP4b2Data(target);
      const before = await officialCounts(target);

      await applyMigration(target, p4b3Migration);

      expect(await officialCounts(target)).toEqual(before);
      const receipt = await target.query<{
        targetOperationReceiptId: string | null;
        undoExpiresAt: Date | null;
        delta: { schemaVersion?: string };
      }>(`
        SELECT "targetOperationReceiptId", "undoExpiresAt", "delta"
        FROM "OperationReceipt"
        WHERE "id" = '80000000-0000-4000-8000-000000000001'
      `);
      expect(receipt.rows[0]).toEqual({
        targetOperationReceiptId: null,
        undoExpiresAt: null,
        delta: { schemaVersion: 'route-adopt-delta-v1' },
      });
      const route = await target.query<{
        status: string;
        undoneAt: Date | null;
      }>(`
        SELECT "status"::text AS status, "undoneAt"
        FROM "AdoptedRoute"
        WHERE "id" = '75000000-0000-4000-8000-000000000001'
      `);
      expect(route.rows[0]).toEqual({ status: 'ACTIVE', undoneAt: null });
      const columns = await target.query<{ columnName: string }>(`
        SELECT column_name AS "columnName"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'OperationReceipt'
          AND column_name IN ('targetOperationReceiptId', 'undoExpiresAt')
        ORDER BY column_name
      `);
      expect(columns.rows.map((row) => row.columnName)).toEqual([
        'targetOperationReceiptId',
        'undoExpiresAt',
      ]);
    });
  });

  it('migrates a populated P5B database without changing official facts', async () => {
    await withDatabase('p5c_populated', async (target) => {
      await applyMigrations(target, p5cMigration);
      await seedP4b2Data(target);
      await seedP5bExtendedData(target);
      const before = await officialCounts(target);

      await applyMigration(target, p5cMigration);

      expect(await officialCounts(target)).toEqual(before);
      expect(before).toMatchObject({
        intents: '1',
        temporalValues: '4',
        transportHistory: '1',
        ownership: '1',
      });
      expect(
        (
          await target.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM "SystemDwellSuggestion"',
          )
        ).rows[0]?.count,
      ).toBe('0');
      const preserved = await target.query<{
        version: number;
        durationSeconds: number;
        actualInstant: Date;
      }>(`
        SELECT t."version", i."durationSeconds",
          v."instant" AS "actualInstant"
        FROM "Trip" t
        JOIN "UserTimeIntent" i ON i."tripId" = t."id"
        JOIN "TemporalValue" v ON v."nodeId" = i."nodeId"
          AND v."layer" = 'ACTUAL' AND v."pointKind" = 'ARRIVAL'
        WHERE t."id" = '10000000-0000-4000-8000-000000000001'
      `);
      expect(preserved.rows[0]).toMatchObject({
        version: 4,
        durationSeconds: 2_400,
        actualInstant: new Date('2030-01-01T00:30:00.000Z'),
      });
      const table = await target.query<{ source: string; duration: number }>(`
        INSERT INTO "SystemDwellSuggestion"
          ("id", "tripId", "nodeId", "durationSeconds", "updatedAt")
        VALUES
          ('99000000-0000-4000-8000-000000000001',
           '10000000-0000-4000-8000-000000000001',
           '30000000-0000-4000-8000-000000000001', 3600,
           CURRENT_TIMESTAMP)
        RETURNING "source"::text AS source, "durationSeconds" AS duration
      `);
      expect(table.rows[0]).toEqual({
        source: 'SYSTEM_SUGGESTION',
        duration: 3600,
      });
      await expect(
        target.query(`
          INSERT INTO "SystemDwellSuggestion"
            ("id", "tripId", "nodeId", "durationSeconds", "updatedAt")
          VALUES
            ('99000000-0000-4000-8000-000000000002',
             '10000000-0000-4000-8000-000000000001',
             '30000000-0000-4000-8000-000000000002', 0,
             CURRENT_TIMESTAMP)
        `),
      ).rejects.toThrow();
    });
  });
});

async function withDatabase(
  suffix: string,
  run: (target: Client) => Promise<void>,
): Promise<void> {
  const databaseName = `travel_p4b3_${suffix}_${randomUUID().replaceAll('-', '')}`;
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

async function applyMigrations(
  target: Client,
  beforeMigration?: string,
): Promise<void> {
  const migrationNames = (await readdir(migrationsPath))
    .filter(
      (name) =>
        /^\d+_/u.test(name) &&
        (beforeMigration === undefined ||
          name.localeCompare(beforeMigration) < 0),
    )
    .sort();
  for (const migrationName of migrationNames) {
    await applyMigration(target, migrationName);
  }
}

async function applyMigration(
  target: Client,
  migrationName: string,
): Promise<void> {
  const sql = await readFile(
    `${migrationsPath}/${migrationName}/migration.sql`,
    'utf8',
  );
  if (migrationName !== p4b2Migration && migrationName !== p4b3Migration) {
    await target.query(sql);
    return;
  }
  // PostgreSQL requires a newly added enum value to commit before a later
  // statement can use it in a predicate or constraint. Prisma deploy applies
  // these migration statements without one all-enclosing transaction.
  for (const statement of sql
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value !== '')) {
    await target.query(statement);
  }
}

async function officialCounts(client: Client) {
  const result = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM "Trip") AS trips,
      (SELECT COUNT(*)::text FROM "DayOccurrence") AS occurrences,
      (SELECT COUNT(*)::text FROM "ItineraryNode") AS nodes,
      (SELECT COUNT(*)::text FROM "TransportEdge") AS transports,
      (SELECT COUNT(*)::text FROM "TemporalValue") AS "temporalValues",
      (SELECT COUNT(*)::text FROM "UserTimeIntent") AS intents,
      (SELECT COUNT(*)::text FROM "TransportEdgeHistory") AS "transportHistory",
      (SELECT COUNT(*)::text FROM "DateOwnership") AS ownership,
      (SELECT COUNT(*)::text FROM "RouteCandidateSnapshot") AS snapshots,
      (SELECT COUNT(*)::text FROM "RoutePreview") AS previews,
      (SELECT COUNT(*)::text FROM "AdoptedRoute") AS adopted_routes,
      (SELECT COUNT(*)::text FROM "OperationReceipt") AS receipts,
      (SELECT COUNT(*)::text FROM "OutboxEvent") AS outbox
  `);
  return result.rows[0];
}

async function seedP5bExtendedData(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "UserTimeIntent"
      ("id", "tripId", "nodeId", "kind", "operator",
       "durationSeconds", "locked", "updatedAt")
    VALUES ('56000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            'MIN_DWELL', 'MINIMUM', 2400, FALSE, CURRENT_TIMESTAMP);

    INSERT INTO "TemporalValue"
      ("id", "nodeId", "layer", "pointKind", "instant", "timeZone",
       "sourceKind", "observedAt", "updatedAt")
    VALUES
      ('55000000-0000-4000-8000-000000000002',
       '30000000-0000-4000-8000-000000000001', 'PLANNED', 'ARRIVAL',
       '2030-01-01T00:20:00Z', 'UTC', 'USER_VALUE', NULL, CURRENT_TIMESTAMP),
      ('55000000-0000-4000-8000-000000000003',
       '30000000-0000-4000-8000-000000000001', 'ESTIMATED', 'ARRIVAL',
       '2030-01-01T00:25:00Z', 'UTC', 'PROVIDER_OBSERVATION',
       '2030-01-01T00:10:00Z', CURRENT_TIMESTAMP),
      ('55000000-0000-4000-8000-000000000004',
       '30000000-0000-4000-8000-000000000001', 'ACTUAL', 'ARRIVAL',
       '2030-01-01T00:30:00Z', 'UTC', 'PROVIDER_OBSERVATION',
       '2030-01-01T00:30:00Z', CURRENT_TIMESTAMP);

    INSERT INTO "TransportEdgeHistory"
      ("id", "originalTransportEdgeId", "tripId", "originalFromNodeId",
       "originalToNodeId", "mode", "fixedService", "source",
       "originalCreatedAt", "invalidatedAt", "invalidationReason")
    VALUES ('57000000-0000-4000-8000-000000000001',
            '57000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002',
            'TAXI', FALSE, 'MANUAL', '2029-12-31T23:00:00Z',
            '2030-01-01T00:00:00Z', 'USER_REPLACED');
  `);
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
