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

Saving captures submitted input before asynchronous work. Accepted writes acknowledge only that snapshot; newer typing remains dirty. Unknown write outcomes retry the same idempotency key. Recovery is reachable inside the drawer, checks the same owner/Trip, reloads current version and requires acknowledgement. Move recovery retains the requested neighboring node identity; a missing day/neighbor requires reselection. If another device removes the adding draft’s original date card, recovery offers an explicit current-date choice; no target is guessed and the activity/Place draft stays intact. Accepted write followed by failed evaluation is reported separately from a rejected write.

P6A-1 R1/R2/R3, time provenance, independent requirements, earlier feasible replacement versus old route time, navigation, explicit Adopt, and execution-aware Undo stay intact. Provider vehicle observation is not user location.

## Verification

All new test data is **SYNTHETIC**, on isolated local development/test PostgreSQL 17. No real timetable, fare, address lookup, paid Provider or production data is used.

- Frozen install, Prisma generate/validate and dev/test migrate deploy passed.
- Clean 25 and populated 24→25 migration tests passed; populated facts remain exact, owner/key uniqueness and Trip deletion work. The prior storage migration test still verifies its own 24-migration historical boundary.
- PostgreSQL/HTTP regression covers empty creation/first content, known Place facts, persistent same-day ordering, new-day moves, empty ends/internal blanks, date collision rollback, stable replay/concurrent version fencing, ACTUAL/locked/ExecutionEvent protection, foreign owner/admin/place rejection, adopted-transport preservation, repeated-date identity and date-line ordering.
- `scripts/p6a2-browser-postgres.ts` performs the real PostgreSQL + HTTP + Chromium user chain, including refresh, temporary blank no-write, cross-day move, version recovery and date collision with zero partial writes. It refuses a non-local/non-task-owned database. Run through `scripts/p6a1-browser-tsconfig.json` so ApplicationError identities use the existing source aliases.
- Browser fixtures additionally test edits during pending activity/place submissions, duplicate accepted input prevention, successful write/failed read recovery, temporary dates and 320/375/390/430/1280 px with enlarged text. Existing P6A-1 browser assertions remain.

Local cloud validation: format/lint/typecheck/build passed; **745 Unit**, **601 PostgreSQL integration** (104 persistence + 497 API), clean Prisma deploy of **25 migrations**, and populated 24→25 checks passed. Chromium completed **77 cases**, including a failed-before/passed-after removed-date regression and its real PostgreSQL/HTTP counterpart. Compose API/Worker and the complete existing acceptance chains passed. P5B passed with **5 users / 200 requests / 0 isolation failures / 0 unexpected 5xx / 0 network failures**. Implementation HEAD `730fe41a3d23a20c2dc13a1b57a630a16e5b98e4` was reverified after network recovery. [CI 37103896664](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/37103896664) matches that implementation HEAD: verify, Compose verification and P5B acceptance all completed/success; its browser logs confirm **77 Chromium + 77 WebKit = 154 passed**. This visual-delivery update changes documentation/artifacts only and does not claim that the implementation CI ran against a later artifact commit.

The initial container checks failed on VFS disk exhaustion and copied host TypeScript build metadata, not a passing runtime. `.dockerignore` now excludes nested generated compiler caches and Playwright results; it preserves source/tests. Inactive known task build caches were reclaimed, Prisma regenerated, and the full container checks rerun successfully. No assertion, dependency or CI gate was weakened.

## Visual review artifacts

These artifacts correspond to implementation HEAD `730fe41a3d23a20c2dc13a1b57a630a16e5b98e4`. All 14 originals were opened individually in this visual-delivery round, verified byte-identical to their committed files at that HEAD, and checked against the capture sequence in `scripts/p6a2-browser-postgres.ts`. The ordinary views are unaffected by the final removed-date recovery fix; its separate recovery capture is included below. No page was regenerated and no original screenshot was modified.

