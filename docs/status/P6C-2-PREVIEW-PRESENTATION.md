# P6C-2 Alternative Preview Presentation

推荐模型：GPT-5.6 Sol / Medium。备选 Sol / Medium；时间事实或调整范围存在歧义时升级推理强度。当前运行模型无法确认；本文不表示已切换模型。

## Scope and starting evidence

- Starting main: `0e5a94c7bd4f64c4e94f208053074c4ddcdbb22f` (fetched and matched).
- Branch: `feat/p6c-2-preview-presentation`.
- Migration total: **26**. API / contract / schema / migration delta: **0 / 0 / 0 / 0**.
- Ownership: immutable RoutePreviewView → Web view model → escaped markup; separate scoped CSS; standalone SYNTHETIC harness and presentation tests.
- Formal Web integration: imports and one `showPreview` rendering expression. Existing Query / Preview / Adopt / Undo handlers, minimum-dwell consent ID, permission/version/expiry checks remain authoritative.
- No A planning workflow, C touch/drawer implementation, Provider, application/domain/persistence, CI standards, migration or schema changes. No paid calls or deployment.

## Presentation matrix

| Domain field                                                                 | User language                                                                                                         | Display / priority                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `routeCorridor.replacementScope = FULL_CORRIDOR`                             | 将重新规划这一段路线；明确起点与目的地                                                                                | Default / highest                                       |
| `routeCorridor.replacementScope = SUFFIX`                                    | 前面的已确认部分保持不变；从 X 之后调整                                                                               | Default / highest                                       |
| `anchor…` / `replacementAnchor…`                                             | Human endpoint labels from same-basis owned Trip, then candidate boundary names                                       | Default / highest; no UUID                              |
| `preservedPrefixNodeIds` / `preservedPrefixTransportEdgeIds`                 | Preserve confirmed prefix, bounded by supplied scope                                                                  | Default; no technical list                              |
| `externalOriginReplacement` / `materializedOrigin.location.name`             | 从你确认的当前位置 / 站点开始                                                                                         | Default / highest; not a new location observation       |
| `externalOriginId` / `providerHubRef` / source IDs / hashes / policy version | None                                                                                                                  | Not shown                                               |
| `transportAction` / `willReplaceTransportEdgeId(s)`                          | 新增交通 / 替换 N 段交通；same-basis route names                                                                      | Default / key changes; full list collapsed              |
| `nodesToRemove`                                                              | Summarize old automatic transfer points; explicitly highlight manual, protected or unidentified removals              | Default / important                                     |
| `nodesToReuse` / `nodesToCreate` / `generatedTransferPoints`                 | Retained transfer count / new route location count / readable transfer labels                                         | Summary default; details collapsed                      |
| `protectedBlockingTransportEdgeIds`                                          | Cannot cover protected transport facts; vehicle observations do not establish personal execution                      | Default / blocking                                      |
| `protectedBlockingNodes.protectionReasons`                                   | Time requirements, locked requirements only when evidenced, actual time facts, user edits/notes, protected references | Default / blocking; no raw enum                         |
| `status` / `adoptable`                                                       | Expired / rules updated / unsupported legacy / evidenced block / reason unavailable                                   | Default / blocking; does not calculate Adopt permission |
| `requiredUserAdjustments`                                                    | Existing minimum dwell before → after; retain unchecked explicit consent                                              | Default / important                                     |
| `userDwellAdjustments`                                                       | Stored Adopt receipt delta, not a Preview input                                                                       | Not consumed; no new write workflow                     |
| `downstreamImpact`                                                           | Authoritative projected dwell; infeasible / user minimum conflict / soft suggestion / unknown                         | Default / important; no second calculation              |
| `candidate.overall` / `proposedSegments`                                     | Proposed plan times in supplied time zones; mode/service/endpoints                                                    | Overall default; segments collapsed                     |
| `internalTransferDetails` / `legIndex`                                       | Station walking transfer, ordered through explicit leg indexes                                                        | Collapsed; never station-name matching                  |
| `proposedDayAssignments` / `proposedTransportDayProjections`                 | Not an engineering date-role list                                                                                     | Not shown; existing date semantics unchanged            |
| `archivableProviderActualTransportEdgeIds`                                   | Used by authoritative adoption/history rules                                                                          | No new presentation claim or history mutation           |

Same-basis Trip enrichment is optional and readonly. A Trip with a different ID or version is ignored. This is not a refresh or authorization mechanism; existing API/resource authorization still controls access. Missing labels use neutral names. Missing deletion evidence does **not** claim that no Place will be deleted.

