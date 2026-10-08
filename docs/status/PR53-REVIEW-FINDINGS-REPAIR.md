# PR #53 independent review findings repair

Original reviewed/base commit: `4a2a5dfc0b2cabf5e1d2750b53043b0ca464bde8`.
Independent branch: `fix/pr53-review-findings`.
Integration target: `feat/real-provider-bootstrap-cloud`, not main.
PR #53 source branch is untouched. This repair does not change production approval gates.

## Confirmed reproductions and repair

| Finding                    | Before repair                                                                                                                                                                                                                                                 | After repair / evidence                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High: endpoint collapse    | Google inputs ~100.08 m apart with identical midpoint outputs (~50.04 m offsets) returned SUCCESS; Baidu inputs ~44.48 m apart with identical midpoint outputs (~22.24 m offsets) returned SUCCESS. Newly added rejection tests both failed on original code. | Both return PROVIDER_UNAVAILABLE. Direction, collapse, ambiguous assignment, parallel-road displacement, over-threshold and precision-only controls are covered by SYNTHETIC provider tests.                                                  |
| Medium: HTTPS proxy        | Original `tsx` startup did not enable Node environment proxy handling. Independent local proxy reproduction showed direct target access with zero proxy requests; enabling Node environment proxy handling used the proxy.                                    | Doctor command uses Node 24 `--use-env-proxy --import tsx`. Local reserved-host HTTPS CONNECT test proves header/query placeholder delivery through the proxy, rejects an untrusted CA, and respects NO_PROXY. No external Provider requests. |
| Medium: Baidu TRANSIT 1002 | HTTP 200, numeric status 1002, result null returned PROVIDER_UNAVAILABLE; the new TRANSIT regression failed on original code. Doctor classified the response as PROVIDER_ERROR.                                                                               | TRANSIT returns UNSUPPORTED_QUERY; Doctor reports UNSUPPORTED. Other modes, unknown codes, malformed/string codes and HTTP failure controls remain failures; TRANSIT 1001 remains no candidate.                                               |

All new fixtures and keys are **SYNTHETIC**. No `provider --live` command was run.

## Endpoint binding and evidence

Google 100 m and Baidu 30 m remain outer rejection limits, not affirmative identity evidence. Without authoritative access legs, ordinary adapters now require returned normalized coordinates to equal requested coordinates at existing Place six-decimal precision. Distinct indistinguishable inputs, collapsed outputs and ambiguous/reversed assignments fail closed. No access time/distance is invented; Domain trusted endpoint rules are untouched.

Candidate legs retain normalized Provider coordinates instead of overwriting them with requested coordinates. Existing `legs[].providerRef` carries application-owned `endpoint-evidence:v1:` provenance: requested/raw/normalized coordinate pairs, raw coordinate system and offsets. This is **not a Provider-issued service ID**. Only validated numeric coordinates and fixed labels are serialized, never provider messages, URLs, credentials or raw response objects. PostgreSQL Query regressions verify successful evidence persistence and failures with zero planning/Trip writes.

Baidu inverse conversion remains approximate/non-authoritative. Legitimate snapping and inverse-conversion discrepancies may now be refused; allowing them safely requires a separately reviewed authoritative access/binding contract. Six-decimal equality does not establish road identity below Place's coordinate resolution or prove Provider accuracy.

## Proxy boundary

Use the supported `pnpm provider:doctor` entry point; it starts Node with environment proxy support. HTTP_PROXY/HTTPS_PROXY/NO_PROXY and existing CA trust are respected. TLS validation is not disabled. The local test uses an ephemeral SYNTHETIC CA, a reserved `.invalid` hostname and a loopback-only tunnel; it cannot contact Google/Baidu. It sends only the literal SYNTHETIC Network Secret placeholder. Real proxy-side secret substitution, API entitlement and Provider behavior were not tested.

## Validation

- Frozen install, Prisma generate/validate: PASS.
- Full Unit: 1,082 PASS (includes 230 affected Provider/Doctor tests).
- PostgreSQL integration: **687 PASS** (persistence 106 + final API 581), including 6 affected Query regressions. Final repair CI is recorded in the independent repair Draft PR; original PR #53 CI is not repair evidence.
- Typecheck, lint, build and format: PASS.
- Clean PostgreSQL deployment: all **27** inherited migrations applied.
- API / contract / schema / migration delta: **0 / 0 / 0 / 0**. Migration total remains **27**.

Production approval, entitlement, coordinate accuracy, storage/retention/TTL/deletion, attribution, quota, pricing and real Provider acceptance remain OPEN/PARTIAL as inherited. No deployment, PR #53 merge or source-branch push.
