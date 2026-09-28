# P5 Audit Repair Batch 3 — F-04 / F-09 / F-12

Status: Draft PR, not a completed main baseline.

Baseline: `ea5230b5a864d8e5ebe379e0a723a0688aad415b`.
Branch: `feature/p5-audit-repair-3-evidence-chain-notifications`.

## F-04 — automatic execution evidence

Location decisions now return a structured reliability (`SUFFICIENT`, `WEAK`, or `INDETERMINATE`), policy version (`execution-location-v2`), reason codes, and competing node IDs. A unique, accurate single observation may still justify automatic arrival; there is no fixed dwell requirement or mandatory per-event user confirmation. Overlapping places and repeated location candidates do not create an automatic ARRIVAL. The optional motion contradiction rule requires both speed ≥12 m/s and heading ≥120° away from the target bearing while already at least one meter from it. These deliberately conservative thresholds identify clear directed pass-through motion, not a probability or a general trajectory classifier; missing speed/heading never penalizes a unique accurate point. The domain produces `WEAK` evidence for ambiguity or clear contradiction. Only `SUFFICIENT` decisions may persist a LOCATION ExecutionEvent and its ACTUAL fact, enforced in the writer and by the new database check. The persisted event retains the derived explanation, not the raw coordinates or a fabricated probability. Legacy events have null evidence rather than a guessed backfill. User correction, suppression, and watermark protections from Batch 1 remain authoritative.

## F-12 — one presentation for one accepted flight observation

ExecutionRisk and FlightMonitoring retain separate durable risk and flight facts. Notifications caused by the same accepted FlightBinding observation share a server-derived presentation group. A flight-change notification with a correlated downstream risk supersedes the risk reminder for presentation, while the risk row and risk notification remain in the database for audit. The visible notification includes the consequence of the downstream risk. A risk-only change remains visible; a subsequent distinct provider observation receives a distinct group. The grouping does not turn an unrelated Trip risk into flight impact, and the accepted observation's timestamp, not client input, determines the key. The database enforces at most one active notification per owner/group.

This is a narrow P5D3 presentation policy. It does not implement Push, a general cross-domain notification preference engine, or global deduplication of unrelated events.

## F-09 — isolated cross-layer acceptance

The existing Compose verification now invokes an additional synthetic-only acceptance: real HTTP authentication and owner isolation, PostgreSQL, an airport LOCATION arrival with persisted evidence/ACTUAL, an explicitly enabled FlightBinding, a durable Worker job, a deliberately injected first Provider failure with retry, a later accepted synthetic flight observation, ExecutionRisk, one active combined reminder, and replay checks. The synthetic Trip contains a selected flight, a fixed onward rail connection, and a user-protected latest departure for the flight. An initial on-demand synthetic refresh establishes the unchanged estimate before location inference; the departure intent is therefore satisfied at the first risk evaluation, then becomes violated by the +45-minute Worker revision. The flight departure is the nearest protected P5D1 target while the airport arrival is the execution frontier. The separate PostgreSQL regression also covers flight delay against a protected downstream rail connection when the execution frontier has advanced. The test-only provider is available only for `APP_ENV=development|test` with `SYNTHETIC_CI_ONLY=true`; it is not a real or paid provider. The isolated Compose project and its database are cleaned up by the existing verification script. No bearer token, Magic Link token, or raw location coordinates are written to the report.

The scenario uses an existing durable monitor job whose due time is advanced only inside the isolated CI database so that Worker claim/retry/replay can run promptly. This is a test-clock control, not production scheduling behavior.

## Migration and verification

Migration: `20260928100000_p5_audit_repair_3`. It adds nullable ExecutionEvent evidence columns and a nullable NotificationEvent presentation key/active state. Existing events and ACTUAL values are untouched. Existing notifications default to active, with no invented group. Clean and populated migration tests cover those rules. No historical migration is edited.

The full unit, PostgreSQL integration, Compose verification, P5B acceptance, and build results are recorded in the Draft PR/CI; local PostgreSQL and Docker are not assumed available. The historical audit findings remain as evidence of the pre-repair baseline.

Out of scope and still open: F-05, F-06, F-07, F-08. This batch does not start P5E2, change the flight webhook/polling strategy, introduce production providers, or deploy staging/production.
