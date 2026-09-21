# 验证记录

## 证据分层

| 层级              | Commit / Run                                                                                                                             | 实际范围                                                                                                                        | 权威度与限制                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 固定业务 baseline | `317a08ed4c9d5ff0fcb455573a012762269eaaf7` / [main Run 35554823250](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35554823250) | `verify`（PostgreSQL 17、migration deploy、format/lint/typecheck/unit/integration/build）、Compose verification、P5B acceptance | 三个 job success；证明既有断言，不证明审计新增场景。                                 |
| 初始审计 PR       | `2b92836b3e512a0f36cdda2c3bcaef18174106eb` / [PR Run 35580280588](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35580280588)   | 既有 verify、Compose、P5B；仅审计文档/repro                                                                                     | 三个 job success；没有审计 PostgreSQL repro。                                        |
| 本轮审计证据提交  | `bf656046eed19e11510da521ce837aed3b8aa401` / [PR Run 35585294571](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35585294571)   | 新增 `[AUDIT ...]` Domain/PostgreSQL characterization tests + 全部既有 jobs                                                     | 三个 job success；缺陷测试“通过”表示稳定复现基线行为，结果仍是 `DEFECT_REPRODUCED`。 |

## 固定基线既有 CI

- `verify`: success；unit **40 files / 459 tests**，PostgreSQL integration **22 files / 221 tests**（persistence 14/59，API 8/162）。
- `Compose verification`: success。
- `P5B acceptance`: success。
- Workflow 定义：`.github/workflows/ci.yml`。具体 test 名称与 assertion 索引见 [evidence-matrix.md](./evidence-matrix.md)。

## 本机已运行

本轮不读取未知本地数据库，不使用真实用户/Provider/生产 secret。

| 命令                                                                   | 结果                          | 证明范围                                                   |
| ---------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `pnpm prisma:validate`                                                 | success                       | schema 未改；只验证现有 schema。                           |
| `pnpm exec vitest run packages/domain/test/execution-location.test.ts` | 1 file / 9 tests success      | 纯 Domain；包含执行前沿不一致的 characterization。         |
| `pnpm lint`                                                            | success                       | 静态 lint，不证明 PostgreSQL 行为。                        |
| `pnpm typecheck`                                                       | success                       | workspace 类型/Prisma generate，不证明运行期行为。         |
| `pnpm test`                                                            | **40 files / 460 tests**      | 全部 unit；比 baseline 增加 1 个 Domain characterization。 |
| `pnpm build`                                                           | success                       | 全 workspace，含真实 Vite production build。               |
| `pnpm exec tsx .../location-single-sample.repro.ts`                    | success                       | 仅刻画单点 baseline；明确不证明 pass-through 误判。        |
| 审计文件 targeted Prettier                                             | success                       | 本轮修改的 docs/tests 全部匹配格式。                       |
| `pnpm format:check`                                                    | exit 1（19 个 baseline 文件） | 固定基线 Windows/CRLF 差异；未批量改写，Linux CI 为权威。  |
| `git diff --check`                                                     | success                       | 无 whitespace error；CRLF warning 不等于 diff error。      |

真实 PostgreSQL、Compose 与 P5B 留给隔离 PR CI。

## 审计新增用例

Run 35585294571 的 `verify` 日志：unit **40 files / 460 tests**；PostgreSQL integration **22 files / 227 tests**（persistence 14/59，API 8/168）。相比固定基线，新增 **1 unit + 6 PostgreSQL integration**；另把 1 个既有 flight monitoring integration test 加强为跨通知域断言，因此测试总数不增加。

