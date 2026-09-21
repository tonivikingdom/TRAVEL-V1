# Findings

所有 finding 均以业务固定基线 `317a08ed4c9d5ff0fcb455573a012762269eaaf7` 为准。保留原 F-01–F-10 编号；新增 F-11–F-13。行号用于定位固定 SHA，后续变化应以函数名复核。

## F-01 航班后台监控没有用户级 opt-in / pause / stop

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / HIGH / ADD`
- **规则与证据**：R1/R2/R7/R9；`apps/worker/src/main.ts:95-107` heartbeat 自动 enrollment；`PrismaFlightMonitoringRepository.ensureEligibleMonitoring` 只看航班状态/时间；`FlightMonitorState` 无用户授权/pause。
- **影响**：有 eligible FlightBinding 即可启动轮询/提醒，用户无法持久停止且保证 late job 不复活。
- **测试限制**：P5D3 tests 证明自动 enrollment 和 job 幂等，不能构造“不授权”。
- **最小修复**：先定义最小 capability state（不默认建立 user/trip/binding/node 全层矩阵），eligibility 与 late job 在同一权威状态上 no-op。
- **闸门**：P5E2 后端设计可先进行；跨层主动协助验收和正式客户端接入前 must-fix。

## F-02 位置辅助与自动事实记录共用隐式许可边界

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / HIGH / ADD`
- **规则与证据**：R1/R3/R4/R8/R9；`POST /execution/location` → `ExecutionLocationService.observeLocation` → `commitLocation` 可直接创建 ExecutionEvent/ACTUAL；request/schema 无 assistance 与 auto-record 独立状态。
- **影响**：不能表达“允许即时辅助但不自动写事实”或暂停后不恢复。
- **最小修复**：用最少的服务端 capability scopes 分离样本使用与事实写入，并保存此次 decision 的 capability basis；不删除历史事实。
- **闸门**：P5E2 后端可设计接口；原生后台定位/正式客户端接入前 must-fix。

## F-03 Undo 后 freshness watermark 消失，已纠正的位置事实会被样本重建

- **分类 / 严重度 / 动作**：`DEFECT / HIGH / MODIFY`
- **规则与静态链**：R6/R8；`ExecutionLocationService.observeLocation` 只用 `ExecutionLocationState.lastObservedAt`；`PrismaExecutionLocationRepository.undoEvent` 删除整个 location state；`createFactEvent` 只排除未 Undo active event。
- **动态证据**：审计新增真实 PostgreSQL tests：arrival→Undo→相同样本、旧但仍 fresh 样本、新样本、owner-lock 下 Undo→observe 并发。均会创建第二个 ARRIVAL event、再次写 ACTUAL、Trip version 从 3→4；机场 binding 场景 trigger 再次调用。结果应标 `DEFECT_REPRODUCED`，不是 pass。
- **影响**：用户纠正优先原则失效；旧设备事件可重放，airport trigger/risk 可能再次进入。
- **最小修复**：让 observation watermark/tombstone 独立于可 Undo 的当前 proximity state；明确“新样本是否允许开启新推断周期”。F-03 可独立优先修，不必等待 F-01/F-02/F-10 的完整 capability 模型。
- **闸门**：P5E2 跨设备/位置验收前 must-fix。

