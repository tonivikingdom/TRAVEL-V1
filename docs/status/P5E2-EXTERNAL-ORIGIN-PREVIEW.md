# P5E2 Batch 5B2A — External-Origin Preview & Replacement Plan

Baseline: `ce61e6d37dc53a8e5edf01a65687a46581afa597` (Batch 5B1 COMPLETE).
Branch: `feature/p5e2-external-origin-preview`. Draft PR only; merge and deployment require a later review.
Recommended model: GPT-6 Astra / High; the running session's exact model variant is not exposed by the available tools. No architectural escalation or delegation was needed.

External Preview describes a future materialization/replacement plan but does not mutate the formal Trip.

Provider-observed ACTUAL on the abandoned source transport is historical vehicle evidence and may be archived in a future Adopt; user/execution ACTUAL remains protected.

External Adopt and Undo remain intentionally unsupported until Batch 5B2B.

## Contract and topology

Node-origin previews retain `route-adoption-preview-v3`, their existing snapshot hash, and `changeSummary.routeCorridor`. External snapshots use the `external-route-candidate-v1` hash and the independent `route-external-origin-preview-v1` policy. GET supports both policies.

`changeSummary.externalOriginReplacement` describes `EXTERNAL_ORIGIN` replacement. It records the external origin, source route/edge/leg IDs, original route anchors, divergence node, exact destination, preserved prefix IDs and replacement node/edge IDs. It does not set `routeCorridor` or pretend the divergence node is the new route origin. `currentConnection` describes the abandoned source edge.

The pure Domain `resolveExternalOriginReplacementCorridor` reuses the existing full-corridor topology proof. It requires an ACTIVE source route in the Trip, exact original destination, uniquely ordered generated internal nodes owned by that route, and exactly one adopted current edge for each pair. Missing, manual, foreign, extra, duplicated or incomplete edges are rejected. Future Adopt/Undo can consume the same resolver without implementing another topology rule.

For `R1 A→B→C→D` with source edge `B→C`:

| Plan                                   | IDs      |
| -------------------------------------- | -------- |
| Preserved nodes                        | A, B     |
| Preserved edges                        | A→B      |
| Replacement nodes                      | B, C, D  |
| Replacement edges, for future archival | B→C, C→D |
| Removable old generated node, if safe  | C        |

A first-edge incident permits prefix `[A]` and no preserved edge. A last-edge incident preserves `[A,B,C]` / `[A→B,B→C]` and requires no old generated-node removal. Ordering is deterministic regardless of input edge order.

## Execution and candidate validation

Application and locked persistence both run the same pure Application plan builder. They require the existing shared external planning authorization: `ARRIVED/CURRENT`, ACTIVE source route, exact current source edge, exact destination, and consistent execution frontier. They additionally validate source leg ID/Trip/route/edge and compare all immutable external-origin snapshot evidence using a canonical hash. Provider recovery alone does not revoke durable user currentness.

Validation includes external candidate hash, snapshot TTL, Provider validity, candidate structure, continuity, supported IANA zones, fare, Query time bounds and departure at or after Preview server time. Destination/downstream schedule evaluation is shared with external Query and excludes the abandoned corridor's service/vehicle anchors. Destination dwell and protected departure requirements are checked again. E supplies no itinerary dwell requirement or user adjustment.

For transfer grouping and generated transfer CREATE/REUSE plans, external Preview reuses the node Preview implementation, including same-hub walking, local dates, Provider metadata and day projection roles. The E anchor remains a separate CREATE plan and never reuses an old suffix node to represent E.

## Future E materialization, without creating E

`materializedOrigin` is a plan with:

- `ref=EXTERNAL_ORIGIN`, `action=CREATE`, `nodeId=null`;
- `kind=PLACE_VISIT`, `source=ROUTE_GENERATED`, `autoReplaceable=true`, `userModifiedAt=null`;
- server-owned name/coordinates, external Provider/hub reference, `providerPlaceRef=null`, `evidence=USER_CONFIRMED`;
- `localDate` from candidate departure converted with the copied trusted E timezone, never from `arrivedAt`;
- a uniquely matching existing day occurrence within the replacement corridor, or null for a future assignment;
- empty `temporalValues` and `executionEvents`.

No E Place, itinerary node, ACTUAL, ExecutionEvent or planned B→E transport is created. D keeps its original ID. The conceptual execution-history gap remains explicit; it is not filled with an invented planned edge. Ground Transit legs, observations and transitions are never scheduled for deletion.

