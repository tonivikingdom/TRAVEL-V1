# P5E2 Batch 4B — Confirmed Live-Origin Authorization

- Recommended model: GPT-6 Astra / High; backup GPT-6.1 Sol / High. Shared execution authorization, transactional rechecks and receipt/history regressions require this reasoning level. Escalate if a causal execution invariant remains unresolved. Actual client model configuration is unconfirmed.
- Starting main: `c03272eb24862367df5be747f7077c9bfe95c6d4`.
- Starting implementation: `682c1016ad41afa7f4679bccf233971b5aaa237a`.
- Branch: `feature/p5e2-route-suffix-replacement-foundation`.
- Continue [Draft PR #33](https://github.com/tonivikingdom/TRAVEL-V1/pull/33); do not create another PR, mark Ready, merge or modify main.
- Schema/migrations: unchanged, zero added migrations.

## Confirmed origin policy

The pure `resolveConfirmedRouteExecutionOrigin` is shared by Handoff, RouteQuery and locked persistence adapters. The existing topology resolver still recognizes FULL_CORRIDOR and SUFFIX without an execution prerequisite. Public SUFFIX authorization is a separate requirement.

The policy uses the existing execution frontier over the ordered Trip, including ACTUAL arrival/departure and durable skipped state. INCONSISTENT yields CONFLICT. A confirmed origin must be an internal PLACE_VISIT of the complete current source route corridor. Its open ACTUAL arrival must exactly match one active, non-undone ExecutionEvent ARRIVAL: `sourceRef = execution-event:<id>`, equal instant, and the established source kind. MANUAL uses USER_VALUE; LOCATION uses EXECUTION_OBSERVATION and requires SUFFICIENT durable reliability. There must be no confirmed departure, later node execution event, chronologically later durable event or inconsistent frontier. The result is CONFIRMED_NODE with its node ID, otherwise NOT_PROGRESSING, UNRESOLVED or CONFLICT without a node ID.

Provider vehicle ACTUAL is never arrival authorization. Arbitrary node ACTUAL, raw or reliable GPS, proximity, motion, hubs and client-supplied fromNodeId cannot authorize a suffix. A reliable location observation can authorize only after the existing Execution system independently commits a confirmed ARRIVAL and its matching ACTUAL fact. Reliable progressed location and independent ground-leg progress can make the original planned origin unsafe, without becoming confirmation evidence themselves.

## Handoff and Query

Handoff remains owner-scoped and read-only. It does not call a route provider or write candidates, previews, routes, edges, receipts or Trip.version.

| Execution state                                                | Handoff           | originBasis              | Query        |
| -------------------------------------------------------------- | ----------------- | ------------------------ | ------------ |
| No route execution progress                                    | READY             | PLANNED_ROUTE_ORIGIN     | Original A→D |
| Confirmed internal B, still at B                               | READY             | CONFIRMED_EXECUTION_NODE | B→D          |
| Departed B, EN_ROUTE, unsafe evidence or inconsistent frontier | ORIGIN_UNRESOLVED | null                     | null         |

Origin timezone continues using existing origin-local evidence only, now selected for B when B is the confirmed origin. There is no downstream or coordinate timezone fallback. Recovery and noncurrent-route NOT_REQUIRED behavior remain intact. `originBasis` is an additive optional contract field for legacy JSON compatibility; the server emits it explicitly.

RouteQuery rereads owner-scoped current execution facts before schedule/provider work. SUFFIX requires CONFIRMED_NODE matching the requested fromNodeId, otherwise 422 ROUTE_QUERY_UNSUPPORTED. A denial creates zero new CandidateSnapshots and leaves routes and monitoring intact. FULL_CORRIDOR and ordinary adjacency keep their existing planning semantics. No handoff token or client authorization assertion is introduced.

Snapshot persistence independently rereads proof under the existing owner advisory lock and Trip row lock after provider return. Proof invalidation rejects persistence through the existing stale/version business-error path. Adopt also rereads the same policy inside those locks, after existing fact/reference protections and before any replacement writes; unsafe proof returns PREVIEW_STALE. Normal Execution API departure increments Trip.version and causes VERSION_CONFLICT when an old Preview is submitted. The independent proof check also rejects a deliberately constructed unchanged-version fixture.

An authorized stored candidate may still produce a blocked Preview explaining subsequent suffix ACTUAL protection. Preview never authorizes a stale commitment; Adopt rechecks current execution, version, topology, historical references and facts.

## Foundation retained

All 4A topology, suffix-only replacement/archive, preserved prefix, source REPLACED/new ACTIVE route lifecycle, monitoring cancellation/scheduling, delta v4 and deterministic Undo remain intact. V2/V3/V4 reading is retained. Historical anchor and retained planning reference protection still checks every route status and rechecks inside Adopt locks. Legal same-ID reuse remains possible; temporary unadopted Query/Preview does not permanently lock nodes.

The eight previous historical-reference regressions now establish a legitimately authorized suffix using the Execution API, then explicitly undo the origin execution event when they must isolate deletion-reference protection from ACTUAL protection. They retain their independent reference assertions, business error expectations and unchanged-state checks. Pure topology tests still demonstrate SUFFIX resolution without execution evidence.

## Regression coverage

Fifteen additional PostgreSQL HTTP cases cover arbitrary direct suffix denial; vehicle-only facts; reliable GPS-only state; bare node ACTUAL; arrival followed by departure; later durable execution; inconsistent frontier; linked MANUAL arrival; real Location API detection without AUTO_RECORD versus durable confirmed LOCATION arrival; provider-return departure race; unchanged-version locked snapshot and Adopt proof rechecks; and read-only planned/confirmed/departed Handoff followed by explicit suffix Adopt/Undo or departure-race rejection.

Denied queries assert zero snapshot increase, no provider call, unchanged durable trip/routes/history/execution/receipts and an existing queued monitoring job left intact. Handoff read-only assertions include durable execution facts. Departure-race rejection leaves no partial adoption writes. The 24 4A and eight historical-reference tests remain in the same real PostgreSQL suite, alongside all 54 earlier route-query regressions.

The Compose chain uses explicit HTTP actions: Query A→D, Preview, Adopt R1; reject an unconfirmed direct B→D Query with zero snapshot increase; commit user ARRIVAL/DEPARTURE A and ARRIVAL B through Execution API; observe downstream synthetic disruption; verify READY/CONFIRMED_EXECUTION_NODE B→D and unchanged planning footprint; explicitly Query, Preview SUFFIX and Adopt R2. It then verifies preserved prefix ID/facts/history, source lifecycle, suffix archival and deterministic Undo/idempotency. No test-only forced completed ground-leg state is used in this chain.

## Cloud acceptance

The cloud is the first acceptance environment: Node 24.19.0, pnpm 11.19.0, PostgreSQL 17.11. Disposable `travel_cloud_p5e2_4b_clean` applied all 20 existing migrations from empty and reports up to date. Credentials and environment/build configuration remain outside Git.

- Frozen lockfile consistency, Prisma generate/validate, format/check, lint, full typecheck and build: PASS.
- Unit: 48 files / 565 tests PASS, including existing Worker regressions and 18 new origin/Handoff cases.
- PostgreSQL 17 full integration: 26 files / 344 tests PASS (Persistence 17/75, API 9/269).
- Focused Batch 4: 47/47 PASS (24 foundation, eight historical-reference repair, 15 new authorization cases). The other 54 route-query regressions also pass in the full suite.
- Populated regression: the existing repair database reports no pending migration; all nine API integration files / 269 tests PASS again on that migrated database.
- API and Worker: build PASS; existing execution/monitoring, owner isolation, job/lease/retry/cancellation and race regressions PASS in Unit/PostgreSQL suites.
- Docker Compose: complete acceptance PASS, independently captured runner returncode 0. Confirmed-user-arrival B, negative unauthorized Query, read-only confirmed Handoff, explicit suffix Adopt/Undo, prefix identity/ACTUAL, earlier F-09/ground-transit scenarios, runtime recovery/SIGTERM, database persistence and private object storage all pass.
- P5B: PASS, independently captured returncode 0; five users / 200 requests / 200 success / zero isolation failures / zero unexpected 5xx / zero network failures. Median 382.4 ms, p95 620.04 ms, maximum 630.28 ms; P5C flow PASS.
- No schema or migration file changed. All 20 original migrations remain the complete migration set.

Cloud container builds/runners use the already verified mirrored base images, platform CA and proxy configuration outside Git. Host source/generated outputs stayed stable during sequential builds. Completed synthetic images from the previous repair were removed after inventory to reclaim temporary disk; active containers and data were untouched. Compose and P5B ran sequentially with COMPOSE_PARALLEL_LIMIT=1 and cleaned their own disposable resources.

The exact final implementation HEAD and independent GitHub CI Run/job conclusions are recorded in the original Draft PR and completion response after push. No claim of CI success is based on cloud results.

## Completion record

| Requested item            | Result                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1 New HEAD                | Final commit on the original branch; exact SHA in PR #33 and completion response.                          |
| 2 Confirmed policy        | One pure resolver; NOT_PROGRESSING / CONFIRMED_NODE / UNRESOLVED / CONFLICT.                               |
| 3 Evidence                | Active MANUAL or sufficient LOCATION ARRIVAL linked exactly to node ACTUAL; consistent execution frontier. |
| 4 Provider ACTUAL         | Never authorizes user origin.                                                                              |
| 5 GPS-only                | Never authorizes; reliable detection without durable ARRIVAL is rejected.                                  |
| 6 originBasis             | PLANNED_ROUTE_ORIGIN / CONFIRMED_EXECUTION_NODE / null.                                                    |
| 7 No progress             | READY, original A→D.                                                                                       |
| 8 Confirmed B             | READY, B→D, chosen-origin timezone.                                                                        |
| 9 Departed B              | ORIGIN_UNRESOLVED, null Query and basis.                                                                   |
| 10 Arbitrary direct B→D   | 422 ROUTE_QUERY_UNSUPPORTED.                                                                               |
| 11 Server revalidation    | Query read, locked snapshot-save proof read, locked Adopt proof read.                                      |
| 12 Unauthorized snapshots | Zero increase; no provider invocation or monitoring change.                                                |
| 13 Departure race         | VERSION_CONFLICT; unchanged-version locked proof test PREVIEW_STALE; no partial adoption.                  |
| 14 Historical references  | Eight prior PostgreSQL cases PASS, independently isolated from ACTUAL protection.                          |
| 15 FULL_CORRIDOR          | Existing topology/planning/time/fact semantics PASS.                                                       |
| 16 SUFFIX Adopt/Undo      | Foundation regressions and real confirmed HTTP/Compose chain PASS; v2/v3/v4 retained.                      |
| 17 Unit                   | 565 PASS.                                                                                                  |
| 18 PostgreSQL             | 344 PASS; populated API regression 269 PASS.                                                               |
| 19 Clean migrations       | PostgreSQL 17.11, all 20 original migrations PASS.                                                         |
| 20 Compose                | PASS, runner returncode 0.                                                                                 |
| 21 P5B cloud              | Five users / 200 success / zero isolation, 5xx and network failures.                                       |
| 22 Final CI Run           | Exact-head independent run linked from PR/completion response after push.                                  |
| 23 verify                 | Independent final-head conclusion checked before completion.                                               |
| 24 Compose verification   | Independent final-head conclusion checked before completion.                                               |
| 25 P5B acceptance         | Independent final-head conclusion checked before completion.                                               |
| 26 New migrations         | Zero.                                                                                                      |
| 27 Automatic Query        | No.                                                                                                        |
| 28 Automatic Preview      | No.                                                                                                        |
| 29 Automatic Adopt        | No.                                                                                                        |
| 30 Real paid Provider     | No.                                                                                                        |
| 31 4B activation          | Confirmed existing internal itinerary-node origin only; activated in Handoff/Query.                        |
| 32 Blocker / stop         | Cloud acceptance complete; stop at the original Draft PR after independent CI, awaiting review.            |

## Scope and review stop

4B activation is limited to confirmed existing itinerary nodes. There is no GPS-coordinate origin, Hub materialization, between-station/onboard routing, automatic Query/Preview/Adopt, real paid provider, Push, formal clients, staging or production work. F-05/F-06/F-07/F-08 remain open. Keep the same Draft PR and wait for the next review.
