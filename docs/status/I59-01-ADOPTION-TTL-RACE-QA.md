# I59-01：Adopt TTL race 独立失败回归持久化

推荐模型：GPT-6.1 Sol；推理强度：High。备选：保持当前可用配置。理由：完整保留既有并发断言并核实 PostgreSQL 证据；升级条件：原文件缺失或证据不能确定性复现。本任务未要求或声称切换运行模型。

## 范围与来源

- 基线分支：`integration/v1-release-readiness`。
- 精确基线：`9a477ee4998424e45363be998c1e4e807f0490dd`。
- 独立 QA 分支：`qa/i59-adoption-ttl-race`。
- 原 scratch 文件仍存在，直接复用 `/workspace/scratch/v1-integration-audit-59/independent.integration.test.ts` 的全部八个用例。
- 正式测试路径：[i59-adoption-ttl-race.integration.test.ts](../../apps/api/test/i59-adoption-ttl-race.integration.test.ts)。沿用现有 API integration 配置及 `replanning-acceptance` helper。
- 只调整 helper/evidence 路径、修正来源注释、移除未使用的 import/旧 evidence helper，并格式化。原断言、用例标题与参数化顺序不变；没有删除、skip、降低断言或把错误行为改为预期行为。
- [provenance.json](assets/i59-adoption-ttl-race/provenance.json) 记录原文件和移植文件 SHA-256；TypeScript AST 核对原 `expect` 链和 `onlyWrites` 调用及用例标题完全相同。四个声明分别运行于两个 fixture，共八个用例。

此次仅保存已发现的 I59-01（原审查 P1）回归证据；没有重新审查或修复 #59，也没有修改 B 的分支。生产代码、既有 helper、API/contract/schema/migration 均零变更。此精确基线已有 **27** 个 migration，新增 **0**，未回退为此前阶段的 26。

## 实际重跑结果

全新隔离 PostgreSQL 17 `i59_qa` 数据库，clean deploy 基线全部 27 个 migration；全部地点、用户和 Provider fixture 为 SYNTHETIC。没有真实 Key、真实 Provider、付费请求或 `--live`。测试通过现有 harness 注入 API，读写真实 PostgreSQL。

**8 tests：4 PASS / 4 FAIL / 0 SKIP，进程退出码 1。** 红灯是本 QA 分支预期证据，四个失败是同一 I59-01 的不同覆盖组合。

| Fixture                  | 用例                                     | 应有结果（原断言）                 | 本次实际结果                   |
| ------------------------ | ---------------------------------------- | ---------------------------------- | ------------------------------ |
| 非固定 aggregate TRANSIT | 请求前 TTL 已过期（控制）                | HTTP 409 / PREVIEW_STALE；零写入   | PASS                           |
| 固定 BUS                 | 请求前 TTL 已过期（控制）                | HTTP 409 / PREVIEW_STALE；零写入   | PASS                           |
| 非固定 aggregate TRANSIT | 已成功 receipt 在 TTL 后幂等回放（控制） | HTTP 200；同一 receipt；零额外写入 | PASS                           |
| 固定 BUS                 | 已成功 receipt 在 TTL 后幂等回放（控制） | HTTP 200；同一 receipt；零额外写入 | PASS                           |
| 非固定 aggregate TRANSIT | owner 锁等待跨越 TTL                     | HTTP 409；完整 footprint 不变      | FAIL：HTTP 200，footprint 改变 |
| 固定 BUS                 | owner 锁等待跨越 TTL                     | HTTP 409；完整 footprint 不变      | FAIL：HTTP 200，footprint 改变 |
| 非固定 aggregate TRANSIT | 事务暂存写入期间跨越 TTL                 | PREVIEW_STALE；回滚全部写入        | FAIL：SUCCESS，footprint 改变  |
| 固定 BUS                 | 事务暂存写入期间跨越 TTL                 | PREVIEW_STALE；回滚全部写入        | FAIL：SUCCESS，footprint 改变  |

原审查日志和四份原始脱敏 JSON 保存在 [original-audit](assets/i59-adoption-ttl-race/original-audit/)。本次结果保存在 [rerun](assets/i59-adoption-ttl-race/rerun/)，包括 [完整失败日志](assets/i59-adoption-ttl-race/rerun/vitest.log)。四份本次 JSON 与对应原 JSON **逐字节相同**；[results.json](assets/i59-adoption-ttl-race/results.json) 包含各文件 hash、期望/实际和完整 write footprint 范围。

## 确定性时序与原始错误行为

