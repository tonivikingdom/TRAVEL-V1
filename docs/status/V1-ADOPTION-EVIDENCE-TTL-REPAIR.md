# I59-01 — Adoption Evidence TTL Race Repair

## Scope and provenance

Recommended model: GPT-6.1 Sol / Extra High; fallback: available Sol / High or Extra High. This task involves lock ordering, transaction rollback and clocks. Escalate review for an unresolved database commit-boundary question. The actual client model configuration is unknown; no automatic model switch is claimed.

- Exact base: `integration/v1-release-readiness`, `9a477ee4998424e45363be998c1e4e807f0490dd`.
- Repair branch: `fix/v1-adoption-evidence-ttl`. PR base remains `integration/v1-release-readiness`; PR #59 and the Provider investigation branches are untouched.
- Production scope: the two existing Prisma Adopt paths and one private evidence predicate. No Query/Preview production edit, TTL change, renewal, buffer, Web workaround or production gate change.
- Public API / contract / Prisma schema / migration delta: **0 / 0 / 0 / 0**. Migration total: **27**.
- Provider requests: **SYNTHETIC only; real/paid requests 0**. Real, task-specific isolated PostgreSQL database `v1_adoption_ttl`; no production database.

## Independent failure reproduced before production edits

The first fixture attempt exposed a Prisma `void` lock-query issue and inconsistent Provider payload/TTL evidence; a second exposed the existing database validity constraint. Those fixture errors were repaired before accepting the reproduction as evidence. No production guard was weakened. The consistent regression suite ran on the original production code: **22 failed / 17 passed**, with no unhandled errors. All 22 failures were the expected HTTP 200 instead of HTTP 409, rather than setup failures.

The same 39 assertions passed after the production repair. Adding external source-row lock cases and valid non-null Provider TTL/replay/Undo cases gives **46 PostgreSQL repair regressions**, all passing. Existing tests were not deleted, skipped or weakened. Filtered runs select I59-01 cases only; full integration runs execute the inherited suite too.

| SYNTHETIC case                                               | Request / expiry / fresh check, UTC | Original production behavior                            | Repaired behavior                                                     |
| ------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| Itinerary owner lock wait                                    | 09:59:01 / 09:59:02 / 09:59:03      | HTTP 200; version 4 → 5; formal writes                  | HTTP 409 `PREVIEW_STALE`; version 4; full rows unchanged              |
| Itinerary Trip lock wait                                     | 09:59:01 / 09:59:02 / 09:59:03      | HTTP 200; version 4 → 5; formal writes                  | HTTP 409 `PREVIEW_STALE`; version 4; full rows unchanged              |
| Fixed BUS, final Outbox insert crosses TTL                   | 09:59:01 / 09:59:02 / 09:59:03      | HTTP 200; version 4 → 5                                 | HTTP 409; all provisional writes rolled back                          |
| Non-fixed aggregate TRANSIT, final Outbox insert crosses TTL | 09:59:01 / 09:59:02 / 09:59:03      | HTTP 200; version 4 → 5                                 | HTTP 409; all provisional writes rolled back                          |
| External Preview-only expiry, owner / Trip lock wait         | 10:29:01 / 10:29:02 / 10:29:03      | HTTP 200; version 5 → 6; materialization/archive writes | HTTP 409; version 5; full rows unchanged                              |
| External final Outbox insert crosses all TTLs                | 10:29:01 / 10:29:02 / 10:29:03      | HTTP 200; version 5 → 6                                 | HTTP 409; materialization, archive and all related writes rolled back |

The vehicle departs at 10:00 (itinerary) or 10:30 (external), so these failures are TTL failures before departure, independent of RWS-02. Lock release follows actual `pg_blocking_pids` evidence. The injected clock advances without sleeping or relying on wall-clock timing. A Prisma test extension advances it only after the last transactional Outbox insert succeeds, so write-phase rejection proves rollback after writes actually occurred.

