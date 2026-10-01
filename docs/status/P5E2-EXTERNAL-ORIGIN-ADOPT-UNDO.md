# P5E2 Batch 5B2B — External-Origin Adopt, Materialization & Undo

推荐模型：GPT-6 Astra / High。实际会话模型配置无法从执行环境核验；没有声称提示词自动切换模型。备选和升级条件：不降级；若 nullable composite relation 无法表达，或需要 external execution mapping，则暂停对应能力并回报。当前 Prisma 已验证 nullable same-Trip composite Restrict relation，未触发停止条件。

Starting main: `5653ad561f27a8a7b80bd8747f720871a6ef8f7c`.
Branch: `feature/p5e2-external-origin-adopt-undo`.
Delivery: continue Draft PR #37; no Ready, Merge, or deployment.

## Product behavior

A CURRENT durable external execution origin E can now be explicitly adopted from a newly generated external v2 Preview. For R1 `A → B → C → D`, with source edge `B → C`, adoption preserves `A → B`, archives `B → C` and `C → D`, removes safe abandoned generated nodes, materializes E after B, and creates R2 `E → … → D`. The timeline is `A, B, E, …, D`; B→E has no TransportEdge. Its ordinary connection view is MISSING. No walking, manual, or synthetic transport fills that execution-history gap.

Explicit Undo restores `A → B → C → D`, old edge IDs, original generated-node metadata/placement, day projections, date ownership/effective range, and accepted dwell adjustments. It deletes the formal E Node and adoption-created Place. R1 returns ACTIVE. R2 remains UNDONE with its live E anchor detached and its immutable historical anchor snapshot retained. ExternalExecutionOrigin E, arrival receipts, and Ground Transit observations/transitions are retained. This returns to Batch 5B1 planning capability; it does not undo execution history or automatically query again.

## Anchor schema and migration

Exactly one migration is added: `20261001100000_p5e2_external_origin_adoption` (22 → 23). No historical migration is edited.

`AdoptedRouteAnchorOriginKind` is ITINERARY_NODE or EXTERNAL_EXECUTION_ORIGIN. `anchorFromNodeId` becomes nullable, retaining the same `(anchorFromNodeId, tripId) → ItineraryNode(id, tripId)` FK and ON DELETE RESTRICT. The relation is optional in Prisma; Trip ownership remains required.

Existing routes default to ITINERARY_NODE and retain their live anchor and old semantic data. The CHECK requires their live anchor and null external ID/snapshot. External routes require an external-origin ID and object snapshot. ACTIVE requires a live anchor; UNDONE requires null live anchor; REPLACED permits either. `anchorFromExternalOriginId` is copied historical evidence without an execution-origin FK.

`external-adopted-route-anchor-v1` stores copied `external-route-origin-v1` evidence plus materialized Node, Place, DayOccurrence IDs and localDate. Only status, live-anchor detachment and undoneAt change on Undo. The historical anchor, candidate snapshot and original adoption receipt remain intact.

The existing generated-node CHECK requires route/receipt ownership at creation. A transaction-private USER_PLANNED stub with null ownership breaks that creation cycle. After R2 and its receipt exist, E is atomically set to ROUTE_GENERATED with R2/receipt ownership. The old CHECK is retained; no temporary state is committed or exposed.

## Preview compatibility

- Node `route-adoption-preview-v3`: unchanged, including FULL_CORRIDOR, SUFFIX, historical reference protection and normal Adopt/Undo.
- External `route-external-origin-preview-v1`: remains supported for GET but ADOPT_UNSUPPORTED/adoptable=false; Adopt returns 422 PREVIEW_UNSUPPORTED even after departure. Old previews are never promoted.
- New external `route-external-origin-preview-v2`: safe ACTIVE/adoptable=true; protected node/transport or infeasible downstream plan remains BLOCKED/adoptable=false.

Query and Preview still do not change the formal Trip or Trip.version. The shared external plan builder and topology resolver remain authoritative. Trusted E/D endpoint binding, IANA timezone, freshness, departure floor, downstream constraints, leg provenance and external currentness are recomputed for new Preview and locked Adopt.

## External Adopt transaction

The existing owner advisory lock, Trip FOR UPDATE and READ COMMITTED boundary are reused. Receipt replay is checked first: same key/hash returns the original receipt; changed payload returns IDEMPOTENCY_CONFLICT. Expired Preview or replaced source route cannot invalidate a successful replay.

Before formal writes, the dedicated external path verifies ownership/version, external v2 policy and preview hash; re-reads the snapshot, current external origin, exact ACTIVE source route, current source edge and source GroundTransit leg; then recomputes the complete plan and compares its hash. It validates provider TTL/validUntil, server-now departure floor, endpoint identity, origin copied evidence, prefix, suffix, removal/reuse facts, transport classification, downstream constraints and exact accepted user adjustments.

