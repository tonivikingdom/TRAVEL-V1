# V1 final code consolidated candidate

Date: 2026-10-09 (Asia/Shanghai). Recommended model: GPT-6.1 Sol / High; fallback equivalent Sol / High. Actual model subconfiguration is not observable. Stop on an unexpected source commit, conflict or security semantic difference.

Branch: `integration/v1-consolidated-candidate`.
Approved exact base: `fix/v1-adoption-evidence-ttl`, `3e3de1e30b15ae3ffbf11be36e04df98cf1119b3`.

This is the single proposed V1 **code candidate** for the controller's next independent review. It adds both Provider diagnosis sources and the original C safety regressions to the approved #61 code. It is not real Provider approval, production authorization or a deployment. The prior #62 candidate without the committed C suite is historical integration evidence, not an additional merge target. No existing source PR is changed or closed by this task.

## Exact commit sources

Fetch verified the approved base, both Provider source heads and the C QA head. Revision-set checks identified exactly one exclusive commit for each requested source after excluding the approved ancestors and, for #60, its #58 ancestor. The commits were cherry-picked **#58 → #60 → C QA with `-x`**. No merge, conflict, source rewrite or repeated #53/#54/#55/#56/#57/#59/#61 repair was introduced.

| Source | Original SHA                               | Picked SHA                                 | Stable patch-id                            |
| ------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| #58    | `5060ecea7804b519e9b18d95b742dcf97474f165` | `9ec206e696773bcc2c5e9d2f6c398e2290b11104` | `4079a34ce02f1166ee658481441c6f1cf316413b` |
| #60    | `52491b1cc4ef23aa4f422c56a3d064aa5f924026` | `b8a5792730dfa588a1a2859b571335eeca417d27` | `5f21140a98f85f7e6c6d5fdb338bca6e240984b2` |
| C QA   | `e7d04157532e2d361173d4447252d636bc346cdb` | `772c372d8b94cc6b62ef3695aea255c8cc5186e8` | `3add5bffe45ed9bec66cd982916586160a8f2b37` |

All three source/picked patch-ids and provenance trailers match. **28 per-commit blobs** and **27 final source files** equal their source trees. The source path set is exactly the union of these three commits. The final extra commit is this task's documentation/evidence only. Exact final HEAD and the new final-head CI are recorded in the Draft PR body/checks rather than a self-referential commit.

[Machine-readable provenance](assets/v1-consolidated/provenance.json) includes all source/picked/final blobs and **19 protected unchanged files**. The complete Google ordinary-route class and Baidu time/mode/request section also match the approved base byte-for-byte. All code outside the explicitly inherited Provider diagnostics and C test is unchanged.

## Safety and cross-regression review

| Boundary                | Evidence / preserved behavior                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Endpoint truth          | Shared binding and WGS84/BD09 implementation unchanged. Six-decimal equivalence, 100m Google / 30m Baidu exclusion limits, distinctness, collapse/reversal refusal and retained Provider endpoint evidence remain. No radius relaxation, canonical masking or fabricated connection. |
| Baidu WALKING diagnosis | Inherited shape → coordinate parse → strict binding → duration → candidate stages emit only runtime-whitelisted fields/codes. Status 0 is distinct from full Domain acceptance. Existing Baidu TRANSIT 1002 and aggregate duration semantics remain.                                 |
| Doctor proxy / privacy  | CLI, proxy regression, regional HTTP and dependencies unchanged. Environment proxy, CA verification, one-request budgets, deadlines and fixed exception categories remain. Diagnostic output has no AK, Headers, URL, coordinates, raw Provider body or free-form exception.         |
| Execution / time        | RWS-02 fixed-service eligibility, confirmed execution state, UTC/Tokyo date classification and canonical midnight fixture/negative assertions unchanged. Non-fixed TRANSIT is not promoted to a timetable or user execution fact.                                                    |
| Evidence TTL            | Approved ordinary/external Query/Snapshot and Preview post-lock/post-insert checks and both Adopt post-lock/post-write checks unchanged. `expiresAt <= now` remains stale; no renewal, buffer or Provider refresh is introduced.                                                     |
| Transaction / reads     | Query/Preview do not mutate official Trip state. Owner/version/hash/protected facts/date ownership/idempotent successful replay/Undo protections and atomic rollback remain.                                                                                                         |
| Runtime gates           | Configuration/API blobs unchanged. No real Provider enablement, automatic Query/Preview/Adopt, map SDK load, future-driving approval or Japan Consumer Transit staging/production permission change.                                                                                 |

Formal **Travel API / Contract / Schema / Migration delta = 0 / 0 / 0 / 0**, migration total **27**. Source #58/#60 add the closed Doctor `responseEvidence` output, four fixed diagnostic-field symbols and an internal optional Baidu observer; these additions are disclosed separately from the unchanged Travel contract. Production gates retain their original values.

## C's original eight regressions

The complete original QA commit is now included, including its historical failure report and evidence. `apps/api/test/i59-adoption-ttl-race.integration.test.ts` retains source blob **`dd4d1d6c5c1e2c499d60f0d252aa9461fb0ce65a`**. No assertion, import, fixture, injected Clock, helper call, expected status or test name was modified or skipped.

On source execution HEAD `772c372d8b94cc6b62ef3695aea255c8cc5186e8`, all **8 PASS / 0 FAIL**:

