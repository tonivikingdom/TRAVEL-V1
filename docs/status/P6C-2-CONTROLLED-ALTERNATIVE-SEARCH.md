# P6C-2 — Controlled Alternative Search

Starting main: `0e5a94c7bd4f64c4e94f208053074c4ddcdbb22f`. Branch: `feat/p6c-2-controlled-alternative-search`. Draft delivery only; no merge, deployment, P6C-3 or PR #41 modification.

Recommended configuration: GPT-5.6 Sol / High. The execution interface cannot independently verify a model subconfiguration or a switch. Escalation would be reserved for a concrete timeline/transaction conflict; no schema redesign was needed.

## Implementation matrix

| Category                    | Existing authority                                                                                                                                                                                       | Delivery                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A: existing Domain/services | Ground operational assessment, confirmed origin policy, FULL_CORRIDOR/SUFFIX/EXTERNAL_ORIGIN, RouteQueryService, RoutePreviewService, RouteAdoptionService, RouteUndoService, snapshot/receipt lifecycle | Reused without a second risk, time or replacement engine.                                                  |
| B: orchestration            | Read-only route-reevaluation Handoff and server-owned query/externalQuery                                                                                                                                | A thin explicit-search service rereads READY before dispatch and after Provider return.                    |
| C: Web wiring               | Today/Next Impact, shared drawer, candidate cards, formal Preview, explicit Adopt and lightweight Undo                                                                                                   | Connected the user actions; no automatic search, selection, preview or adoption.                           |
| D: missing contract         | No formal combined controlled-search contract                                                                                                                                                            | Added request/response and one POST endpoint; legacy node/external query contracts remain intact.          |
| E: excluded                 | Real Provider, origin confirmation redesign, arbitrary GPS, automatic planning, generic recommendation/history UI                                                                                        | Not added. Place Search, backup, immutable/history protection, canonical fixtures and schema are retained. |

## Explicit workflow and authority

Today/Next remains the primary view. Impact offers “查看调整方案” only for a READY handoff matching the currently read Trip version. Viewing Impact or opening this entry sends no route query. NOT_REQUIRED has no alternative entry; ORIGIN_UNRESOLVED explains that current position/progress must first be confirmed through the existing supported workflow. This batch does not infer or automatically confirm that origin.

Only “搜索替代方案” calls `POST /trips/:tripId/alternatives/query`, with `{ handoff }` copied from the authoritative Impact response. Web does not construct from/to IDs, external-origin identity, timezone or basisVersion. The server rereads the existing owner-scoped Handoff and compares its source edge/route, origin basis, query identity, version, timezone, reason and opaque planning-facts fingerprint. NOT_REQUIRED, unresolved, changed or mismatched evidence fails closed with VERSION_CONFLICT before the Provider call.

The additive Handoff `planningFactsHash` fingerprints current route/leg facts and accepted execution-origin evidence. It is read evidence, not a new authorization state machine or persisted token. Canonicalization preserves Date instants and ignores object property order. An observation change can invalidate an old handoff even without a Trip.version change. Only the advancing server DEPART_AT-now instant is excluded from identity comparison; the query uses the freshly revalidated server handoff, retains ARRIVE_BY identity, and delegates all bounds/timezone validation, ranking and locked snapshot authorization to the existing Query service. Revalidation after Provider return prevents changed authorization from returning usable alternatives. Existing lock-level version/external-origin guards remain intact; query evidence is disposable and does not mutate the formal Trip.

Candidates remain unselected until the user clicks one. Only that choice requests a formal Preview. Replacement information is rendered directly from `changeSummary`; Web computes no replacement set. The Preview explains the current route segment, preserved prefix, suffix-only change, or start at the confirmed external location, removed generated arrangements where supplied, destination retention, fare and downstream/user dwell adjustments. Extra costs remain unknown when the Provider does not supply fare. No gap transport or execution fact is synthesized by the UI.

Only `status = ACTIVE`, `adoptable = true`, matching version and explicit “采用此调整” dispatch the existing Adopt service. Protected dwell changes require their existing explicit acceptance. Successful Adopt retains its receipt before fresh reads; Impact and Today/Next are reread. The existing light Undo action rereads those projections again after success. Its execution/audit guards remain unchanged; a changed state is described neutrally, never as proof that the user started execution.