Replacement and prefix TransportEdge rows, existing TemporalValue rows, and removal/reuse/prefix/destination ItineraryNode rows with temporal/time-intent facts are locked. Place rows are also locked. Parent row locks serialize new FK child inserts. A new non-Provider ACTUAL blocks adoption with PREVIEW_BLOCKED; new Provider ACTUAL that changes the archival classification makes the old plan PREVIEW_STALE. Rejected requests leave no materialization, archival, route, receipt, version or outbox writes.

E uses trusted server-owned name/coordinates/providerHubRef. It is PLACE_VISIT, ROUTE_GENERATED, autoReplaceable, unmodified, without note, providerPlaceRef, ACTUAL, ExecutionEvent or time intent. Its localDate derives from candidate departure in E's trusted timezone. A unique Preview DayOccurrence is strictly reused; null creates a distinct occurrence, including repeated-date ambiguity. Tail occurrences are split only when needed to keep E immediately after divergence. Undo restores original cards before removing adoption-created empty cards.

Old suffix edges and every TemporalValue are archived with USER_REPLACED. Only ACTUAL/PROVIDER_OBSERVATION is archivable. USER_VALUE, EXECUTION_OBSERVATION, DERIVED, SYSTEM_SUGGESTION and ADOPTED_TRANSPORT_FACT ACTUAL remain protected. History preserves layer/point/instant/timezone/source/sourceRef/observedAt/original timestamps. GroundTransitLegExecution keeps its deliberate non-FK transport identity; old evidence is neither moved nor rebuilt.

R1 becomes REPLACED. Existing monitoring cancellation semantics cancel queued jobs and request cancellation of running jobs. R2 becomes ACTIVE with external live/historical anchor fields. Candidate edges use ADOPTED_ROUTE/R2 and PLANNED/ADOPTED_TRANSPORT_FACT. RAIL/BUS create new Ground Transit baselines and normal projections. There is no projection for the B→E gap. Same-ID transfer reuse is retained and its previous metadata is recorded.

Successful Adopt increments Trip.version exactly once and writes one ROUTE_ADOPT receipt/ROUTE_ADOPTED outbox. ExternalExecutionOrigin and its receipts do not change. It may remain ARRIVED/CURRENT; external Query is fenced because its source R1 is REPLACED, rather than by inventing departure.

## Receipt and Undo

`route-adopt-delta-v5` retains every V3 restoration field plus EXTERNAL_ORIGIN scope; source route/edge/leg, original anchors/divergence/destination; external ID and immutable anchor snapshot; materialized IDs; prefix IDs/hash; exact archived edge IDs and provider-ACTUAL subset. It additionally records exact post-adopt generated Node/Place/day/temporal/execution facts and an archived-suffix audit hash for defensive Undo.

Parser invariants bind previous route to source route, before corridor to replacement nodes, divergence/destination endpoints, after corridor to materialized E/destination, prefix ending at divergence, E Node/Place creation, exact edge counts, disjoint CREATE/REUSE IDs and provider-ACTUAL subset. First-edge prefix `[A]` with no prefix edge is supported. V2/V3/V4 parsing remains compatible; their semantics/hash formats are unchanged.

V5 Undo validates the complete current corridor, origin-kind/policy/live and historical anchors, created edges/projections, generated-node and Place facts, history hash, old route, and preserved prefix. User edits or any ACTUAL on R2 edges—including Provider ACTUAL—return UNDO_CONFLICT. Raw mutation without a version increment is also detected for note/Place/time intent/node ACTUAL/execution event/move/anchor/prefix/history/day changes.

Undo first marks R2 UNDONE and sets `anchorFromNodeId=null`, then removes created edges and formal nodes/Places. It restores reuse metadata and original occurrence/node placement, restores old generated nodes/edge IDs/provider temporal values/projections, consumes history rows, reactivates R1, restores dwell/date ownership, checks adjacency and prefix hash, and increments Trip.version once. One ROUTE_UNDO receipt with `route-undo-delta-v3` records the dematerialized Node/Place and retained external ID. Legacy Undo v1/v2 data remain readable; node-origin Undo still emits v2.

Same-key concurrent Adopt/Undo replay one receipt. Different-key devices commit once and receive VERSION_CONFLICT or UNDO_CONFLICT. A later handoff after Undo can expose externalQuery at the new version if E remains CURRENT; Query/Preview/Adopt always require fresh explicit actions.

## PR #37 execution evidence fence repair

