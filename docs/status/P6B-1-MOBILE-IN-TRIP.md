# P6B-1 Mobile In-Trip Experience

Status: implemented for human review; keep Draft. No Ready, merge, deployment, P6B-2 or P6C work.

## Baseline and isolation

- Starting `origin/main`: `6871aa1f88964f8590ca61e3d368bb4da67072d3`; fetched and verified before development. The pre-submission fetch is recorded in the PR report.
- Branch: `feat/p6b-1-mobile-in-trip`.
- Task A PR #42 remained open/Draft during implementation. No cherry-pick, authoring implementation or dependency on its unmerged API/schema.
- Google PR #41, sidecar and Consumer Transit Provider behavior are untouched. All verification fixtures are **SYNTHETIC**; no paid Provider calls.
- Recommended model: GPT-5.6 Sol / High for scoped Web implementation and existing contracts; alternative: GPT-6.1 Sol / High if available. Escalate reasoning for conflicting time facts, execution frontier, timeline projection or concurrency analysis; routine UI construction does not need an upgrade. The runtime model identity cannot be independently verified from this workspace; this recommendation does not switch it.

## Implementation matrix

| Category                       | Existing evidence / implementation                                                                                                                                                                        | Outcome                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A: reuse main                  | TripView, DayOccurrence sequence, schedule evaluation, node times/dwell/intents, selected transport, saved routes/legs, explicit adoption provenance, maps/navigation, detail sheets, drafts and R1/R2/R3 | Reused; no parallel itinerary database or timeline                                                                              |
| B: Web projection/UI           | Device-local today, neutral next item, compact action/time/navigation cards, next leg with folded full transfer, saved Flight fields and honest unavailable states                                        | Implemented in the existing Trip page                                                                                           |
| C: API without schema          | Explicit user ExecutionEvent frontier and saved FlightBinding snapshots were not exposed together for this view                                                                                           | Added isolated owner-scoped read API                                                                                            |
| D: schema-dependent capability | PlaceView lacks a reliable accommodation classification                                                                                                                                                   | **BLOCKED**: no automatic hotel classification or hotel-only shortcut; ordinary known places still show name/address/notes/maps |

## Ownership and API

Owned changes are limited to formal Web projection/styles and B-specific tests; additive `in-trip` contracts, application read service, Prisma read repository and their barrel exports; API dependency wiring and one GET endpoint; this status document and B screenshots.

`GET /trips/:tripId/in-trip` returns the owned Trip version, explicit execution frontier and saved Flight snapshots. It requires an active authenticated actor and existing private-resource authorization. Foreign owners, including administrators, receive no private Trip data. Invalid IDs fail validation. The repository uses one repeatable-read transaction; no commands, Provider refreshes, receipts, events or Trip updates occur. Flight snapshots require the exact active edge/provider binding identity.

**Schema changes: 0. New migrations: 0. Existing migrations: 24.** DateOwnership, DayOccurrence/sequence, schedule storage, Route Query/Preview/Adopt/Undo and Provider semantics are unchanged. CI, lockfile and repository Compose configuration are unchanged.

## Product behavior

The existing Trip page now offers a lightweight **今天 / 下一步** mode beside **全部日程**. Its initial mode remains the existing itinerary. Today shows one relevant item, at most two subsequent items, the current date/time and a small set of actions. Complete details still open the existing sheet. Transfers use persisted order and explicit adoption evidence; the next leg is prominent and the complete ordered chain is collapsed by default.

The browser supplies its device timezone explicitly. Unknown/invalid timezone or ambiguous date occurrences produce a neutral state; server timezone is never a fallback. Current relevance is a plan projection unless coherent explicit user execution evidence exists. A past plan time does not mark an activity completed. Explicit arrival/departure records are labeled as records, rather than inferred current location. Vehicle ESTIMATED/ACTUAL, gates and other observations never imply the user boarded, departed or arrived.

Authoritative selected times are reused. ESTIMATED is emphasized, with the original plan shown only when the instant changes. Ground estimates require exact matching fresh stored evidence; stale/unavailable estimates fall back to plan with an honest availability message. Stored observations are labeled with their update timestamp and are never presented as guaranteed live. Vehicle ACTUAL retains its explicit vehicle label. Provider-only failures leave the rest of the Trip visible. Core failures, forbidden reads and mixed Trip/schedule/evidence versions hide the unreliable current view and offer recovery.

Flight details reuse stored AeroDataBox snapshots: scheduled, revised/predicted, runway actual, terminal, gate, baggage and secondary aircraft fields. Predicted is not actual delay; protected authoritative edge ACTUAL wins over a disagreeing raw observation. No new Provider implementation or refresh calls are introduced.

Places expose reliable names, address and notes. Reliable coordinates enable map/navigation; missing coordinates show unavailable location. Saved public-transit boarding enables walking directions; manual public-transit endpoints do not masquerade as boarding points. Walking/driving/taxi can navigate to a reliable destination. External maps may independently find directions and do not represent a saved service booking.

Action hints use existing plan/intents/minimum dwell only. No station/airport/global buffer is introduced. Where a latest recommended departure cannot be supported, the card says **暂时无法确定建议出发时间**.

## Projection versus formal data writes

| Interaction                                                                                      | Formal Trip effect                                                                                       |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Open Today, switch modes, select a displayed item, expand transfers, inspect saved Flight fields | Read-only UI projection; no Trip mutation                                                                |
| Device clock advances                                                                            | Local projection recalculation; no polling or background commands                                        |
| Reload                                                                                           | Authenticated stored-data reads and existing schedule evaluation; no Provider refresh or execution event |
| Open a map or navigation link                                                                    | No ExecutionEvent, Query, Preview or Adopt; no Google backend lookup                                     |
| Open existing detail sheet                                                                       | Read-only until an explicit existing edit/route action is submitted                                      |
| Explicit existing note/time/dwell/remove or Query/Preview/Adopt/Undo actions                     | Existing main commands retain their existing writes, authorization, concurrency and recovery rules       |

