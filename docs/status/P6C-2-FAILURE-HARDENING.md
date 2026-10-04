# P6C-2 Failure / Concurrency / Mobile Hardening — BLOCKED

Recommendation: GPT-5.6 Sol / High; fallback available Sol / High. Runtime switch not claimed; escalate for disputed owner/version/concurrency evidence.

Starting main **`0e5a94c7bd4f64c4e94f208053074c4ddcdbb22f`** fetched and matched. Branch `feat/p6c-2-failure-hardening`. Migration **26**. All new test data **SYNTHETIC**; no real/paid Provider.

## Stop condition / discovered blocker

**P6C2-01 blocks completion.** Text-only Place Search drafts are absent from discard protection. A normal handle drag closes the drawer with zero confirmation and resets authoring/search context; opening a route detail also bypasses protection. `FormData` excludes the unnamed search input/language controls, leaving `draftDirty` false. Chromium and WebKit independently reproduce it. [CURRENT-TASK](../codex/CURRENT-TASK.md) records exact steps and scope.

Production remains untouched. This affects authoring/search draft-state across modalities, beyond a handle-only interaction repair. Per user instruction, stop development and await controller decision; do not repair A/B or weaken the active failing regression. This is incomplete acceptance work, not green final delivery.

## Harness / invariants matrix

API helper `apps/api/test/helpers/replanning-acceptance.ts` wires existing services and Fastify over real Prisma/PostgreSQL repositories. Only clock/route/ground Providers are synthetic. Gates synchronize requests instead of fixed delays. Cleanup targets created owners only. Browser helper mocks HTTP for UI behavior; mocked responses are not persistence proof.

| Invariant                                             | Current evidence                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Query failure Trip unchanged                          | PostgreSQL unavailable / no match / unsupported; distinct HTTP/code; zero rows changed                                     |
| Query success                                         | Only RouteCandidateSnapshot changes; explicit basisVersion                                                                 |
| Preview success                                       | Only RoutePreview changes; explicit basisVersion                                                                           |
| Preview failure                                       | N Query → N+1 Preview and expired snapshot rejected; zero writes                                                           |
| Adopt failure before commit                           | Actual PostgreSQL exception at outbox insertion; earlier transaction writes rolled back; same-key retry succeeds           |
| Stale Adopt                                           | N Preview → N+1 Adopt VERSION_CONFLICT; zero writes                                                                        |
| Provider late arrival                                 | Trip advances while Provider gated; Query VERSION_CONFLICT; zero writes                                                    |
| Two devices Adopt                                     | Different previews: one success / one VERSION_CONFLICT; exactly one version increment/route/edge/receipt/outbox            |
| Double click / idempotency                            | Parallel same-key requests replay same response; one receipt/outbox; changed request key reuse conflicts                   |
| Undo vs new facts                                     | Fresh undo window; accepted execution fact retained, UNDO_CONFLICT; no planning changes                                    |
| Undo / fact race                                      | Both request orders queued behind real owner advisory lock; first succeeds, second fails; no accepted fact lost            |
| Logout during Provider request                        | Already-authorized Query may finish only private snapshot; revoked session 401 and another owner 404 on subsequent Preview |
| Owner/admin isolation                                 | Other USER/ADMIN Query/Preview/Adopt/Undo/Impact/Backup 404; zero changes                                                  |
| Impact / Handoff / Backup GET                         | Actual PostgreSQL rows unchanged; no additional route-provider query                                                       |
| Replanning failure / static Backup                    | Stored artifact remains unchanged                                                                                          |
| Provider failure UI                                   | Local failure; live timeline remains; no formal request                                                                    |
| Slow / repeated tap                                   | Query/close/Adopt disabled; no duplicate request; pending Escape/drag does not close/Adopt                                 |
| Close/back                                            | Preview button / Escape / drag never sends Adopt                                                                           |
| Changed search intent / late UI response              | Earlier Query discarded; no candidate/formal request                                                                       |
| Query 401 while pending                               | Session removed; no candidates or Adopt                                                                                    |
| Authoring title draft                                 | Refused route open / handle close preserves title                                                                          |
| Place Search text-only draft                          | **FAIL: P6C2-01**, handle closes without confirmation                                                                      |
| Impact/Backup browser views                           | Zero planning/formal requests                                                                                              |
| 320/375/390/430                                       | Actual 24px root font; simulated VisualViewport resize/restore, scroll, no overflow, short/long drag                       |
| Landscape                                             | 740×375 failure sheet remains scrollable/closable; zero writes                                                             |
| Old response after Trip/account switch; A integration | Remaining coverage incomplete at stop                                                                                      |

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

## Validation at stop

- Isolated PostgreSQL 17, `p6c2_synthetic_test`: deploy **26**; **18/18** new integration cases PASS.
- Final targeted suites: Chromium **16 PASS / 1 FAIL**; WebKit **16 PASS / 1 FAIL**, both P6C2-01. Independent normal-handle repro also fails with zero confirmation. Final regression retains visibility/value/confirmation assertions.
- Prettier format, ESLint and full workspace typecheck **PASS** (typecheck regenerates Prisma). The harness explicitly annotates its exported row-snapshot type for Prisma declaration portability; assertions still compare full rows.
- Full Unit/full PostgreSQL/full browsers/Compose/P5B final validation not completed after blocker. No older CI substituted. An evidence Draft PR cannot claim green acceptance.
- Physical iPhone / iOS Safari / actual soft keyboard **not verified**; VisualViewport is a simulation.

## Visual evidence

Existing product UI only. All **10** SYNTHETIC images were actually opened: failure/pending/conflict/overflow evidence; the blocker before/after panels document the unconfirmed closure, not a repaired UX.

- [Provider unavailable](assets/p6c-2-hardening/mobile-provider-unavailable.png)
- [Pending / disabled](assets/p6c-2-hardening/mobile-pending-disabled.png)
- [Preview conflict](assets/p6c-2-hardening/mobile-preview-version-conflict.png)
- [Adopt conflict](assets/p6c-2-hardening/mobile-adopt-version-conflict.png)
- [320px](assets/p6c-2-hardening/mobile-320-large-text-failure.png), [375px](assets/p6c-2-hardening/mobile-375-large-text-failure.png), [390px](assets/p6c-2-hardening/mobile-390-large-text-failure.png), [430px](assets/p6c-2-hardening/mobile-430-large-text-failure.png)
- [Search draft before close](assets/p6c-2-hardening/mobile-place-search-draft-before-close.png)
- [Drawer closed without confirmation](assets/p6c-2-hardening/mobile-place-search-draft-lost-after-close.png)

## Deltas / remaining limitations

Production **0**; API/application/Domain/Provider/schema/migration **0/0/0/0/0/0**, migration total **26**. No new Query/Preview/Adopt rule, replanning UI, offline capability or backup architecture. Backup remains immutable and separate from Live; Impact remains read-only and does not automatically Query. A/B and PR #41 untouched.

P6C2-01 unresolved; remaining matrix/full final CI incomplete. Embedded map and Google Transit PARTIAL; real Provider/timetable/fare, F-05/F-06 and physical-device acceptance remain open. Keep evidence PR Draft. No Ready/merge/deploy/next task; stop for controller review.