1. 固定初始 clock 为 `2026-10-08T04:00:00Z`；行程出发是 `2026-10-10T10:00:00Z`，即 Shanghai 18:00。
2. 构建计划、地点时间和约束，明确用户仍在前一地点；Query 使用明确 TRANSIT / DEPART_AT。
3. 在 `2026-10-10T09:59:00Z` 保存 SYNTHETIC candidate，Provider `validUntil` 为 `09:59:02Z`。由此生成短 TTL snapshot/preview，原测试明确断言 preview `expiresAt=09:59:02.000Z` 且 adoptable。
4. owner-lock 用例在 `09:59:01Z` 发起新幂等键 Adopt，用真实 `pg_advisory_xact_lock(hashtextextended(ownerId, 2))` 持锁，等待 `pg_stat_activity` 确认请求实际阻塞后推进 clock 到 `09:59:03Z`，再释放锁。使用 gate，不用猜测 sleep。
5. 事务写入用例直接复用正式 `PrismaRoutePlanningRepository.adoptPreview`，注入 clock：第一次采样 `09:59:01Z`，第二次在写入后采样 `09:59:03Z`。保留原 `samples === 2` 断言；不替换数据库写入、不修改正式事务。
6. 固定 BUS 此刻尚未到 `10:00:00Z` 发车时间；因此是 TTL 失效，而非已错过发车时间。aggregate TRANSIT fixture 明确 `fixedService=false`、`serviceLabel=null`。

原始错误机制仍是基线 `prisma-route-adoption.ts` 中以请求前 `input.now` 判断 preview/snapshot/provider TTL；锁后和提交前的较新 clock 检查固定班次是否错过，但不重新阻止此次 TTL 过期。这里只记录既有发现，没有改动实现。

## 完整数据库零写入期望

在 fixtures / Query / Preview 已完成之后、Adopt 之前取 `before`。这不是要求 fixture 建立过程零写入，也不是要求 Query 不保存 snapshot。

现有 `footprint` 在 PostgreSQL `RepeatableRead` 一致读取完整行，并按稳定顺序读取：

- `Trip` 全部字段，包括 `version`；
- `ItineraryNode`、`TransportEdge`、`AdoptedRoute`；
- `RouteCandidateSnapshot`、`RoutePreview`；
- `OperationReceipt`、`OutboxEvent`、`ExecutionEvent`；
- `TripStaticBackup`、`TripAuthoringReceipt`；
- `DayOccurrence`、`DateOwnership`、`TemporalValue`、`UserTimeIntent`。

四个失败用例原断言要求 **before/after 完整行 JSON 相等**，`footprintUnchanged=true`，同时拒绝 Adopt。四个控制用例使用既有 `onlyWrites(before, after)`，没有允许写入表。JSON 中计数仅是脱敏展示，不替代完整行比较；不输出 owner/session/token/邮件/Provider 原始响应。

四个错误 Adopt 都实际提交了如下正式写入，而非正确拒绝/回滚：

| Footprint        | Before | After | 期望                         |
| ---------------- | ------ | ----- | ---------------------------- |
| Trip.version     | 10     | 11    | 保持 10                      |
| TransportEdge    | 0      | 1     | 保持 0                       |
| AdoptedRoute     | 0      | 1     | 保持 0                       |
| OperationReceipt | 0      | 1     | 保持 0                       |
| OutboxEvent      | 0      | 1     | 保持 0                       |
| TemporalValue    | 5      | 7     | 保持 5，既有行内容也不能改变 |

其余表的计数保持原值；完整行零写入断言仍失败。测试结束仅清理本次生成的 SYNTHETIC owner 资源；没有 reset 其他数据库。

## 复现命令

从此 QA 分支仓库根目录执行。`TEST_DATABASE_URL` 必须指向全新隔离的 PostgreSQL 测试库，不能指向生产或未知数据库。

```bash
pnpm install --frozen-lockfile
export TEST_DATABASE_URL='postgresql://<synthetic-user>:<synthetic-password>@127.0.0.1:<isolated-port>/<isolated-database>'
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate:deploy
pnpm --filter @travel/api test:integration test/i59-adoption-ttl-race.integration.test.ts
```

本次实际运行同一聚焦命令，连接本任务专用本机 PostgreSQL 17 容器的 `i59_qa` 数据库。成功复现的退出码为 **1**，必须保留上述四个失败和四个通过。运行会将脱敏 evidence 写到此 checkout 的 `docs/status/assets/i59-adoption-ttl-race/rerun/`。

移植测试的 ESLint、`@travel/api` TypeScript typecheck 和定向 Prettier 检查通过。未运行新的全仓库验收，也不复用 #59 绿灯宣称这些新回归通过。现有 CI 只触发 pull_request 或 main push；本任务仅 push QA 分支，不创建 PR、不修改 workflow。没有合并、部署或变更 production gates。