P6B-1 adds **no user execution command**, automatic route change, automatic skip/dwell extension or new formal Trip write.

## Verification

| Check                                                   | Result                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                        | PASS                                                                                                                    |
| Prisma generate / validate                              | PASS; existing 24 migrations deploy to empty isolated PostgreSQL                                                        |
| Format, lint, typecheck, build                          | PASS                                                                                                                    |
| Unit                                                    | **749 passed**                                                                                                          |
| PostgreSQL integration                                  | **102 persistence + 489 API = 591 passed**                                                                              |
| Chromium, full formal Web suite                         | **84 passed**                                                                                                           |
| WebKit, full formal Web suite                           | **84 passed**                                                                                                           |
| Actual PostgreSQL + HTTP + Chromium baseline acceptance | PASS: edit/version/revocation/offline/drafts/route replacement/Adopt/Undo/navigation chains                             |
| Compose                                                 | PASS                                                                                                                    |
| P5B                                                     | PASS: 5 users, 200 requests; 0 isolation failures, 0 unexpected 5xx, 0 network failures                                 |
| Draft PR CI                                             | Existing CI includes Chromium **and** WebKit, PostgreSQL, Compose and P5B; final run results/links are in the PR report |

New B coverage includes future and elapsed plans, unknown progress, coherent recorded execution and undone/conflicting events, version refusal, forbidden reads, saved ESTIMATED/vehicle ACTUAL, unavailable/stale Provider evidence, explicit leg order/provenance, trustworthy/missing navigation coordinates, manual walking, unknown free-action time, Flight source hierarchy and protected actuals, service 503/offline recovery, concurrent read isolation, 320/375/390/430px long text and enlarged text, safe-area CSS, scroll reachability and desktop. Existing R1/R2/R3, draft recovery, Query/Preview/Adopt/Undo and route replacement suites remain included.

Evidence boundaries: B browser scenarios use explicit **SYNTHETIC** contract fixtures; the new API has authenticated real PostgreSQL integration coverage. The separate unchanged baseline harness verifies the existing browser → real HTTP → PostgreSQL chain. This is not a claim that every new B browser scenario used a live backend or Provider.

Cloud adaptations stayed outside the repository: official WebKit was downloaded and its missing Debian runtime libraries were supplied locally, with an explicit official executable path; the same browser suites/assertions ran. Compose used task-local CA/proxy forwarding and cleared copied incremental build caches before building. TLS validation, assertions, repository Dockerfile/Compose scripts and CI standards were not weakened.

## Screenshots

All screenshots use clearly marked **SYNTHETIC** fixtures. Each linked image was actually opened and visually inspected, rather than only generated.

| Acceptance view                                      | Screenshot                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Mobile Today first screen                            | [mobile-today](assets/p6b-1/mobile-today.png)                             |
| Place next step                                      | [mobile-place](assets/p6b-1/mobile-place.png)                             |
| Transport next step                                  | [mobile-transport](assets/p6b-1/mobile-transport.png)                     |
| Ordered multi-leg transfer                           | [mobile-transfer](assets/p6b-1/mobile-transfer.png)                       |
| Changed estimate / original plan                     | [mobile-estimated](assets/p6b-1/mobile-estimated.png)                     |
| Vehicle actual, progress unknown                     | [mobile-vehicle-actual](assets/p6b-1/mobile-vehicle-actual.png)           |
| Provider unavailable / unknown                       | [mobile-unavailable](assets/p6b-1/mobile-unavailable.png)                 |
| Saved Flight hierarchy                               | [mobile-flight](assets/p6b-1/mobile-flight.png)                           |
| 320px                                                | [mobile-320](assets/p6b-1/mobile-320.png)                                 |
| 375px                                                | [mobile-375](assets/p6b-1/mobile-375.png)                                 |
| 390px                                                | [mobile-390](assets/p6b-1/mobile-390.png)                                 |
| 430px                                                | [mobile-430](assets/p6b-1/mobile-430.png)                                 |
| Enlarged text, long station                          | [mobile-enlarged](assets/p6b-1/mobile-enlarged.png)                       |
| 320px enlarged text, long place, missing coordinates | [mobile-place-long-enlarged](assets/p6b-1/mobile-place-long-enlarged.png) |
| Desktop                                              | [desktop](assets/p6b-1/desktop.png)                                       |

## Remaining limits and gate

- Reliable accommodation classification is **BLOCKED** pending an authorized Domain/schema capability; no name-based hotel guesses.
- Progress needs existing explicit user execution records; no GPS, background location, boarding inference or newly created execution facts. External-origin-only evidence does not become a recorded node position in this view.
- Saved Provider observations require explicit reload to read newer stored data; they are not continuous live tracking. Provider unavailability reflects existing persisted evidence, not a new health probe.
- No complete offline mode/static backup. Core service failure hides the current view; embedded maps remain **PARTIAL** with external navigation only.
- WebKit desktop automation is covered; physical iOS/Safari/device accessibility verification remains a human review activity.
- If main changes, especially when task A merges, integration must be reconciled without overwriting either feature and the full regression rerun before merge. No automatic force rebase.

Keep the PR **Draft** for human review. No deployment or follow-on task is authorized by this delivery.
