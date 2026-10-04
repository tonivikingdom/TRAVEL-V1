import { randomUUID } from 'node:crypto';
import type { AdoptRoutePreviewResponse } from '@travel/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  footprint,
  gate,
  onlyWrites,
  waitForOwnerLock,
  replanningHarness,
  type SyntheticOwner,
} from './helpers/replanning-acceptance.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for P6C2');

describe('P6C2 black-box failure / concurrency write safety (SYNTHETIC PostgreSQL)', () => {
  let h: ReturnType<typeof replanningHarness>;
  let owner: SyntheticOwner;
  beforeEach(async () => {
    h = replanningHarness(databaseUrl);
    owner = await h.identity();
  });
  afterEach(async () => {
    await h.close();
  });
  const capture = (tripId: string) => footprint(h.managed, tripId);

  it.each([
    {
      status: 'PROVIDER_UNAVAILABLE' as const,
      reason: 'UPSTREAM_UNAVAILABLE' as const,
      http: 503,
      code: 'PROVIDER_UNAVAILABLE',
    },
    {
      status: 'NO_MATCHING_CANDIDATE' as const,
      http: 404,
      code: 'NO_MATCHING_CANDIDATE',
    },
    {
      status: 'UNSUPPORTED_QUERY' as const,
      http: 422,
      code: 'ROUTE_QUERY_UNSUPPORTED',
    },
  ])(
    '$status is distinct and leaves every tracked row unchanged',
    async ({ http, code, ...result }) => {
      const trip = await h.seed(owner);
      const before = await capture(trip.id);
      h.setResult(result);
      const response = await h.query(owner, trip);
      expect(response.statusCode, response.body).toBe(http);
      expect(response.json().error.code).toBe(code);
      onlyWrites(before, await capture(trip.id));
    },
  );

  it('successful Query only stores candidate snapshots; Preview only stores preview', async () => {
    const trip = await h.seed(owner);
    const before = await capture(trip.id);
    const candidateId = await h.candidate(owner, trip);
    const queried = await capture(trip.id);
    onlyWrites(before, queried, ['snapshots']);
    expect(queried.snapshots).toHaveLength(1);
    expect(queried.snapshots[0]!.basisVersion).toBe(trip.version);
    const response = await h.preview(owner, trip, candidateId);
    expect(response.statusCode, response.body).toBe(201);
    const previewed = await capture(trip.id);
    onlyWrites(queried, previewed, ['previews']);
    expect(previewed.previews).toHaveLength(1);
    expect(previewed.previews[0]!.basisVersion).toBe(trip.version);
  });

  it('N Query → N+1 rejects Preview without a write', async () => {
    const trip = await h.seed(owner);
    const candidateId = await h.candidate(owner, trip);
    await h.note(owner, trip);
    const before = await capture(trip.id);
    const response = await h.preview(owner, trip, candidateId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('VERSION_CONFLICT');
    onlyWrites(before, await capture(trip.id));
  });

  it('N Preview → N+1 rejects Adopt without a write', async () => {
    const trip = await h.seed(owner);
    const preview = await h.prepared(owner, trip);
    await h.note(owner, trip);
    const before = await capture(trip.id);
    const response = await h.adopt(owner, trip, preview);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('VERSION_CONFLICT');
    onlyWrites(before, await capture(trip.id));
  });

  it('late Provider response after another device changes Trip fails closed', async () => {
    const trip = await h.seed(owner);
    const arrived = gate(),
      release = gate();
    h.setProviderHook(async () => {
      arrived.release();
      await release.pending;
    });
    const pending = h.query(owner, trip);
    await arrived.pending;
    try {
      await h.note(owner, trip);
      const before = await capture(trip.id);
      release.release();
      const response = await pending;
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe('VERSION_CONFLICT');
      onlyWrites(before, await capture(trip.id));
    } finally {
      release.release();
      await pending;
    }
  });

  it('expired snapshot rejects Preview and expired Preview rejects Adopt without writes', async () => {
    const trip = await h.seed(owner);
    const preview = await h.prepared(owner, trip);
    h.setNow(new Date('2030-09-01T00:16:00Z'));
    const before = await capture(trip.id);
    const previewResponse = await h.preview(
      owner,
      trip,
      preview.candidateSnapshotId,
    );
    const adoptResponse = await h.adopt(owner, trip, preview);
    expect(previewResponse.statusCode).toBe(409);
    expect(adoptResponse.statusCode).toBe(409);
    onlyWrites(before, await capture(trip.id));
  });

  it('actual PostgreSQL failure at outbox insert rolls back earlier Adopt writes', async () => {
    const trip = await h.seed(owner);
    const preview = await h.prepared(owner, trip);
    const before = await capture(trip.id);
    // Ephemeral, test-only DDL in the SYNTHETIC database; no product migration.
    const suffix = randomUUID().replaceAll('-', '');
    const name = `p6c2_fault_${suffix}`;
    await h.client.$executeRawUnsafe(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."tripId" = '${trip.id}'::uuid THEN RAISE EXCEPTION 'SYNTHETIC P6C2 before commit'; END IF; RETURN NEW; END $$`,
    );
    await h.client.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    const key = randomUUID();
    try {
      const failed = await h.adopt(owner, trip, preview, key);
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json().error.code).toBe('SERVICE_UNAVAILABLE');
      onlyWrites(before, await capture(trip.id));
    } finally {
      await h.client.$executeRawUnsafe(`DROP TRIGGER ${name} ON "OutboxEvent"`);
      await h.client.$executeRawUnsafe(`DROP FUNCTION ${name}()`);
    }
    const retried = await h.adopt(owner, trip, preview, key);
    expect(retried.statusCode, retried.body).toBe(200);
    expect((await capture(trip.id)).trip.version).toBe(trip.version + 1);
  });

  it('two devices adopt different previews: exactly one formal commit', async () => {
    const trip = await h.seed(owner);
    const one = await h.prepared(owner, trip),
      two = await h.prepared(owner, trip);
    const before = await capture(trip.id);
    const responses = await Promise.all([
      h.adopt(owner, trip, one),
      h.adopt(owner, trip, two),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.statusCode === 409)!.json().error.code).toBe(
      'VERSION_CONFLICT',
    );
    const after = await capture(trip.id);
    onlyWrites(before, after, [
      'trip',
      'nodes',
      'edges',
      'routes',
      'receipts',
      'outbox',
      'times',
      'days',
      'ownership',
    ]);
    expect(after.trip.version).toBe(trip.version + 1);
    expect(after.routes).toHaveLength(1);
    expect(after.edges).toHaveLength(1);
    expect(after.receipts).toHaveLength(1);
    expect(after.outbox).toHaveLength(1);
    expect(after.outbox[0]!.operationReceiptId).toBe(after.receipts[0]!.id);
  });

  it('double Adopt with identical key replays one receipt; same key/different request fails', async () => {
    const trip = await h.seed(owner);
    const one = await h.prepared(owner, trip),
      two = await h.prepared(owner, trip);
    const key = randomUUID();
    const responses = await Promise.all([
      h.adopt(owner, trip, one, key),
      h.adopt(owner, trip, one, key),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    const before = await capture(trip.id);
    expect(before.trip.version).toBe(trip.version + 1);
    expect(before.receipts).toHaveLength(1);
    expect(before.outbox).toHaveLength(1);
    const conflict = await h.adopt(owner, trip, two, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    onlyWrites(before, await capture(trip.id));
  });

  it('new execution fact prevents Undo from deleting progress', async () => {
    const trip = await h.seed(owner);
    h.setNow(new Date('2030-10-01T10:05:00Z'));
    const adopted = (
      await h.adopt(owner, trip, await h.prepared(owner, trip))
    ).json<AdoptRoutePreviewResponse>();
    h.setNow(new Date('2030-10-01T10:05:00Z'));
    const fact = await h.post(owner, `/trips/${trip.id}/execution/events`, {
      baseTripVersion: adopted.trip.version,
      idempotencyKey: randomUUID(),
      type: 'MANUAL_ARRIVAL',
      nodeId: trip.days[0]!.nodes[0]!.id,
      occurredAt: '2030-10-01T10:00:00Z',
    });
    expect(fact.statusCode, fact.body).toBe(200);
    const before = await capture(trip.id);
    const response = await h.undo(owner, adopted);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('UNDO_CONFLICT');
    onlyWrites(before, await capture(trip.id));
    expect(before.execution).toHaveLength(1);
    expect(before.execution[0]!.undoneAt).toBeNull();
  });

  it.each(['fact-first', 'undo-first'] as const)(
    'Undo races execution fact (%s): serialized, no lost accepted fact',
    async (order) => {
      const trip = await h.seed(owner);
      h.setNow(new Date('2030-10-01T10:05:00Z'));
      const adopted = (
        await h.adopt(owner, trip, await h.prepared(owner, trip))
      ).json<AdoptRoutePreviewResponse>();
      const before = await capture(trip.id);
      const locked = gate(),
        release = gate();
      const holder = h.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${owner.id}, 2))`;
          locked.release();
          await release.pending;
        },
        { timeout: 15000 },
      );
      await locked.pending;
      const fact = () =>
        h.post(owner, `/trips/${trip.id}/execution/events`, {
          baseTripVersion: adopted.trip.version,
          idempotencyKey: randomUUID(),
          type: 'MANUAL_ARRIVAL',
          nodeId: trip.days[0]!.nodes[0]!.id,
          occurredAt: '2030-10-01T10:00:00Z',
        });
      const first = order === 'fact-first' ? fact() : h.undo(owner, adopted);
      try {
        await waitForOwnerLock(h.managed, 1);
        const second = order === 'fact-first' ? h.undo(owner, adopted) : fact();
        await waitForOwnerLock(h.managed, 2);
        release.release();
        const responses = await Promise.all([first, second]);
        expect(
          responses.map((r) => r.statusCode),
          responses.map((r) => r.body).join('\n'),
        ).toEqual([200, 409]);
        const after = await capture(trip.id);
        expect(after.trip.version).toBe(adopted.trip.version + 1);
        onlyWrites(
          before,
          after,
          order === 'fact-first'
            ? ['trip', 'times', 'execution']
            : [
                'trip',
                'nodes',
                'edges',
                'routes',
                'receipts',
                'outbox',
                'times',
                'days',
                'ownership',
              ],
        );
        if (order === 'fact-first') {
          expect(responses[1]!.json().error.code).toBe('UNDO_CONFLICT');
          expect(after.execution).toHaveLength(1);
          expect(after.execution[0]!.undoneAt).toBeNull();
        } else {
          expect(responses[1]!.json().error.code).toBe('VERSION_CONFLICT');
          expect(after.execution).toEqual([]);
          expect(after.receipts).toHaveLength(2);
          expect(after.outbox).toHaveLength(2);
        }
      } finally {
        release.release();
        await holder;
        await first;
      }
    },
  );

  it('logout during Query cannot mutate Trip; revoked session and switched owner cannot use its result', async () => {
    const trip = await h.seed(owner);
    const before = await capture(trip.id);
    const arrived = gate(),
      release = gate();
    h.setProviderHook(async () => {
      arrived.release();
      await release.pending;
    });
    const pending = h.query(owner, trip);
    await arrived.pending;
    try {
      expect((await h.post(owner, '/auth/logout', {})).statusCode).toBe(204);
      release.release();
      const result = await pending;
      // Authorization is at request entry. Only a private snapshot may finish.
      expect(result.statusCode, result.body).toBe(200);
      const after = await capture(trip.id);
      onlyWrites(before, after, ['snapshots']);
      const snapshot = after.snapshots[0]!;
      expect(snapshot.ownerUserId).toBe(owner.id);
      expect((await h.preview(owner, trip, snapshot.id)).statusCode).toBe(401);
      const switched = await h.identity();
      expect((await h.preview(switched, trip, snapshot.id)).statusCode).toBe(
        404,
      );
      onlyWrites(after, await capture(trip.id));
    } finally {
      release.release();
      await pending;
    }
  });

  it.each(['USER', 'ADMIN'] as const)(
    'another %s cannot Query/Preview/Adopt/Undo/read private backup',
    async (role) => {
      const trip = await h.seed(owner);
      const view = await h.prepared(owner, trip);
      const adopted = (
        await h.adopt(owner, trip, view)
      ).json<AdoptRoutePreviewResponse>();
      const other = await h.identity(role);
      const before = await capture(trip.id);
      const responses = await Promise.all([
        h.query(other, adopted.trip),
        h.preview(other, adopted.trip, view.candidateSnapshotId),
        h.adopt(other, adopted.trip, view),
        h.undo(other, adopted),
        h.get(other, `/trips/${trip.id}/impact`),
        h.get(other, `/trips/${trip.id}/backup`),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([
        404, 404, 404, 404, 404, 404,
      ]);
      onlyWrites(before, await capture(trip.id));
    },
  );

  it('Impact/Handoff/backup GET are zero planning writes; replanning failure preserves backup', async () => {
    const trip = await h.seed(owner);
    const adopted = (
      await h.adopt(owner, trip, await h.prepared(owner, trip))
    ).json<AdoptRoutePreviewResponse>();
    const generated = await h.post(owner, `/trips/${trip.id}/backup`, {
      baseTripVersion: adopted.trip.version,
      idempotencyKey: randomUUID(),
    });
    expect(generated.statusCode, generated.body).toBe(200);
    const before = await capture(trip.id);
    const impact = await h.get(owner, `/trips/${trip.id}/impact`);
    const handoff = await h.get(
      owner,
      `/trips/${trip.id}/execution/ground-transit/${adopted.trip.connections[0]!.transport!.id}/route-reevaluation`,
    );
    const backup = await h.get(owner, `/trips/${trip.id}/backup`);
    expect(impact.statusCode, impact.body).toBe(200);
    expect(handoff.statusCode, handoff.body).toBe(200);
    expect(backup.statusCode).toBe(200);
    expect(backup.json().backup).toEqual(generated.json());
    expect(h.inputs).toHaveLength(1);
    onlyWrites(before, await capture(trip.id));
    h.setResult({
      status: 'PROVIDER_UNAVAILABLE',
      reason: 'UPSTREAM_UNAVAILABLE',
    });
    expect((await h.query(owner, adopted.trip)).statusCode).toBe(503);
    onlyWrites(before, await capture(trip.id));
  });
});
