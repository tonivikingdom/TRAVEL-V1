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
const p3b1Migration = '20260919180000_p3b1_time_intent_constraints';

describe('P3B1 populated P3A database migration', () => {
  it('adds intent constraints without changing DayOccurrence, Node, Transport, or TemporalValue data', async () => {
    const databaseName = `travel_p3b1_${randomUUID().replaceAll('-', '')}`;
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
          .filter((name) => name < p3b1Migration)
          .sort();
        for (const migrationName of migrationNames) {
          await target.query(
            await readFile(
              `${migrationsPath}/${migrationName}/migration.sql`,
              'utf8',
            ),
          );
        }
        await seedP3aData(target);
        const before = await coreCounts(target);

        await target.query(
          await readFile(
            `${migrationsPath}/${p3b1Migration}/migration.sql`,
            'utf8',
          ),
        );

        expect(await coreCounts(target)).toEqual(before);
        await target.query(`
          INSERT INTO "UserTimeIntent"
            ("id", "tripId", "nodeId", "kind", "pointKind", "operator",
             "instant", "timeZone", "durationSeconds", "locked", "updatedAt")
          VALUES
            ('50000000-0000-4000-8000-000000000001',
             '10000000-0000-4000-8000-000000000001',
             '30000000-0000-4000-8000-000000000001',
             'POINT_TIME', 'ARRIVAL', 'EXACT',
             '2030-01-01T10:00:00Z', 'UTC', NULL, true, CURRENT_TIMESTAMP),
            ('50000000-0000-4000-8000-000000000002',
             '10000000-0000-4000-8000-000000000001',
             '30000000-0000-4000-8000-000000000001',
             'MIN_DWELL', NULL, 'MINIMUM',
             NULL, NULL, 2400, false, CURRENT_TIMESTAMP)
        `);
        const intents = await target.query<{
          kind: string;
          durationSeconds: number | null;
        }>(`
          SELECT "kind"::text AS kind, "durationSeconds"
          FROM "UserTimeIntent"
          ORDER BY "kind"
        `);
        expect(intents.rows.map((row) => row.kind)).toEqual([
          'POINT_TIME',
          'MIN_DWELL',
        ]);

        await expect(
          target.query(`
            INSERT INTO "UserTimeIntent"
              ("tripId", "nodeId", "kind", "pointKind", "operator",
               "instant", "timeZone", "updatedAt")
            VALUES
              ('10000000-0000-4000-8000-000000000001',
               '30000000-0000-4000-8000-000000000001',
               'MIN_DWELL', NULL, 'MINIMUM',
               '2030-01-01T10:00:00Z', NULL, CURRENT_TIMESTAMP)
          `),
        ).rejects.toMatchObject({ code: '23514' });

        await expect(
          target.query(`
            INSERT INTO "UserTimeIntent"
              ("tripId", "nodeId", "kind", "pointKind", "operator",
               "durationSeconds", "updatedAt")
            VALUES
              ('10000000-0000-4000-8000-000000000001',
               '30000000-0000-4000-8000-000000000001',
               'MIN_DWELL', NULL, 'MINIMUM', 600, CURRENT_TIMESTAMP)
          `),
        ).rejects.toMatchObject({ code: '23505' });
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

async function coreCounts(client: Client) {
  const result = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM "DayOccurrence") AS occurrences,
      (SELECT COUNT(*)::text FROM "ItineraryNode") AS nodes,
      (SELECT COUNT(*)::text FROM "TransportEdge") AS transports,
      (SELECT COUNT(*)::text FROM "TemporalValue") AS temporal_values
  `);
  return result.rows[0];
}

async function seedP3aData(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "User"
      ("id", "email", "normalizedEmail", "updatedAt")
    VALUES
      ('00000000-0000-4000-8000-000000000001',
       'p3b1@synthetic.example.test',
       'p3b1@synthetic.example.test', CURRENT_TIMESTAMP);

    INSERT INTO "Trip"
      ("id", "ownerUserId", "name", "planningAnchorDate", "defaultPeopleCount",
       "version", "effectiveStartDate", "effectiveEndDate", "updatedAt")
    VALUES
      ('10000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000001',
       'SYNTHETIC P3A populated', '2030-01-01', 1, 3,
       '2030-01-01', '2030-01-01', CURRENT_TIMESTAMP);

    INSERT INTO "DateOwnership" ("ownerUserId", "localDate", "tripId")
    VALUES
      ('00000000-0000-4000-8000-000000000001', '2030-01-01',
       '10000000-0000-4000-8000-000000000001');

    INSERT INTO "DayOccurrence"
      ("id", "tripId", "localDate", "sequence", "updatedAt")
    VALUES
      ('20000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001', '2030-01-01', 0,
       CURRENT_TIMESTAMP);

    INSERT INTO "ItineraryNode"
      ("id", "tripId", "dayOccurrenceId", "kind", "position", "note", "updatedAt")
    VALUES
      ('30000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001',
       'FREE_ACTION', 0, 'SYNTHETIC P3A node', CURRENT_TIMESTAMP),
      ('30000000-0000-4000-8000-000000000002',
       '10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000001',
       'FREE_ACTION', 1, 'SYNTHETIC P3A node 2', CURRENT_TIMESTAMP);

    INSERT INTO "TransportEdge"
      ("id", "tripId", "fromNodeId", "toNodeId", "mode", "fixedService", "updatedAt")
    VALUES
      ('40000000-0000-4000-8000-000000000001',
       '10000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000001',
       '30000000-0000-4000-8000-000000000002',
       'RAIL', true, CURRENT_TIMESTAMP);

    INSERT INTO "TemporalValue"
      ("nodeId", "layer", "pointKind", "instant", "timeZone",
       "sourceKind", "updatedAt")
    VALUES
      ('30000000-0000-4000-8000-000000000001', 'PLANNED', 'ARRIVAL',
       '2030-01-01T10:00:00Z', 'UTC', 'USER_VALUE', CURRENT_TIMESTAMP);
  `);
}
