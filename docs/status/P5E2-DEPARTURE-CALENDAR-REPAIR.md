# P5E2 — UTC/Tokyo departure eligibility repair

## Scope

Recommended model: GPT-6.1 Sol / Extra High. Fallback: available Sol / High or Extra High. Calendar context, execution provenance and transaction rollback require careful review; escalate for any unexplained clock or lock boundary. Actual client model configuration is unknown.

- Exact starting HEAD: `c6acff57ca4a70a0e4b73675148bcffbf265124d`.
- Branch: `fix/v1-adoption-evidence-ttl`; existing Draft PR #61, base `integration/v1-release-readiness`.
- Prior CI `37806725147`: verify and P5B passed; Compose failed at the unchanged assertion `P5E2 Batch 4 expired fixed suffix service must be rejected`. This run is failure evidence, not final acceptance.
- Production change: only `packages/application/src/route-departure-eligibility.ts`. No API, contract, schema, migration, provider, Web or approval-gate change. Migration total **27**, all four deltas **0**.
- Provider requests **0 real / 0 paid**. Real isolated task PostgreSQL database: `v1_departure_tokyo`; all Provider results explicitly SYNTHETIC.

## Root cause and independent reproduction

The canonical fixture's absolute instants and endpoint local dates are valid. `syntheticRouteDay` deliberately supplies an explicit single-day Tokyo or UTC context; `syntheticExternalWindow` retains trusted Tokyo and explicit cross-day endpoints. Their existing full UTC-day minute sweep and negative Preview controls remain unchanged.

The execution API saves the event-linked ACTUAL TemporalValue with `timeZone: UTC`. That is its storage representation, not evidence that the origin's local calendar is UTC. The departure guard previously preferred that ACTUAL zone over planned/intent/candidate context. At `2030-09-30T16:01Z`, the Tokyo itinerary date is October 1 but the serialized UTC date is September 30. The guard incorrectly classified the executing Trip as future planning before consulting its open execution frontier.

Before any production edit, three desired-behavior assertions were independently run against the exact starting code and isolated PostgreSQL:

| Phase   | Expected                    | Reproduced before repair | Database effect                       |
| ------- | --------------------------- | ------------------------ | ------------------------------------- |
| Query   | 404 `NO_MATCHING_CANDIDATE` | 200                      | New Snapshot                          |
| Preview | 409 `PREVIEW_STALE`         | 201, adoptable           | New Preview                           |
| Adopt   | 409 `PREVIEW_STALE`         | 200                      | Version 4 → 5 and formal route writes |

All three failures were the expected response assertions, with successful fixture setup and no database/setup errors. The user confirmed arrival at `15:58Z`, the fixed BUS departed `15:59Z`, and the server clock was `16:01Z`. Stored execution timezone remains UTC throughout. Preview and Snapshot were unexpired, so this independently isolates the calendar bug from I59-01 TTL rejection.

Sanitized fixed-clock evidence is committed under [before](assets/p5e2-departure-calendar/before/) and [after](assets/p5e2-departure-calendar/after/). It records HTTP status, version and full-row equality without credentials or private identifiers.

## Minimal repair and preserved boundaries

Exclude `execution-event:`-linked time values **only from calendar timezone selection**. Their committed, non-undone manual/sufficient events continue to authorize execution exactly as before. Explicit independent node time values, time intents and validated candidate departure clocks remain the existing calendar sources. No server-default timezone, coordinates/GPS inference or vehicle ACTUAL boarding inference is added. The event writer and its UTC serialization are unchanged.

All existing date-period and frontier rules remain intact: planning without confirmed progress and editing after the reliably classified Trip period remain supported; within the Trip period, a previous-day origin is execution-relevant only while the confirmed frontier is still `AT_NODE` at that origin. Explicit departure clears this previous-day carry-over; it does not invent arrival at the next node or boarding a vehicle. Unknown/invalid classification retains existing fail-closed behavior. Aggregate non-fixed TRANSIT remains a duration estimate, not a timetable.

