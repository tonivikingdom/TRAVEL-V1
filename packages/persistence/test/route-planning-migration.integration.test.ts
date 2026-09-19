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
const p4b1Migration = '20260919210000_p4b1_candidate_snapshot_preview';

describe('P4B1 populated P4A1 database migration', () => {
  it('adds snapshot/preview tables without changing official Trip facts', async () => {
    const databaseName = `travel_p4b1_${randomUUID().replaceAll('-', '')}`;
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
          .filter((name) => name < p4b1Migration)
          .sort();
        for (const migrationName of migrationNames) {
          await target.query(
            await readFile(
              `${migrationsPath}/${migrationName}/migration.sql`,
              'utf8',
            ),
          );
        }
        await seedP4a1Data(target);
        const before = await officialCounts(target);

        await target.query(
          await readFile(
            `${migrationsPath}/${p4b1Migration}/migration.sql`,
            'utf8',
          ),
        );

        expect(await officialCounts(target)).toEqual(before);
        await target.query(`
          INSERT INTO "RouteCandidateSnapshot"
            ("id", "ownerUserId", "tripId", "basisVersion", "fromNodeId",
             "toNodeId", "provider", "providerCandidateRef", "observedAt",
             "candidatePayload", "candidateHash", "queryTimeCondition",
             "createdAt", "expiresAt")
          VALUES
            ('60000000-0000-4000-8000-000000000001',
             '00000000-0000-4000-8000-000000000001',
             '10000000-0000-4000-8000-000000000001', 3,
             '30000000-0000-4000-8000-000000000001',
             '30000000-0000-4000-8000-000000000002',
             'SYNTHETIC', 'candidate-1', '2030-01-01T00:00:00Z',
             '{"candidateId":"candidate-1"}'::jsonb,
             '${'a'.repeat(64)}', '{}'::jsonb,
             '2030-01-01T00:00:00Z', '2030-01-01T00:15:00Z');

          INSERT INTO "RoutePreview"
            ("id", "ownerUserId", "tripId", "basisVersion",
             "candidateSnapshotId", "candidateHash", "policyVersion",
             "previewPayload", "createdAt", "expiresAt")
          VALUES
            ('70000000-0000-4000-8000-000000000001',
             '00000000-0000-4000-8000-000000000001',
             '10000000-0000-4000-8000-000000000001', 3,
             '60000000-0000-4000-8000-000000000001',
             '${'a'.repeat(64)}', 'route-adoption-preview-v1', '{}'::jsonb,
             '2030-01-01T00:00:00Z', '2030-01-01T00:10:00Z')
        `);
        const counts = await target.query<{
          snapshots: string;
          previews: string;
        }>(`
          SELECT
            (SELECT COUNT(*)::text FROM "RouteCandidateSnapshot") AS snapshots,
            (SELECT COUNT(*)::text FROM "RoutePreview") AS previews
        `);
        expect(counts.rows[0]).toEqual({ snapshots: '1', previews: '1' });

        await expect(
          target.query(`
            INSERT INTO "RouteCandidateSnapshot"
              ("ownerUserId", "tripId", "basisVersion", "fromNodeId",
               "toNodeId", "provider", "observedAt", "candidatePayload",
               "candidateHash", "queryTimeCondition", "createdAt", "expiresAt")
            VALUES
              ('00000000-0000-4000-8000-000000000001',
               '10000000-0000-4000-8000-000000000001', 3,
               '30000000-0000-4000-8000-000000000001',
               '30000000-0000-4000-8000-000000000002',
               'SYNTHETIC', CURRENT_TIMESTAMP, '{}'::jsonb,
               '${'b'.repeat(64)}', '{}'::jsonb,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `),
        ).rejects.toMatchObject({ code: '23514' });
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

async function officialCounts(client: Client) {
  const result = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM "Trip") AS trips,
      (SELECT COUNT(*)::text FROM "DayOccurrence") AS occurrences,
      (SELECT COUNT(*)::text FROM "ItineraryNode") AS nodes,
      (SELECT COUNT(*)::text FROM "TransportEdge") AS transports,
      (SELECT COUNT(*)::text FROM "TemporalValue") AS temporal_values,
      (SELECT COUNT(*)::text FROM "UserTimeIntent") AS intents
  `);
  return result.rows[0];
}

async function seedP4a1Data(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "User"
      ("id", "email", "normalizedEmail", "updatedAt")
    VALUES
      ('00000000-0000-4000-8000-000000000001',
       'p4b1@synthetic.example.test',
       'p4b1@synthetic.example.test', CURRENT_TIMESTAMP);

    INSERT INTO "Trip"
      ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount",
       "version", "effectiveStartDate", "effectiveEndDate", "updatedAt")
    VALUES
      ('10000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000001',
       'SYNTHETIC P4A1 populated', '2030-01-01', 1, 3,
       '2030-01-01', '2030-01-01', CURRENT_TIMESTAMP);

    INSERT INTO "DayOccurrence"
      ("id", "tripId", "localDate", "sequence", "updatedAt")
    VALUES
      ('20000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', '2030-01-01', 0,
       CURRENT_TIMESTAMP);

    INSERT INTO "Place"
      ("id", "ownerUserId", "name", "latitude", "longitude")
    VALUES
      ('40000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000001', 'From', 35, 139),
      ('40000000-0000-4000-8000-000000000002',
       '00000000-0000-4000-8000-000000000001', 'To', 36, 140);

    INSERT INTO "ItineraryNode"
      ("id", "tripId", "dayOccurrenceId", "kind", "position", "placeId",
       "updatedAt")
    VALUES
      ('30000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001',
       'PLACE_VISIT', 0, '40000000-0000-4000-8000-000000000001',
       CURRENT_TIMESTAMP),
      ('30000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001',
       'PLACE_VISIT', 1, '40000000-0000-4000-8000-000000000002',
       CURRENT_TIMESTAMP)
  `);
}