Repair recommendation: GPT-6 Sol / High; no Astra required for this focused state/audit/concurrency repair. Actual session model configuration cannot be verified from the execution environment. Escalation is limited to a demonstrated lock/audit architecture problem; none was needed. Reviewed repair starting HEAD: `94638187ad6ed78613a03c6213882250769aa967`.

External route Undo is available only before the adopted R2 accumulates execution evidence. A Ground Transit Provider observation or state transition is execution evidence even when no TransportEdge ACTUAL has yet been written.

The reproduction committed a real SYNTHETIC ON_TIME observation through `PrismaGroundTransitRepository.commitObservation`: one observation, zero R2 edge ACTUAL, unchanged Trip.version. Before this repair, Undo incorrectly returned 200 and removed formal E. The repaired path returns 409 UNDO_CONFLICT and leaves the formal Trip, R1/R2, receipts, external origin and execution history unchanged.

V5 now records `afterGroundTransitLegFacts` after all candidate edges and Adopt-created Ground Transit baselines exist. `externalGroundTransitExecutionFacts` selects leg identity, Trip/route/edge, index, provider/mode/service identity/class, baseline, state, latest observation/fetch fields, deviation state/count and nextCheckAt. It includes immutable observation IDs/identity/fetch/hash/facts and complete state transitions. Dates normalize to ISO JSON; records sort by ID and object keys use `hashExternalRouteAudit`. Leg/observation ORM createdAt/updatedAt are excluded. The original PENDING / ROUTE_ADOPT / adopted-route:R2 transition is the expected baseline, not post-Adopt execution.

`createdGroundTransitTransportEdgeIds` records exact RAIL/BUS coverage. The V5 parser validates unique UUID leg/edge identities, receipt-target R2 ownership, created-edge membership, exact audit coverage and initial transition shape. Locked Undo also compares that coverage with actual live R2 RAIL/BUS edges, so removing both a fact and its coverage entry cannot silently omit a leg. Zero ground legs require empty coverage/facts arrays.

V5 Undo holds FOR UPDATE on R2 GroundTransitLegExecution parents and existing GroundTransitObservation/StateTransition children before current-state validation. It reloads canonical facts and rejects every difference before teardown. Observation commit, derived location advancement, changed latest/deviation/scheduler fields, missing/extra/tampered legs and modified/deleted transitions or observations all conflict without needing an edge ACTUAL or Trip.version change. Existing edge-ACTUAL guards remain additive. Old R1 Provider ACTUAL remains archivable/restorable under its existing lifecycle rules.

Real owner/Trip concurrency verifies both winners: an observation committed first fences Undo; Undo committed first makes the later normal Provider commit return NOT_FOUND because R2/edge is no longer current. Raw FK insertion tests for observations and transitions bypass the owner lock and prove that parent locks prevent insertion throughout validation/teardown. After Undo commits, a raw insert may append evidence to the retained historical leg; it cannot slip into the protected interval and no evidence is cascade-deleted. Historical legs intentionally survive Undo.

This repair adds no migration and does not change migration 23 or migrations 1–22. Total remains 23. It does not alter node-route V2/V3/V4 semantics, external origin lifecycle, anchor snapshots, materialization rules or Provider ACTUAL archival policy.

Repair cloud validation: frozen install, Prisma generate/validate, format, lint, full typecheck and build PASS; Unit **700/700** and PostgreSQL 17 integration **564/564** (86 persistence + 478 API). Clean 23 migrations and populated 22→23 deployment PASS; 19 existing tables preserved. Added repair coverage: 30 API PostgreSQL cases, two raw Ground Transit FK serialization cases and 13 receipt Unit cases. The original 5B2B defensive, legacy node/receipt, migration/anchor and immediate-Undo regressions remain green. API/Worker/Debug Web, Compose, P5B and final-head CI evidence are recorded in the Draft PR delivery report.

## Validation evidence

Cloud focused PostgreSQL verifies first/middle/last edges, exact Provider ACTUAL archival/restoration, prefix hash stability, Node/Place deletion, detached historical anchor, read-only handoff restoration, same-key replay, different-key concurrency, departures, supersession/conflict, source/edge/leg/protection/metadata/time races, same-ID C reuse and new/repeated date-card restoration. Dedicated raw-FK concurrency tests prove new ACTUAL inserts block on parent locks and cannot be lost through cascade. Migration tests cover clean 23, populated 22→23 preservation and CHECK/same-Trip FK cases. Receipt unit tests cover V5 invariants and legacy V2/V3/V4 parsing.

The originally reviewed implementation passed the following cloud checks before Draft PR creation; repair validation is recorded separately below:

| Check                          | Result                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm frozen install            | PASS; lockfile unchanged                                                                                                                                    |
| Prisma generate / validate     | PASS, including optional same-Trip composite relation                                                                                                       |
| Format / lint / full typecheck | PASS                                                                                                                                                        |
| Unit                           | 687 passed, 57 files                                                                                                                                        |
| PostgreSQL 17 integration      | 532 passed: persistence 84, API 448                                                                                                                         |
| Clean migration deploy         | PASS, 23 migrations from empty PostgreSQL 17                                                                                                                |
| Populated migration deploy     | PASS, 22→23; 19 existing tables preserved                                                                                                                   |
| Build                          | PASS, including API, Worker and Debug Web                                                                                                                   |
| Compiled runtime smoke checks  | API live/ready, Worker READY and Debug Web all PASS                                                                                                         |
| Docker Compose                 | PASS, including explicit external Adopt/Undo, Provider ACTUAL restoration, no gap edge, restored handoff, and existing Worker/outage/private-storage checks |
| P5B                            | PASS: 5 users, 200 requests, 0 isolation failures, 0 unexpected 5xx, 0 network failures                                                                     |
| Historical migration changes   | 0; one new migration, 23 total                                                                                                                              |

New focused coverage comprises 51 API PostgreSQL cases, three migration cases, two raw-FK concurrency cases and 19 receipt unit cases. It covers first/middle/last source edges, same-ID C reuse, new/repeated date occurrences, same/different-key concurrent Adopt and Undo, stable replay after Preview expiry, owner/admin isolation, 27 changed-evidence Adopt cases, real departure/version fencing and 13 defensive Undo mutations without a version increment. All existing node-origin FULL_CORRIDOR/SUFFIX, receipt V2/V3/V4, external lifecycle/rollover, endpoint/provenance and monitoring regressions remain in the full suite.

The positive Compose chain gracefully pauses only its synthetic Worker during immediate R2 Adopt/Undo, then restarts it. This ensures that the immediate Undo scenario has no new R2 execution evidence. Independent PostgreSQL cases verify that R2 Provider ACTUAL and other new execution facts block Undo; the product's monitoring lifecycle and protection rules are unchanged.

The following IDs are evidence from the final isolated cloud Compose run, not production data. That test database was deleted by normal acceptance cleanup. Formal E Node/Place were already absent immediately after Undo, before cleanup.

| Synthetic evidence                                   | Value                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| R1 source route                                      | `0d5a3593-2768-4e41-88cc-f79aeb2c0c37`                                                                |
| R2 external route                                    | `4a5ec162-fc82-4da3-aab5-268d72b27ad1`                                                                |
| Materialized E Node                                  | `faeb8278-0158-46f2-840c-83f48726b829`                                                                |
| Materialized E Place                                 | `d4c9a323-f79e-4bc0-ab85-ce2807931a52`                                                                |
| Materialized E DayOccurrence                         | `974c1c89-35de-4b7f-9ba0-4ebaa5eafdae`                                                                |
| Created R2 edge                                      | `35ce9b75-4a8a-44ed-8540-e9dd480c0d3e`                                                                |
| Archived/restored source edge                        | `7bf05028-dbce-4735-98db-808fdd81dffd`                                                                |
| Prefix hash before Adopt, after Adopt and after Undo | `eed0418b09d175fa05a30c29ccda05e66e7949df54a401534eeaf2b979e2aec7`                                    |
| E ACTUAL / ExecutionEvent / fake divergence→E edge   | 0 / 0 / 0                                                                                             |
| Adopt lifecycle                                      | R1 REPLACED, R2 ACTIVE; Trip.version +1                                                               |
| Undo lifecycle                                       | R1 ACTIVE, R2 UNDONE; live E anchor null; formal E Node/Place absent; Trip.version +1                 |
| External execution fact                              | Retained unchanged through Adopt and Undo, with original arrival receipt/history                      |
| Undo handoff                                         | READY, CONFIRMED_EXTERNAL_EXECUTION_ORIGIN, externalQuery at the new version; zero automatic planning |

GitHub verify, Compose verification and P5B acceptance remain the independent second verification layer. The Draft PR and delivery report identify the final commit and its CI run; no Ready/Merge action is authorized.

## Explicit scope boundary

No automatic Query, Preview or Adopt. No node ACTUAL synthesis or B→E transport. No ExternalExecutionOrigin materialized-node mapping. No GPS auto-confirmation, arbitrary coordinate routing, onboard/mid-edge routing, real Hub Resolver, paid Ground Transit Provider, formal Desktop/Mobile UI, Push, Staging or Production. F-05/F-06/F-07/F-08 remain Open. Delivery stops at Draft PR for review.
