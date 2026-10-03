# P6C-1 — Trip Impact & Re-evaluation Experience

Starting main: `77b37ac1931b5ffe653bc147eebf90949258e94c`. Branch: `feat/p6c-1-impact-reevaluation`. Draft delivery only; no deployment, merge, P6C-2 or PR #41 changes.

Recommended model: GPT-5.6 Sol / High. The execution interface does not independently expose a verifiable model subconfiguration; this recommendation does not claim a model switch.

## Implementation matrix

| Category                | Existing authority                                                                                                                                                                                   | This batch                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A: Domain               | Schedule evaluation, independent protected requirements, execution risk, boarding/transfer safety, operational disposition, execution frontier, suffix eligibility and external-origin authorization | Reused directly. No second feasibility engine, new buffer or persistence enum.                                                           |
| B: Application/API      | Schedule evaluation, Ground Transit read, route-reevaluation, saved Flight facts and in-trip read                                                                                                    | Existing handoff and execution semantics retained; formal Web gets a quiet auxiliary impact card in Today/Next and an explanation sheet. |
| C: thin read projection | Existing risk evaluation reconciles durable risks/notifications; no combined read-only user projection                                                                                               | One owner-scoped GET endpoint combines the existing pure evaluators and existing read services without reconciliation writes.            |
| D: missing Domain       | No new Domain rule is necessary for this scoped read experience                                                                                                                                      | None added. Missing reliable timing/provenance stays UNKNOWN.                                                                            |
| E: excluded             | Alternative search, adoption, execution confirmation and other next-batch actions                                                                                                                    | No automatic Query/Preview/Adopt, mutation, location inference, Provider refresh, fee commitment or schema change.                       |

## Read authority and consistency

`GET /trips/:tripId/impact` returns `tripId`, `basisVersion`, `evaluatedAt`, explanation items and the unchanged existing route-reevaluation handoffs. Items use the existing SATISFIED / VIOLATED / UNKNOWN / CONFLICT schedule status and a display-only change flag. Web maps these to quiet / attention / adjustment needed / unknown; no new business state machine exists.

Authorization uses READ_PRIVATE_RESOURCE and owner-scoped repositories. Foreign users and administrators receive no private Trip facts. The service evaluates the existing schedule and the same pure execution-risk input adapter used by the durable risk service. The durable risk service retains its reconciliation behavior; this endpoint never invokes that write path.

The service checks matching Trip versions across the initial reads and the handoff basis. It also checks Ground Transit observation/state identity and rereads Trip, Ground Transit and user execution/Flight evidence before returning. Changed observation facts are rejected even when they do not increment Trip.version. A mixed basis returns controlled VERSION_CONFLICT; Web requires reload rather than presenting a stale result.

Provider cancellation/endpoint change uses the existing operational assessment. Missing/expired Ground Transit evidence and unresolved origins remain unknown. Saved Flight observations are honestly labelled as stored evidence, not a newly verified live status; unavailable or insufficient current evidence cannot imply an on-time guarantee.

Explicit coherent user execution records restrict the remaining relevant itinerary. A service's ARRIVED_PENDING_HANDOFF/COMPLETED state or vehicle/Flight ACTUAL never advances user progress or marks the user's Trip completed. No ExecutionEvent is created.

## User experience

Today/Next keeps its existing next step first. A small auxiliary card says either the checked arrangements can continue, time/transport changed, later arrangements need adjustment, or the impact cannot yet be determined. Quiet state is not a realtime guarantee.

The sheet identifies the affected place or exact current transport and explains the existing authoritative constraint or operational result. The 13:00 arrival / 15:00 departure / one-hour minimum example with a reliable 13:35 estimate remains attention, explaining a 35-minute reduction and 85 minutes remaining. An unmet minimum or missed fixed service is an adjustment, not an invented AI risk score. Independent requirements remain unchanged.

