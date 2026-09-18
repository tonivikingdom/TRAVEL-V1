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

不持久化第二份 localDateTime 真相。写入边界只接受带 `Z` 或明确 UTC offset 的 instant；只有
当地钟点但没有唯一 instant 的输入保持不支持。Node 或 TransportEdge 恰好一个 subject 非空，
并分别以 `(subject, pointKind, layer)` 唯一；更新 ESTIMATED 不覆盖 PLANNED，ACTUAL 也不覆盖
前两层。

Transport 归档时，其所有 TemporalValue 同事务复制到强类型
`TransportEdgeHistoryTimeValue`，然后 current value 随 edge 删除；历史时间不会因 current edge
失效而丢失。

## 权限、版本与阶段边界

所有读写都从 Session actor 取得 owner，并先锁 owner/Trip、校验 `baseTripVersion`。普通用户与
ADMIN 均没有跨 owner 例外；不存在与跨 owner ID 对外统一 `NOT_FOUND`。Transport 与可信
application temporal 写入成功时每个 command 只增加一次 Trip version。

P2B 不开放任意 TimeValue HTTP 写接口，也不实现传播、反推、UserTimeIntent、风险、生命周期、
Provider、路线 Query、Preview/Adopt、跨日移动、Undo 或正式 UI。O-03 与 O-07 仍未解决；P3
传播和 P4 Provider/Preview/Adopt 尚未实现。
