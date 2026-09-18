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
const p3aMigration = '20260919120000_p3a_day_occurrence_sequence';

describe('P3A populated database migration', () => {
  it('backfills stable occurrences without changing the old node or transport order', async () => {
    const databaseName = `travel_p3a_${randomUUID().replaceAll('-', '')}`;
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
          .filter((name) => name < p3aMigration)
          .sort();
        for (const migrationName of migrationNames) {
          await target.query(
            await readFile(
              `${migrationsPath}/${migrationName}/migration.sql`,
              'utf8',
            ),
          );
        }

        await seedP2bCompatibleData(target);
        await target.query(
          await readFile(
            `${migrationsPath}/${p3aMigration}/migration.sql`,
            'utf8',
          ),
        );

        const occurrences = await target.query<{
          id: string;
          localDate: string;
          sequence: number;
        }>(`
          SELECT "id", "localDate"::text AS "localDate", "sequence"
          FROM "DayOccurrence"
          WHERE "tripId" = '10000000-0000-4000-8000-000000000001'
          ORDER BY "sequence"
        `);
        expect(
          occurrences.rows.map(({ localDate, sequence }) => [
            localDate,
            sequence,
          ]),
        ).toEqual([
          ['2030-01-01', 0],
          ['2030-01-02', 1],
          ['2030-01-03', 2],
        ]);

        const nodes = await target.query<{ note: string }>(`
          SELECT node."note"
          FROM "ItineraryNode" AS node
          JOIN "DayOccurrence" AS occurrence
            ON occurrence."id" = node."dayOccurrenceId"
           AND occurrence."tripId" = node."tripId"
          WHERE node."tripId" = '10000000-0000-4000-8000-000000000001'
          ORDER BY occurrence."sequence", node."position"
        `);
        expect(nodes.rows.map((row) => row.note)).toEqual(['A', 'C', 'B']);

        const edge = await target.query<{
          fromNodeId: string;
          toNodeId: string;
        }>(`
          SELECT "fromNodeId", "toNodeId"
          FROM "TransportEdge"
          WHERE "id" = '40000000-0000-4000-8000-000000000001'
        `);
        expect(edge.rows[0]).toEqual({
          fromNodeId: '30000000-0000-4000-8000-000000000001',
          toNodeId: '30000000-0000-4000-8000-000000000003',
        });

        const emptyCount = await target.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM "DayOccurrence"
          WHERE "tripId" = '10000000-0000-4000-8000-000000000002'
        `);
        expect(emptyCount.rows[0]?.count).toBe('0');

        const legacyColumn = await target.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'ItineraryNode'
            AND column_name = 'localDate'
        `);
        expect(legacyColumn.rows[0]?.count).toBe('0');

        await target.query(`
          INSERT INTO "DayOccurrence"
            ("tripId", "localDate", "sequence", "updatedAt")
          VALUES
            ('10000000-0000-4000-8000-000000000001', '2030-01-01', 3, CURRENT_TIMESTAMP)
        `);
        const repeatedDateCount = await target.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM "DayOccurrence"
          WHERE "tripId" = '10000000-0000-4000-8000-000000000001'
            AND "localDate" = '2030-01-01'
        `);
        expect(repeatedDateCount.rows[0]?.count).toBe('2');

        await expect(
          target.query(`
            INSERT INTO "ItineraryNode"
              ("id", "tripId", "dayOccurrenceId", "kind", "position", "note", "updatedAt")
            VALUES
              ('30000000-0000-4000-8000-000000000004',
               '10000000-0000-4000-8000-000000000002',
               '${occurrences.rows[0]!.id}', 'FREE_ACTION', 99, 'cross-trip', CURRENT_TIMESTAMP)
          `),
        ).rejects.toMatchObject({ code: '23503' });
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

async function seedP2bCompatibleData(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "User"
      ("id", "email", "normalizedEmail", "updatedAt")
    VALUES
      ('00000000-0000-4000-8000-000000000001', 'p3a@synthetic.example.test', 'p3a@synthetic.example.test', CURRENT_TIMESTAMP);

    INSERT INTO "Trip"
      ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount",
       "version", "effectiveStartDate", "effectiveEndDate", "updatedAt")
    VALUES
      ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
       'SYNTHETIC populated', '2030-01-01', 1, 4, '2030-01-01', '2030-01-03', CURRENT_TIMESTAMP),
      ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
       'SYNTHETIC empty', '2030-02-01', 1, 1, NULL, NULL, CURRENT_TIMESTAMP);

    INSERT INTO "DateOwnership" ("ownerUserId", "localDate", "tripId")
    VALUES
      ('00000000-0000-4000-8000-000000000001', '2030-01-01', '10000000-0000-4000-8000-000000000001'),
      ('00000000-0000-4000-8000-000000000001', '2030-01-02', '10000000-0000-4000-8000-000000000001'),
      ('00000000-0000-4000-8000-000000000001', '2030-01-03', '10000000-0000-4000-8000-000000000001');

    INSERT INTO "Place"
      ("id", "ownerUserId", "name", "latitude", "longitude")
    VALUES
      ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'A', 35, 139),
      ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'B', 34, -118),
      ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'C', 35.1, 139.1);

    INSERT INTO "ItineraryNode"
      ("id", "tripId", "kind", "localDate", "position", "placeId", "note", "updatedAt")
    VALUES
      ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'PLACE_VISIT', '2030-01-01', 0, '20000000-0000-4000-8000-000000000001', 'A', CURRENT_TIMESTAMP),
      ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'PLACE_VISIT', '2030-01-01', 1, '20000000-0000-4000-8000-000000000003', 'C', CURRENT_TIMESTAMP),
      ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'PLACE_VISIT', '2030-01-03', 0, '20000000-0000-4000-8000-000000000002', 'B', CURRENT_TIMESTAMP);

    INSERT INTO "TransportEdge"
      ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService", "updatedAt")
    VALUES
      ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003',
       'FLIGHT', TRUE, CURRENT_TIMESTAMP);
  `);
}