- Fixed BUS and non-fixed aggregate TRANSIT, already-expired evidence refuses Adopt with zero official writes.
- The same two modes, successful receipt replay after expiry remains successful and zero-write.
- The same two modes, actual PostgreSQL owner lock waits cross TTL and refuse the new Adopt; complete footprint is unchanged.
- The same two modes, tentative-write Clock crossing aborts the transaction, preserves the footprint and retains the exact two-sample assertion.

Original QA comments / reports and generated `targetHead=9a477...` literals refer to the historical failing baseline; they are deliberately preserved, not current failures. The test rewrites four historical `rerun/*.json` paths when executed. This task saves current SYNTHETIC results under a separate [evidence wrapper](assets/v1-consolidated/original-qa-result.json), then restores only those four known generated files to their source blobs. No historical FAIL record is overwritten in Git. The [current run log](assets/v1-consolidated/original-qa-run.txt) and wrapper identify actual execution HEAD separately. Repeat on the final documentation HEAD and record the exact result in the PR.

## Unified validation

Task-owned PostgreSQL database: `v1_consolidated_candidate`, independent of previous review/integration databases; clean deployment of all 27 migrations. Test/build commands unset the four real Google/Baidu server/browser bindings. Provider test fetches are SYNTHETIC mocks or local proxy/TLS servers. No `provider:doctor --live`, paid request or actual Provider query is executed. Real Provider requests: **0**.

| Check                                                    | Result                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Frozen install                                           | PASS                                                                                                       |
| Prisma generate / validate / clean migration deploy      | PASS; 27 migrations                                                                                        |
| Format / Lint / Typecheck / Build                        | PASS                                                                                                       |
| Full Unit                                                | PASS: **1282 / 98 files**                                                                                  |
| Provider Doctor + WALKING synthetic directed regressions | PASS: **129 / 5 files**, including local HTTPS CONNECT path / untrusted CA rejection, budget and redaction |
| Original C suite                                         | PASS: **8 / 8** unchanged assertions                                                                       |
| Full PostgreSQL                                          | PASS: **106 persistence + 713 API = 819 / 46 files**, including original C suite                           |
| Chromium / WebKit                                        | Complete unchanged final HEAD CI; result recorded in Draft PR                                              |
| Compose verification / P5B acceptance                    | Complete unchanged final HEAD CI; result recorded in Draft PR                                              |

The shared local filesystem has less than 400MB free; complete browser and Compose/P5B acceptance run in the unchanged GitHub Actions workflow. No timeout, test, guard, workflow, TLS or CA requirement is relaxed. Historical #61 / #62 CI is not a substitute for this candidate's final-head run. **CODE_INTEGRATION_READY may be reported only after verify, Compose verification and P5B acceptance all complete successfully on the final HEAD.**

Failure/conflict record: no cherry-pick conflict, semantic rewrite or test weakening. All local validations passed; no local test failure was hidden or reclassified. Final HEAD CI is mandatory and recorded in the PR. The preserved C source contains historical four-failure evidence on #59; that record is not relabeled as this candidate's outcome.

## Real acceptance and release gates remain open

- Google Places' historical `LIVE_CONTRACT_PASS` proves its recorded search contract only. It is not Google Routes or complete Provider acceptance. Typed trusted Google identity propagation, road-endpoint equivalence and independently verified access connections remain unresolved; internal UUIDs and notes are not trusted Google Place IDs.
- Baidu WALKING's historical HTTP 200/status 0 did not prove a usable bound route. #60's later attempt obtained no HTTP response and reported NETWORK_BLOCKED; real post-status-0 failure isolation is still unresolved. SYNTHETIC stage coverage is not live acceptance.
- Baidu real ordinary-mode coverage, numerical/Provider coordinate truth, future-driving account entitlement and timezone/time-window semantics need their recorded live acceptance. Aggregate TRANSIT remains estimated duration, not concrete train/bus service, fare or actual user execution evidence.
- Japan Consumer Transit staging/production prohibition remains. Upstream 503 history, long-running reliability, real cross-midnight and operator timetable/fare truth are not closed by this consolidation.
- F-05/F-06 remain OPEN. Entitlement, storage/retention/TTL/deletion/attribution/quota/pricing/coverage, production approval, map SDK and physical iPhone/Safari/soft-keyboard acceptance retain OPEN/PARTIAL/NOT_REVIEWED as previously recorded.
- Trusted Clock synchronization and the finite final Clock sample → COMMIT/response latency remain inherited operational limits; no atomic wall-clock COMMIT predicate is claimed.

## Suggested main dependency order (controller approval required)

After independent review of this candidate, the controller should reconcile the approved ancestor chain with the then-current main and choose one merge path:

1. Provider contract baseline #55, already containing #53/#54; do not independently reintroduce those inherited commits.
2. Release-readiness baseline #59, already containing #56/#57; do not repeat those source fixes.
3. Approved #61 evidence/execution safety baseline.
4. This consolidated candidate, which supplies #58/#60 and the original C tests. Do not also merge #58/#60/#62 as competing integrations of the same patches.

This is a logical dependency order, not approval to merge these PRs blindly or a substitute for current-main review. Before any main integration, verify patch ancestry, retain all later main changes, resolve only authorized conflicts and rerun the complete final-head CI. Controller may instead authorize one separately reviewed squash candidate containing the full chain. No retarget/rebase, source PR closure, main merge or production action is performed here.

Keep the new PR Draft and stop for independent review. No deployment, Provider enablement or production approval change.
