import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdoptRoutePreviewResponse,
  RoutePreviewView,
  TripView,
} from '@travel/contracts';
import type { RouteProviderResult } from '@travel/application';
import {
  bearer,
  gate,
  replanningHarness,
  type SyntheticOwner,
} from './helpers/replanning-acceptance.js';
import {
  adoptionFootprint,
  setSyntheticSnapshotExpiry,
  ttlAdoptionApi,
  ttlEvidence,
  waitForAdoptionLock,
} from './helpers/adoption-evidence-ttl.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('TEST_DATABASE_URL required for SYNTHETIC TTL acceptance');
const requestAt = new Date('2030-10-01T09:59:01Z');
const expiresAt = new Date('2030-10-01T09:59:02Z');
const afterExpiry = new Date('2030-10-01T09:59:03Z');
const later = new Date('2030-10-01T10:08:00Z');
type Kind = 'preview' | 'snapshot' | 'provider' | 'all';

describe('I59-01 ITINERARY_NODE evidence TTL — SYNTHETIC Provider / real PostgreSQL', () => {
  let h: ReturnType<typeof replanningHarness>;
  let owner: SyntheticOwner;
  beforeEach(async () => {
    h = replanningHarness(databaseUrl);
    h.setNow(new Date('2030-10-01T09:59:00Z'));
    owner = await h.identity();
  });
  afterEach(async () => {
    await h.close();
  });

  async function prepared(
    mode: 'BUS' | 'TRANSIT' = 'BUS',
    kind: Kind = 'all',
    nullable = false,
  ) {
    let trip = await h.seed(owner);
    const event = await h.post(owner, `/trips/${trip.id}/execution/events`, {
      baseTripVersion: trip.version,
      idempotencyKey: randomUUID(),
      type: 'MANUAL_ARRIVAL',
      nodeId: trip.days[0]!.nodes[0]!.id,
      occurredAt: '2030-10-01T09:59:00Z',
    });
    expect(event.statusCode, event.body).toBe(200);
    trip = (await h.get(owner, `/trips/${trip.id}`)).json<TripView>();
    const location = (index: number) => ({
      name: trip.days[0]!.nodes[index]!.place!.name,
      latitude: trip.days[0]!.nodes[index]!.place!.latitude,
      longitude: trip.days[0]!.nodes[index]!.place!.longitude,
      providerPlaceRef: null,
    });
    const departure = {
      instant: new Date('2030-10-01T10:00:00Z'),
      timeZone: 'UTC',
    };
    const arrival = {
      instant: new Date('2030-10-01T11:00:00Z'),
      timeZone: 'UTC',
    };
    const result: RouteProviderResult = {
      status: 'SUCCESS',
      candidates: [
        {
          candidateId: 'SYNTHETIC:I59',
          provider: 'SYNTHETIC',
          providerCandidateRef: null,
          observedAt: new Date('2030-10-01T09:59:00Z'),
          validUntil: null,
          departure,
          arrival,
          durationSeconds: 3600,
          fare: null,
          legs: [
            {
              mode,
              from: location(0),
              to: location(1),
              departure,
              arrival,
              durationSeconds: 3600,
              fixedService: mode === 'BUS',
              serviceLabel: mode === 'BUS' ? 'SYNTHETIC fixed BUS' : null,
              providerRef: 'SYNTHETIC:I59',
            },
          ],
        },
      ],
    };
    h.setResult(result);
    const queried = await h.query(owner, trip);
    expect(queried.statusCode, queried.body).toBe(200);
    const snapshotId = queried.json().candidates[0]
      .candidateSnapshotId as string;
    await setSyntheticSnapshotExpiry(
      h.managed,
      snapshotId,
      // PostgreSQL requires Snapshot.expiresAt <= providerValidUntil.
      kind === 'snapshot' || kind === 'provider' || kind === 'all'
        ? expiresAt
        : later,
      nullable
        ? null
        : kind === 'provider' || kind === 'all'
          ? expiresAt
          : later,
    );
    const previewResponse = await h.preview(owner, trip, snapshotId);
    expect(previewResponse.statusCode, previewResponse.body).toBe(201);
    const preview = previewResponse.json<RoutePreviewView>();
    expect(preview.adoptable).toBe(true);
    await h.client.routePreview.update({
      where: { id: preview.previewId },
      data: {
        expiresAt: kind === 'preview' || kind === 'all' ? expiresAt : later,
      },
    });
    return { trip, preview };
  }

  for (const lock of ['owner', 'Trip'] as const) {
    it.each(['preview', 'snapshot', 'provider', 'all'] as const)(
      `${lock} lock wait crossing %s TTL rejects without any writes`,
      async (kind) => {
        const { trip, preview } = await prepared('BUS', kind);
        h.setNow(requestAt);
        const before = await adoptionFootprint(h.managed, trip.id, owner.id);
        const held = gate(),
          release = gate();
        let pid = 0;
        const holder = h.client.$transaction(
          async (tx) => {
            pid = (
              await tx.$queryRaw<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            )[0]!.pid;
            if (lock === 'owner')
              await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${owner.id},2))`;
            else
              await tx.$queryRaw`SELECT id FROM "Trip" WHERE id=${trip.id}::uuid FOR UPDATE`;
            held.release();
            await release.pending;
          },
          { timeout: 15000 },
        );
        await held.pending;
        const request = h.adopt(owner, trip, preview);
        try {
          await waitForAdoptionLock(h.managed, pid);
          h.setNow(afterExpiry);
          release.release();
          const r = await request;
          const after = await adoptionFootprint(h.managed, trip.id, owner.id);
          if (kind === 'all')
            await ttlEvidence(`itinerary-${lock}-wait`, before, after, {
              requestAt: requestAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              checkedAt: afterExpiry.toISOString(),
              httpStatus: r.statusCode,
              errorCode: r.json().error?.code ?? null,
            });
          expect(r.statusCode, r.body).toBe(409);
          expect(r.json().error.code).toBe('PREVIEW_STALE');
          expect(after).toEqual(before);
        } finally {
          release.release();
          await holder;
          await request;
        }
      },
    );
  }

  for (const mode of ['BUS', 'TRANSIT'] as const) {
    it.each(['preview', 'snapshot', 'provider', 'all'] as const)(
      `${mode} tentative writes crossing %s TTL roll back the complete transaction`,
      async (kind) => {
        const { trip, preview } = await prepared(mode, kind);
        h.setNow(requestAt);
        const before = await adoptionFootprint(h.managed, trip.id, owner.id);
        let now = requestAt,
          observedWrites = 0;
        const app = ttlAdoptionApi(
          h.managed,
          () => now,
          () => {
            observedWrites++;
            now = afterExpiry;
          },
        );
        try {
          const r = await app.inject({
            method: 'POST',
            headers: bearer(owner),
            url: `/trips/${trip.id}/previews/${preview.previewId}/adopt`,
            payload: {
              baseTripVersion: trip.version,
              idempotencyKey: randomUUID(),
            },
          });
          const after = await adoptionFootprint(h.managed, trip.id, owner.id);
          if (kind === 'all')
            await ttlEvidence(
              `itinerary-${mode.toLowerCase()}-writes`,
              before,
              after,
              {
                requestAt: requestAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
                checkedAt: now.toISOString(),
                observedTentativeOutboxWrites: observedWrites,
                httpStatus: r.statusCode,
                errorCode: r.json().error?.code ?? null,
              },
            );
          expect(observedWrites).toBe(1);
          expect(r.statusCode, r.body).toBe(409);
          expect(r.json().error.code).toBe('PREVIEW_STALE');
          expect(after).toEqual(before);
        } finally {
          await app.close();
        }
      },
    );
  }

  it.each(['preview', 'snapshot', 'provider'] as const)(
    'exact equality at %s expiry rejects',
    async (kind) => {
      const { trip, preview } = await prepared('BUS', kind);
      const before = await adoptionFootprint(h.managed, trip.id, owner.id);
      h.setNow(expiresAt);
      const r = await h.adopt(owner, trip, preview);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error.code).toBe('PREVIEW_STALE');
      expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
        before,
      );
    },
  );
  it.each([
    ['BUS', false],
    ['BUS', true],
    ['TRANSIT', false],
    ['TRANSIT', true],
  ] as const)(
    '%s valid evidence with provider TTL null=%s adopts, replays after expiry and can Undo',
    async (mode, nullable) => {
      const { trip, preview } = await prepared(mode, 'all', nullable);
      h.setNow(requestAt);
      const key = randomUUID();
      const first = await h.adopt(owner, trip, preview, key);
      expect(first.statusCode, first.body).toBe(200);
      const accepted = first.json<AdoptRoutePreviewResponse>();
      expect(accepted.operationReceipt.undoExpiresAt).toBe(
        '2030-10-01T10:09:01.000Z',
      );
      h.setNow(afterExpiry);
      const before = await adoptionFootprint(h.managed, trip.id, owner.id);
      const replay = await h.adopt(owner, trip, preview, key);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json<AdoptRoutePreviewResponse>().operationReceipt).toEqual(
        accepted.operationReceipt,
      );
      expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
        before,
      );
      const conflictingReplay = await h.adopt(
        owner,
        accepted.trip,
        preview,
        key,
      );
      expect(conflictingReplay.statusCode, conflictingReplay.body).toBe(409);
      expect(conflictingReplay.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
        before,
      );
      const undone = await h.undo(owner, accepted);
      expect(undone.statusCode, undone.body).toBe(200);
      expect(undone.json<AdoptRoutePreviewResponse>().trip.version).toBe(
        accepted.trip.version + 1,
      );
      expect(
        (await adoptionFootprint(h.managed, trip.id, owner.id)).execution,
      ).toEqual(before.execution);
    },
  );
  it('null provider TTL still rejects an expired Snapshot', async () => {
    const { trip, preview } = await prepared('TRANSIT', 'snapshot', true);
    h.setNow(afterExpiry);
    const before = await adoptionFootprint(h.managed, trip.id, owner.id);
    const r = await h.adopt(owner, trip, preview);
    expect(r.statusCode, r.body).toBe(409);
    expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
      before,
    );
  });
  it('owner isolation and version conflict retain priority', async () => {
    const { trip, preview } = await prepared();
    h.setNow(afterExpiry);
    const stranger = await h.identity();
    const before = await adoptionFootprint(h.managed, trip.id, owner.id);
    expect((await h.adopt(stranger, trip, preview)).statusCode).toBe(404);
    expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
      before,
    );
    await h.note(owner, trip);
    const changed = await adoptionFootprint(h.managed, trip.id, owner.id);
    const r = await h.adopt(owner, trip, preview);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe('VERSION_CONFLICT');
    expect(await adoptionFootprint(h.managed, trip.id, owner.id)).toEqual(
      changed,
    );
  });
});
