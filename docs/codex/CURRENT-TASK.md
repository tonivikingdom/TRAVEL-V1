# CURRENT TASK — P6C-2 Failure / Concurrency / Mobile Hardening (BLOCKED)

Recommendation: GPT-5.6 Sol / High; fallback available Sol / High. No runtime switch is claimed. Escalate for uncertain owner/version/concurrency evidence.

- Starting main: `0e5a94c7bd4f64c4e94f208053074c4ddcdbb22f`, fetched and matched.
- Branch: `feat/p6c-2-failure-hardening`.
- Migration **26**, production API/schema/migration delta **0/0/0**.
- Own synthetic acceptance helpers, PostgreSQL footprint/concurrency tests and browser/mobile regressions. Do not modify A/B/Provider/PR #41.

## P6C2-01 — text-only Place Search draft bypasses discard protection

Reproduced on existing production Web, without product edits, in Chromium and WebKit. Open Trip → 添加安排 → 地点; wait for saved-place loading to finish; type `SYNTHETIC place-search protected draft` only in the search input; drag the normal handle down past 110px. **Observed:** the drawer closes without any confirmation, resetting authoring/search context. Switching to route detail also bypasses protection. **Required:** preserve the unsubmitted Place Search draft when navigation/closure is refused and honor discard protection.

Cause: `TripAuthoringEditor.input()` compares `new FormData(form)` with its baseline. `[data-place-query]` and `[data-place-language]` have no `name`, so their edits are absent from comparison and `draftDirty` remains false. The drawer/route close guards allow transition, and the closed callback calls `authoring.reset()`. A selected candidate or note is a different dirty state and does not cover text-only search.

This is cross-modal authoring/Place Search draft-state behavior, beyond Task C's narrow mobile interaction ownership. Current user instruction: “如果发现当前正式代码已有 bug：不要擅自大修。写入 docs/codex/CURRENT-TASK.md 明确 blocker，停止等待总控决定。” **No product repair applied. Stop development pending controller decision.**

- Active, unskipped failing regression: `apps/web/test/replanning-hardening.browser.ts`, `place-search draft refuses drag close and route open without clearing values`.
- PostgreSQL new harness: **18/18 PASS** against isolated PostgreSQL 17, with actual rows for all nine mandated resources plus Backup/Authoring/Day/Ownership/Temporal/Intent.
- Final targeted Chromium: **16 PASS / 1 FAIL**; WebKit: **16 PASS / 1 FAIL**. Independent normal-handle reproductions also fail in both engines (zero confirmation). The final regression asserts the drawer remains visible as well as draft value/confirmation.
- SYNTHETIC before/after evidence: `docs/status/assets/p6c-2-hardening/mobile-place-search-draft-before-close.png`, `mobile-place-search-draft-lost-after-close.png`.
- Full green final acceptance blocked; remaining work and actual checks: [status](../status/P6C-2-FAILURE-HARDENING.md).
- Do not RESOLVED, skip/weaken the regression, Ready, merge, deploy, repair A/B, change PR #41 or begin another task.

## Historical task — PR #46 integrated final acceptance (RESOLVED)

Recommendation: GPT-5.6 Sol / High; fallback available Sol / High. No runtime switch is claimed. Raise effort for time/concurrency regressions.

The user explicitly authorized integrating merged Mobile Safari/Touch main into the existing Place Search branch. This supersedes the previous fixture-only scope; no new feature phase is authorized.

- PR #46 must remain Open / Draft.
- Branch: `feat/place-search-geocoding`.
- Starting HEAD: `61733cd808a374826359db4e9b94d72979867838`.
- Integration base: `f407765675b3290a6aac01fbfd90506c150943bb`.
- Migration total: **26**, schema/migration delta **0/0**.
- Merge integration: `cae31e36f5f8d6aaff98ac83b7df441627a37566`.