Sanitized before/after evidence: [before](assets/i59-01/before/) and [after](assets/i59-01/after/). These JSON files contain clocks, HTTP status, table counts and the outcome of full-row equality comparisons, not credentials or user identifiers.

## Transaction guarantee on both adoption paths

1. Acquire the existing owner advisory lock. Locate the owner/Trip/idempotency receipt first; a matching successful request replays its recorded receipt before TTL or version checks. A changed payload retains `IDEMPOTENCY_CONFLICT` priority.
2. For a new adoption, retain the owner-scoped Trip row lock and version priority. Use the existing injected Clock, with the existing request-time lower bound, to check `RoutePreview.expiresAt`, `CandidateSnapshot.expiresAt` and non-null `providerValidUntil`. **Equality is expired: `expiry <= now`.**
3. Itinerary adoption samples after owner/Trip locks. External adoption samples after the owner/Trip locks and external source/affected-node/edge/Ground Transit locks. Existing source evidence, hash, protected facts, adjacency, date ownership and dwell validation remain intact.
4. After every provisional write, including the receipt update and Outbox insertion, sample the Clock again and check all three TTLs. A failure throws the existing `AdoptionAbort('PREVIEW_STALE')`; the encompassing PostgreSQL transaction rolls back before the existing API maps it to HTTP 409.
5. The same two samples retain RWS-02 fixed-departure checking. Aggregate non-fixed TRANSIT is not promoted to a timetable. No Provider ACTUAL or GPS observation creates user execution facts. Request timestamps and Undo window remain unchanged.

Rollback comparisons include complete Trip, nodes, Places, TransportEdges, AdoptedRoutes, Snapshots, Previews, receipts, Outbox, TemporalValues, authoring receipts, dates/occurrences, time intents and dwell suggestions; node/execution/location/watermark/suppression facts; archived transport history and its time values; day projections; Ground Transit executions, observations/transitions; external origins/receipts and jobs. The checks compare row contents, not counts alone.

The existing `RouteCandidateSnapshot_provider_validity_check` requires `Snapshot.expiresAt <= providerValidUntil`. A persisted Provider-only expiry with an unexpired Snapshot is therefore structurally impossible under the unchanged schema. PostgreSQL tests preserve that constraint and cover Provider expiry together with its Snapshot; Unit tests isolate the Provider predicate with the other two deadlines later. Null Provider TTL neither invents an expiry nor disables Preview/Snapshot checks. Candidate payload/hash and Provider TTL are kept consistent before constructing Preview fixtures.

## Regression and validation

- **13 new Unit boundary cases**: independently expired Preview/Snapshot/Provider, exact equality and ±1 ms, null Provider TTL, unchanged immutable evidence across clock advancement.
- **46 new PostgreSQL cases**: owner/Trip lock waits, external source-row waits, each TTL, write-phase rollback for fixed BUS and aggregate TRANSIT, both adoption origins, null/non-null Provider TTL, exact equality, successful Adopt, expired-evidence receipt replay, changed-payload idempotency conflict, original-window Undo, owner isolation and version conflict priority.
- Local frozen install, Prisma generate/validate, clean migration deploy **27**, Lint, Typecheck and Build: PASS.
- Full Unit: **1,184 PASS**, including the inherited departure guard and Provider/secret/proxy tests.
- Full PostgreSQL, Chromium/WebKit and exact final HEAD CI results are recorded in the Draft repair PR body after completion. Old PR #59 CI is not repair evidence. Final CI must run its ordinary verify / Compose / P5B jobs without reducing standards.

Repeat the focused regression on a separately deployed SYNTHETIC database:

```bash
cd apps/api
I59_EVIDENCE_PHASE=after ../../node_modules/.bin/vitest run \
  --config vitest.integration.config.ts \
  test/v1-adoption-evidence-ttl.integration.test.ts \
  test/route-query.integration.test.ts -t I59-01
```