NOT_REQUIRED has no replanning action. ORIGIN_UNRESOLVED explains that current position/progress must be confirmed first, without guessing it. READY offers “查看调整方案”: in this batch it reveals the supported origin/destination entry and explicitly says no alternative service has been searched. It does not invoke Query. Confirmed-node suffix explains that the earlier confirmed portion remains unchanged and replanning starts after the named node; an external origin uses the existing trusted confirmation and source-bound handoff.

The existing mobile bottom sheet / desktop side drawer is reused with grouped controls, symmetric padding, wrapping text and 320/375/390/430 px checks. Authoring, submitted-snapshot draft protection, saved transport timing/navigation, explicit Adopt/Undo and static backup are unchanged.

## Verification and evidence boundaries

All fixtures are **SYNTHETIC**, in isolated development/test databases. No real paid Provider, timetable/fare validation, GPS collection or production data is used.

- Frozen install; Prisma generate/validate; format, lint, typecheck and build: passed.
- Unit: **767 passed**. PostgreSQL 17: **106 persistence + 520 API = 626 passed**. Existing clean 26 / populated 25→26 migration and historical migration tests remain included. New schema/migrations: **0**; total **26**.
- New PostgreSQL/API regressions prove attention/35-minute loss, satisfied/violated dwell, missed next traffic, cancellation/changed endpoint, unavailable and PENDING/ARRIVED_PENDING_HANDOFF/COMPLETED service states, exact confirmed suffix READY, owner isolation, version race and vehicle/Flight ACTUAL separation. Durable counts remain unchanged by reads. Thirteen focused scenarios passed after the latest source edits.
- Full Chromium suite: **157 cases**, including existing P6A authoring/drafts/route constraints and P6B static backup. The new 17 cases cover all impact presentations, handoff readiness, no automatic planning calls, late/mismatched reads, mobile widths, enlarged text and desktop. Final source-freeze validation and independent CI results are recorded in the PR report.
- `scripts/p6c1-browser-postgres.ts` performs actual Chromium → authenticated HTTP → PostgreSQL: reliable estimate → attention → explain 35-minute loss; a separately committed synthetic timing change → missed-service explanation. It asserts zero read-side durable writes and zero Query/Preview/Adopt calls. It refuses non-local/non-test database use.
- Compose: **PASS**, including API/Worker, existing route/execution/Adopt/Undo, object storage and outage/recovery. P5B: **PASS — 5 users / 200 requests / 0 isolation failures / 0 unexpected 5xx / 0 network failures**. Exact final-HEAD Chromium/WebKit CI is recorded in the PR report after execution; earlier runs do not substitute for final-HEAD CI.

The initial HTTP harness encountered stale workspace dist exports and passed after building current source. Its final rerun initially refused the inherited development APP_ENV, before any fixture writes; explicit APP_ENV=test retained the safety guard. A stale close-control selector was aligned to the existing frame, and the complete real HTTP/PG/browser chain then passed. The first local browser launch lacked the default Playwright Chromium executable; the installed Chromium binary ran the unchanged suite. Visual inspection found an incorrect new drawer container class; the shared existing frame fixed its spacing. The targeted layout selectors were then aligned to the existing sheet/close control while preserving overflow and reachability assertions. Docker initially hit a read-only default configuration directory and a proxy-host mismatch; task-local configuration/CA-secret builds were used outside Git. The VFS daemon also exhausted disk during container creation/recreation; identified inactive synthetic images and current-task build caches were reclaimed. An empty-database startup health failure and an initial migration-container failure were not passing evidence; separately initializing the owned test database/migrations allowed the unchanged acceptance to pass. Current-source images were explicitly built once with a CA secret, then used for runtime acceptance without repeated rebuilds. No assertion, CI requirement, TLS validation, dependency or repository infrastructure was weakened.