Only conflict: `apps/web/src/styles.css`. Both appended rule groups are retained, with closing braces resolved explicitly. Preserve Place Search candidate/long-text/saved fallback styles and all Safari/touch input/font/viewport/scroll/safe-area rules. Keep drawer 44px handle, lost capture/cancel reset, dirty-draft guard, VisualViewport fitting and vh/dvh fallback. No whole-file ours/theirs replacement.

Keep `scripts/synthetic-route-day.mjs` canonical with Ground/handoff/suffix/external fixture changes and all 13 boundary cases: Tokyo midnight, full UTC-day minute sweep, exact ENDPOINT_DAY_MISMATCH and CROSS_DAY_TRANSFER_LOCATION negative controls, external trusted Tokyo context. Never weaken production Preview/Domain or change clocks/buffers.

Preserve search/cancel zero writes, explicit candidate selection before authoritative authoring, signed owner/Trip evidence, missing-coordinate rejection, local Provider degradation and saved fallback. Geoapify disabled by default; real Provider/F-05 OPEN/PARTIAL; no live/paid call.

Run complete integrated-head frozen install, Prisma generate/validate, format/lint/typecheck/build, Unit, PostgreSQL, Chromium, WebKit via final CI, Compose and P5B. Old local PASS/CI is not integrated evidence. The first integrated CI 37135295594 passed Compose/P5B but failed four new WebKit cases: a repeated handle drag became native text drag-and-drop. Add handle-only primary-pointer default-event/user-select prevention and selected-place native control text containment, preserve body text selection, use real capture release and require discard prompt/transform reset; keep every original assertion. Full final validation must rerun. Four joined mobile Place Search regressions cover 320/375/390/430, 24px text, drag/draft/lost-capture/keyboard protections and explicit write.

Only mark RESOLVED after latest main is integrated, conflicts are resolved and final-head verify (Chromium + WebKit), Compose and P5B CI are completed/success. Record validated HEAD and CI, and final documentation HEAD/CI in PR #46. Stop if main changes from the authorized base.

Do not Ready, merge, deploy, modify PR #47 or PR #41, or start another task. Stop for human review after final evidence.

## Resolution evidence

The authorized main was fetched again and remains `f407765675b3290a6aac01fbfd90506c150943bb`. Both parents are preserved in merge `cae31e36f5f8d6aaff98ac83b7df441627a37566`; the CSS conflict is resolved, all main and original Place Search rule blocks retained. The two narrow WebKit interaction repairs are documented in the status report; authoring and production API/Domain/Provider/Prisma remain unchanged from reviewed `61733cd`.

- Validated integrated execution HEAD: `79f54543fb848db404dd5f27cf6e60285153f8ba`.
- CI: [37136546370](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/37136546370), completed/success.
- verify, Compose verification, P5B acceptance: **all completed/success**.
- Unit **773**, PostgreSQL **627**, Chromium **166**, WebKit **166** in CI.
- Frozen install, Prisma generate/validate, format/lint/typecheck/build, full Unit/PostgreSQL/Chromium, Compose and P5B rerun locally on frozen integrated source and passed. Clean deploy **26**, populated deploy **26/no pending**, schema/migration delta **0/0**.
- Canonical midnight helper and companion files remain unchanged, all **13** boundary cases pass; original invalid fixtures remain rejected by exact guards.
- All **11** refreshed SYNTHETIC PNGs and the nine-panel contact sheet were actually opened.

RESOLVED was recorded only after that integrated HEAD's CI succeeded. This following documentation/artifact commit does not change runtime or tests. Its exact final HEAD and a second complete final-head CI must be recorded in [PR #46](https://github.com/tonivikingdom/TRAVEL-V1/pull/46) and succeed before handoff; the file cannot embed its own commit hash. Keep Draft and stop for human review. All real Geoapify/F-05 and hardware/Provider limitations remain OPEN/PARTIAL. No Ready, merge, deploy, PR #47 / PR #41 change or next task.