## Structure and reusable interface

- `apps/web/src/preview-presentation.ts`: `previewPresentation(preview, trip?)` returns a pure view model; `previewMarkup(view)` escapes every displayed label. No I/O, clock, mutation, Provider or command dependency.
- `apps/web/src/preview-presentation.css`: scoped layout for readable stacked scope, key changes, warnings and expandable detail. No changes to shared drawer, VisualViewport, safe-area or touch rules.
- `apps/web/test/preview-harness/index.html?case=…`: Vite dev/test-only harness using existing contracts. Not a production build entry or a new product navigation layer.
- Formal Web keeps explicit `data-action="adopt"` outside the presentation renderer, and keeps `#accept-adjustments`. The renderer cannot adopt anything.

Viewing, folding and opening navigation do not change Trip.version, itinerary, execution facts, authoring receipts or user requirements. Only the existing explicit Adopt command can change Trip data. Candidate time display remains **PLANNED**, not ESTIMATED, vehicle ACTUAL or user execution.

## Contract limits / BLOCKED presentation requirements

1. **Exact before/after time delta and full-day impact: BLOCKED by existing contract.** Preview supplies candidate plan and limited downstream assessment, not a full before/after schedule. Show these supplied values and explicitly state the missing comparison. Do not subtract unrelated values or run Web feasibility logic.
2. **Finer explanation for a non-adoptable Preview without reason evidence: BLOCKED.** Map supplied status, protection reasons and downstream assessment. Otherwise say the specific reason is unavailable; do not guess expiry, personal execution or locked conflicts.
3. `nodesToRemove` has no node label/source. Same-basis Trip enables correct classification; without it, highlight uncertain removals instead of guessing automatic/manual origin. No contract extension.
4. Legacy proposed segments without explicit leg indexes cannot be interleaved with station walks by inference. When internal walks exist, show the authoritative original candidate leg order and explain the missing correspondence. Never append an unlinked walk as though it occurs after the whole route.
5. Minimal change is shown according to supplied CREATE/REPLACE evidence; no invented global no-op equivalence test.

These limits belong to contract/product decisions for the controller and A. This task does not extend APIs or Domain.

## Verification

Local evidence and the final commit CI are recorded in the Draft PR body. Full verification includes frozen install, Prisma generate/validate, format, lint, typecheck, build, Unit, isolated PostgreSQL migration/integration, Chromium, WebKit, Compose and P5B.

Presentation acceptance covers FULL, SUFFIX, EXTERNAL_ORIGIN, non-adoptable, protected/locked requirements, automatic/manual removals, minimal change, unknown optional labels, expiry, explicit dwell consent, XSS escaping, stale/foreign label context, explicit internal-transfer ordering, long Japanese names, 320/375/390/430, 24px enlarged text and desktop. Formal Web checks preserve explicit Adopt and refusal without dwell consent; the existing full suite exercises route replacement/Undo, authoring/drafts, owner/version regressions and Safari/touch protection.

Local Compose uses an isolated SYNTHETIC project with the environment proxy CA mounted for verified TLS. Repository Dockerfile, CI and TLS standards are unchanged. No live Provider calls.

## Visual evidence

All fixtures and screenshots are **SYNTHETIC**. Assets are committed under [assets/p6c-2-preview](assets/p6c-2-preview/). Full originals keep the entire captured UI; contact sheet preserves proportions and includes scope variants, protected block, removals, unknown information, narrow/enlarged layout and desktop.

[Review contact sheet](assets/p6c-2-preview/review-contact-sheet.jpg)

Screenshots were actually opened for review. This found and corrected a global header flex/height collision in the new scoped CSS; browser checks now verify header content fits its region, in addition to no horizontal overflow, 44px expansion control and scroll reachability.

## Remaining limits and stop

- A's new P6C-2 planning workflow is outside this task; module is independently reusable on the current RoutePreviewView contract.
- SYNTHETIC acceptance does not validate real services/fares or live Provider coverage. Google Transit / embedded maps remain PARTIAL; Geoapify/F-05 remains OPEN/PARTIAL under inherited rules.
- Physical iPhone touch/Safari/keyboard behavior remains unverified; automated WebKit is not a real-device claim.
- No recommendation engine, automatic Query/Preview/Adopt, schema, migration, offline feature, production deployment or merging.
- Deliver as **Draft PR**, stop for manual review.
