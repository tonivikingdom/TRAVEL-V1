# V1 final Provider diagnostics integration

Date: 2026-10-09 (Asia/Shanghai). Recommended model: GPT-6.1 Sol / High; fallback available Sol / High. Actual model subconfiguration is unknown. Escalate audit effort and stop if commit ownership, conflict or semantic differences appear.

Branch: `integration/v1-provider-safety-convergence`.
Approved starting base: `fix/v1-adoption-evidence-ttl`, exact `3e3de1e30b15ae3ffbf11be36e04df98cf1119b3`; its prior CI `37872554464` is historical evidence, not final integration acceptance.

## Sources and provenance

Fetch confirmed the three source heads and the QA head exactly matched the controller's values. Source #58 and #60 share ancestor `b5523548340d421443afeb1c99dcc6d3afb26f59` (#55), already contained in the approved base. `git cherry` / revision-set inspection identified one unique commit per requested source. No #53/#54/#55, #56/#57/#59/#61 repair commit was repeated.

| Source PR | Exact source commit                        | Cherry-picked commit                       | Stable patch-id                            |
| --------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| #58       | `5060ecea7804b519e9b18d95b742dcf97474f165` | `3ee5c751c2e7cabb91ac186a1bfe169535bcd3c7` | `4079a34ce02f1166ee658481441c6f1cf316413b` |
| #60       | `52491b1cc4ef23aa4f422c56a3d064aa5f924026` | `a5aabeba8fc5d7d3aa11835383b99c27108f5c71` | `5f21140a98f85f7e6c6d5fdb338bca6e240984b2` |

Both were cherry-picked **#58 → #60 with `-x`**, with no conflicts or rewrites. Source and picked patch-ids match. All 14 per-commit changed blobs match their source commits; all 13 final source-changed files match the #60 source tree. The changed path set before this documentation commit is exactly the union of the two source commits. A following documentation-only commit records evidence; it cannot embed its own hash. The exact final source HEAD and final CI are recorded in the new Draft PR body/checks.

[Machine-readable provenance](assets/provider-safety-convergence/provenance.json) records full patch-ids, source/picked/final blob hashes and 16 protected files whose blobs match #61. Google route class and the Baidu request/time-policy section also have identical SHA-256 digests before/after. No source PR branch is modified.

## Integration difference and safety review

| Boundary                                 | Result and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baidu WALKING stages                     | Existing request → routes shape → endpoint objects → coordinate parse → strict binding → duration → candidate construction now emits closed diagnostics. Source #60 tests cover valid structure, missing/type-invalid fields, invalid coordinates/duration, wrong coordinate system, offsets, collapse/reversal and optional observer behavior.                                                                                                                               |
| Endpoint binding                         | `endpoint-binding.ts` is byte-identical to #61. WGS84/BD09 normalization, six-decimal equivalence, Google 100 m / Baidu 30 m **exclusion limits**, distinctness, orientation, collapse rejection and retained provenance are unchanged. There is no endpoint replacement, invented access connection or duration.                                                                                                                                                             |
| Google requests / Baidu time semantics   | Google route class is byte-identical; Baidu query time/mode validation and HTTP request construction are byte-identical. No new future-driving approval, date fallback, ordinary-route fallback or fixed TRANSIT timetable is introduced. TRANSIT 1002 remains unsupported; failure is not no-routes.                                                                                                                                                                         |
| HTTPS proxy and certificate verification | `package.json`, Doctor CLI, proxy regression, regional HTTP adapter and existing configuration are unchanged. Node `--use-env-proxy`, CA validation, timeouts, request budget and exception classification remain. Local CONNECT tests retain untrusted-CA refusal. No TLS/CA bypass or credential extraction.                                                                                                                                                                |
| Diagnostic privacy                       | Source #58 adds Doctor-only `responseEvidence`, containing only whitelisted content/body/target/intermediary/source categories. Source #60 adds four fixed diagnostic field names and an optional Baidu observer. Serialization whitelists strip extra properties and reject unknown values. No AK, private name, Header value, URL, coordinates, exception message or raw Provider body is emitted. SYNTHETIC redaction and request-budget tests run in the full Unit suite. |
| Query → Preview → Adopt → Undo           | Application, persistence and official contracts have no source change. RWS-02, I59-01, UTC/Tokyo calendar repair and ordinary/external Draft TTL repository/helpers are unchanged; full PostgreSQL and original C regression validate their behavior.                                                                                                                                                                                                                         |
| Production gates                         | Gate/configuration files and dependencies unchanged. No enablement, new entitlement, purchase, live dispatch, source-branch modification, main merge or deployment.                                                                                                                                                                                                                                                                                                           |

