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
const migration = '20261001100000_p5e2_external_origin_adoption';
const splitMigrations = new Set([
  '20260920110000_p4b2_route_adoption',
  '20260920150000_p4b3_route_undo',
]);

describe('P5E2 5B2B external adopted-route anchor migration', () => {
  it('applies exactly 23 migrations on empty PostgreSQL 17 and preserves composite Restrict FK', async () => {
    await withDatabase('external_adopt_clean', async (client) => {
      const names = (await migrationNames()).filter(
        (name) => name <= migration,
      );
      expect(names).toHaveLength(23);
      for (const name of names) await applyMigration(client, name);
      const result = await client.query(
        `SELECT conkey, confkey, confdeltype FROM pg_constraint WHERE conname='AdoptedRoute_anchorFromNodeId_tripId_fkey'`,
      );
      expect(result.rows).toEqual([
        expect.objectContaining({
          conkey: expect.any(Array),
          confkey: expect.any(Array),
          confdeltype: 'r',
        }),
      ]);
      expect(result.rows[0].conkey).toHaveLength(2);
      expect(result.rows[0].confkey).toHaveLength(2);
      expect(await count(client, 'AdoptedRoute')).toBe(0);
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND conrelid='"AdoptedRoute"'::regclass AND confrelid='"ExternalExecutionOrigin"'::regclass`,
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });
  it('preserves populated 22-migration snapshots, v1 external previews, receipts and execution evidence', async () => {
    await withDatabase('external_adopt_populated', async (client) => {
      const names = (await migrationNames()).filter((name) => name < migration);
      expect(names).toHaveLength(22);
      for (const name of names) await applyMigration(client, name);
      await seedPopulated(client);
      const tables = [
        'User',
        'Trip',
        'Place',
        'DayOccurrence',
        'ItineraryNode',
        'TransportEdge',
        'TemporalValue',
        'TransportEdgeHistory',
        'RouteCandidateSnapshot',
        'RoutePreview',
        'AdoptedRoute',
        'OperationReceipt',
        'OutboxEvent',
        'ExecutionEvent',
        'ExternalExecutionOrigin',
        'ExternalExecutionOriginReceipt',
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
                  `SELECT jsonb_agg(to_jsonb(t)-'anchorOriginKind'-'anchorFromExternalOriginId'-'anchorFromSnapshot' ORDER BY t."id") data FROM "${table}" t`,
                )
              ).rows[0].data,
          ),
        );
      const before = await snapshot();
      await applyMigration(client, migration);
      expect(await snapshot()).toEqual(before);
      const routes = (
        await client.query(
          `SELECT "anchorOriginKind","anchorFromNodeId","anchorFromExternalOriginId","anchorFromSnapshot","status" FROM "AdoptedRoute" ORDER BY "status"`,
        )
      ).rows;
      expect(routes).toHaveLength(3);
      expect(
        routes.every(
          (row) =>
            row.anchorOriginKind === 'ITINERARY_NODE' &&
            row.anchorFromNodeId !== null &&
            row.anchorFromExternalOriginId === null &&
            row.anchorFromSnapshot === null,
        ),
      ).toBe(true);
      expect(routes.map((row) => row.status).sort()).toEqual([
        'ACTIVE',
        'REPLACED',
        'UNDONE',
      ]);
      expect(await count(client, 'ExternalExecutionOrigin')).toBe(1);
      expect(
        (
          await client.query(
            `SELECT "originKind" FROM "RouteCandidateSnapshot" ORDER BY "originKind"`,
          )
        ).rows.map((r) => r.originKind),
      ).toEqual(['ITINERARY_NODE', 'EXTERNAL_EXECUTION_ORIGIN']);
      expect(
        (
          await client.query(
            `SELECT count(*)::int n FROM "RoutePreview" WHERE "policyVersion"='route-external-origin-preview-v1'`,
          )
        ).rows[0].n,
      ).toBe(1);
    });
  });
  it('rejects ambiguous/missing anchors and requires explicit detach for historical external route', async () => {
    await withDatabase('external_adopt_shape', async (client) => {
      for (const name of await migrationNames())
        await applyMigration(client, name);
      await seedP4b2Data(client);
      const route = '75000000-0000-4000-8000-000000000001';
      for (const assignment of [
        '"anchorFromNodeId"=NULL',
        `"anchorFromExternalOriginId"='f0000000-0000-4000-8000-000000000001'`,
        `"anchorFromSnapshot"='{}'::jsonb`,
        `"anchorOriginKind"='EXTERNAL_EXECUTION_ORIGIN'`,
        `"anchorOriginKind"='EXTERNAL_EXECUTION_ORIGIN',"anchorFromSnapshot"='{}'::jsonb`,
        `"anchorOriginKind"='EXTERNAL_EXECUTION_ORIGIN',"anchorFromExternalOriginId"='f0000000-0000-4000-8000-000000000001'`,
      ]) {
        await expect(
          client.query(
            `UPDATE "AdoptedRoute" SET ${assignment} WHERE "id"='${route}'`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      await client.query(
        `UPDATE "AdoptedRoute" SET "anchorOriginKind"='EXTERNAL_EXECUTION_ORIGIN',"anchorFromExternalOriginId"='f0000000-0000-4000-8000-000000000001',"anchorFromSnapshot"='{"schemaVersion":"external-adopted-route-anchor-v1","fixture":"SYNTHETIC"}' WHERE "id"='${route}'`,
      );
      for (const assignment of [
        '"anchorFromNodeId"=NULL',
        `"anchorFromSnapshot"='null'::jsonb`,
        `"anchorFromSnapshot"='[]'::jsonb`,
        `"status"='UNDONE'`,
      ]) {
        await expect(
          client.query(
            `UPDATE "AdoptedRoute" SET ${assignment} WHERE "id"='${route}'`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
      // Nullable does not weaken same-Trip ownership. A foreign Trip node is still rejected.
      await client.query(
        `INSERT INTO "Trip" ("id","ownerUserId","name","planningAnchorDate","defaultPeopleCount","updatedAt") VALUES ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','SYNTHETIC foreign trip','2030-01-01',1,CURRENT_TIMESTAMP)`,
      );
      await expect(
        client.query(
          `UPDATE "AdoptedRoute" SET "tripId"='10000000-0000-4000-8000-000000000002' WHERE "id"='${route}'`,
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await client.query(`INSERT INTO "DayOccurrence" ("id","tripId","localDate","sequence","updatedAt") VALUES ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','2030-01-01',0,CURRENT_TIMESTAMP);
        INSERT INTO "ItineraryNode" ("id","tripId","dayOccurrenceId","kind","position","placeId","updatedAt") VALUES ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','PLACE_VISIT',0,'40000000-0000-4000-8000-000000000001',CURRENT_TIMESTAMP);`);
      await expect(
        client.query(
          `UPDATE "AdoptedRoute" SET "anchorFromNodeId"='30000000-0000-4000-8000-000000000003' WHERE "id"='${route}'`,
        ),
      ).rejects.toMatchObject({
        code: '23503',
        constraint: 'AdoptedRoute_anchorFromNodeId_tripId_fkey',
      });
      const before = (
        await client.query(
          `SELECT "anchorFromSnapshot" FROM "AdoptedRoute" WHERE "id"='${route}'`,
        )
      ).rows[0];
      await client.query(
        `UPDATE "AdoptedRoute" SET "status"='UNDONE',"anchorFromNodeId"=NULL WHERE "id"='${route}'`,
      );
      expect(
        (
          await client.query(
            `SELECT "anchorFromNodeId","anchorFromSnapshot" FROM "AdoptedRoute" WHERE "id"='${route}'`,
          )
        ).rows[0],
      ).toEqual({ anchorFromNodeId: null, ...before });
      await client.query(
        `UPDATE "AdoptedRoute" SET "status"='REPLACED' WHERE "id"='${route}'`,
      );
      await client.query(
        `UPDATE "AdoptedRoute" SET "anchorFromNodeId"='30000000-0000-4000-8000-000000000001' WHERE "id"='${route}'`,
      );
      await client.query(
        `UPDATE "AdoptedRoute" SET "anchorFromNodeId"=NULL WHERE "id"='${route}'`,
      );
    });
  });
});

async function seedPopulated(client: Client) {
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
  await client.query(`
        INSERT INTO "ExternalExecutionOrigin" ("id","ownerUserId","tripId","sourceAdoptedRouteId","sourceTransportEdgeId","sourceGroundTransitLegExecutionId","sourceGroundTransitObservationId","sourceObservationIdentity","sourceObservationFetchedAt","sourceObservationFactsHash","provider","providerHubRef","canonicalHubRef","name","latitude","longitude","timeZone","arrivedAt","updatedAt") VALUES
        ('f0000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001','SYNTHETIC:accepted','2030-01-01T00:00:00Z','${'d'.repeat(64)}','SYNTHETIC','E','synthetic:E','Synthetic E',35,139,'Asia/Tokyo','2030-01-01T00:00:00Z',CURRENT_TIMESTAMP);
        INSERT INTO "ExternalExecutionOriginReceipt" ("id","ownerUserId","tripId","externalOriginId","transition","idempotencyKey","requestHash","occurredAt","resultingTripVersion","response") VALUES
        ('f1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','f0000000-0000-4000-8000-000000000001','ARRIVAL','SYNTHETIC:external','${'e'.repeat(64)}','2030-01-01T00:00:00Z',5,'{}');
      `);
  for (const version of [2, 3, 4]) {
    await client.query(
      `INSERT INTO "OperationReceipt" ("id","ownerUserId","tripId","operationType","idempotencyKey","requestHash","baseTripVersion","resultingTripVersion","previewId","adoptedRouteId","delta","createdAt") SELECT $1::uuid,"ownerUserId","tripId","operationType",$2,"requestHash","baseTripVersion","resultingTripVersion","previewId","adoptedRouteId",$3::jsonb,"createdAt" FROM "OperationReceipt" LIMIT 1`,
      [
        randomUUID(),
        `SYNTHETIC:v${version}`,
        JSON.stringify({
          schemaVersion: `route-adopt-delta-v${version}`,
          fixture: 'SYNTHETIC retained receipt',
        }),
      ],
    );
  }

  await client.query(`
    INSERT INTO "RouteCandidateSnapshot" ("id","ownerUserId","tripId","basisVersion","originKind","fromNodeId","fromExternalOriginId","externalOriginSnapshot","toNodeId","provider","observedAt","candidatePayload","candidateHash","queryTimeCondition","createdAt","expiresAt") SELECT '60000000-0000-4000-8000-000000000002',"ownerUserId","tripId","basisVersion",'EXTERNAL_EXECUTION_ORIGIN',NULL,'f0000000-0000-4000-8000-000000000001','{"schema":"external-route-origin-v1","fixture":"SYNTHETIC copied evidence"}',"toNodeId","provider","observedAt","candidatePayload","candidateHash","queryTimeCondition","createdAt","expiresAt" FROM "RouteCandidateSnapshot" LIMIT 1;
    INSERT INTO "RoutePreview" ("id","ownerUserId","tripId","basisVersion","candidateSnapshotId","candidateHash","policyVersion","previewPayload","previewHash","createdAt","expiresAt") SELECT '70000000-0000-4000-8000-000000000002',"ownerUserId","tripId","basisVersion",'60000000-0000-4000-8000-000000000002',"candidateHash",'route-external-origin-preview-v1','{"fixture":"SYNTHETIC v1 remains unsupported"}',"previewHash","createdAt","expiresAt" FROM "RoutePreview" LIMIT 1;
    INSERT INTO "RoutePreview" ("id","ownerUserId","tripId","basisVersion","candidateSnapshotId","candidateHash","policyVersion","previewPayload","previewHash","createdAt","expiresAt") SELECT '70000000-0000-4000-8000-000000000003',"ownerUserId","tripId","basisVersion","candidateSnapshotId","candidateHash","policyVersion","previewPayload","previewHash","createdAt","expiresAt" FROM "RoutePreview" WHERE "id"='70000000-0000-4000-8000-000000000001';
    INSERT INTO "RoutePreview" ("id","ownerUserId","tripId","basisVersion","candidateSnapshotId","candidateHash","policyVersion","previewPayload","previewHash","createdAt","expiresAt") SELECT '70000000-0000-4000-8000-000000000004',"ownerUserId","tripId","basisVersion","candidateSnapshotId","candidateHash","policyVersion","previewPayload","previewHash","createdAt","expiresAt" FROM "RoutePreview" WHERE "id"='70000000-0000-4000-8000-000000000001';
    INSERT INTO "AdoptedRoute" ("id","tripId","anchorFromNodeId","anchorToNodeId","sourcePreviewId","candidateSnapshotId","candidateHash","policyVersion","status") SELECT '75000000-0000-4000-8000-000000000002',"tripId","anchorFromNodeId","anchorToNodeId",'70000000-0000-4000-8000-000000000003',"candidateSnapshotId","candidateHash","policyVersion",'REPLACED' FROM "AdoptedRoute" LIMIT 1;
    INSERT INTO "AdoptedRoute" ("id","tripId","anchorFromNodeId","anchorToNodeId","sourcePreviewId","candidateSnapshotId","candidateHash","policyVersion","status") SELECT '75000000-0000-4000-8000-000000000003',"tripId","anchorFromNodeId","anchorToNodeId",'70000000-0000-4000-8000-000000000004',"candidateSnapshotId","candidateHash","policyVersion",'UNDONE' FROM "AdoptedRoute" WHERE "id"='75000000-0000-4000-8000-000000000001';
    INSERT INTO "OperationReceipt" ("id","ownerUserId","tripId","operationType","idempotencyKey","requestHash","baseTripVersion","resultingTripVersion","previewId","adoptedRouteId","targetOperationReceiptId","delta") SELECT '80000000-0000-4000-8000-000000000002',"ownerUserId","tripId",'ROUTE_UNDO','SYNTHETIC undo receipt',"requestHash",4,5,"previewId","adoptedRouteId","id",'{"schemaVersion":"route-undo-delta-v2"}' FROM "OperationReceipt" WHERE "id"='80000000-0000-4000-8000-000000000001';
    INSERT INTO "TransportEdgeHistory" ("id","tripId","originalTransportEdgeId","originalFromNodeId","originalToNodeId","invalidationReason","mode","fixedService","serviceLabel","source","adoptedRouteId","provider","originalCreatedAt") SELECT '51000000-0000-4000-8000-000000000001',"tripId","id","fromNodeId","toNodeId",'USER_REPLACED',"mode","fixedService","serviceLabel","source","adoptedRouteId","provider","createdAt" FROM "TransportEdge" LIMIT 1;
  `);
}

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