The shared guard protects all existing call sites:

1. Query filters elapsed fixed candidates after Provider return. Snapshot persistence checks again after owner/Trip locks and after inserts; rejection rolls back draft writes.
2. Preview checks fixed clocks before creation and again inside its locked persistence transaction and after its insert; rejection leaves no new Preview.
3. New Adopt checks after authoritative locks and after all provisional writes. Existing RWS-02 departure rejection and I59-01 Preview/Snapshot/non-null Provider TTL checks abort the transaction. Successful receipt replay retains its existing priority; Undo semantics are unchanged.

The repair adds no Clock samples, changes no fixed service clock or TTL, and does not weaken any Preview/Domain cross-day guard. The original Compose negative assertion and positive later-service chain remain byte-for-byte unchanged.

## Deterministic regression and validation

- **9 added Unit cases**: before/after Tokyo and UTC midnight, local Tokyo date differing from UTC, both independent planned context and candidate-only context, committed open arrival vs explicit departure, historical manual facts, invalid explicit zone. Original departure assertions remain unchanged.
- **15 added PostgreSQL cases**: four boundary contexts × Query/Preview/Adopt, plus complete Query → Preview → Adopt → Undo chains for aggregate TRANSIT, planning-only history and old manual facts after the Trip period. Both fixed BUS and RAIL are exercised. No sleep or actual-time midnight dependency.
- All 12 rejection cases compare complete database row footprints: Trip/version, nodes/Places, TransportEdges, AdoptedRoutes, Snapshot/Preview, receipt/Outbox, TemporalValues, authoring/date/intent records, execution facts/state/location/watermark, history/projections, Ground Transit observations/transitions, external origins/receipts and jobs.
- Existing I59-01 **46 PostgreSQL + 13 Unit** TTL regressions remain, including both adoption origins, owner/Trip/source locks, provisional-write rollback, exact expiry, null Provider TTL, replay and Undo.
- Existing RWS-02 clock/lock/write-phase, historical, owner/version/idempotency and external-origin tests remain unchanged. Canonical midnight negative controls remain unchanged.

Full local Unit: **1,193 PASS**. Frozen install, Prisma generate/validate, clean deploy of all 27 migrations, Format, Lint, Typecheck and Build: PASS. Sidecar SYNTHETIC browser lifecycle (both modes, fresh contexts, no live traffic): PASS.

One local Compose image build exhausted the shared 32 GB disk. The concurrent first full API integration attempt then produced PostgreSQL `53100` / `No space left on device` failures; those results are not acceptance. Only caches/downloads created by this task were removed, and the complete isolated PostgreSQL suite was restarted. The local Compose attempt is infrastructure-blocked; the unchanged canonical Compose and P5B commands and full Chromium/WebKit suite must pass on the final HEAD in CI, without a CA/TLS workaround or reduced checks. Final local PostgreSQL counts, exact final HEAD and all three CI jobs are recorded in PR #61 after execution. Old CI is not substituted for final HEAD verification.

## Remaining risks / next task

- Query/Preview **draft evidence TTL** races independently recorded in [I59-01](V1-ADOPTION-EVIDENCE-TTL-REPAIR.md) are the next authorized task; this calendar repair does not implement those changes. New Adopt still rejects expired evidence atomically.
- The final application clock sample precedes the physical PostgreSQL COMMIT by finite latency. Trusted server-clock synchronization remains an operational assumption. This repair makes no stronger commit-instant guarantee.
- Date classification uses existing explicit calendar context and existing Trip-period semantics; it adds neither geolocation/timezone discovery nor a new execution lifecycle. Old arrival facts do not keep a finished Trip permanently active.
- Provider entitlement/reliability and production approval, F-05/F-06, storage/retention/deletion/attribution/quota/pricing/coverage, operator timetable/fare/cross-midnight truth, map SDK and physical iPhone/Safari/keyboard gates retain their inherited OPEN/PARTIAL values.
- Draft only. No main merge, production deployment/enablement, real Provider request, source PR #59 or Provider investigation branch modification.