Formal Travel API / Contract / Schema / Migration delta: **0 / 0 / 0 / 0**. Doctor diagnostic output has the explicitly inherited additive closed `responseEvidence` field and four fixed diagnostic-field symbols; the Baidu adapter's internal optional observer argument is inherited from #60. These are not Route Domain/API/schema changes. Migration count remains **27**.

## Original independent C regression

QA source branch: `qa/i59-adoption-ttl-race`, exact `e7d04157532e2d361173d4447252d636bc346cdb`.

Only `apps/api/test/i59-adoption-ttl-race.integration.test.ts` was copied from that exact commit into a separate detached integration checkout, `/workspace/TRAVEL-CONVERGENCE-QA`. No QA branch merge/cherry-pick, production code, assertion or test clock was changed. The entire test file's blob equals source blob **`dd4d1d6c5c1e2c499d60f0d252aa9461fb0ce65a`** before and after execution.

Task-owned PostgreSQL database: `v1_provider_convergence_qa`, clean deploy of 27 migrations. Original suite: **8 PASS / 0 FAIL** at execution HEAD `a5aabeba8fc5d7d3aa11835383b99c27108f5c71`: fixed BUS and non-fixed aggregate TRANSIT, already-expired rejection, successful receipt replay, actual owner-lock waits and deterministic write-phase expiry. The original zero-write comparisons, PREVIEW_STALE expectations and two Clock-sample assertion are unchanged.

The original test retains a historical `targetHead=9a477...` literal in its generated audit output; it was deliberately not rewritten. [Result wrapper](assets/provider-safety-convergence/original-qa-result.json) separately records the actual integration execution HEAD and original outputs. [Unchanged-suite run log](assets/provider-safety-convergence/original-qa-vitest.log) records eight passes. Repeat on final documentation HEAD before delivery and record that exact rerun in the PR body.

The first isolated-checkout attempt could not load tests because its generated Prisma client was missing; pnpm's linked dependency check refused a modules-directory purge without TTY. No shared modules were purged or production code changed. Generate was completed using the existing locked Prisma binary, then all eight original tests ran successfully. Environment setup failure is not claimed as a product regression.

## Full validation

Main integration test database: `v1_provider_convergence`, separate from the QA database. Test/build commands unset the four real Google/Baidu server/browser bindings; every Provider response is SYNTHETIC or a local test server. No `provider --live` command or real Provider request is executed in this task.

| Check                                                    | Result                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Frozen install, Prisma generate / validate, clean deploy | PASS; 27 migrations                                                             |
| Unit                                                     | PASS: 1282 / 98 files                                                           |
| PostgreSQL integration                                   | PASS: 106 persistence + 705 API = 811 / 45 files; original QA separately 8 PASS |
| Format / Lint / Typecheck / Build                        | PASS                                                                            |
| Chromium / WebKit                                        | Exact final HEAD standard CI; results in new Draft PR                           |
| Compose verification / P5B acceptance                    | Exact final HEAD standard CI; results in new Draft PR                           |

Local shared filesystem has under 400 MB available; final complete browser and Docker Compose/P5B acceptance runs in unchanged GitHub Actions on the exact pushed HEAD. No test standard, workflow, TLS or production setting is weakened. Historical source test numbers and the #61 CI do not substitute for final integration validation.

## Live / production status remains separate

This task's real Provider requests: **0**. Historical source reports remain unchanged and labeled historical:

- Google Places' earlier `LIVE_CONTRACT_PASS` validates only that recorded Place Search contract/scenario. It does not certify Google Routes, typed identity propagation, endpoint access connections or complete Provider readiness. Internal Place IDs/notes never become trusted Google Place IDs.
- Baidu WALKING's earlier HTTP 200 / business status 0 did not establish a normalized trustworthy route. The #60 live attempt obtained no HTTP response and reported NETWORK_BLOCKED; its post-status-0 contract failure is still not live-isolated. SYNTHETIC granular diagnosis is code acceptance, not live Provider acceptance.
- Google official Routes remains blocked where returned road endpoints cannot satisfy strict equivalence / reliable access evidence. Baidu real WALKING/other ordinary-mode coverage, future-driving entitlement, coordinate truth and operator fare/timetable truth remain OPEN/PARTIAL as recorded.
- Production approval remains NOT_REVIEWED/PARTIAL. F-05/F-06, actual entitlement, storage/retention/TTL/deletion/attribution/quota/pricing/coverage, Japan staging/production prohibition and long-running reliability, map SDK and physical iPhone/Safari/keyboard acceptance are not closed by this integration.
- Final application Clock sample → COMMIT/response latency and Clock synchronization remain the previously documented operational timing assumptions; #61's checks are preserved, not advertised as an atomic wall-clock COMMIT predicate.

Deliver one new Draft PR with base `fix/v1-adoption-evidence-ttl`; no Ready, merge, deployment, real enablement or next task. Stop for independent review after final HEAD Verify / Compose / P5B all succeed.