## Failure, retries and ownership

Provider unavailable is “暂时无法搜索替代方案”, not “没有路线”. The original Trip/selected route and read Impact remain present. Retry is an explicit action. Zero matching candidates is a separate successful search result.

Buttons suppress in-flight double Query, Preview and Adopt. Repeated intentional Query/Preview can create new planning evidence; they never increment Trip.version. Adopt retains one idempotency key for that accepted Preview. If its response is lost, an accessible “核验本次采用” retries the exact submitted request/key after checking the original account. A committed request replays rather than creating another route, receipt or version increment. This is limited to the current drawer request, without background retries or a new history/recovery platform.

After stale/failed core reads the old sheet facts are hidden. A separate read-only recovery action remains reachable and rereads current Impact/Handoff; stale candidates/Preview are discarded and search stays disabled until revalidation. Accepted Adopt followed by failed reads is explicitly reported as saved with verification pending. Reload returns to the same owned Trip and retains the known receipt. Existing place/authoring submitted-snapshot and draft recovery behavior remain unchanged.

The existing authentication, owner scope, optimistic concurrency, locked transactions, candidate expiry/hashes, protected facts, idempotency and Undo evidence fence remain the authorities. Different users/admins cannot query another owner's private handoff. Provider vehicle/Flight ACTUAL does not advance user execution. No real Provider call, GPS collection, new fee commitment or deployment is performed.

## API and storage delta

- One thin explicit orchestration endpoint and its request/response contract.
- Additive opaque read-basis field on the existing Handoff.
- Existing Query, Preview, Adopt and Undo endpoints and hash formats are unchanged.
- Domain feasibility/replacement rules: unchanged. Schema/migration delta: **0/0**. Total migrations: **26**.
- Query writes only existing CandidateSnapshots; Preview writes only existing RoutePreview; only explicit Adopt/Undo changes the formal Trip. Viewing candidates and navigation are read-only.
- Canonical `scripts/synthetic-route-day.mjs`, its 13 boundary regressions and production clock/Preview guards are inherited unchanged. CURRENT-TASK remains historical RESOLVED with no manufactured active task.

## Verification

All acceptance data is **SYNTHETIC**, using isolated local/test PostgreSQL and local Provider fixtures. Tests do not establish live timetable/fare accuracy or user/device acceptance.

Local validation uses the current implementation, not P6C-1 branch CI. Final-head independent GitHub CI is linked in the Draft PR, including measured Chromium/WebKit totals.

| Check                                                                    | Actual result                                                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Frozen install, Prisma generate/validate, format, lint, typecheck, build | PASS                                                                                                                               |
| Unit                                                                     | 798 PASS (17 new orchestration/read-basis regressions)                                                                             |
| PostgreSQL 17                                                            | 652 PASS: 106 persistence + 546 API; 11 new controlled-search cases                                                                |
| Chromium                                                                 | 213 PASS, including 25 controlled alternatives browser cases                                                                       |
| Real Chromium → HTTP → PostgreSQL                                        | PASS; zero entry query/formal planning writes, Adopt/Undo each +1, original IDs restored                                           |
| Migration                                                                | Clean Prisma deploy of all 26 PASS; existing populated/history/anchor/FK regression suite PASS; schema/migration delta 0/0         |
| Compose                                                                  | PASS, including explicit controlled Handoff search and existing suffix/external chains, Worker, outage/recovery and object storage |
| P5B                                                                      | PASS: 5 users, 200 requests, zero isolation failures/unexpected 5xx/network failures                                               |
| Independent final-head WebKit/Chromium/Compose/P5B                       | See final run and results in this PR; no old-head result substitutes for these checks                                              |

The first full Chromium run found four legacy reload-flow regressions. One additional page-load timeout was not reproduced in the complete rerun. Same-Trip recovery is now limited to the known successful adoption receipt; unrelated drafts/backups retain their original reload/list behavior. All original safety assertions are retained. An intermediate run overlapped a copy edit and retained two already-loaded old-text assertions; the complete run was restarted against frozen source and tests. The complete suite and final captures were rerun; documentation and synthetic fixture captions do not represent real Provider acceptance.

