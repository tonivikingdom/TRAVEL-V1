# P6A-2 — Trip Authoring

Starting main: `6871aa1f88964f8590ca61e3d368bb4da67072d3`.
Branch: `feat/p6a-2-trip-authoring`. Delivery stops at Draft PR.

Recommended model: GPT-5.6 Sol / High; alternate higher reasoning only for unresolved timeline/date/concurrency conflicts. The execution interface does not expose a verifiable model subconfiguration, so this document does not claim a model switch.

## User outcome and reuse

The formal Web can create an empty planning Trip, add an arrangement to a date card, select a reliable saved Place or name a FreeAction, change same-day order and move an unprotected arrangement to another legal date. It never asks for database IDs, coordinates or sequence numbers. Unspecified arrival/departure/dwell stays unknown.

| Capability                                | Existing implementation                                                              | P6A-2 adaptation                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Trip creation/read, saved Place ownership | TripService, PrismaTripRepository, existing HTTP contracts                           | Create form; optional idempotent create; owned Trip catalog                                               |
| Add PlaceVisit / FreeAction               | ADD_PLACE_VISIT / ADD_FREE_ACTION, insertNode                                        | Date-card entry; existing Place identity; activity title uses existing note field                         |
| Real ordering and dates                   | DayOccurrence sequence, node position, MOVE_NODE, resolveTargetDayOccurrence         | Natural-language position selector and explicit occurrence identity, including repeated dates             |
| Range/date ownership                      | reconcileDateOwnership, owner lock                                                   | Reuse atomically; content establishes range, internal blanks remain, empty ends shrink                    |
| Safe authoring command                    | Generic commands lack idempotency; generic MOVE archives newly nonadjacent transport | Separate owner/version/idempotent authoring transaction rejects transport disruption instead of archiving |
| Stable replay                             | Existing route receipts require real route/preview FKs                               | One additive TripAuthoringReceipt table; no fabricated route receipt                                      |
| Place search/manual geocoding             | No configured formal search source                                                   | Explicit downgrade to saved reliable places; no fake name search, coordinates or paid calls               |

No previous `/commands` contract or route adoption/Undo semantics change. No Google Consumer Transit branch is modified or cherry-picked.

## APIs and minimum schema change

- `POST /trips` accepts an optional `idempotencyKey`; existing callers remain compatible.
- `POST /trips/:id/authoring`: `{ baseTripVersion, idempotencyKey, command }`. Only ADD_PLACE_VISIT, ADD_FREE_ACTION and MOVE_NODE are accepted. MOVE accepts the existing explicit EXISTING/NEW day target contract.
- Owner advisory lock and Trip row lock serialize version, date ownership and the mutation. Parent node/edge rows are locked before validating facts/topology. Only a successful transaction increments Trip.version, exactly once. Same owner/key/request replays its original accepted response before version checking; different request with the same key conflicts.
- Any current transport whose adjacency or endpoint occurrence would change causes controlled CONSTRAINT_CONFLICT and full rollback. No automatic deletion, archival, recreation, Query or Adopt. Route-generated nodes, live execution facts and locked user requirements cannot be moved; crossing established execution order is protected.
- Date conflicts, foreign places/days and stale versions roll back occurrences, positions, range, receipt and version together.

Exactly one new migration: `20261003090000_p6a2_trip_authoring_receipts` (24 → **25**). This was necessary because no general authoring idempotency receipt existed, while OperationReceipt requires route/preview identities and supports route operations only. TripAuthoringReceipt stores owner/trip, owner-scoped key, canonical request hash, base/result versions and the accepted owner-safe TripView. Its Trip ownership FK cascades with Trip deletion; it has no node/route anchor FK. Existing data/timeline/date/route tables are unchanged.

## Temporary days and protection

“添加前一天 / 添加下一天” adds UI intent only: zero API write and no DateOwnership until valid content is committed. Refresh or leaving the Trip drops empty temporary dates. Intermediate blank real occurrences are retained. Calendar date is not a unique occurrence identifier; repeated dates and date-line order retain their actual IDs/sequence.

Known-place selection reads only the authenticated owner's existing Trip/Place data and does not resolve names or manufacture coordinates. An owner with no saved reliable Place can add a FreeAction; new location search/geocoding remains a P6A gap, explicitly disclosed in the editor.

Saving captures submitted input before asynchronous work. Accepted writes acknowledge only that snapshot; newer typing remains dirty. Unknown write outcomes retry the same idempotency key. Recovery is reachable inside the drawer, checks the same owner/Trip, reloads current version and requires acknowledgement. Move recovery retains the requested neighboring node identity; a missing day/neighbor requires reselection. Accepted write followed by failed evaluation is reported separately from a rejected write.