## Protection and transactional fencing

Only strict internal generated nodes after divergence and before D can be removed. Existing ACTUAL, user content/intents, modification flags, historical AdoptedRoute anchors and retained planning dependencies remain blocking. Same-ID transfer reuse does not trigger deletion-only reference protection; other protections still apply. Prefix and endpoints never enter the deletion set.

The Domain ACTUAL classifier applies only to external replacement edges. Provider-only `ACTUAL/PROVIDER_OBSERVATION` enters `archivableProviderActualTransportEdgeIds`. An ACTUAL with any other provenance blocks that edge, including mixed Provider/user ACTUAL. Node-origin protection is unchanged.

`createExternalOriginPreview` acquires the existing owner advisory lock and Trip row lock, reloads the snapshot, Trip/reference facts and execution context, takes a fresh server clock reading, rebuilds the plan and compares its full canonical hash before inserting a RoutePreview. Version, currentness, source topology, leg provenance, metadata, TTL, removal protection and ACTUAL classification changes return `PREVIEW_STALE` with no write. A new Provider-only ACTUAL is not a blocker, but an outdated payload is rejected so regeneration can include its archival classification.

Safe external Preview: `status=ADOPT_UNSUPPORTED`, `adoptable=false`. Fact blockers take precedence as `BLOCKED`; expiry and superseded policy remain higher priority. External Adopt returns `422 PREVIEW_UNSUPPORTED` under the existing authorization/locks, including a stale external plan, before entering the legacy node adoption path. No receipt or formal writes occur.

## Verification

Focused PostgreSQL/API regression covers first/middle/last edges, complete formal-footprint preservation, GET, controlled Adopt rejection, all six ACTUAL provenances, generated-node content/fact/reference protection, legal same-ID reuse, source/currentness/metadata/hash/expiry rejection, locked departure/supersession/topology/leg/protection races, Provider-only observation race and regeneration, owner isolation, destination dwell/departure constraints, recovery and E→F rollover.

Compose extends the existing explicit synthetic chain: Adopt R1 → Worker short-turn/Provider ACTUAL → confirm E → Handoff → explicit future-departure external Query → Preview → rejected Adopt → departure → rejected Query. It verifies the first-edge one-node prefix, full source provenance, E CREATE plan, Provider ACTUAL archival classification and no formal E materialization. No automatic planning operation was added.

Cloud verification was executed on 2026-10-01 with Node 24.19.0, pnpm 11.19.0 and PostgreSQL 17.11:

| Check                                                          | Result                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, Prisma generate / validate                     | PASS                                                                                                                       |
| Format, lint, full typecheck                                   | PASS                                                                                                                       |
| Focused Domain / Application / legacy node Preview Unit        | 68 passed                                                                                                                  |
| Focused external Preview PostgreSQL/API regression             | 62 passed                                                                                                                  |
| Full Unit, including Worker regressions                        | 663 passed, 55 files                                                                                                       |
| Full PostgreSQL integration                                    | 468 passed: 79 persistence + 389 API                                                                                       |
| Clean database migration deployment                            | All 22 migrations applied; no new migration                                                                                |
| Populated migration regression                                 | 21→22 preserves 19 baseline tables, legacy hashes, v2/v3/v4 receipts, external origins and Ground Transit history          |
| Build, API live / ready, Worker heartbeat / SIGTERM, Debug Web | PASS                                                                                                                       |
| Docker Compose                                                 | PASS, including external Preview, one-node prefix, Provider ACTUAL, rejected external Adopt and existing suffix Adopt/Undo |
| P5B acceptance                                                 | 5 users, 200 requests; 0 isolation failures, 0 unexpected 5xx, 0 network failures                                          |

Cloud Docker's `vfs` image cache initially exhausted storage during container creation. Removing unreferenced old TRAVEL-V1 test images and running Compose/P5B sequentially resolved it; both complete acceptance runs then passed. No application or CI checks were weakened. Independent GitHub CI results belong to the final Draft PR report.

## Scope and migrations

Zero new migrations; 22 total. Prisma schema and all migration files are unchanged. No changes to AdoptedRoute anchors, route delta v2/v3/v4, Undo or external-origin persistence mapping.

Batch 5B2B is not started. External Adopt/materialization/archival, delta v5 and external Undo remain unsupported. Automatic Query/Preview/Adopt, GPS confirmation/routing, real Hub Resolver, paid Provider, formal UI, Push, Staging and Production remain absent. F-05/F-06/F-07/F-08 remain open.
