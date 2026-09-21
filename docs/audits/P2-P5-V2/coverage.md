# 审计覆盖矩阵

## 阶段/模块覆盖

| 模块                                     | 静态审阅                                           | 自动化证据                                  | 结论/缺口                                                              |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| P2A Trip / DayOccurrence / DateOwnership | schema、Trip repository、command/API、migration    | Trip PostgreSQL integration；main CI        | 版本、owner、日期所有权和 sequence 边界已覆盖；未重做产品语义。        |
| P2B Transport / History / TemporalValue  | adjacency、history、FACT_PROTECTED、strict instant | transport-temporal integration；main CI     | 当前 adjacency 与历史保留设计成立。                                    |
| P3A DayOccurrence sequence               | migration、read model、node move                   | migration/integration；main CI              | 重复 localDate 与 sequence 排序受覆盖。                                |
| P3B1 Intent / Evaluate                   | schema、commands、read-only evaluate               | unit/integration；main CI                   | intent 与事实分离。                                                    |
| P3B2 Propagation                         | worklist/fixed-point、provenance、conflict         | domain unit/integration；main CI            | hard/soft 边界清楚；未发现自动写回。                                   |
| P4A1 Provider-neutral query              | port、capability、normalization                    | provider/application tests；main CI         | query 只读；真实 Provider 留存/归因仍有 F-05/F-06。                    |
| P4B1 Snapshot / Preview                  | immutable snapshot、expiry、owner/version          | route-query integration；main CI            | 快照可追溯但无清理生命周期，见 F-05。                                  |
| P4B2 Adopt                               | transaction、receipt/outbox、route lifecycle       | PostgreSQL fault/concurrency tests；main CI | 显式 Adopt，不自动采用。                                               |
| P4B3 Undo                                | inverse basis、ACTUAL/new-fact guard、idempotency  | route-query integration；main CI            | route undo 边界完整。                                                  |
| P5A Debug Web                            | auth/session、API client、debug workflows          | unit/build；main CI                         | 非正式 UI；通知空态文案已过时，见 F-08。                               |
| P5B Acceptance                           | isolated Compose harness、reset guard              | main CI P5B acceptance                      | P0–P5A 跨层通过；尚未覆盖 P5E1 location chain，见 F-09。               |
| P5C Planning Policy                      | ranking/lookback/dwell adjustment/undo             | unit/integration/P5B extension；main CI     | 取舍与显式 adjustment 已覆盖。                                         |
| P5D1 Execution Risk                      | reconcile、dedupe、ack/snooze                      | unit/integration；main CI                   | 风险状态与 Notification 分离；用户级 capability 偏好缺失。             |
| P5D2 Flight Facts                        | snapshot、fact mapping、ACTUAL protection          | unit/integration；main CI                   | provider snapshot 长期留存决策缺失，见 F-05。                          |
| P5D3 Flight Monitoring                   | jobs、decision marker、notification aggregation    | unit/worker/integration；main CI            | 并发 decision 幂等已覆盖；默认自动 enroll，见 F-01。                   |
| P5E1 Execution Location                  | decision、fact event、Undo、airport trigger claim  | domain/API integration；main CI             | 单点即事实与 Undo 重放缺陷，见 F-03/F-04；无 Compose 全链，见 F-09。   |
| Auth / Session                           | Magic Link、session、disable                       | P1 regressions；main CI                     | 未发现新增越权路径。                                                   |
| Job / Worker                             | PostgreSQL claim/lease/retry/shutdown              | worker unit、Compose CI                     | at-least-once 边界明确。                                               |
| Notification / Outbox                    | owner list/dismiss、trusted writer、dedupe         | integration/Compose                         | 没有把 Notification 当 Push；提醒偏好仍未建模。                        |
| ObjectStorage                            | owner-scoped lookup、reservation/provider boundary | integration/main CI                         | stale PENDING reconciliation 仍是已登记上线闸门，见 F-07。             |
| P5E2 前置设计                            | 无实现                                             | 无                                          | 必须先处理 remediation plan 中的 capability/recording/lifecycle 决策。 |

## 跨模块链路 A–H

| 链路 | 路径                                                                                       | 状态                  | 证据或缺口                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A    | Trip command → DayOccurrence → DateOwnership → Transport invalidation → version            | **VERIFIED**          | PostgreSQL integration 与 transaction tests 覆盖成功/失败/并发。                                                                   |
| B    | UserTimeIntent → deterministic propagation → Route Query hard window                       | **VERIFIED**          | P3/P4 unit + integration 覆盖 forward/backward/bidirectional 与 query condition。                                                  |
| C    | Provider candidate → Snapshot → Preview → Adopt → Receipt/Outbox → Undo                    | **VERIFIED**          | P4B integration、P5C acceptance 与 main CI；显式 adoption。                                                                        |
| D    | Flight provider → FlightBinding/TemporalValue → ExecutionRisk → Monitor Job → Notification | **VERIFIED with GAP** | P5D2/P5D3 integration/worker 通过；用户 opt-in 与 acquisition policy 缺失（F-01/F-06）。                                           |
| E    | Location sample → ExecutionEvent/ACTUAL → Risk → Airport Flight trigger                    | **PARTIAL**           | API PostgreSQL integration 覆盖 claim；缺少真实 API+Worker Compose 全链（F-09），并有 Undo replay/single-point 问题（F-03/F-04）。 |
| F    | Invitation → Magic Link request → durable Job → Worker → captured mail → session           | **VERIFIED**          | P5B acceptance 与 Compose verification。                                                                                           |
| G    | Trusted domain event → Notification → owner-only list/dismiss                              | **VERIFIED with GAP** | owner isolation 与 dismiss 覆盖；Push/客户端 presence 未实现且未伪装。                                                             |
| H    | Object reserve → provider write → READY/FAILED → owner read/delete                         | **PARTIAL**           | 正常/失败边界有测试；进程死在 PENDING 后没有 reconciliation（F-07）。                                                              |

## 未覆盖/未验证

- 真实 Push、后台定位客户端、正式 Desktop/Mobile Client：`NOT IMPLEMENTED`。
- Production/Staging Provider、外部 ingress、隐私/备份：`NOT AUTHORIZED / UNVERIFIED`。
- 真实 Provider 长期留存和归因是否满足账户合同：`UNVERIFIED`。
- 旅行结束后的能力清理和短尾需求：`PRODUCT DECISION REQUIRED`。
- 本机 PostgreSQL/Compose/P5B：环境缺少连接串与 Docker CLI，见 verification。