P6A-1 R1/R2/R3, time provenance, independent requirements, earlier feasible replacement versus old route time, navigation, explicit Adopt, and execution-aware Undo stay intact. Provider vehicle observation is not user location.

## Verification and screenshots

All new test data is **SYNTHETIC**, on isolated local development/test PostgreSQL 17. No real timetable, fare, address lookup, paid Provider or production data is used.

- Frozen install, Prisma generate/validate and dev/test migrate deploy passed.
- Clean 25 and populated 24→25 migration tests passed; populated facts remain exact, owner/key uniqueness and Trip deletion work. The prior storage migration test still verifies its own 24-migration historical boundary.
- PostgreSQL/HTTP regression covers empty creation/first content, known Place facts, persistent same-day ordering, new-day moves, empty ends/internal blanks, date collision rollback, stable replay/concurrent version fencing, ACTUAL/locked/ExecutionEvent protection, foreign owner/admin/place rejection, adopted-transport preservation, repeated-date identity and date-line ordering.
- `scripts/p6a2-browser-postgres.ts` performs the real PostgreSQL + HTTP + Chromium user chain, including refresh, temporary blank no-write, cross-day move, version recovery and date collision with zero partial writes. It refuses a non-local/non-task-owned database. Run through `scripts/p6a1-browser-tsconfig.json` so ApplicationError identities use the existing source aliases.
- Browser fixtures additionally test edits during pending activity/place submissions, duplicate accepted input prevention, successful write/failed read recovery, temporary dates and 320/375/390/430/1280 px with enlarged text. Existing P6A-1 browser assertions remain.

Screenshots below come from the real PostgreSQL/HTTP chain and were opened for visual inspection. Viewport automation is not iPhone hardware/soft-keyboard verification.

| View                                        | Image                                                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile complete day with Place and activity | [mobile-day-places.png](assets/p6a-2/mobile-day-places.png)                                                                                                                |
| Add arrangement choice                      | [mobile-add-choice.png](assets/p6a-2/mobile-add-choice.png)                                                                                                                |
| Add reliable saved Place                    | [mobile-add-place.png](assets/p6a-2/mobile-add-place.png)                                                                                                                  |
| Add FreeAction                              | [mobile-add-activity.png](assets/p6a-2/mobile-add-activity.png)                                                                                                            |
| Order/date editor                           | [mobile-order-date.png](assets/p6a-2/mobile-order-date.png)                                                                                                                |
| Place detail                                | [mobile-place-detail.png](assets/p6a-2/mobile-place-detail.png)                                                                                                            |
| Desktop day                                 | [desktop-day.png](assets/p6a-2/desktop-day.png)                                                                                                                            |
| Date collision                              | [mobile-date-conflict.png](assets/p6a-2/mobile-date-conflict.png)                                                                                                          |
| Version conflict recovery                   | [mobile-version-conflict.png](assets/p6a-2/mobile-version-conflict.png)                                                                                                    |
| Narrow mobile                               | [320 px](assets/p6a-2/mobile-day-320.png), [375 px](assets/p6a-2/mobile-day-375.png), [390 px](assets/p6a-2/mobile-day-390.png), [430 px](assets/p6a-2/mobile-day-430.png) |

Local cloud validation: format/lint/typecheck/build passed; **745 Unit**, **601 PostgreSQL integration** (104 persistence + 497 API), clean Prisma deploy of **25 migrations**, and populated 24→25 checks passed. Chromium completed **76 cases**, with the final three recovery checks also rerun after the content-wrapper adjustment. Compose API/Worker and the complete existing acceptance chains passed. P5B passed with **5 users / 200 requests / 0 isolation failures / 0 unexpected 5xx / 0 network failures**. Final dual-engine GitHub CI is recorded against the final HEAD in the Draft PR delivery report.

The initial container checks failed on VFS disk exhaustion and copied host TypeScript build metadata, not a passing runtime. `.dockerignore` now excludes nested generated compiler caches and Playwright results; it preserves source/tests. Inactive known task build caches were reclaimed, Prisma regenerated, and the full container checks rerun successfully. No assertion, dependency or CI gate was weakened.

## Remaining boundaries

Embedded map remains **PARTIAL**. Formal new-place search/geocoding is unavailable; saved reliable locations and free activities provide a controlled authoring path. Real Provider timetable/fare/coverage/entitlement, iPhone hardware touch, real Safari and soft keyboard remain unverified. F-05/F-06 remain OPEN. F-07/F-08 stay CLOSED.

No P6B/P6C, paid Provider, automatic Query/Preview/Adopt, production/staging deployment, attachment product, new navigation or Google route-tool migration is started. Engineering green checks do not claim complete product or real-travel acceptance.
