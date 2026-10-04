# CURRENT TASK — P6C2-01 RESOLVED

Recommendation: GPT-5.6 Sol / High.

Controller decision: repair P6C2-01 in PR #49 only.

- Branch: feat/p6c-2-failure-hardening
- Blocker HEAD: 92f90fd56a2b0633a598af70b3b5434121453997
- Expected main basis: 0e5a94c7bd4f64c4e94f208053074c4ddcdbb22f
- Migration remains 26.

Problem: text-only Place Search state is omitted from the authoring dirty baseline, so drawer close or replacement can reset it without the existing draft confirmation.

Required behavior:
- search text that would be lost on close counts as dirty;
- search language also counts as dirty if lossy;
- drag close, close button, and drawer replacement all reuse the existing authoring discard guard;
- dismissing the prompt keeps exact search values;
- accepted discard behaves as before;
- selected candidate and note protection remain unchanged;
- search edits remain zero-write.

Important async edge case: saved-place loading later establishes the initial baseline. User search text/language entered before that request resolves must not be absorbed into the baseline and become clean. Add regression for both before-load and after-load edits.

Review explicit cancel-search behavior: it may intentionally clear search-only draft state, but must not silently clear unrelated note/place draft. Test the intended behavior.

Keep the existing failing browser regression unskipped. Add focused Chromium/WebKit cases for text-only, language-only, before-load, close/navigation replacement, accepted discard, cancel semantics, and zero-write footprint. Preserve the existing 18 PostgreSQL hardening regressions.

Production edits must stay limited to authoring/place-search draft-state integration. Do not change Place Search API/provider semantics, Query/Preview/Adopt/Undo, A/B workflow contracts, schema/migration, or PR #41.

Run full final-head validation: frozen install, Prisma generate/validate, format/lint/typecheck/build, Unit, PostgreSQL, Chromium/WebKit, Compose, P5B. Only mark RESOLVED after exact final-head CI is all green.

Keep Draft. Do not merge or deploy. Stop for human review.


## P6C2-01 resolution evidence

RESOLVED after the exact repaired execution HEAD passed all CI jobs. The original failing regression remains active and unskipped, with its assertions preserved.

- Repair starting PR HEAD: `71d63fc506e697bf8f851c94eb6056d75c91e942`.
- Validated repaired execution HEAD: `6c35ebf2682b7fb511bd1a7d09d2d5e2a822eb90`.
- CI: [37168691198](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/37168691198), **completed/success**.
- verify, Compose verification, P5B acceptance: **all completed/success**.
- Unit **781**, PostgreSQL **659** (106 persistence + 553 API), Chromium **226**, WebKit **226** in CI and locally. Existing **18** PostgreSQL hardening cases unchanged.
- Frozen install, Prisma generate/validate, format/lint/typecheck/build, full Unit/PostgreSQL/Chromium/WebKit, Compose and P5B rerun on frozen repaired source and passed. CI clean deploy **26**; local status **26/no pending**. Schema/migration delta **0/0**.
- Production changes confined to `authoring.ts` and `place-search.ts`: exact local search text/language baseline established before async saved-place loading; existing guard on close/drag/Escape/replacement; cancel clears only search state; expired candidate invalidation preserves the baseline; accepted-write search snapshot retains later edits without changing formal command/accepted snapshots.
- **21** new browser cases plus strengthened expired-evidence recovery; original failing handle/replacement assertions intact. Refused discard keeps exact values; accepted discard works; note/saved-place/candidate and pending-write protection retained; search edits/cancel remain zero-write.
- All **3** new SYNTHETIC repair PNGs actually opened. Original blocker images remain historical evidence.

This following documentation-only commit records the successful repaired execution HEAD; it does not change runtime or tests. Its exact final HEAD and a second complete CI must be recorded in [PR #49](https://github.com/tonivikingdom/TRAVEL-V1/pull/49) and succeed before handoff; this file cannot embed its own commit hash. Keep Open / Draft and stop for human review after that verification.

Physical iPhone / iOS Safari / actual soft keyboard remain unverified. No new A replanning UI/API is connected here; its future async Trip/account-switch integration must extend these helpers. Embedded map / Google Transit remain PARTIAL; real Provider/timetable/fare and F-05/F-06 remain open. No Ready, merge, deploy, PR #41 change, or next task.

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