| 用例                                            | 使用真实 PostgreSQL | 使用真实 Application/Repository                                     | Flight trigger / Worker                               | 结果含义                                                                 |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| F-03 identical sample after Undo                | 是（PR CI）         | 是，真实 HTTP→ExecutionLocationService→repository                   | Flight trigger 为 mock；无 Worker                     | `DEFECT_REPRODUCED`：第二 event/ACTUAL/version/trigger。                 |
| F-03 older still-fresh sample after Undo        | 是（PR CI）         | 是                                                                  | 无 Flight binding；无 Worker                          | `DEFECT_REPRODUCED`。                                                    |
| F-03 newer sample after Undo                    | 是（PR CI）         | 是                                                                  | 无 Worker                                             | 当前行为记录；仍重建事实。                                               |
| F-03 owner-lock concurrent Undo→observe         | 是（PR CI）         | 是，真实 advisory transaction lock                                  | 无 Worker                                             | `DEFECT_REPRODUCED`；串行化不能保持用户纠正。                            |
| SOURCE TRUST public Provider provenance         | 是（PR CI）         | 是，真实 authenticated temporal HTTP                                | 无 Worker                                             | `DEFECT_REPRODUCED`：普通 owner 的 caller-controlled provenance 被接受。 |
| Risk + Flight notification paths                | 是（PR CI）         | 是，真实 FlightMonitoringService/FlightService/ExecutionRiskService | 调用 durable job service；没有启动独立 Worker process | `STATIC_CONFIRMED/DEFECT CHARACTERIZED`：同轮各一条不同 kind。           |
| Arrival Undo leaves Departure                   | 是（PR CI）         | 是，真实 HTTP/service/repository                                    | 无 Worker                                             | `DEFECT_REPRODUCED`。                                                    |
| Open earlier/current + later completed frontier | 否，纯 Domain       | 真实 domain function                                                | 无                                                    | `STATIC_CONFIRMED` characterization。                                    |

## 未执行/未证明

1. 本机 PostgreSQL integration：未设置/使用审计专用 `TEST_DATABASE_URL`；按要求不探测未知本地库，交由 PR 的隔离 PostgreSQL CI。
2. 本机 Compose/P5B：本轮未运行；使用固定 baseline 与 PR CI job，不能把它写成本机结果。
3. F-09 API+Worker+Flight 全链：未新增；P5E1 suite 只 mock Flight trigger，P5D3 suite 虽使用真实 services 但不是由 location HTTP/Worker 串起。
4. 真实 pass-through/重叠地点轨迹：未执行；`location-single-sample.repro.ts` 仅证明单点当前行为。
5. 真实 Provider account entitlement、webhook 签名、费用、retention：未验证；没有付费调用、订阅变更或数据删除。
6. Production/Staging、Push、原生后台定位和正式客户端：未实现/未授权。

## 结果分类

- `BASELINE_TESTS_PASSED`：既有 main/PR CI 通过。
- `DEFECT_REPRODUCED`：F-03、F-11、F-13 的审计 PostgreSQL用例复现；测试绿不等于产品正确。
- `STATIC_CONFIRMED`：F-01/F-02/F-04A/F-06/F-07/F-08/F-10/F-12 调用链或缺口。
- `UNVERIFIED`：F-04B 具体误判、F-05 account governance、F-09 全链及 A–H 表明确标注的缺段。

## 外部资料使用边界

审计只可用供应商官方资料判断“一般提供什么能力”，不能据此推定当前账户 entitlement、价格、字段完整性、回调签名或合同许可。不同 provider 不应被假设为统一 webhook 机制。本轮不新增订阅、不调用付费接口、不删除现有数据。

参考入口（查询日期 2026-09-21）：

- [Google Routes API policies](https://developers.google.com/maps/documentation/routes/policies)
- [Google Maps Platform service-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
- [AeroDataBox API](https://aerodatabox.com/api)
- [AeroDataBox pricing](https://aerodatabox.com/pricing/)

## 审计材料校验

```text
pnpm exec prettier --check "docs/audits/P2-P5-V2/**/*.md" "docs/audits/P2-P5-V2/**/*.ts"
pnpm exec tsx docs/audits/P2-P5-V2/repro/location-single-sample.repro.ts
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```
