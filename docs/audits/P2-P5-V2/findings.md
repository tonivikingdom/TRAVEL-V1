# Findings

所有 finding 均以 baseline `317a08ed4c9d5ff0fcb455573a012762269eaaf7` 为准。行号用于定位该固定 SHA；后续代码变化时应以函数名复核。

## F-01 航班后台监控没有用户级 opt-in / pause / stop

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / HIGH / ADD`
- **关联规则**：R1、R2、R7、R9。
- **定位**：`apps/worker/src/main.ts:95-107` `heartbeat()`；`packages/application/src/flight-monitoring-service.ts:34-64` `ensureEligibleMonitoring()/executeJob()`；`packages/persistence/src/prisma-flight-monitoring-repository.ts:29-118` `ensureEligibleMonitoring()`；`prisma/schema.prisma:678-698` `FlightMonitorState`。
- **触发**：用户拥有一个临近 24 小时、尚未终态的 `FlightBinding`，但从未显式开启航班监控；Worker heartbeat 仍创建 monitor state/job。
- **用户后果**：后台查询和提醒可在未接受该能力时启动；用户没有 pause/stop 后保持停止的持久语义。
- **当前 / 期望**：当前 eligibility 仅由航班状态和时间决定。期望有 owner/trip/binding 级 capability state，默认关闭或由明确授权开启，并区分 pause、stop、事实终态与清理。
- **证据类型**：静态确认；现有 integration tests 反而确认自动 enrollment。
- **复现**：见 `repro/flight-monitoring-auto-enrollment.md`。
- **测试为何未发现**：测试目标是 Job 调度与幂等，没有“未授权用户”这个状态可构造。
- **最小修复**：持久化 capability consent/lifecycle；eligibility query 必须过滤 enabled；pause/stop 原子取消或使既有 Job no-op；不得由 heartbeat 静默恢复。
- **依赖 / migration**：依赖 Worker/Job/Notification/Trip lifecycle；预计需要 migration。
- **P5E2 影响**：**must-fix**。客户端必须有明确开关和状态，不能只提供 UI 上的临时 toggle。

## F-02 位置采集与自动事实记录共用一个隐式许可边界

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / HIGH / ADD`
- **关联规则**：R1、R3、R4、R8、R9。
- **定位**：`apps/api/src/app.ts:455-469` location endpoint；`packages/contracts/src/execution.ts:56-63` `ExecutionLocationSampleRequest`；`packages/application/src/execution-location-service.ts:65-136` `observeLocation()`；`packages/persistence/src/prisma-execution-location-repository.ts:176-250` `commitLocation()`。
- **触发**：任何已认证 owner 向 location endpoint 发送满足精度/时效条件的样本。
- **用户后果**：系统无法表达“允许用位置辅助，但不自动写行程事实”或“暂停采集但保留已有记录”。
- **当前 / 期望**：当前 request 只含位置数据，满足 decision 即直接写 `ExecutionEvent` 和 ACTUAL。期望至少分离 location assistance consent 与 auto-record consent；每次写入保存使用的 capability basis。
- **证据类型**：静态确认。
- **复现**：使用 owner session POST 一个目标半径内样本；断言 Trip version +1、ExecutionEvent/ACTUAL 创建，但数据库不存在任何 capability 授权行。
- **测试为何未发现**：现有 API integration 只验证授权主体和事实写入正确，不验证能力授权状态。
- **最小修复**：新增持久 capability preferences；API/应用层在采集、推断、写事实三个边界检查相应 scope；关闭后新样本不得写入，历史事实不删除。
- **依赖 / migration**：Execution、Session/owner、P5E2 client；需要 migration。
- **P5E2 影响**：**must-fix**，同时需要产品确定默认值和首次授权交互。

## F-03 Undo 位置事实后删除 freshness watermark，旧样本可重新创建同一事实

