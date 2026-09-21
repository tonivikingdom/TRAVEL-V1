# P5 Audit Defect Repair Batch 1

- 开工 main：`c4c3776dc578ae6966790c9d7610ea50e7fcffb9`
- 分支：`fix/p5-audit-defects-f03-f11-f13`
- 范围：仅修复审计 finding `F-03`、`F-11`、`F-13`
- migration：`20260925100000_p5_audit_repair_1`

## F-03：Undo 后的位置 observation

- `ExecutionObservationWatermark` 独立保存每个 Trip 已接受的位置 observation 高水位；事实 Undo 和
  proximity state 重置不会删除 freshness。
- `ExecutionArrivalSuppression` 按 Node 保存被用户撤销的 ARRIVAL。相同 observation 幂等 no-op，更旧
  observation 继续 stale，新但仍在到达半径内的 observation 不重建事件、ACTUAL、Trip version、风险或
  airport trigger。
- 只有可靠 observation 明确位于 `arrival radius + exit hysteresis` 外，才解除 suppression。解除只做
  housekeeping，不增加 Trip version；之后真正重新进入才可创建新的 ARRIVAL。
- 后续节点命中只有在当前被撤销节点已明确位于其 exit boundary 外时才会被确认；重叠范围内保持
  `NO_CHANGE`。被 suppression 的后续节点同样不参与自动 ARRIVAL 候选。
- migration 从现有 proximity state 和 LOCATION event 回填可恢复的 watermark；对没有 active ARRIVAL/
  ACTUAL 的历史 undone ARRIVAL 回填 suppression，不保存原始坐标。

## F-11：公开时间事实来源边界

- `POST /trips/:id/temporal-values` 的服务端 writer 固定为 `USER_VALUE`。
- 兼容显式 `sourceKind=USER_VALUE`，但拒绝客户端声明 `PROVIDER_OBSERVATION`、
  `ADOPTED_TRANSPORT_FACT`、`EXECUTION_OBSERVATION`、`DERIVED`、`SYSTEM_SUGGESTION`。
- 公开入口拒绝非空 `sourceRef`，避免 caller-controlled trusted namespace。
- Route Adopt、Flight refresh、Execution location 等内部 writer 继续通过受信 application/repository
  路径保存各自 provenance；Debug Web 不再提供 privileged source 选择。

## F-13：Arrival / Departure 因果一致性

- ARRIVAL Undo 在同一 owner lock + Trip row lock transaction 内检查同 Node 的 ACTUAL DEPARTURE；存在
  dependent departure 时返回 `EXECUTION_EVENT_CONFLICT`，不删除任何事实、不增加版本。
- execution frontier 对多个 open ARRIVAL，或 earlier open ARRIVAL 与 later execution evidence 并存，返回
  `INCONSISTENT` 和结构化 `frontierConflict`；不再伪装为正常 `AT_NODE`。
- location observation 遇到 inconsistent frontier 返回 409，不生成新事实。正常
  `completed → open → future` 与合法 first-node departure-only 仍保持兼容。

## 验证证据

- Unit：`40 files / 467 tests` success；覆盖 F-03 suppression/re-arm、重叠范围、F-13
  inconsistent/normal/departure-only domain regression。
- PostgreSQL API integration：same/older/newer-inside/outside/re-entry、Undo/observe serialization、机场 trigger、
  public provenance rejection、Undo dependent departure、inconsistent frontier 409；本机专用 PostgreSQL 验证
  `8 files / 177 tests` success。
- PostgreSQL persistence regression：`6 files / 48 tests` success。受本机测试账号无 `CREATE DATABASE` 权限限制，
  隔离 migration suites 以 GitHub CI 为正式结果。
- Migration integration：clean deploy 与 populated main → repair migration；历史 event、airport marker、Trip
  version 保持，watermark/suppression 按安全条件回填。
- GitHub CI Run [`35592969481`](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35592969481)：
  `verify`、`Compose verification`、`P5B acceptance` 全部 success。
- 原 `[AUDIT F-03/F-11/F-13]` characterization 已改为 `[REGRESSION ...]` 语义；审计目录继续保留当时基线证据。

## 明确未处理

本批不处理：`F-01/F-02/F-04/F-05/F-06/F-07/F-08/F-09/F-10/F-12`。未实现 P5E2、
AssistanceCapability、航班 webhook/polling 架构调整、真实 Provider、Staging 或 Production 操作。
