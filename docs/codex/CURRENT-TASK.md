# CURRENT TASK — PR #46 integrated final acceptance (ACTIVE)

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

Run complete integrated-head frozen install, Prisma generate/validate, format/lint/typecheck/build, Unit, PostgreSQL, Chromium, WebKit via final CI, Compose and P5B. Old local PASS/CI is not integrated evidence. Four joined mobile Place Search regressions cover 320/375/390/430, 24px text, drag/draft/lost-capture/keyboard protections and explicit write.

Only mark RESOLVED after latest main is integrated, conflicts are resolved and final-head verify (Chromium + WebKit), Compose and P5B CI are completed/success. Record validated HEAD and CI, and final documentation HEAD/CI in PR #46. Stop if main changes from the authorized base.

Do not Ready, merge, deploy, modify PR #47 or PR #41, or start another task. Stop for human review after final evidence.