- **分类 / 严重度 / 动作**：`DEFECT / HIGH / MODIFY`
- **关联规则**：R6、R8。
- **定位**：`packages/application/src/execution-location-service.ts:81-106` 仅使用 `ExecutionLocationState.lastObservedAt` 去重；`packages/persistence/src/prisma-execution-location-repository.ts:430-464` `undoEvent()` 删除 ACTUAL 后删除整个 location state；同文件 `590-648` `createFactEvent()` 只排除未 Undo 的 active event。
- **触发**：目标内样本 S 创建 LOCATION arrival → 用户 Undo → 相同 `observedAt` 的样本 S 被重放。
- **用户后果**：用户明确纠正的到达事实会再次出现；Trip version 再次增加，机场触发也可能再次进入 claim 流程。
- **当前 / 期望**：当前 Undo 清空去重 watermark。期望 Undo 事实不等于忘记已处理 observation；相同或更旧样本必须稳定 no-op/STALE，除非用户显式重新启用新的推断周期。
- **证据类型**：静态确认；动态 PostgreSQL 复现因本机缺少 `TEST_DATABASE_URL` 未执行。
- **复现**：见 `repro/execution-location-undo-replay.md`。
- **测试为何未发现**：`apps/api/test/execution-location.integration.test.ts:492-540` 验证的是手工幂等 replay 不再次 claim flight trigger，没有在 Undo 后重放原 location sample。
- **最小修复**：把 observation freshness/tombstone 与当前 proximity state 分离并在 Undo 后保留；增加 Undo→同样本、Undo→旧样本、Undo→新样本 PostgreSQL integration。
- **依赖 / migration**：ExecutionLocationState/Event、airport trigger、Trip version；预计需要 migration 或不可删除的独立 watermark。
- **P5E2 影响**：**must-fix**，否则客户端的纠正操作不可靠。

