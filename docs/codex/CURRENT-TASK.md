# CURRENT TASK — RESOLVED

The active backup → live authority-verification task has been removed after its result was recorded in [P6B-2 status](../status/P6B-2-TRAVEL-ESSENTIALS-BACKUP.md#pr-44-backup--live-authority-follow-up). The original instructions remain in Git history at `b317cbd3a26b57fde299b92d3e8dab83f7c8282e`.

Both materials entries now use the shared authoritative Trip verification. The explicitly opened static backup remains available during verification. Core failure conceals live content while retaining an explicitly opened static artifact, including a server-only copy; version disagreement requires reload; backup/in-trip-only failures remain local degradation. Owner/session/navigation/version/request guards and A/B draft/idempotency protections are preserved.

Evidence: 3 regressions failed on original product code; a further server-only artifact regression failed on the intermediate repair and was fixed without adding local-storage writes. All 12 new regressions now pass in each browser. Full Chromium 140, WebKit 140, Unit 754 and PostgreSQL 614 pass, as do real SYNTHETIC HTTP/PostgreSQL acceptance, frozen install, Prisma, format/lint/typecheck/build, Compose and P5B (5 users / 200 requests / zero isolation, unexpected-5xx or network failures).

The exact new HEAD and that HEAD's final CI link/results are recorded in [Draft PR #44](https://github.com/tonivikingdom/TRAVEL-V1/pull/44), after push and final verification. No older green run substitutes for final-head CI.

Migration total remains **26**. No API/storage/schema/Provider/route semantics redesign, G / PR #41 changes, P6C, merge or deployment. Stop for human review; no further active task is assigned here.
