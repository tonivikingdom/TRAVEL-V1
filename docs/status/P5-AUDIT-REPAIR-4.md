# P5 Audit Repair Batch 4 — F-07 / F-08

- Starting main: `1fe6f8bba5a438c2ec11616d6296abaa567f4455` (P5E2 Batch 5B2B COMPLETE).
- Branch: `feature/p5-audit-repair-4-storage-reconciliation-wording`.
- Recommended model: GPT-6 Sol / High; the active session's model/effort is not exposed for verification.
- Scope: DB-authoritative private-object maintenance and current Debug Web/status wording. No P5E2 changes.

## F-07: stale reservations and physical cleanup

Previously, a process crash between `reserve(PENDING)` and `markReady/markFailed` left quota reserved indefinitely.
Physical delete failure also had no durable retry/completion metadata. The DB is now the cleanup authority; no provider
bucket or filesystem discovery is performed.

Migration `20261002090000_p5_audit_storage_reconciliation` adds `storageDeletedAt` (timestamptz),
`cleanupAttempts` (integer default 0), `cleanupNextAttemptAt` (timestamptz), `cleanupLastErrorCode` (varchar 64)
and a `(state, storageDeletedAt, cleanupNextAttemptAt, createdAt)` index. This is one new migration, 24 total.
Existing logical states and evidence remain unchanged; legacy physical completion is null, not presumed successful.

`storageDeletedAt` means confirmed physical deletion, independently of the logical FAILED/DELETED lifecycle.
READY/PENDING cannot carry physical completion. The quota algorithm still counts PENDING + READY only, with the
existing owner advisory lock and unchanged product limits.

Each DB READY Worker heartbeat requests at most one batch. A single atomic SQL claim selects eligible rows with
`FOR UPDATE SKIP LOCKED`, increments `cleanupAttempts`, sets a lease and moves stale PENDING to FAILED. This
immediately releases stale quota even if deletion later fails. The transaction ends before provider I/O. Completion
and retry updates match the exact owner/id/key/attempt and uncompleted FAILED/DELETED state, fencing late Workers.

| Worker environment             | Default                | Valid range        |
| ------------------------------ | ---------------------- | ------------------ |
| `OBJECT_PENDING_STALE_MS`      | 1,800,000 (30 minutes) | 60,000–604,800,000 |
| `OBJECT_CLEANUP_BATCH_SIZE`    | 25                     | 1–100              |
| `OBJECT_CLEANUP_LEASE_MS`      | 60,000                 | 1,000–600,000      |
| `OBJECT_CLEANUP_RETRY_BASE_MS` | 5,000                  | 100–60,000         |
| `OBJECT_CLEANUP_RETRY_MAX_MS`  | 3,600,000              | 60,000–86,400,000  |

Retry is `min(max, base * 2^(attempt-1))`; sanitized allowlisted codes replace raw exceptions. There is no permanent
attempt limit. One object's error does not skip other candidates or escape the heartbeat maintenance wrapper. Logs
contain `storage_reconciliation` and claimed/cleaned/failed/fenced counts, without keys, paths or secrets.

| Crash/failure                                        | Recovery                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| After reserve, no physical file                      | Stale claim releases quota; missing-object delete succeeds                                     |
| Physical object/partial exists before markReady      | Stale claim removes the exact DB-owned object and partial                                      |
| After claim, before deletion                         | Lease expiry permits the restarted Worker to claim the next attempt                            |
| After provider deletion, before DB completion        | Next attempt repeats idempotent delete and records completion                                  |
| Synchronous upload failure / explicit delete failure | FAILED / DELETED remains authoritative and retryable                                           |
| Long upload crosses stale cutoff                     | Late markReady fails; upload failure cleanup takes a new fenced attempt; no READY resurrection |

Synchronous upload cleanup preserves the original API error. Explicit deletion remains logically DELETED even when
physical storage returns STORAGE_UNAVAILABLE. Their immediate cleanup records success or schedules the same Worker
retry. A late upload's cleanup can reopen an already completed physical deletion to handle its late write.

LocalFilesystem deletes existing, missing and concurrently deleted regular files idempotently. Its partial filename
is now `.tmp-{reservation UUID}` so crash cleanup can delete exactly the partial belonging to the trusted DB key.
Unknown objects and legacy random partial filenames are never discovered or inferred; this maintenance does not
claim to clean unknown pre-existing files. UUID validation, private safe root, symlink rejection and regular-file
guards remain in force. Development/Test API and Worker share the configured local root/Compose named volume.
Staging/Production remains unconfigured: reconciliation is a no-op, without enabling a real Provider.

No public cleanup endpoint, durable cleanup JobType or per-object Job is added. No Attachment UI/product or quota
limit changes are introduced.

## F-08: monitoring, polling and Push wording

Current copy now distinguishes implemented server-side Flight/Ground Transit monitoring, opt-in Assistance capability,
durable Worker Jobs and in-app NotificationEvent from unimplemented native Push and client/OS background location
collection. Debug Web does not automatically poll. Its flight panel keeps the credential warning and makes the
panel/server distinction explicit; execution-risk buttons are manual test triggers, while server monitoring/provider
flows can also evaluate risk. Lightweight tests verify the copy is rendered by the actual panels.

Current architecture responsibilities/roadmap are corrected. Dated audit findings and P1B2 ADR evidence remain
historical, with an additive follow-up link rather than rewriting the original failure.

## Findings status and boundaries

| Finding | Result                                                                                    |
| ------- | ----------------------------------------------------------------------------------------- |
| F-07    | CLOSED by durable bounded reconciliation and crash/concurrency acceptance                 |
| F-08    | CLOSED by current wording and Debug Web regression coverage                               |
| F-05    | OPEN — real Provider retention/account entitlement remains an independent production gate |
| F-06    | OPEN — concrete Provider webhook/polling/Push strategy remains unverified                 |

Real ObjectStorage/Hub/Ground Transit Providers, paid calls, bucket enumeration, Push, webhook ingress, automatic
Query/Preview/Adopt, formal clients, Staging and Production deployment: **NO**.

## Validation

Cloud first-layer acceptance passed:

- Frozen install, Prisma generate/validate, format, lint, full typecheck and build.
- Unit: **719/719**; full PostgreSQL 17 integration: **580/580** (102 persistence + 478 API).
- Focused PostgreSQL: **16/16**, including quota/crash/retry/SKIP LOCKED/attempt fencing/upload races and migration.
- Clean Prisma deploy: **24 migrations**; populated baseline deploy: **23→24**, five storage lifecycle fixtures and
  twenty existing tables' facts preserved, including route receipts, external origins and Ground Transit evidence.
- Compiled API live/ready, Worker heartbeat/health and Debug Web HTTP health.
- Full Compose: existing route/execution/Worker acceptance remains green; a restarted Worker heartbeat transitions
  synthetic stale PENDING to FAILED, releases quota and physically removes its orphan from the shared local volume.
- P5B: **5 users / 200 requests / 0 isolation failures / 0 unexpected 5xx / 0 network failures**.

The final HEAD and independent three-job GitHub CI are recorded in the Draft PR. Draft remains for review;
no merge or deployment is authorized by this batch.