## F-04 单个可靠坐标点即可直接形成 ARRIVAL ACTUAL，缺少证据强度/置信度

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / HIGH / MODIFY`
- **关联规则**：R8（同时受 R3/R4 前置授权约束）。
- **定位**：`packages/domain/src/execution-location.ts:14-23` policy；`119-152` `decideExecutionLocation()`；`packages/domain/test/execution-location.test.ts:39-67` 单点 arrival 期望。
- **触发**：一个时效和 accuracy 合格的样本落入目标半径，例如车辆路过机场/车站或定位楼层错误。
- **用户后果**：系统可把“经过附近”写成“实际到达”，进而触发风险与航班监控。
- **当前 / 期望**：当前判定只有距离/精度。期望在 auto-record 已授权时使用可解释的合理证据（例如连续观察、dwell/运动上下文或目标类型策略），保存 provenance/confidence，并允许简单纠正；不是要求每条都确认。
- **证据类型**：静态确认；纯 Domain 动态演示见 `repro/location-single-sample.repro.ts`。
- **复现命令**：`pnpm exec tsx docs/audits/P2-P5-V2/repro/location-single-sample.repro.ts`。
- **测试为何未发现**：单点确认是 P5E1 已接受的阶段语义，测试把它当作成功标准；新 R8 提高了产品证据要求。
- **最小修复**：先确定按 Place 类型/运动状态的证据阈值；decision 输出 confidence/evidence；自动写入保留来源并与 capability 绑定。
- **依赖 / migration**：Domain、ExecutionEvent/TemporalValue、P5E2 location client；是否 migration 取决于 confidence 是否持久化，产品决策必需。
- **P5E2 影响**：**must-decide before background location**。

## F-05 真实 Provider 数据的留存、归因和计划合同边界没有被验证

- **分类 / 严重度 / 动作**：`VERIFICATION_GAP / HIGH / ADD`
- **关联规则**：R7、R9；外部服务合规边界。
- **定位**：`prisma/schema.prisma:535-560` `RouteCandidateSnapshot.candidatePayload/expiresAt`；`packages/persistence/src/prisma-route-planning-repository.ts:32-70` 写快照；`prisma/schema.prisma:651-675` `FlightBinding.selectedSnapshot/latestSnapshot`；`packages/persistence/src/prisma-flight-repository.ts:143-147,261-269` 写航班快照；`apps/debug-web/src/main.ts:1059-1061` 仅显示 provider 文本。
- **触发**：启用真实 Routes/Flight provider，并持续保存候选/选择/最新快照。
- **用户后果**：若实际账户条款要求特定 TTL、字段删除或 attribution，系统可能长期保存不应保存的数据或缺少展示归因。
- **当前 / 期望**：当前 `expiresAt` 只限制采用，没有通用 TTL cleanup；Flight selected snapshot 没有 retention metadata；没有 provider-plan capability/attribution matrix。期望每个真实 provider 明确字段级 retention、归因、计划权限、清理任务与证据。
- **证据类型**：静态确认 + 官方资料核对（2026-09-21），见 `verification.md`。账户实际合同未知，因此不下“已违规”结论。
- **复现**：见 `repro/provider-retention-audit.md`。
- **测试为何未发现**：现有测试验证 snapshot immutable/expiry/adoption，不验证时间推进后的物理清理或许可展示。
- **最小修复**：建立 provider governance matrix；确认计划；实现可测试的 TTL cleanup/redaction 和 attribution UI；Production/Staging enablement 以该矩阵为闸门。
- **依赖 / migration**：Provider、Snapshot、Flight、Job/Worker、Debug/正式 client；可能需要 retention 元数据 migration。
- **P5E2 影响**：P5E2 可以继续 synthetic/dev 设计，但真实 provider 展示与持久化前必须解决。

## F-06 航班事实采集只实现 polling，Webhook/Push 与 fallback 策略未决

- **分类 / 严重度 / 动作**：`PRODUCT_DECISION / MEDIUM / DEFER`
- **关联规则**：R7。
- **定位**：`packages/persistence/src/prisma-flight-monitoring-repository.ts:29-118` 调度；`packages/application/src/flight-monitoring-service.ts:38-64` Job refresh；`apps/worker/src/main.ts:81-107` Worker wiring。
- **触发**：P5D3 在真实 flight provider 上运行。
- **用户后果**：轮询频率、费用、延迟和覆盖可能不符合账户能力；也没有 webhook 丢失后的 backfill 决策。
- **当前 / 期望**：当前使用有界 polling/backoff。AeroDataBox 官方列出 push flight/airport subscriptions，但是否包含当前计划、费用和交付保证未知。期望记录 capability decision：webhook 为主还是 polling 为主，query-on-demand、去重、签名、重放、失败 fallback。
- **证据类型**：静态确认 + 2026-09-21 官方资料；没有付费调用。
- **复现**：启动 Worker 后可观察所有刷新均由 `FLIGHT_MONITOR` Job 发起；代码无 webhook ingress/subscription adapter。
- **测试为何未发现**：测试验证已选 polling 的可靠性，不判断它是否是最佳采集模式。
- **最小修复**：产品/工程共同确认 provider plan 和 SLO；若支持合适 webhook，设计签名、幂等 observation、重放/补偿和 polling fallback。
- **依赖 / migration**：Flight provider、API ingress、Job/Worker、decision marker；是否 migration 取决于 subscription 状态。
- **P5E2 影响**：客户端不得宣称“实时”；应显示最近更新时间与 provider capability。

## F-07 ObjectStorage 的 stale PENDING reservation 仍可能永久占 quota

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / MEDIUM / DEFER`
- **关联规则**：可靠生命周期/cleanup（R9 的同类工程原则）。
- **定位**：`packages/application/src/object-service.ts:49-114` reserve→provider write→READY/FAILED；`docs/status/P1B2.md:61-66`；`docs/architecture/roadmap-and-gates.md:102-104`；ADR 0004。
- **触发**：进程在 DB reserve 成功后、provider write 或 READY/FAILED 回写前崩溃。
- **用户后果**：PENDING 继续占 quota；provider 侧可能残留 orphan object。
- **当前 / 期望**：当前正式文档已把 reconciliation 登记为上线前硬闸门，但实现仍无 lease/expiry reconciler。期望在公开 upload 或 staging storage 前有 stale expiry、provider orphan cleanup 与幂等恢复。
- **证据类型**：静态确认，已知接受风险。
- **复现**：故障注入 reserve 后终止进程；超过合理窗口后查询仍为 PENDING 且 quota 未释放。
- **测试为何未发现**：当前没有公开 Attachment/upload API，测试覆盖正常失败而非进程死亡。
- **最小修复**：基于 created/updated time 的 bounded reconciliation Job，所有清理 owner-scoped 且 provider delete 幂等。
- **依赖 / migration**：ObjectStorage、Job/Worker、quota；现有时间字段可能足够，未必需要 migration。
- **P5E2 影响**：非当前 location/client blocker；Attachment UI/staging storage 前必须完成。

## F-08 当前状态文档和 Debug Web 空态仍描述“后台实时监控未实现”