New coverage includes READY explicit query; unavailable/unresolved/no-required entry; explicit candidate and Preview; FULL/SUFFIX/external replacement; blocked/expired/unsupported Preview; Adopt/Undo and projection refresh; version and changed-evidence races; owner isolation; double actions; lost response replay; accepted-write/read-failure recovery; narrow/enlarged/desktop layout. Existing Place Search, backup, saved transport timing/navigation, authoring/drafts, endpoint binding, provider ACTUAL and route/receipt history tests remain in the full suites.

`scripts/p6c2-browser-postgres.ts` performs actual Chromium → authenticated HTTP → PostgreSQL: create/adopt a synthetic route, commit a synthetic cancellation, read Impact/Handoff, explicitly search/choose/Preview/Adopt/Undo. It asserts zero entry Provider calls, zero Query/Preview formal writes, exactly one version increase for each mutation, original node/edge ID restoration and zero new ExecutionEvent. It refuses non-local/non-test database use. Separate PostgreSQL API coverage exercises FULL, confirmed suffix and external Adopt/Undo with the existing locked services.

## Visual review artifacts

All captures show SYNTHETIC data, are committed to this branch and were actually opened. Phone images are viewport captures, not a resized desktop view. Confirmation views additionally show the scrolled primary action. The contact sheet preserves original proportions and does not replace the originals or device acceptance.

[Review contact sheet](assets/p6c-2/review-contact-sheet.jpg)

| Artifact                                                                                                           | Viewport              | Scenario                         |
| ------------------------------------------------------------------------------------------------------------------ | --------------------- | -------------------------------- |
| [READY entry](assets/p6c-2/mobile-ready-entry.png)                                                                 | 390 × 844             | Impact entry, zero Query         |
| [Explicit search](assets/p6c-2/mobile-search-explicit.png)                                                         | 390 × 844             | Trusted handoff before search    |
| [Candidates](assets/p6c-2/mobile-candidates.png)                                                                   | 390 × 844             | Unselected alternatives          |
| [Full replacement](assets/p6c-2/mobile-preview-full.png) / [Confirm](assets/p6c-2/mobile-preview-full-confirm.png) | 390 × 844             | Authoritative full-route change  |
| [Suffix](assets/p6c-2/mobile-preview-suffix.png) / [Confirm](assets/p6c-2/mobile-preview-suffix-confirm.png)       | 390 × 844             | Confirmed prefix retained        |
| [External](assets/p6c-2/mobile-preview-external.png) / [Confirm](assets/p6c-2/mobile-preview-external-confirm.png) | 390 × 844             | Confirmed external origin        |
| [Provider unavailable](assets/p6c-2/mobile-provider-unavailable.png)                                               | 390 × 844             | Original itinerary retained      |
| [Adopt](assets/p6c-2/mobile-adopt.png)                                                                             | 390 × 844             | Explicit success and Undo entry  |
| [Undo](assets/p6c-2/mobile-undo.png)                                                                               | 390 × 844             | Restored planning state          |
| [320 px](assets/p6c-2/mobile-320.png)                                                                              | 320 × 844             | Narrow layout                    |
| [390 px](assets/p6c-2/mobile-390.png)                                                                              | 390 × 844             | Mobile layout                    |
| [Enlarged text](assets/p6c-2/mobile-enlarged.png)                                                                  | 390 × 844             | 24px root text, reachable action |
| [Desktop](assets/p6c-2/desktop.png)                                                                                | 1280 × 960            | Shared desktop side drawer       |
| [Real HTTP/PG Adopt](assets/p6c-2/postgres-mobile-adopt.png)                                                       | 390 × 844 (full page) | Actual persisted synthetic chain |

## Remaining limitations

Embedded map remains PARTIAL; Google Consumer Transit / PR #41 remains PARTIAL/frozen and is not a dependency. Real Geoapify/F-05 remains OPEN/PARTIAL, F-06 OPEN, real timetables/fares and physical iPhone/Safari/touch/soft keyboard unverified. Hotel-only shortcut remains BLOCKED. Origin confirmation uses the existing supported execution path; this batch adds no arbitrary location input. No automatic replanning, Provider refresh, production deployment or next batch. Stop at Draft for human review.
