# R1–R9 产品原则核验

状态定义：`PASS` 表示当前实现与原则相符；`PARTIAL` 表示基础机制存在但缺少关键边界；`GAP` 表示客户端实现前必须补齐或明确决策。

| 规则                                                                                           | 结论        | 证据                                                                                                                                                                                                                                               | 主要缺口                                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1 协助能力逐项 opt-in，支持 pause/stop 且不静默恢复                                           | **GAP**     | `apps/worker/src/main.ts:95-107` 每次 heartbeat 都调用 flight monitoring eligibility；`packages/persistence/src/prisma-flight-monitoring-repository.ts:29-118` 扫描所有 eligible binding；`prisma/schema.prisma:678-698` 没有用户授权或 pause 字段 | 航班监控由“存在绑定且临近起飞”隐式启用；位置能力也没有持久 capability 状态。见 F-01、F-02、F-10。                                    |
| R2 主动提醒必须有用且重要，不反复催促                                                          | **PARTIAL** | `ExecutionRisk` 与 P5D3 各自有 fingerprint/generation/decision marker，可防本域并发重复                                                                                                                                                            | 同一次 flight refresh 可各生成一条 Risk 和 Flight 通知；跨域没有 aggregation/suppression，且没有 capability 提醒偏好。见 F-12。      |
| R3 自动记录可选，且与位置协助独立                                                              | **GAP**     | `POST /trips/:id/execution/location` 进入 `ExecutionLocationService.observeLocation` 后可直接写 `ExecutionEvent` 与 ACTUAL；请求和 schema 无独立 auto-record 开关                                                                                  | 收集位置、用于辅助、写入事实目前是同一个许可边界。见 F-02。                                                                          |
| R4 机械计算仅在已接受范围自动化；查询/采集/改计划/写记录分别授权                               | **PARTIAL** | P3 evaluate、P3 propagation、P4 query/preview 都只读；Adopt/Undo 需要显式 mutation、版本与幂等 key                                                                                                                                                 | 路线能力符合原则；位置输入一旦送达即可自动写事实，缺少“采集”和“记录”分权。见 F-02。                                                  |
| R5 推荐必须展示真实取舍，永不自动采用                                                          | **PASS**    | P5C ranking metadata 与 provider canonical facts 分离；P4B Preview 冻结影响；只有显式 Adopt 写正式 Transport；没有 worker 自动 Adopt 路径                                                                                                          | 仍需 P5E2 UI 保留来源、fare、时长、约束与 required adjustment，不得只展示单一“最佳”。                                                |
| R6 新用户意图优先；废弃目标停止驱动；不移动 ACTUAL/固定事实，不假装完成外部行为                | **PARTIAL** | `FACT_PROTECTED`、Trip version、Undo conflict 和 current intent uniqueness 提供保护；fixedService/ACTUAL 是 hard anchors                                                                                                                           | arrival Undo 删除 watermark，旧样本会复活；arrival/departure 因果顺序也可被 Undo 打破。见 F-03、F-13。                               |
| R7 采集能力按 push/webhook 优先、polling fallback、query on demand 选择；不假设完整/免费/可靠  | **PARTIAL** | 产品方向已经确认；Provider config 区分 unconfigured/synthetic/live，错误不伪装 no-route，polling 有 failure backoff                                                                                                                                | 当前只实现 polling；待核实账号 entitlement、字段、费用、投递/签名和 fallback，而不是重开整个产品方向。见 F-06。                      |
| R8 auto-record 开启后可直接形成带来源/合理可靠程度且易纠正的记录；不要求每次确认，也不编造细节 | **GAP**     | ExecutionEvent 有 LOCATION source、TemporalValue 有 sourceRef、支持 Undo；单点到达是已知阶段行为，本身不等于缺陷                                                                                                                                   | 缺 policy/evidence/reliability 表达；真实 pass-through/重叠误判未验证；Undo 后旧样本可重放。见 F-03/F-04。                           |
| R9 协助有 start/continue/pause/stop/cleanup；旅行结束停止普通协助但允许短尾需求；不按午夜截断  | **GAP**     | 原则已确认；Worker 有 graceful lifecycle，Flight monitor 有事实终态 STOPPED；时间处理基于 instant/occurrence sequence                                                                                                                              | 没有 Trip/capability lifecycle/end/cleanup authority；短尾细节需沿用已批准窗口或另行决定，不能从示例创造“两小时”规则。见 F-01/F-10。 |

## 正向边界确认

以下现有设计应保留：

1. `UserTimeIntent`、`TemporalValue`、`ScheduleProjection/Propagation` 三者分离。
2. `ACTUAL > ESTIMATED > PLANNED` 的事实优先级与 ACTUAL protection。
3. Route Query → Snapshot → Preview → Adopt → Undo 的显式写入边界；Preview 不写正式计划。
4. Adopt/Undo 的 owner serialization、Trip row lock、版本单调增长和 request hash 幂等。
5. Notification 是持久业务事件，不等于 Push 已投递；没有伪造 Push 能力。
6. private resource 的 owner isolation 对 ADMIN 同样没有跨用户例外。
7. owner isolation 不等于来源可信；公开写入口仍须限制可声明的 `sourceKind/sourceRef`（F-11）。