- **分类 / 严重度 / 动作**：`DEFECT / LOW / MODIFY`
- **关联规则**：准确披露能力边界。
- **定位**：`docs/status/P5E1.md:1-末尾` 仍是实施/Draft 口径；`apps/debug-web/src/main.ts:823-825` 空通知文案；`docs/architecture/responsibilities.md` 末段仍将实时监控概括为未实现。
- **触发**：开发者阅读状态文档，或 Debug Web 当前没有通知。
- **用户后果**：误判 P5D3 server-side flight monitoring 尚不存在；也可能把“未实现 Push/客户端 presence”和“未实现后台监控”混为一谈。
- **当前 / 期望**：当前基线已包含 P5D3/P5E1，main CI 成功。期望文案精确区分：后台航班监控已实现；Push、后台定位客户端和完整 quiet-assist lifecycle 未实现。
- **证据类型**：静态确认。
- **复现**：`rg -n "后台实时监控|Draft|实施中" docs/status/P5E1.md apps/debug-web/src/main.ts docs/architecture/responsibilities.md`。
- **测试为何未发现**：文档/文案没有语义断言，build 只验证可编译。
- **最小修复**：单独 docs/UI 文案 PR 更新 merged SHA/CI 和精确能力边界；不改业务行为。
- **依赖 / migration**：无；不需要 migration。
- **P5E2 影响**：避免 P5E2 设计基于错误现状。

## F-09 缺少 Location → ACTUAL → Risk → Flight Monitor 的真实 Compose 全链验收

- **分类 / 严重度 / 动作**：`VERIFICATION_GAP / MEDIUM / ADD`
- **关联规则**：R4、R8；跨模块可靠性。
- **定位**：`apps/api/test/execution-location.integration.test.ts` 使用可控 `flightTrigger`；`scripts/verify-compose.mjs` 与 `scripts/p5b-acceptance.mjs` 未覆盖 P5E1 location chain；`.github/workflows/ci.yml` 运行这些既有 harness。
- **触发**：location arrival commit 后的 post-commit airport trigger claim，再由 Worker/flight provider 进入 monitor。
- **用户后果**：应用测试能证明 transaction/claim，但不能证明真实 API+Worker 配置、Job 调度和 Notification 在容器环境中完整联通。
- **当前 / 期望**：当前单模块 integration 很强；期望增加一条 synthetic、无秘密的 Compose acceptance：location→event/ACTUAL→claim→monitor state/job→可观察结果，含 replay/no-duplicate。
- **证据类型**：静态测试盘点；本机 Docker 不可用，未执行动态 Compose。
- **复现**：在现有 P5B project 增加 synthetic Trip/flight，POST 目标内 location，轮询 monitor/outbox/notification 并断言 exactly-once claim。
- **测试为何未发现**：P5B 在 P5E1 之前创建；P5E1 API integration 有 mock trigger，职责上没有启动 Worker。
- **最小修复**：扩展独立 acceptance 或新增轻量 P5E harness；保留有界 timeout 和 secret redaction。
- **依赖 / migration**：API、Persistence、Worker、Flight provider、Notification；不需要 migration。
- **P5E2 影响**：**must-verify**，否则客户端验收会建立在未跨层验证的链路上。

## F-10 旅行结束后的 assistance lifecycle 与短尾需求没有正式模型

- **分类 / 严重度 / 动作**：`PRODUCT_DECISION / HIGH / ADD`
- **关联规则**：R1、R9。
- **定位**：`prisma/schema.prisma:382-414` `Trip` 没有 lifecycle 状态；`prisma/schema.prisma:678-698` monitor STOPPED 是 flight domain mode；现有 O-07/roadmap 文档把自动生命周期留在后续。
- **触发**：旅行主体结束，但航班行李/到达后短时信息仍可能有价值；或用户主动停止某种协助。
- **用户后果**：没有统一答案说明何时停止 location/flight/risk Job、何时保留短尾提醒、何时清理 capability state；若仅按日期或事实终态可能过早/过晚。
- **当前 / 期望**：当前各 domain 自己判断终态，没有 Trip/capability 级 start/continue/pause/stop/cleanup。期望先定义 lifecycle 与尾部窗口，不用午夜作为隐式 cutoff。
- **证据类型**：静态确认；这是明确产品决策，不是现有 transaction defect。
- **复现**：无法通过现有 API 表达“Trip 结束但保留 baggage 2 小时”或“只停止位置协助”；schema/contract 没有相应状态。
- **测试为何未发现**：没有可构造的 lifecycle input，现有测试只覆盖各模块终态。
- **最小修复**：冻结 capability lifecycle 状态机、Trip end 信号和 post-trip tail policy；然后再决定持久模型与 cleanup jobs。
- **依赖 / migration**：Trip、Flight monitor、Execution location、Risk/Notification、Worker；大概率需要 migration。
- **P5E2 影响**：**must-decide**，客户端导航和设置需要真实状态来源。

## 优先级小结

1. P5E2 前：F-01、F-02、F-03、F-04、F-10。
2. P5E2 跨层验收前：F-09。
3. 真实 Provider/Staging 前：F-05、F-06、F-07。
4. 下一次状态文档维护：F-08。
