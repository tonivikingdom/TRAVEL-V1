# V1 Query / Preview draft evidence TTL repair

Starting branch: `fix/v1-adoption-evidence-ttl`.
Starting HEAD: `c0178a57203d66d4579886061b0abaa368d9203d`.
Delivery: continue [Draft PR #61](https://github.com/tonivikingdom/TRAVEL-V1/pull/61), base `integration/v1-release-readiness`; no new PR, merge or deployment.

## Independent reproduction before production edits

A new isolated PostgreSQL database, `v1_draft_evidence_ttl`, was migrated cleanly with all **27** migrations. All Providers were SYNTHETIC. Only injected application Clock values advanced; actual owner advisory-lock / Trip-row-lock waits were observed through `pg_stat_activity` and `pg_blocking_pids`. No sleep or wall-clock timing was used to cross a deadline. Write-phase hooks run after a real Snapshot / Preview INSERT inside the production transaction.

Ordinary-origin request: `2030-10-01T09:59:01Z`; expiry: `09:59:02Z`; lock release / write hook: `09:59:03Z`. External-origin fixtures use the equivalent `10:29:01Z / 10:29:02Z / 10:29:03Z`, before their fixed RAIL departure at `10:30Z`, to isolate evidence expiry from departure eligibility.

Before editing production code, the desired-rejection regression ran on the pinned starting HEAD:

- Ordinary origin: **19 FAIL / 2 PASS**. Expired Query returned 200 and expired Preview returned 201; inserted drafts changed the database footprint. Mixed-candidate and equality assertions also failed.
- External origin: **9 FAIL / 9 PASS**. Query accepted expired evidence after owner/Trip waits or inserts; Preview accepted evidence expiring during insertion. External Preview already rejected lock-wait expiry; those successful safeguards were retained.
- Combined original suite: **28 FAIL / 11 PASS**. After repair, the identical suite passed **39 / 39**.

The initial test construction used the wrong Query request field and assumed the wrong read-only Preview response status. Those setup mistakes were corrected before recording the accepted pre-repair results. Read-only GET retains the existing HTTP 200 `EXPIRED`, `adoptable=false` behavior and never inserts a new draft. Later expanded tests corrected an existing-snapshot count assumption and a missing test helper; no production rule was weakened.

[Before evidence](assets/draft-evidence-ttl/before/) and [after evidence](assets/draft-evidence-ttl/after/) contain 30 paired, sanitized SYNTHETIC records. Of those, 24 originally returned expired-success responses and changed rows; six already safely rejected external Preview lock waits. All 30 after records reject and compare the complete database row footprint unchanged, rather than checking only counts.

## Transaction guarantees

| Path                           | After authoritative owner / Trip locks                                                                                 | After all temporary inserts, before transaction return                                                                        | Existing rejection                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Itinerary Query Snapshot batch | Fresh Clock; filter expired Snapshot / non-null Provider TTL, retaining the existing missed-fixed-departure guard      | Fresh Clock; if any inserted candidate evidence expires or becomes departure-ineligible, throw and roll back the entire batch | `404 NO_MATCHING_CANDIDATE` if none valid |
| External-origin Query batch    | Same TTL filter; preserve explicit external-origin authorization and existing elapsed-fixed-departure guard            | Same whole-batch rollback; no expired or dangling Snapshot IDs returned                                                       | `404 NO_MATCHING_CANDIDATE` if none valid |
| Itinerary Preview              | Fresh Clock; check Snapshot, non-null Provider TTL and Preview own TTL, preserving owner/version/hash/corridor checks  | Fresh Clock; recheck all three deadlines plus the existing departure guard; transaction abort removes the tentative Preview   | `409 PREVIEW_STALE`                       |
| External-origin Preview        | Same three deadlines; retain policy/hash/origin validation and the locked authoritative Preview payload reconstruction | Same final evidence/departure check and rollback                                                                              | `409 PREVIEW_STALE`                       |

Provider I/O already sampled a fresh Clock in `RouteQueryService`; it is unchanged and now explicitly tested for both origins. Persistence uses the existing injected Clock and the existing request-time lower bound, never a stale request time alone. **`expiresAt <= now` is expired**, including exact equality. Null Provider TTL adds no invented deadline. No TTL, Provider evidence, timetable or route timestamp is renewed, shifted or buffered; no retry/refetch is introduced.

Before insertion, mixed live/expired Query candidates retain only live candidates. If an initially valid candidate expires during insertion, the whole transaction rolls back even if another candidate remains valid. Successful Query returns only the records actually persisted. Successful mixed-result tests also verify that all other rows, including Trip.version and execution facts, remain unchanged.

The unchanged PostgreSQL constraint requires Snapshot expiry not to exceed non-null Provider validity. Therefore a persisted expired Provider TTL with a still-live Snapshot is structurally impossible. PostgreSQL tests preserve that invariant and keep candidate payload/hash consistent; pure Unit predicates independently test Provider expiry with other deadlines later.

## Regression and verification

- **11 new Unit tests**: independent Snapshot / Provider / Preview deadlines, exact equality and ±1 ms, null Provider, immutable evidence across clock advancement.
- **46 new PostgreSQL tests** (plus the boundary offsets exercised inside two ordinary tests): ordinary and external origins; owner/Trip waits; all temporary-write expiry paths; own Preview TTL; mixed candidates; post-Provider I/O clocks; exact equality and ±1 ms; null Provider; read-only expired Preview; successful Query → Preview → Adopt → receipt replay → Undo.
- Rejection comparisons cover complete Trip, Place/node/edge/route rows, Snapshots, Previews, receipts, Outbox, TemporalValues, authoring receipts, days/date ownership, time intents, execution events/state/location/watermarks/suppressions, dwell suggestions, archived history, day projections, Ground Transit observations/transitions, external origins/receipts and jobs.
- Existing I59-01 Adopt TTL, RWS-02 missed BUS/RAIL, non-fixed aggregate TRANSIT, history editing, version/owner/idempotency/Undo and P5E2 UTC/Tokyo regressions remain mandatory in the full suites. Adoption implementation, departure guard and canonical midnight fixture are unchanged from the starting HEAD.

Validation results are recorded below after execution; the exact final HEAD and its final CI run are recorded in the PR body/checks. Prior runs do not certify this repair.

| Verification                                             | Result                                            |
| -------------------------------------------------------- | ------------------------------------------------- |
| Frozen install; Prisma generate / validate; clean deploy | PASS; 27 migrations                               |
| Full Unit                                                | PASS: 1204 / 94 files                             |
| Full PostgreSQL                                          | PASS: 106 persistence + 705 API = 811 / 45 files  |
| Format / Lint / Typecheck / Build                        | PASS                                              |
| Chromium / WebKit                                        | Exact final HEAD results: PR #61 CI checks / body |
| Compose verification / P5B acceptance                    | Exact final HEAD results: PR #61 CI checks / body |

Local disk availability is below 500 MB on the shared 32 GB filesystem. Full browser and Docker Compose/P5B validation therefore run unchanged on the final GitHub Actions HEAD rather than allocating another local image/browser download. No test standard, TLS check, workflow or production gate is relaxed.

## Boundaries and remaining risks

API / Contract / Schema / Migration delta for this continuation: **0 / 0 / 0 / 0**. Migration total remains **27**. Only private persistence helpers / checks, SYNTHETIC test code and status evidence change. Query/Preview neither increment Trip.version nor create execution facts, authoring receipts or AdoptedRoutes. Existing receipt replay and Undo remain adoption-owned and unchanged. Other PR source branches are untouched.

A fresh final Clock check occurs after the last insert and before returning the transaction callback. Finite driver/COMMIT/HTTP latency remains between that sample and commit/response; this does not claim an atomic database wall-clock predicate at COMMIT or indefinite draft validity after a successful response. Subsequent Preview/Adopt independently revalidate evidence. Server Clock trust/synchronization remains an operational assumption; existing monotonic request-time floors do not repair a misconfigured Clock.

TTL validity alone does not prove boardability, vehicle delay/cancellation, operator timetable/fare truth or capacity. No Provider ACTUAL or GPS is inferred as user execution. All production approval gates remain unchanged: F-05/F-06, entitlement/storage/retention/TTL/deletion/attribution/quota/pricing/coverage, real Provider reliability and cross-midnight truth, Japan staging/production prohibition, map SDK and physical iPhone/Safari/keyboard acceptance remain OPEN/PARTIAL as inherited.

Real paid Provider requests: **0**. Draft only; no main merge, deployment or production enablement. Stop for independent review.