## F-04 自动到达缺少证据说明/可靠程度表达，具体误判场景尚未验证

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / MEDIUM / MODIFY + VERIFY`
- **校准后的规则**：R8 允许在目标明确且证据合理时直接自动记录；不要求固定五分钟、多个样本或逐条确认。用户纠正优先，内部应保留来源与合理的可靠程度。
- **A—实现缺口（静态确认）**：`decideExecutionLocation` 以 freshness/accuracy/radius 作决定；ExecutionEvent/TemporalValue 保存来源，但没有 decision policy version、evidence refs/summary 或可供内部审计的 reliability class。这里不要求伪精确概率。
- **B—误判验证（UNVERIFIED）**：`location-single-sample.repro.ts` 只证明单点会触发当前行为，不能证明“经过但未到达”已经误判。重复车站/酒店、重叠半径、乘车经过、楼层差异缺少受控轨迹验证。
- **最小修复**：先补可解释 evidence contract 与场景测试，再依据证据决定是否需要连续样本、运动上下文或目标类型策略；不得为了测试随意规定停留分钟数。
- **闸门**：P5E2 后端设计可继续；原生后台定位接入前必须完成 evidence policy 验证。

## F-05 真实 Provider 留存、归因与账户合同边界未验证

- **分类 / 严重度 / 动作**：`VERIFICATION_GAP / HIGH / ADD`
- **证据**：RouteCandidateSnapshot 与 FlightBinding 持久化 provider payload；snapshot expiry 控制采用，不等于物理 retention；没有与实际 account plan 绑定的字段/TTL/attribution matrix。
- **限制**：公开资料不能证明当前账号 entitlement，也不能据此断言违规；本审计没有付费调用或订阅变更。
- **最小修复**：真实 Provider 前完成字段级 retention、attribution、删除、费用/覆盖矩阵与 cleanup 证据。
- **闸门**：synthetic P5E2 可继续；真实 Provider 使用、Staging/Production 前 must-verify。

## F-06 Push/Webhook 优先方向已确认，但账号能力和 fallback 实现边界未验证

- **分类 / 严重度 / 动作**：`PRODUCT_DECISION / MEDIUM / DEFER`
- **已确定原则**：R7 已确认 Push/Webhook 优先、Polling 补充、Query 按需；不再把整个采集方向列为待决定。
- **仍待验证/决定**：当前 provider/account 是否具备所需 subscription、事件字段、签名机制、投递保证、费用与覆盖；失联 backfill、乱序/重放、polling fallback 的实现边界。不能假设所有供应商有相同回调签名。
- **当前证据**：P5D3 仅有 durable polling jobs；无 webhook ingress/subscription adapter。公开 provider 页面只能证明一般能力，不能证明当前账户。
- **闸门**：P5E2 ground-transit 设计不是被它整体阻塞；真实 flight Provider acquisition 切换前 must-decide/verify。

## F-07 ObjectStorage stale PENDING reservation 可能永久占 quota

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / MEDIUM / DEFER`
- **证据**：ObjectService 的 reserve→provider write→READY/FAILED 在进程死亡点没有 expiry/reconciler；既有 ADR/status 已登记上线硬闸门。
- **影响**：quota 永久占用、provider orphan。
- **最小修复**：bounded stale reconciliation、quota release、provider delete 幂等；只按 owner-scoped allowlist。
- **闸门**：不阻塞 P5E2 后端；公开 Attachment、真实 storage、正式客户端附件或上线前 must-fix。

## F-08 状态文档/Debug Web 文案把“Push 未实现”误写成“后台监控未实现”

- **分类 / 严重度 / 动作**：`DEFECT / LOW / MODIFY`
- **证据**：P5D3 server-side flight monitoring 已在 main；部分 P5E1 status/Debug notification empty-state/responsibilities 仍用笼统“后台实时监控未实现”。
- **影响**：混淆 server monitoring、Push、客户端后台位置和完整 lifecycle。
- **最小修复**：单独 docs/UI 文案修正；不改业务行为/schema。

## F-09 缺少 Location→ACTUAL→Risk→Airport trigger→Flight monitor 的真实 Compose 全链

- **分类 / 严重度 / 动作**：`VERIFICATION_GAP / MEDIUM / ADD`
- **证据**：P5E1 API integration 使用真实 PostgreSQL/Application/ExecutionRisk，但 FlightMonitoring trigger 是 mock；P5D3 integration 真实调用 FlightMonitoringService，却不是从 location HTTP/Worker 启动；P5B harness 早于 P5E1。
- **影响**：无法用现有证据证明真实 wiring、Worker retry 和跨域 exactly-once。
- **最小修复**：独立 synthetic acceptance，不调用付费 Provider；断言 replay/no duplicate/secret redaction。
- **闸门**：P5E2 设计/后端实现可继续；跨层验收前 must-verify。