The first GitHub Compose run and its retry correctly rejected an existing Ground Transit acceptance fixture at the Tokyo midnight boundary (`PREVIEW_UNSUPPORTED / ENDPOINT_DAY_MISMATCH`). This was reproduced locally on the original fixture: its 30-minute candidate arrived on the following date while both endpoints had been placed on the departure date. The synthetic ground/external fixtures now use the actual endpoint dates. Immediate handoff/suffix replacement fixtures explicitly select a test timezone away from midnight, because their same-day replacement scenario is not a cross-night planning test. Five focused fixture regressions cover midnight/year boundaries and the explicit safe test timezone. Domain date validation and all adoption/Undo assertions remain unchanged. These fixture-only repairs are not a product timezone fallback.

## Visual review artifacts

All originals are browser contract captures with visibly SYNTHETIC data. They were opened and inspected; they contain no credentials, cookies or real personal data. Full-page height can exceed the viewport. The contact sheet preserves native proportions and complete UI; it is an index, not a substitute for the originals or device acceptance.

[Review contact sheet](assets/p6c-1/review-contact-sheet.jpg) — 1386 × 7270 px, RGB JPEG, native 1:1 screenshot pixels with titles and no cropping. Sixteen original PNG views remain separately available.

| Artifact                                                               | Viewport   | Scenario                               |
| ---------------------------------------------------------------------- | ---------- | -------------------------------------- |
| [No impact](assets/p6c-1/mobile-no-impact.png)                         | 390 × 844  | Quiet checked-plan card                |
| [Attention](assets/p6c-1/mobile-attention.png)                         | 390 × 844  | Time change, still feasible            |
| [Adjustment needed](assets/p6c-1/mobile-replan-needed.png)             | 390 × 844  | Authoritative conflict                 |
| [Unknown](assets/p6c-1/mobile-unknown.png)                             | 390 × 844  | Information insufficient               |
| [Attention explanation](assets/p6c-1/mobile-attention-detail.png)      | 390 × 844  | 35-minute loss, still feasible         |
| [Adjustment explanation](assets/p6c-1/mobile-replan-needed-detail.png) | 390 × 844  | Missed transport / minimum reason      |
| [Unknown explanation](assets/p6c-1/mobile-unknown-detail.png)          | 390 × 844  | Missing reliable time evidence         |
| [Origin unresolved](assets/p6c-1/mobile-origin-unresolved.png)         | 390 × 844  | Confirmation needed; no query          |
| [Ready](assets/p6c-1/mobile-ready.png)                                 | 390 × 844  | Supported entry/destination, no search |
| [Suffix](assets/p6c-1/mobile-suffix.png)                               | 390 × 844  | Confirmed prefix preserved             |
| [320 px](assets/p6c-1/mobile-320.png)                                  | 320 × 844  | Narrow layout                          |
| [375 px](assets/p6c-1/mobile-375.png)                                  | 375 × 844  | Mobile layout                          |
| [390 px](assets/p6c-1/mobile-390.png)                                  | 390 × 844  | Mobile layout                          |
| [430 px](assets/p6c-1/mobile-430.png)                                  | 430 × 844  | Wider mobile layout                    |
| [Enlarged text](assets/p6c-1/mobile-enlarged.png)                      | 390 × 844  | 24px root text; reachable controls     |
| [Desktop](assets/p6c-1/desktop.png)                                    | 1280 × 960 | Next-step-first auxiliary impact       |

## Limitations and stopping point

This is stored-fact impact and entry visibility, not continuous monitoring in the browser, alternative route search or a complete replanning workflow. It does not prove real Provider availability/coverage or user location. Unsupported/insufficient facts remain unknown. Re-evaluation may require an existing explicit origin confirmation, which is not automated by this batch.

Formal Place Search/geocoding is not connected; embedded maps remain PARTIAL. Real timetable/fare and physical iPhone touch/Safari/soft keyboard remain unverified. F-05/F-06 remain OPEN; F-07/F-08 remain CLOSED. WebKit CI results are separate from local Chromium; browser automation is not device validation.

CURRENT-TASK remains RESOLVED with its historical information intact. Stop at Draft PR for human review. No merge, deployment, P6C-2, automatic planning or PR #41 modification.