The data is visibly **SYNTHETIC**. The inspected screenshots contain no tokens, cookies, real credentials or personal information. They are isolated PostgreSQL/HTTP/Chromium captures; viewport automation is not iPhone hardware, Safari or soft-keyboard validation. Visible recovery warnings are captured states, not claims that a failed read succeeded.

[Open the contact sheet](assets/p6a-2/review-contact-sheet.png) — **1416 × 4434 px**, nine titled panels. Each original is pasted at **1:1 native pixels**, with its aspect ratio intact, no crop and no overlay over the UI. Desktop occupies a separate full-width row. This sheet is an inspection index, not a replacement for the original files. Open the original-resolution image to inspect text and spacing.

| Artifact                                                               | Capture viewport (CSS px)        | Review scenario                                                                    |
| ---------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| [Contact sheet](assets/p6a-2/review-contact-sheet.png)                 | Assembly, not a browser viewport | Nine key mobile/desktop views together                                             |
| [Mobile complete day](assets/p6a-2/mobile-day-places.png)              | 390 × 844                        | Saved Place and FreeAction, long name, separate arrival/departure/dwell            |
| [Add arrangement choice](assets/p6a-2/mobile-add-choice.png)           | 390 × 844                        | Planning anchor and Place/FreeAction choice in bottom sheet                        |
| [Add saved Place](assets/p6a-2/mobile-add-place.png)                   | 390 × 844                        | Owned reliable Place, explicit search downgrade, unsaved note                      |
| [Add FreeAction](assets/p6a-2/mobile-add-activity.png)                 | 390 × 844                        | Natural activity title, unspecified time stays unknown                             |
| [Date/order editor](assets/p6a-2/mobile-order-date.png)                | 390 × 844                        | Natural date and position choices, protection explanation                          |
| [Place detail](assets/p6a-2/mobile-place-detail.png)                   | 390 × 844                        | Saved location/navigation, separate times, note editing, map PARTIAL               |
| [Date conflict](assets/p6a-2/mobile-date-conflict.png)                 | 390 × 844                        | Another Trip owns the date; draft retained, no partial write                       |
| [Version conflict](assets/p6a-2/mobile-version-conflict.png)           | 390 × 844                        | Retained draft and reachable reread/verification action                            |
| [Removed-date recovery](assets/p6a-2/mobile-removed-date-recovery.png) | 390 × 844                        | Another device removed the original date; explicit retarget before acknowledgement |
| [320 px day](assets/p6a-2/mobile-day-320.png)                          | 320 × 844                        | Narrow date cards, actions and activity cards                                      |
| [375 px day](assets/p6a-2/mobile-day-375.png)                          | 375 × 844                        | Narrow mobile layout and controls                                                  |
| [390 px day](assets/p6a-2/mobile-day-390.png)                          | 390 × 844                        | Standard mobile layout after cross-day move                                        |
| [430 px day](assets/p6a-2/mobile-day-430.png)                          | 430 × 844                        | Wider mobile layout without desktop scaling                                        |
| [Desktop day](assets/p6a-2/desktop-day.png)                            | 1280 × 960                       | Separate date/itinerary/detail columns                                             |

The captures use `fullPage: true`: PNG height can exceed viewport height (for example, the removed-date recovery image is 390 × 1788 px). The extra page area is preserved rather than cropped. The narrow-width captures are normal-size text views; enlarged-text behavior is covered separately by browser tests. Contact-sheet assembly does not alter product styling or layout and does not establish human visual acceptance by itself.

## Remaining boundaries

Embedded map remains **PARTIAL**. Formal new-place search/geocoding is unavailable; saved reliable locations and free activities provide a controlled authoring path. Real Provider timetable/fare/coverage/entitlement, iPhone hardware touch, real Safari and soft keyboard remain unverified. F-05/F-06 remain OPEN. F-07/F-08 stay CLOSED.

No P6B/P6C, paid Provider, automatic Query/Preview/Adopt, production/staging deployment, attachment product, new navigation or Google route-tool migration is started. Engineering green checks do not claim complete product or real-travel acceptance.
