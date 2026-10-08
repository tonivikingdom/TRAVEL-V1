# V1 Execution-Aware Departure Eligibility Repair — RWS-02

## Scope and provenance

- Repair branch: `fix/v1-departed-route-guard`.
- Exact starting base: `fix/pr53-review-findings` at `9d32c0b23198d35b6f2873d7d9016365f934d635`.
- QA source: `qa/v1-travel-scenarios` at `67c7fdc5fc2b5d89f58f7fc8532529af6bbf59cb`, `apps/api/test/v1-travel-scenarios.integration.test.ts` and `docs/status/V1-REAL-WORLD-TRAVEL-SCENARIOS.md`.
- Only the two RWS-02 PostgreSQL acceptance cases and their required fixture helpers were transplanted; the QA branch was not merged. Their original HTTP assertions and complete database footprint comparisons remain intact.
- All requests are SYNTHETIC against isolated, real PostgreSQL. No real Provider requests, production enablement, source-branch changes, merge or deployment.
- Migration total: **27**, inherited from the exact base. Public API endpoint/request/response shape delta **0**; Domain contract delta **0**; Prisma schema delta **0**; migration delta **0**. The internal planning repository can return the existing `NO_MATCHING_CANDIDATE` error after lock acquisition.

## Independently reproduced failure

The origin is manually confirmed at 17:59 Shanghai local time, with no user departure fact. The fixed BUS departs at 18:00. At 18:05 the execution frontier still reads `AT_NODE`.

| Case                                                | Before repair at the exact base                                                          | After repair                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Query for the departed BUS                          | HTTP 200; one CandidateSnapshot written                                                  | HTTP 404 `NO_MATCHING_CANDIDATE`; all table footprints unchanged               |
| Adopt a Preview created at 17:59, expiring at 18:09 | HTTP 200; Trip.version 10 → 11; edge, route, receipt, outbox and temporal values written | HTTP 409 `PREVIEW_STALE`; version 10 unchanged; all table footprints unchanged |

Committed, sanitized evidence contains only SYNTHETIC clocks, HTTP status and table counts:

- [Before Query](assets/v1-departed-route-guard/before/already-departed-query.json)
- [Before Adopt](assets/v1-departed-route-guard/before/already-departed-adopt.json)
- [After Query](assets/v1-departed-route-guard/after/already-departed-query.json)
- [After Adopt](assets/v1-departed-route-guard/after/already-departed-adopt.json)

The original assertions were run before production code edits and both failed. After repair both pass. The tests additionally compare complete rows for Trip, nodes, edges, routes, snapshots, previews, receipts, outbox, execution, authoring receipts, days, ownership, temporal values and intents; the artifacts summarize those comparisons.

## Eligibility policy

`hasMissedFixedDeparture` is a shared rejection guard. It never certifies boarding or creates execution facts.

- Use server-side injected/system clock and absolute candidate/leg departure instants. No device clock, TTL shortening, plan rewriting, invented access duration or universal boarding buffer.
- Classify the Trip calendar in an explicit origin timezone from existing temporal context/time requirements, with validated candidate timezone as fallback. Never use the server's default timezone. Missing calendar/timezone context fails closed for fixed services.
- Only committed user execution facts (or existing confirmed external execution facts) activate the current-trip guard. A date alone does not prove that the user is executing the Trip. Planning-only routes retain their PLANNED meaning and do not certify current boardability.
- During an executing Trip's effective calendar period, the current origin date cannot receive an expired fixed candidate. Unknown/conflicting progress within that executing Trip is not evidence that the user already took the service.
- A previous-date origin remains historical planning unless the committed execution frontier still confirms `AT_NODE` there. Only active MANUAL events or sufficient committed LOCATION events can carry an open origin across midnight within the Trip period. Undone/weak events, raw GPS, location cache and Provider vehicle ACTUAL cannot do this.
- Outside the Trip period, old/future plans remain editable, including plans with old manual execution facts. The existing calendar lifecycle is not replaced with a new persisted state.
- Reject a stale overall departure or any missed/missing fixed-leg departure. A leading walk is not assumed performed. An exactly equal departure instant adds no buffer; passing this guard still does not prove boarding is feasible.
- Non-fixed aggregate `TRANSIT` estimates are not timetables and retain their existing semantics.

## Three authoritative stages

### Query