## F-10 R9 结束原则已确认，但 Trip/capability lifecycle 尚未实现

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / HIGH / ADD`
- **已确定原则**：旅行结束停止普通协助；允许已批准的短尾需求；不能按服务器午夜截断；不为补记录继续监控。
- **实现缺口**：Trip 没有 lifecycle/end 信号；Flight monitor `STOPPED` 是航班事实终态，不是用户 pause/stop；location/risk/job 没有统一 cleanup authority。
- **仍需少量决定**：哪些已有业务窗口属于批准短尾、触发/结束信号、late job 处理。此前“行李两小时”仅为示例，现明确撤回其“产品要求”地位；沿用已有窗口或另行批准，不由审计发明。
- **最小修复**：与 F-01/F-02 共用最小 capability lifecycle/root authority，避免默认创建四级庞大配置体系。
- **闸门**：P5E2 后端可先实现无后台采集部分；原生后台、跨夜/结束验收与正式客户端前 must-fix。

## F-11 普通 owner 可通过公开时间事实 API 冒充 Provider 来源

- **分类 / 严重度 / 动作**：`DEFECT / HIGH / MODIFY`
- **证据链**：`POST /trips/:id/temporal-values` 做 owner check，但 body 接受 `sourceKind/sourceRef`；`TripService.validateTemporalValue` 允许 `PROVIDER_OBSERVATION`、`ADOPTED_TRANSPORT_FACT` 等值。审计 PostgreSQL test 用普通 owner 提交 ACTUAL + `PROVIDER_OBSERVATION` + caller-controlled sourceRef，返回 200 并原样持久化。
- **影响**：private-resource isolation 正确，但事实 provenance 不可信；后续审计/执行逻辑可把客户端自报值误认作受信 provider observation。
- **测试为何未发现**：既有 HTTP tests 关注 owner、时间格式、version 和 ACTUAL overwrite，不区分可信 writer。
- **最小修复**：公开客户端入口只允许用户来源；Provider/derived/adopted facts 使用受信 application port/内部 capability，不以 caller enum 作为授权。Debug 测试事实入口也需明确 dev/test guard。
- **闸门**：正式客户端或真实 Provider 写入前 must-fix；P5E2 纯后端设计可先进行。

## F-12 同一次航班变化可分别生成 ExecutionRisk 与 FlightImportantChange 两条通知

- **分类 / 严重度 / 动作**：`PRINCIPLE_GAP / MEDIUM / MODIFY`
- **证据链**：`FlightService.refresh` 在写 facts 后调用 `ExecutionRiskService.evaluateTripRisks`；其 repository 创建 kind=`EXECUTION_RISK`。随后 `FlightMonitoringService`/repository 创建 kind=`FLIGHT_IMPORTANT_CHANGE`。两者 dedupeKey 域不同，只有各自内部去重。
- **动态证据**：审计 PostgreSQL test 从 durable flight job 触发 delayed refresh，同时断言一条 EXECUTION_RISK 和一条 FLIGHT_IMPORTANT_CHANGE；原 test 只过滤 flight kind 并称“一条通知”。
- **影响**：同一客观变化可能产生两个用户可见入口；不能只用模块内 dedupe 证明 R2。
- **最小修复**：先确定跨域 presentation/aggregation authority；可以保留两条内部事实，但客户端/notification policy 应避免重复主动打扰。不要复制 risk 算法到 monitoring。
- **闸门**：跨层主动提醒验收/Push 前 must-decide+fix；不阻塞 P5E2 基础数据能力。

## F-13 执行前沿与 Arrival Undo 未维护 arrival→departure 因果顺序

- **分类 / 严重度 / 动作**：`DEFECT / HIGH / MODIFY`
- **证据 A**：`resolveExecutionFrontier` 独立取最后一个 open arrival 为 current，却以任何 later arrival/departure 推进 frontier。审计 Domain test 构造 A=arrival/no departure、B=arrival+departure、C=empty，结果 current=A、target=C、state=AT_NODE。
- **证据 B**：`undoEvent` 对 ARRIVAL 只删除该 point 的 ACTUAL，不检查同节点现存 DEPARTURE。审计 PostgreSQL test arrival→departure→Undo arrival 后，ARRIVAL=0、DEPARTURE=1、version 正常 +1。
- **影响**：frontier/target 可跳过尚未离开的 current node；事实出现 departure without arrival，下游 risk/location 推断依据不一致。
- **最小修复**：定义最小 causal invariant；Undo arrival 若存在 dependent departure 应冲突或通过显式补偿一起处理；frontier 对不一致 facts 应显式 conflict/unknown，而非静默组合。
- **闸门**：P5E2 execution editing/跨设备验收前 must-fix。

## 汇总

| 分类             |   数量 | 最高严重度 |
| ---------------- | -----: | ---------- |
| DEFECT           |      4 | HIGH       |
| PRINCIPLE_GAP    |      6 | HIGH       |
| PRODUCT_DECISION |      1 | MEDIUM     |
| VERIFICATION_GAP |      2 | HIGH       |
| **合计**         | **13** | **HIGH**   |

没有 CRITICAL；也没有依据要求回滚正式数据。新增 findings 是 F-11、F-12、F-13；没有撤销原 F-ID。F-04 降为 MEDIUM 并拆清实现缺口/误判验证，F-06 缩小为账户与 fallback 决策，F-10 从“原则待定”校准为“原则已定但未实现”。
