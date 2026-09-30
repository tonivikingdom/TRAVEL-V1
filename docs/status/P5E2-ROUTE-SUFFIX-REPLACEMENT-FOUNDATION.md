# P5E2 Batch 4A — Route Suffix Replacement Foundation

- Recommended model: GPT-6 Astra / High. Backup: GPT-6.1 Sol / High. Query, Preview, adoption and deterministic Undo share topology and transactional fact protection, which merits the recommended reasoning level. Escalate to Extra High if a concurrency/history invariant remains unresolved. The task does not claim to change the client's actual model configuration; it is unconfirmed.
- Starting main: `c03272eb24862367df5be747f7077c9bfe95c6d4`.
- Branch: `feature/p5e2-route-suffix-replacement-foundation`.
- Implementation HEAD (cloud/CI validated): `aef15e5d35df51e93d9ce3229538de87625720f0`. Documentation-only follow-ups are identified by the current PR head.
- Status: cloud acceptance PASS; [Draft PR #33](https://github.com/tonivikingdom/TRAVEL-V1/pull/33) and independent [CI Run 36680289025](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/36680289025) PASS. Keep Draft and wait for merge review.
- Schema / migrations: unchanged; `route-adopt-delta-v4` evolves the receipt JSON contract.

Batch 4A establishes safe suffix Query / Preview / Adopt / Undo infrastructure. Given an ACTIVE route R1 `A → B → C → D`, explicit queries `B → D` and `C → D` can replace only the future suffix. `A → D` retains FULL_CORRIDOR behavior. A replacement query reuses `{ basisVersion, fromNodeId, toNodeId, hint }` and existing CandidateSnapshot/time algorithms.

**Batch 3 handoff still returns ORIGIN_UNRESOLVED for progressed execution. Live-origin handoff activation is deferred to Batch 4B.** No Batch 3 readiness, execution-origin selection or timezone fallback policy is enabled by this batch. An explicit suffix request uses reliable origin-local timezone evidence. The suffix infrastructure itself has no ACTUAL-arrival prerequisite.

## PR #33 blocking review repair

Reviewed HEAD: `ded697c30fc89edf8ca961b7ef37903bc06c4f20`. The repair stays on the original feature branch and Draft PR; starting main is unchanged. The original acceptance evidence below describes the pre-review implementation. Repair validation is recorded separately here.

The real PostgreSQL reproduction used an unmodified generated-node fixture with no ACTUAL, notes or user time constraints: adopt R1 `A → B → C → D`, explicitly adopt R2 `B → X → D`, undo R2, then preview a full `A → Y → D` candidate that removes B/C. On the reviewed implementation Preview incorrectly returned adoptable. Calling the persistence Adopt path raised Prisma P2003 at `prisma-route-adoption.ts:497`, `transaction.itineraryNode.deleteMany`, on `AdoptedRoute_anchorFromNodeId_tripId_fkey`; the HTTP Adopt returned unexpected 503. The transaction rolled back, but database FK rejection occurred after replacement writes had been attempted.

`prisma-node-deletion-protection.ts` now defines a shared relation selection and fact mapper used by the owner-scoped Trip read and locked Adopt node read. It checks both anchorFrom and anchorTo references without any route-status filter. It also checks node → CandidateSnapshot → Preview deletion cascades: a snapshot retained by an AdoptedRoute, or a Preview retained by an AdoptedRoute or any OperationReceipt, makes the endpoint's deletion unsafe. Ordinary unadopted snapshots/previews remain temporary and can cascade normally.

The Application helper maps these facts to `REFERENCED_BY_ADOPTED_ROUTE` and `REFERENCED_BY_RETAINED_PLANNING_DATA`. Preview applies them only to generated `nodesToRemove`, marks those nodes protected, and emits the existing `protectedBlockingNodes`, `status = BLOCKED`, `adoptable = false`. It does not alter the candidate to retain an unwanted node. Existing ACTUAL/user-content rules still apply to reused mutable suffix nodes; the new reference rule permits reuse of an original node ID.

Adopt reloads the same references inside the existing owner advisory lock and Trip row lock, before changing route lifecycle, edges, receipts or nodes. It returns `PREVIEW_BLOCKED` even when an older stored Preview was adoptable. Normal version fencing remains first, and rejection leaves the durable trip, routes, nodes, edges, histories, planning evidence, execution evidence, receipts and outbox unchanged. No FK exception is used as the normal control path.

Five regression groups add eight real PostgreSQL tests:

| Group | Regression                                                                                                                                                                                                                                 | Result         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| A     | Undo suffix from B, then full candidate deletes historical anchor B; Preview BLOCKED, HTTP Adopt 409/PREVIEW_BLOCKED, durable state unchanged                                                                                              | PASS           |
| B     | Undo suffix from C, then earlier B→D candidate deletes historical anchor C; same protection under SUFFIX                                                                                                                                   | PASS           |
| C     | Full candidate legally reuses historical anchor B with its original ID; adoption succeeds and UNDONE route reference remains valid                                                                                                         | PASS           |
| D     | Only unadopted B→D Query/Preview exists; later full adoption succeeds, removes B and cascades temporary planning data                                                                                                                      | PASS           |
| E     | Preview precedes new anchorFrom, anchorTo, retained snapshot or receipt reference; direct persistence Adopt rechecks inside locks, blocks without writes; refreshed Preview agrees and changed Trip.version still returns VERSION_CONFLICT | PASS (4 cases) |

The E fixtures insert new persistent records without changing Trip.version solely to isolate the transactional reference check. They do not rewrite existing historical anchor IDs. The anchorTo fixture uses REPLACED; the anchorFrom fixture uses UNDONE. The retained-snapshot and receipt cases have no direct historical anchor reference to the removed node, proving cascade protection independently.

No schema change or migration is added. Historical routes, receipts, observations and transitions are preserved. FULL_CORRIDOR/SUFFIX, v2/v3/v4, ACTUAL protection, Undo, monitoring and owner isolation retain their policies. **Batch 3 progressed execution still returns ORIGIN_UNRESOLVED; 4B live-origin activation remains deferred.** No automatic Query/Preview/Adopt or paid provider is enabled; F-05/F-06/F-07/F-08 remain open.

Repair cloud validation: frozen install, Prisma generate/validate, format/lint/full typecheck PASS; Unit 47 files / 547 tests PASS. A new disposable PostgreSQL 17 database `travel_cloud_pr33_repair_clean` applied all 20 existing migrations from empty and is up to date. Full PostgreSQL integration: 26 files / 329 tests (Persistence 17/75, API 9/254) PASS; build and API/Worker regressions PASS. Compose explicit suffix Adopt/Undo and full runtime acceptance PASS with separately recorded runner returncode 0. P5B PASS: 5 users / 200 requests / 200 success / 0 isolation failures / 0 unexpected 5xx / 0 network failures; median 410.9 ms, p95 558.21 ms. Final-head independent CI is checked before the completion response and linked from the original Draft PR.

Cloud acceptance diagnostics: the first Compose attempt failed during PostgreSQL startup before business checks; an isolated container with the same configuration initialized healthy. A later repeat build explicitly failed with no disk space. Known completed synthetic test images and old unused build layers were cleaned after inspecting the inventory, and the images were rebuilt sequentially. The final complete run used `COMPOSE_PARALLEL_LIMIT=1`, passed every chain, returned 0, and cleaned its disposable resources. Reusable cloud startup guidance now also limits runner build parallelism and keeps host source/generated outputs stable during container builds. These are environment-only corrections, with no repository Docker/schema change.

## Shared corridor policy and contracts

`packages/domain/src/route-replacement-corridor.ts` supplies the pure, provider-neutral `resolveCurrentRouteReplacementCorridor`. The Application record adapter and locked Prisma adapter both call it: Query eligibility, Preview scope, CandidateSnapshot persistence eligibility and transactional Adopt validation have one topology policy. The obsolete persistence adjacency helper is now named `isCurrentRouteCorridor` while its public failure contract is retained.

The result carries `replacementScope`, `sourceAdoptedRouteId`, source route anchors, replacement anchors, replacement node/edge IDs, and preserved prefix node/edge IDs. The prefix node list includes the shared replacement origin. SUFFIX requires an internal PLACE_VISIT owned by one ACTIVE source route, its original anchorTo as destination, an intact generated-node ownership invariant, exactly one source-owned edge per adjacency, and unambiguous complete source topology. Missing, mixed, replaced or ambiguous source routes are unsupported. An arbitrary middle segment or prefix is unsupported unless independently legal under the existing ordinary adjacency policy.

Preview's existing `routeCorridor.anchorFromNodeId`, `anchorToNodeId`, `currentNodeIds` and `currentAdoptedRouteId` keep their replacement-corridor meaning. Optional additive fields identify scope, original source anchors, replacement anchors and preserved prefix IDs, so legacy Preview JSON remains readable. For SUFFIX `willReplaceTransportEdgeIds` contains only future suffix edges. Neither endpoint can enter generated-node remove/reuse plans, even when the origin has `source = ROUTE_GENERATED`.

Protection applies to mutable internal nodes and replaced edges. Origin ACTUAL and prefix ACTUAL are allowed; internal suffix ACTUAL or suffix-edge ACTUAL blocks Preview/Adopt, and locked adoption rechecks facts arriving after Preview. Internal generated-node user content/ownership protections remain enforced. FULL_CORRIDOR continues emitting v3 receipts and retains its existing Preview/Adopt/Undo semantics, including existing transactional edge protection.

## Adoption, history and monitoring

Adopting `B → X → D` transitions R1 to REPLACED using its original `A → D` anchors. It archives only `B → C` and `C → D`, removes only safely replaceable suffix internal nodes, and creates ACTIVE R2 anchored at `B → D`. R2 receives current edges, PLANNED facts, route-generated nodes, ground-transit baselines and day projections through the existing persistence path.

The prefix `A → B` is neither archived nor deleted/recreated. Its ID, original `adoptedRouteId = R1`, provider metadata, temporal rows, ACTUAL facts, day projections and execution history remain authentic. A prefix edge sourced from a REPLACED route is intentional historical execution evidence. Current monitoring and handoff checks still use `AdoptedRoute.status === ACTIVE`.

Old GroundTransitLegExecution rows, observations and state transitions survive archived/deleted suffix edges because their historical edge identity has no current-edge foreign key. New suffix edges receive new execution baselines. Existing cancellation cancels queued R1 jobs and requests cancellation of running R1 jobs. The existing scheduler discovers ACTIVE R2 through the unchanged trip-level ENABLED capability. No additional monitor lifecycle is introduced.

## V4 receipt and deterministic Undo

SUFFIX writes `route-adopt-delta-v4`, retaining every necessary V3 field and recording scope, previous active route ID, source anchors, replacement anchors, prefix node/edge IDs, a canonical prefix hash, original archived suffix edge IDs, and their history IDs. Prefix evidence includes immutable node ownership/content/time facts and complete preserved edge/fact/projection rows; timeline renumbering metadata is excluded. The hash is captured after any explicitly accepted origin dwell adjustment so immediate Undo can validate and restore that adjustment.

Undo reads v2/v3/v4. Legacy full-corridor receipts retain strict old/new anchor equality. SUFFIX instead requires common original/replacement anchorTo, the recorded internal replacement origin, exact preserved prefix topology/evidence, precisely owned old suffix histories, and a current R2 corridor matching the receipt. It reconstructs the old source topology from V4 prefix IDs and archived/generated-node snapshots and verifies it with the shared resolver, rather than guessing the prior route.

Successful Undo sets R2 UNDONE and R1 ACTIVE, deletes R2's suffix edges/nodes, restores old suffix IDs and generated nodes, consumes exactly the archived suffix histories, restores projections/day occurrences/node placement/date ownership and accepted dwell adjustments, and increments Trip.version once. The prefix is kept throughout with the same edge IDs and ACTUAL rows. Adopt and Undo replays reuse their existing owner-scoped idempotent receipts.

New R2 execution facts, modified prefix evidence, altered topology or inconsistent delta/history return UNDO_CONFLICT. Stale Trip versions/source routes/origin ownership/suffix topology fence Query/Preview/Adopt through VERSION_CONFLICT/PREVIEW_STALE. Owners and administrators cannot read or operate on another owner's trip, candidate, preview or receipts.

## Verification evidence

The cloud is the first complete acceptance environment: Node 24.19.0, pnpm 11.19.0 and PostgreSQL 17.11. A dedicated disposable `travel_cloud_p5e2_4a_clean` database applied all 20 existing migrations from empty and reported up to date. No migration was added. Credentials, environment files and local build/network configuration remain outside Git.

- Frozen lockfile installation, Prisma generate/validate, format:check, lint, full typecheck and build: PASS.
- Unit: 47 files / 547 tests, including 11 new corridor cases and existing Worker/Batch 3 timezone/handoff regressions: PASS.
- PostgreSQL integration: 26 files / 321 tests (Persistence 17/75, API 9/246): PASS.
- The Route Query integration file includes 24 new Batch 4A scenarios alongside 54 existing regressions. Coverage includes full/early/later suffix, no required origin ACTUAL, prefix departure/arrival ACTUAL, protected mutable suffix, ACTUAL after Preview, concurrent Adopt, legacy Preview and v2/v3 reading, V4 Adopt/Undo/idempotency, cross-day projections/placement, accepted origin dwell restoration, historical execution retention, monitor cancellation/scheduling, stale topology/version and owner isolation.
- API/Worker regression: existing job/lease/retry/cancellation, flight/ground execution and monitoring tests pass as part of the full Unit/PostgreSQL suites. Progressed Batch 3 handoff remains ORIGIN_UNRESOLVED.
- Docker Compose verification: PASS, exit 0; live/ready, durable Job delivery, Adopt/Undo receipts/outbox, lease recovery, database outage/recovery, Worker SIGTERM, PostgreSQL persistence and private object-volume write/restart/delete all passed. Existing F-09 and P5E2 Batch 1/2/3 chains also passed.
- Compose explicit suffix Adopt and Undo chains: PASS, including unchanged prefix ACTUAL/execution and Undo replay.
- P5B: PASS, exit 0; 5 synthetic users / 200 requests / 200 success / 0 isolation failures / 0 unexpected 5xx / 0 network failures. Median 356.36 ms, p95 516.34 ms, maximum 533.9 ms; existing P5C flow PASS.
- Independent [GitHub CI Run 36680289025](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/36680289025) on implementation HEAD `aef15e5d35df51e93d9ce3229538de87625720f0`: `verify`, `Compose verification`, and `P5B acceptance` all SUCCESS. Final documentation-only HEAD is checked again before the completion report.

The Compose runner imports `scripts/verify-route-suffix-chain.mjs`. Its synthetic-only HTTP chain explicitly queries `A → D`, previews and adopts R1, records user prefix/B ACTUAL and a test-only completed ground-leg fixture, explicitly queries `B → D`, previews SUFFIX and adopts R2. It checks source lifecycle, retained prefix identity/facts/execution, archived suffix and current replacement; then explicitly undoes R2 and checks original IDs, placements, history consumption, unchanged prefix ACTUAL and Undo replay. The same runner is already invoked by the CI Compose job, so CI executes the added chain independently.

Cloud Compose builds use the verified mirrored base images and platform CA/proxy settings outside the repository, retaining TLS checks. Builds run sequentially to limit duplicate layers; obsolete synthetic test images and failed build containers were removed after a cloud disk-space failure, then builds completed. Before container builds, only ignored generated TypeScript incremental metadata is removed to avoid copying host cache without excluded `dist` output. These cloud prerequisites do not change product behavior or CI's clean-checkout build.

## Completion checklist

| Item                        | Result                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1 Branch                    | `feature/p5e2-route-suffix-replacement-foundation`                                                                        |
| 2 HEAD                      | Implementation/cloud/CI HEAD `aef15e5d35df51e93d9ce3229538de87625720f0`; use PR head for documentation-only follow-ups.   |
| 3 Draft PR                  | [#33](https://github.com/tonivikingdom/TRAVEL-V1/pull/33), OPEN/Draft; do not Ready/Merge.                                |
| 4 Starting main             | `c03272eb24862367df5be747f7077c9bfe95c6d4`                                                                                |
| 5 replacementScope contract | FULL_CORRIDOR / SUFFIX; additive Preview metadata and V4 suffix receipt.                                                  |
| 6 FULL_CORRIDOR behavior    | Existing behavior and v3 emission retained; regression passes.                                                            |
| 7 SUFFIX eligibility        | Internal PLACE_VISIT to original anchorTo; intact, unambiguous ACTIVE ownership.                                          |
| 8 Shared resolver           | Pure Domain resolver consumed by Application and locked Prisma adapters.                                                  |
| 9 Query B→D                 | Supported explicitly, preserving existing time/hint policy.                                                               |
| 10 Snapshot persistence     | Same shared corridor eligibility; snapshots retain B/D endpoints.                                                         |
| 11 Preview suffix semantics | Only suffix changes/edge replacement set.                                                                                 |
| 12 Replacement origin       | Endpoint protected from remove/reuse; origin ACTUAL allowed.                                                              |
| 13 Preserved prefix         | Original IDs/source/temporal facts/projections/history kept.                                                              |
| 14 Suffix ACTUAL            | Mutable suffix nodes/edges block replacement; locked recheck.                                                             |
| 15 Old source lifecycle     | R1 ACTIVE → REPLACED; original anchors used.                                                                              |
| 16 New route lifecycle      | R2 ACTIVE with B/D anchors and new baselines.                                                                             |
| 17 Ground history           | Old observations/state transitions retained, prefix execution unmodified.                                                 |
| 18 Monitoring               | Existing queued cancellation/running cancelRequested and capability scheduler.                                            |
| 19 Delta v4                 | JSON evolution with source/replacement/prefix/history evidence; v2/v3/v4 read.                                            |
| 20 Undo suffix              | R1 ACTIVE, R2 UNDONE, old suffix IDs/nodes/projections/placement/dwell restored.                                          |
| 21 Undo after new ACTUAL    | UNDO_CONFLICT, no overwritten execution facts.                                                                            |
| 22 Stale/version fencing    | Existing version locks plus shared topology and preview hash validation.                                                  |
| 23 Schema/migration         | None added.                                                                                                               |
| 24 Unit                     | 547 passed.                                                                                                               |
| 25 PostgreSQL integration   | 321 passed.                                                                                                               |
| 26 Clean migration          | PostgreSQL 17; 20 existing migrations from empty, up to date.                                                             |
| 27 Worker regression        | PASS in full Unit/PostgreSQL suites and Compose runtime/recovery/SIGTERM.                                                 |
| 28 Compose suffix chain     | PASS: explicit Query/Preview/Adopt; source REPLACED, suffix ACTIVE, prefix preserved.                                     |
| 29 Compose Undo chain       | PASS: R1 ACTIVE/R2 UNDONE, original IDs/placements/history restored, prefix ACTUAL unchanged.                             |
| 30 P5B                      | PASS: 5 users, 200 requests, zero isolation/5xx/network failures.                                                         |
| 31 Cloud validation         | PASS: locked install, Prisma, format/lint/typecheck, Unit, clean migrations/integration, build, API/Worker, Compose, P5B. |
| 32 GitHub CI Run            | [36680289025](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/36680289025), implementation SHA verified.          |
| 33 verify                   | SUCCESS in independent GitHub CI; final documentation-only HEAD checked before completion report.                         |
| 34 Compose verification     | SUCCESS in independent GitHub CI, including suffix Adopt and Undo.                                                        |
| 35 P5B CI                   | SUCCESS: 5 users / 200 requests / zero isolation/5xx/network failures.                                                    |
| 36 Automatic Query          | No.                                                                                                                       |
| 37 Automatic Preview        | No.                                                                                                                       |
| 38 Automatic Adopt          | No.                                                                                                                       |
| 39 Real paid Provider       | No.                                                                                                                       |
| 40 Batch 3 live-origin      | Still disabled; progressed execution remains ORIGIN_UNRESOLVED.                                                           |
| 41 F-05/F-06/F-07/F-08      | Remain open.                                                                                                              |
| 42 Blocker                  | None. Cloud and independent CI PASS; stop at Draft PR pending review.                                                     |

No arbitrary middle/prefix/subcorridor or GPS origin, mid-edge/onboard replanning, automatic next train, real Ground Transit Provider, Push, formal Desktop/Mobile UI, staging or production work is implemented. Stop at a green Draft PR and wait for review.