After Provider I/O, filter candidates using the fresh application clock. Saving CandidateSnapshots acquires the existing owner advisory lock and Trip row lock, re-reads owner-scoped Trip/execution facts, and rechecks time. If none remain, return `NO_MATCHING_CANDIDATE` without inserts. If a departure crosses during tentative inserts, throw an internal abort and roll back the whole draft transaction.

### Preview

Preview creation validates the snapshot and eligibility in application code. The persistence path rechecks under owner/Trip locks and again before draft commit. A stale departure returns the existing `PREVIEW_STALE`; no new Preview is written. Readonly retrieval also rejects a now-missed fixed departure without modifying the stored Preview or Trip. Preview TTL and planned clocks are unchanged.

### Adopt

Receipt replay remains first after the owner lock. A replay returns the recorded outcome without performing a new adoption, even after departure. New adoption retains version, hash, policy, corridor and fact protections, and additionally loads current execution facts and resamples the server clock inside the existing owner/Trip transaction locks. Recheck immediately before transaction return; throwing `AdoptionAbort('PREVIEW_STALE')` after tentative writes rolls back Trip.version, transports, route records, temporal values, dates, receipt and outbox together.

Confirmed external origins use the same fixed-clock predicate after Provider I/O, under snapshot/Preview locks and during readonly retrieval. External Adopt retains its existing `departure >= now` rule, now using a fresh post-lock clock and a final rollback check. No external-origin planning policy is loosened. Request timestamps, TTL and Undo window are not shifted. Undo itself is unchanged.

## Regression evidence

- **20 new Unit cases**: exact/one-millisecond boundary, planning vs confirmed execution, Provider ACTUAL/location-cache non-evidence, future/history, Tokyo date vs UTC, aggregate TRANSIT, stale walking prefix, fixed-leg clock, missing clock/calendar/timezone and committed/weak/undone/carry-over execution events.
- **13 PostgreSQL cases**: the two original RWS-02 cases; Preview creation/retrieval; delayed Provider I/O; Query/Preview/Adopt owner-lock wait; Adopt Trip-row-lock wait; departure during tentative writes with full rollback (also checking Places, Ground Transit executions/observations/transitions, transport-day projections and archived temporal values); idempotent replay and original-window Undo; historical full chain; aggregate TRANSIT full chain; owner isolation and version conflict priority.
- **4 additional external-origin PostgreSQL cases** reuse existing authoritative fixtures: fixed departure during Provider I/O; Query/Preview/Adopt owner-lock wait; each locked case also verifies readonly retrieval. Preview expires at 10:39 while its fixed RAIL departs at 10:30 and the clock advances to 10:31, independently of TTL. All external durable-state rows remain unchanged.
- Clean PostgreSQL migration deploy: **27** migrations. Existing schema/migrations and public contracts are unchanged.
- Final local checks and required CI job results are recorded in the repair PR body together with exact HEAD and CI URL. The PR targets `fix/pr53-review-findings` and remains Draft. CI verifies Chromium/WebKit, Compose and P5B in addition to Unit/PostgreSQL/build/lint/typecheck.

Existing P5E2 topology/reference repair fixtures now explicitly execute their historical edits after the Trip period, with both temporary and replacement Previews created in the same unexpired window. Original candidate clocks, execution facts, protection assertions and full durable-state comparisons are retained. Canonical midnight fixtures remain unchanged, including their negative controls. Compose suffix acceptance additionally asserts that the original, now-expired fixed replacement is rejected without any writes, then explicitly requests a later SYNTHETIC service for its positive Adopt/Undo chain. Original route and ACTUAL clocks remain intact; no production time window or guard is changed.

## Remaining limits

- This guard uses reliable absolute clocks present in the normalized candidate; it cannot discover an unreported vehicle delay, cancellation, capacity or whether the user boarded. A refreshed candidate is required for changed authoritative timing.
- No new explicit historical-vs-live API intent or persisted Trip lifecycle is introduced. Current-date fixed-service requests with committed execution facts within the Trip period are conservative; previous-date planning and outside-period history remain available under the policy above.
- A server/database commit has finite latency. Rechecks occur after lock acquisition and immediately before transaction return, with no invented safety buffer. Trusted server clock synchronization remains an operational assumption.
- Real cross-midnight/operator timetable/fare truth and Provider production approval remain OPEN/PARTIAL. All existing production gates and prohibitions remain unchanged.
