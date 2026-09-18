# ADR 0006：P2B 相邻交通、失效历史与 resolved 三层时间

- 状态：Accepted for P2B implementation
- 日期：2026-09-18
- 推荐模型 / 强度：GPT-5.6 Sol / Extra High
- 备选施工：GPT-5.6 Luna / Max，仅用于范围明确的小修
- 实际使用模型与强度：未知（仓库无法读取客户端实际设置）
- 升级条件：若必须改变 O-03/O-07、引入 Provider，或把 resolved value 扩成用户约束求解，
  停止对应部分并另行复核。

## 当前边与历史分离

`TransportEdge` 只保存当前 timeline 中真正相邻的两个 `PLACE_VISIT` 之间、由用户手工确认的
交通。一个 adjacency 最多一条当前边，每个节点最多一条当前 incoming 与 outgoing；数据库还
约束端点不同、端点存在且与 edge 属于同一 Trip。邻接性由持有 Trip 行锁的事务按
`localDate ASC, position ASC` 校验。

缺少交通由 `connections[]` projection 表达为 `MISSING`，不创建 PENDING、默认步行或其他假
Transport。FreeAction 没有假地点：Place→FreeAction 和 FreeAction→FreeAction 为
`NOT_APPLICABLE`，FreeAction→Place 为 `RUNTIME_ORIGIN_REQUIRED`，任何包含 FreeAction 的
adjacency 都拒绝手工 Transport。

失效边复制到 `TransportEdgeHistory` 后从 current 表删除。History 保存原 edge ID、原端点 ID、
mode、独立的 `fixedService`、标签、备注、来源、创建时间、失效时间与明确原因；端点 ID 不设
Node FK，因此 Node 物理删除后证据仍存在。`fixedService` 不从 mode 推断。

## 精确邻接失效

结构命令完成节点写入后重新生成相邻 pair 集合，仅把不再属于该集合的 current edge 归档为
`ADJACENCY_CHANGED`。删除节点先以 `NODE_DELETED` 归档 incident edges，再物理删除；Replace
Place 即使 Node ID 不变，也以 `ENDPOINT_REPLACED` 归档该节点两侧边。手工替换与清除分别使用
`USER_REPLACED`、`USER_CLEARED`。新 adjacency 保持 `MISSING`，绝不复制旧边或拼接两段交通。

节点结构、历史快照、current edge 删除、DateOwnership reconciliation 与 Trip `version + 1`
位于同一个事务。事务失败不保留半个 Node、History 或版本增量。

## Resolved TemporalValue

`TemporalValue` 只表示已经解析的明确时间事实/结果，不表示 UserTimeIntent、lock、最晚/最早、
最低停留或模糊当地钟点。权威值只持久化：

- `instant`：`timestamptz` 绝对时刻；
- `timeZone`：IANA timezone，仅用于正确投影当地时间；
- `layer`：`PLANNED | ESTIMATED | ACTUAL`；
- `pointKind`：`ARRIVAL | DEPARTURE`；
- `sourceKind`、可选 `sourceRef` 与 `observedAt`。

不持久化第二份 localDateTime 真相。写入边界只接受带 `Z` 或明确 UTC offset 的 instant；共享
domain 纯解析器严格检查 Gregorian 年月日与闰年、时分秒及 offset，不依赖 `Date.parse` 的宽松
纠正。offset 上限为 `±14:00`，`-00:00`、无时区与仅日期输入均拒绝。数据库为
`timestamptz(3)`，因此只接受最多三位小数秒，超出毫秒精度时明确失败，不静默截断。

`timeZone` 只接受项目锁定 Node/ICU 环境明确列出的 IANA 命名时区，另显式保留 `UTC`；`+08:00`
等纯 offset 不能充当 `timeZone`。instant 本身仍可携带合法 offset。只有当地钟点但没有唯一
instant 的输入保持不支持。Node 或 TransportEdge 恰好一个 subject 非空，并分别以
`(subject, pointKind, layer)` 唯一；更新 ESTIMATED 不覆盖 PLANNED，ACTUAL 也不覆盖前两层。

## ACTUAL 最小保护

P2B 尚无实际记录纠错流程。Node 只要已有任一 ACTUAL，普通 `DELETE_NODE` 与 `REPLACE_PLACE`
就在持有 Trip 行锁的 mutation 事务内以 `FACT_PROTECTED` 拒绝；不会级联丢失实际事实，也不会
让旧地点事实附着到新地点。拒绝时 Node、Place、Transport、History、DateOwnership、
TemporalValue 与 Trip version 全部回滚不变。

可信通用时间 setter 可以继续更新 PLANNED/ESTIMATED，但同一 subject + pointKind 的 ACTUAL
存在后，不得用不同 instant、timeZone、source 或 observedAt 覆盖。Node 与 current Transport
采用相同规则；`DERIVED` 和 `SYSTEM_SUGGESTION` 不能作为 ACTUAL 来源。ACTUAL 写与结构命令共享
同一个 Trip 行锁和 `baseTripVersion`，并发时只有一个基于该版本的 mutation 能提交。

这只是没有纠错工作流时的保守保护，不代表实际事实永久不可更正。未来如需纠正，必须单独设计
显式授权、来源、审计与版本语义；本 PR 不通过清空 ACTUAL、放松 FK 或删除历史来模拟纠错。

Transport 归档时，其所有 TemporalValue 同事务复制到强类型
`TransportEdgeHistoryTimeValue`，然后 current value 随 edge 删除；历史时间不会因 current edge
失效而丢失。

## 权限、版本与阶段边界

所有读写都从 Session actor 取得 owner，并先锁 owner/Trip、校验 `baseTripVersion`。普通用户与
ADMIN 均没有跨 owner 例外；不存在与跨 owner ID 对外统一 `NOT_FOUND`。Transport 与可信
application temporal 写入成功时每个 command 只增加一次 Trip version。

P2B 不开放任意 TimeValue HTTP 写接口，也不实现传播、反推、UserTimeIntent、风险、生命周期、
Provider、路线 Query、Preview/Adopt、跨日移动、Undo 或正式 UI。ADR 接受时 O-03 与 O-07 尚未
解决；后续 Draft PR #8 已在产品规则层面确认 O-03（含 DST）、O-04 与 O-07，但没有改变本 ADR
的 P2B 实现。P3 传播、DayOccurrence/sequence、生命周期、保护安排和 P4 Provider/Preview/Adopt
仍未实现。
