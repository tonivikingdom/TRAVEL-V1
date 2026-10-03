# CURRENT TASK — PR #44 backup → live authority verification

## Execution recommendation
- Model: GPT-5.6 Sol
- Thinking: High

## Scope
Continue the existing P6B-2 branch and Draft PR #44 only.

- Repository: tonivikingdom/TRAVEL-V1
- Branch: `feat/p6b-2-travel-essentials-backup`
- Reviewed HEAD before this task: `0bc9bda702d81d519ac1469044cea93f16873ab9`
- Starting main for P6B-2: `2bd53f99d39bff2b18011d44404e4a5dbf19efaa`
- Migration total must remain: **26**

Do not modify G / PR #41. Do not start P6C. Keep PR #44 Draft.

## Confirmed good behavior — preserve it
The direct "旅行资料 / 备份" entry now verifies the authoritative Trip before exposing live materials.

Preserve:
- Core Trip failure hides stale in-memory online Trip/Flight data.
- Backup-only or in-trip-only failure is local degradation, not a whole-app outage.
- 401/403/404 and Trip/version mismatch fail closed.
- Request sequence, materials-open state, navigation epoch, owner, credential and Trip/version guards prevent stale responses from filling a newer context.
- A/B authoring drafts, owner isolation, version protection and idempotency behavior remain intact.
- Backup architecture, owner-private GET/POST backup API, append-only JSONB, 1 MiB limit and static HTML semantics remain unchanged.

## Blocking review finding
There is still a second path into online materials that bypasses the authority verification.

Current click handling for `data-action="live-essentials"` effectively does:

```ts
viewingBackup = null;
render();
```

This means:

1. User loads a Trip while the service is healthy.
2. User opens/views a static backup.
3. Core service later becomes unavailable while browser connectivity itself remains available.
4. User presses **查看在线旅行资料**.

The UI can return directly to cached in-memory Trip/Flight data and label it as online materials without re-reading the authoritative Trip.

The same bypass matters if another device has advanced the Trip version while this user is viewing the backup.

This violates the established rule: entering live/online materials must be preceded by an authoritative Trip verification.

## Required implementation
First add failing regression coverage against the current behavior.

Then make **查看在线旅行资料** use the same authoritative verification path/protection as the main materials entry.

Prefer one shared authority-verification flow. Do not add a second divergent outage implementation.

While verification is pending:
- do not expose cached online Trip/Flight as verified live data;
- keep the explicit static backup available;
- preserve owner/session/navigation/version stale-response guards.

Expected outcomes:

### Core Trip unavailable
Backup → 查看在线旅行资料 → authoritative Trip read fails.

Result:
- do not show old in-memory Trip/Flight as 在线行程资料;
- clearly show service unavailable / backup-safe state;
- the already generated static backup remains available.

### Trip version changed
Backup was opened from Trip version N; server now has N+1.

Result:
- do not render N as verified online material;
- follow the existing version/reload semantics;
- do not mix N and N+1.

### Core Trip healthy; backup API fails
Online Trip remains usable.
Backup capability degrades locally.

### Core Trip healthy; in-trip/flight read fails
Reliable Trip/saved transport material remains usable.
Failed evidence/flight data must not be retained as if current.

## Audit adjacent paths
Inspect other transitions inside the materials module that switch from backup/fallback state into live materials.

If an equivalent bypass exists, cover/fix it using the same shared authority flow.

Do **not** turn this into a project-wide refactor.

## Required regressions
At minimum add browser-level regression for:

1. Backup → live, then core 503.
2. Backup → live, then network failure.
3. Backup → live after authoritative Trip version changes.
4. Backup → live with backup endpoint failure only.
5. Backup → live with in-trip endpoint failure only.
6. Delayed old success cannot refill after close/reopen.
7. Delayed old failure cannot overwrite a newer successful read.
8. Owner/logout/Trip switch during verification cannot leak/refill data.

Keep all previously added P6B-2 outage regressions passing.

Where practical, verify the core failure path with real HTTP/PostgreSQL synthetic acceptance as in the previous repair.

## Non-goals / forbidden changes
Do not:
- redesign backup storage;
- add schema or migration;
- change migration total from 26;
- modify Provider semantics;
- change Query/Preview/Adopt/Undo;
- infer hotel classification;
- implement offline editing/app shell;
- modify G / PR #41;
- start P6C;
- deploy production.

## Validation
Run the normal final-head validation appropriate to this PR:
- frozen install
- Prisma generate / validate
- format / lint / typecheck / build
- Unit
- PostgreSQL integration
- Chromium
- WebKit in final CI
- Compose
- P5B

Do not use an older green CI as evidence for the new HEAD.

## Delivery
Update the existing PR #44 only.

After implementation:
- keep Draft;
- push the new HEAD;
- update `docs/status/P6B-2-TRAVEL-ESSENTIALS-BACKUP.md` with this regression and evidence;
- update this file with a short **RESOLVED** section containing the new HEAD and evidence, or remove its active-task content only after the status document records the result.

Final report should include:
- new HEAD;
- files changed;
- exact regression count/result;
- Unit/PostgreSQL/Chromium/WebKit totals;
- Compose/P5B;
- migration total = 26;
- final CI URL;
- confirmation that PR #44 remains Draft.

Stop for human review. Do not merge.
