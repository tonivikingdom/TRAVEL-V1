# P6C-2 Failure / Concurrency / Mobile Hardening — P6C2-01 RESOLVED

Recommendation: GPT-5.6 Sol / High; fallback available Sol / High. Runtime switch not claimed; escalate for disputed owner/version/concurrency evidence.

Starting main **`0e5a94c7bd4f64c4e94f208053074c4ddcdbb22f`** fetched and matched. Branch `feat/p6c-2-failure-hardening`. Migration **26**. All new test data **SYNTHETIC**; no real/paid Provider.

## P6C2-01 authorized narrow repair

Repair starting PR HEAD **`71d63fc506e697bf8f851c94eb6056d75c91e942`**, fetched from PR #49 after the controller updated [CURRENT-TASK](../codex/CURRENT-TASK.md). The earlier blocker HEAD was `92f90fd56a2b0633a598af70b3b5434121453997`. On the unchanged old runtime, the new before-load text-only regression failed before repair: search typing was omitted from dirty-state. The original failing handle/replacement regression stays active with its assertions intact.

Production changes are confined to `apps/web/src/authoring.ts` and `apps/web/src/place-search.ts`. The picker records exact query/language values independently from formal FormData, before asynchronous saved-place loading. Authoring combines that local dirty-state with its existing form draft guard. Late saved-place responses cannot acknowledge search edits. Close button, handle drag, Escape and drawer replacement reuse the existing confirmation; refusing it retains exact values.

Explicit cancel resets search conditions to their initial values, removes search candidate state and invalidates late search results. It preserves unrelated notes and saved-place selection, including their discard protection. Invalidating expired candidate evidence during recovery preserves the search draft baseline. On an accepted authoring write, only the submitted search snapshot is acknowledged; search edits made while the write is pending remain dirty. Search controls stay outside formal command/accepted snapshots, so search-only changes cannot bypass duplicate-submit protection. Owner, base version and idempotency request fields are unchanged.

**P6C2-01 RESOLVED** after exact repaired execution HEAD `6c35ebf2682b7fb511bd1a7d09d2d5e2a822eb90` passed [CI 37168691198](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/37168691198). verify, Compose verification and P5B acceptance are **completed/success**. CI reports Unit **781**, PostgreSQL **659**, Chromium **226**, WebKit **226**. Keep PR #49 Draft.