`TEST_DATABASE_URL` must identify the task-owned isolated database. Evidence writes are SYNTHETIC and selected manually by `I59_EVIDENCE_PHASE`; the historical before files are not overwritten by normal after/CI runs.

## Independent Query / Preview audit — outside this repair

Two additional SYNTHETIC PostgreSQL probes reproduced draft-evidence TTL races. They were run separately from the repair suite and confirmed the observed limitations; their successful probe assertions do **not** mean these behaviors satisfy the TTL requirement. Production Query/Preview code is unchanged as instructed.

| Finding                                                                                                  | Reproduction                                                                                                                      | Impact                                                                                                                       | Minimal follow-up                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query snapshot persistence checks departure with fresh clocks, but not evidence TTL                      | Provider valid until 09:59:02; start Query 09:59:01, hold owner lock until 09:59:03 → HTTP 200 and persisted expired Snapshot     | Expired draft evidence may be returned; formal Trip version unchanged                                                        | In `saveCandidateSnapshots` / external equivalent, filter evidence TTL with fresh post-lock time and abort on expiry after inserts, preserving owner/version and existing error semantics |
| Itinerary Preview persistence checks Snapshot TTL with request time and only departure with fresh clocks | Start Preview 09:59:01 from a Snapshot expiring 09:59:02; hold owner lock until 09:59:03 → HTTP 201 and persisted expired Preview | Stale draft Preview can be created; formal Trip version unchanged. New Adopt rejects it with HTTP 409 and zero formal writes | In `createPreview`, use fresh post-lock Snapshot/Provider TTL checks and recheck all draft evidence after insert; audit the external Preview final check too                              |

Sanitized reproduction: [Query](assets/i59-01/audit/query.json), [Preview and repaired Adopt rejection](assets/i59-01/audit/preview.json). No extra Provider call, contract change or independent production repair was introduced. These confirmed limitations remain open for controller-authorized follow-up.

## Remaining timing and release risks

- There is finite latency between the final application Clock sample, transaction return and PostgreSQL COMMIT. This repair checks immediately after the last write, as required; it does not claim an atomic wall-clock predicate at the database commit instant. Clock synchronization and trustworthy server Clock implementation remain operational assumptions. The inherited `Math.max` floor prevents a sampled backward clock from reducing elapsed request/transaction time, but cannot repair clock synchronization itself.
- Evidence TTL does not certify boardability, vehicle delay/cancellation, capacity or operator truth. RWS-02 remains a separate preserved safeguard; receipt replay is a replay of an earlier adoption, not a fresh boarding decision.
- The two confirmed draft Query/Preview TTL races above are not repaired in this Adopt-only change.
- All inherited production approval gates remain unchanged: real Provider entitlement and reliability, F-05/F-06, storage/retention/TTL/deletion/attribution/quota/pricing/coverage, Japan staging/production prohibition, map SDK limits, operator timetable/fare/cross-midnight truth and physical iPhone/Safari/keyboard acceptance remain OPEN/PARTIAL as recorded at the base.
- Draft only. No main merge, deployment, production enablement, PR #59 source change, Provider branch change or next batch.

## P5E2 follow-up on this repair branch

The failed Compose acceptance at starting HEAD `c6acff57ca4a70a0e4b73675148bcffbf265124d` was independently reproduced as an execution-calendar provenance defect: event-linked ACTUAL values serialize UTC, which was incorrectly preferred as the origin's local calendar. The separately authorized [P5E2 UTC/Tokyo repair](P5E2-DEPARTURE-CALENDAR-REPAIR.md) excludes those linked values from calendar timezone selection while preserving their execution facts. The canonical fixture and original Compose negative assertion remain unchanged. I59-01 TTL transactions and all existing RWS-02 checks remain intact. Query/Preview draft TTL races above remain the next task; the P5E2 repair does not implement them. Final combined HEAD verification is recorded in Draft PR #61.