This following documentation-only commit records those results. Its exact final HEAD must receive a second complete successful CI before handoff; final documentation HEAD/CI will be recorded in [PR #49](https://github.com/tonivikingdom/TRAVEL-V1/pull/49). Runtime and tests are unchanged from the validated execution HEAD.

## Harness / invariants matrix

API helper `apps/api/test/helpers/replanning-acceptance.ts` wires existing services and Fastify over real Prisma/PostgreSQL repositories. Only clock/route/ground Providers are synthetic. Gates synchronize requests instead of fixed delays. Cleanup targets created owners only. Browser helper mocks HTTP for UI behavior; mocked responses are not persistence proof.

| Invariant                                    | Current evidence                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Query failure Trip unchanged                 | PostgreSQL unavailable / no match / unsupported; distinct HTTP/code; zero rows changed                                     |
| Query success                                | Only RouteCandidateSnapshot changes; explicit basisVersion                                                                 |
| Preview success                              | Only RoutePreview changes; explicit basisVersion                                                                           |
| Preview failure                              | N Query → N+1 Preview and expired snapshot rejected; zero writes                                                           |
| Adopt failure before commit                  | Actual PostgreSQL exception at outbox insertion; earlier transaction writes rolled back; same-key retry succeeds           |
| Stale Adopt                                  | N Preview → N+1 Adopt VERSION_CONFLICT; zero writes                                                                        |
| Provider late arrival                        | Trip advances while Provider gated; Query VERSION_CONFLICT; zero writes                                                    |
| Two devices Adopt                            | Different previews: one success / one VERSION_CONFLICT; exactly one version increment/route/edge/receipt/outbox            |
| Double click / idempotency                   | Parallel same-key requests replay same response; one receipt/outbox; changed request key reuse conflicts                   |
| Undo vs new facts                            | Fresh undo window; accepted execution fact retained, UNDO_CONFLICT; no planning changes                                    |
| Undo / fact race                             | Both request orders queued behind real owner advisory lock; first succeeds, second fails; no accepted fact lost            |
| Logout during Provider request               | Already-authorized Query may finish only private snapshot; revoked session 401 and another owner 404 on subsequent Preview |
| Owner/admin isolation                        | Other USER/ADMIN Query/Preview/Adopt/Undo/Impact/Backup 404; zero changes                                                  |
| Impact / Handoff / Backup GET                | Actual PostgreSQL rows unchanged; no additional route-provider query                                                       |
| Replanning failure / static Backup           | Stored artifact remains unchanged                                                                                          |
| Provider failure UI                          | Local failure; live timeline remains; no formal request                                                                    |
| Slow / repeated tap                          | Query/close/Adopt disabled; no duplicate request; pending Escape/drag does not close/Adopt                                 |
| Close/back                                   | Preview button / Escape / drag never sends Adopt                                                                           |
| Changed search intent / late UI response     | Earlier Query discarded; no candidate/formal request                                                                       |
| Query 401 while pending                      | Session removed; no candidates or Adopt                                                                                    |
| Authoring title draft                        | Refused route open / handle close preserves title                                                                          |
| Place Search text/language draft             | Before/after async load × text/language × close/drag/route; refused confirmation preserves exact values                    |
| Impact/Backup browser views                  | Zero planning/formal requests                                                                                              |
| 320/375/390/430                              | Actual 24px root font; simulated VisualViewport resize/restore, scroll, no overflow, short/long drag                       |
| Landscape                                    | 740×375 failure sheet remains scrollable/closable; zero writes                                                             |
| Search cancel / pending authoring / recovery | Late candidate discarded; unrelated drafts retained; accepted command not repeated by search-only edits                    |

## DB write footprint

One RepeatableRead snapshot compares row contents, not counts: **Trip/version, ItineraryNode, TransportEdge, AdoptedRoute, RouteCandidateSnapshot, RoutePreview, OperationReceipt, OutboxEvent, ExecutionEvent**, plus TripStaticBackup, TripAuthoringReceipt, DayOccurrence, DateOwnership, TemporalValue and UserTimeIntent.

| Action                            | Permitted measured changes                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query / Preview success           | Candidate snapshots / previews respectively                                                                                                                      |
| Failure/stale/expiry/owner denial | None                                                                                                                                                             |
| Adopt success                     | Trip/version, nodes, edges, route, receipt, outbox, planned temporal values, day/date projections; snapshot/preview/execution/backup/authoring/intents unchanged |
| Undo wins race                    | Existing Undo footprint; +1 version and one extra receipt/outbox; zero execution write                                                                           |
| Fact wins race                    | Trip, temporal facts, ExecutionEvent; zero route/receipt/outbox change                                                                                           |
| Impact/Handoff/latest Backup view | None                                                                                                                                                             |

The before-commit fault is a uniquely named, trip-specific ephemeral PostgreSQL OutboxEvent trigger, removed in finally. Test-only DDL, **no product schema/migration**. No production guard or canonical day fixture changes.

## Repair validation

The new focused browser file adds **21 cases**: the 12 async/field/exit combinations, Escape/Impact replacement, accepted discard/pristine state, three cancel/unrelated-draft variants, late search cancellation, selected candidate/note protection, and two accepted-write snapshot cases. The existing expired-evidence recovery test adds search-only close/cancel assertions without dropping any original assertions. Browser HTTP mocks prove UI request behavior; they do not substitute for PostgreSQL persistence checks.

The existing **18** real-PostgreSQL hardening regressions and their full-row footprint assertions remain unchanged. Full frozen repair source validation:

| Check                                    | Local result                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Frozen install; Prisma generate/validate | PASS                                                                                 |
| Format / lint / typecheck / build        | PASS                                                                                 |
| Unit                                     | **781 PASS**                                                                         |
| PostgreSQL 17                            | **659 PASS** (106 persistence + 553 API), including the unchanged 18 hardening cases |
| Chromium                                 | **226 PASS**, including 55 targeted Place Search/hardening cases                     |
| WebKit                                   | **226 PASS**, including all original and new discard-protection assertions           |
| Compose                                  | PASS; unchanged full-chain verification script                                       |
| P5B                                      | PASS; 5 users / 200 requests, 0 isolation failures                                   |
| Migration                                | **26**, no pending migration, delta **0**                                            |

Local Compose initially encountered Docker storage exhaustion. Confirmed task-owned disposable test images/cache were removed; the unchanged suite then passed. Cloud-only build adaptation supplies the platform proxy CA with TLS verification enabled and default bridge networking; repository Docker/Compose files and all assertions are unchanged. The exact repaired execution CI above independently passed the repository scripts without cloud build adaptations.

Physical iPhone / iOS Safari / actual soft keyboard **not verified**. VisualViewport and browser touch/viewport tests are simulations, not hardware acceptance.

## Visual evidence

Existing product UI only; no visual redesign. The original **10** SYNTHETIC images were actually opened in the blocker phase and remain historical evidence. All **3** new repair PNGs were actually opened. They show retained search values before/after a refused handle close, including edits made before saved-place loading completes.

- [Provider unavailable](assets/p6c-2-hardening/mobile-provider-unavailable.png)
- [Pending / disabled](assets/p6c-2-hardening/mobile-pending-disabled.png)
- [Preview conflict](assets/p6c-2-hardening/mobile-preview-version-conflict.png)
- [Adopt conflict](assets/p6c-2-hardening/mobile-adopt-version-conflict.png)
- [320px](assets/p6c-2-hardening/mobile-320-large-text-failure.png), [375px](assets/p6c-2-hardening/mobile-375-large-text-failure.png), [390px](assets/p6c-2-hardening/mobile-390-large-text-failure.png), [430px](assets/p6c-2-hardening/mobile-430-large-text-failure.png)
- [Search draft before close](assets/p6c-2-hardening/mobile-place-search-draft-before-close.png)
- [Drawer closed without confirmation](assets/p6c-2-hardening/mobile-place-search-draft-lost-after-close.png)

- [Before-load search draft retained after refused drag](assets/p6c-2-hardening/mobile-search-draft-protected.png)
- [Search draft before discard prompt](assets/p6c-2-hardening/mobile-place-search-draft-before-discard-prompt.png)
- [Search draft retained after refused close](assets/p6c-2-hardening/mobile-place-search-draft-after-refused-close.png)

## Deltas / remaining limitations

Production **2 Web draft-state files only**; API/application/Domain/Provider/schema/migration **0/0/0/0/0/0**, migration total **26**. No new Query/Preview/Adopt rule, replanning UI, offline capability or backup architecture. Backup remains immutable and separate from Live; Impact remains read-only and does not automatically Query. Existing A/B workflow contracts and PR #41 unchanged.

P6C2-01 resolved; final documentation-head CI remains required before handoff; no new A replanning UI is connected in this task. A future UI/API must reuse and extend these helpers, including Trip/account-switch cases for its own async requests. Embedded map and Google Transit PARTIAL; real Provider/timetable/fare, F-05/F-06 and physical-device acceptance remain open. Keep PR #49 Draft. No Ready/merge/deploy/next task; stop for human review after final evidence.
