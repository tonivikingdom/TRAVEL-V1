# ADR-0008：Route Adopt Undo 使用前向补偿与版本化 inverse basis

- 状态：Accepted for P4B3
- 日期：2026-09-20

## Context

Route Adopt 会在一个事务内替换 corridor、generated Node、Transport、时间事实、日期投影、
DayOccurrence、DateOwnership、effective range 和 AdoptedRoute lifecycle。P4B2 receipt 记录了审计 delta，
但没有保存足以精确重建全部 before state 的 topology。根据当前数据库或名称猜测旧结构会覆盖新现实，
尤其无法安全处理复用 generated Node、被收缩的 DayOccurrence 和重复 localDate。

## Decision

1. Undo 是新的 ROUTE_UNDO 补偿操作，Trip version 单调 +1，不做 version rollback。
2. 新 Adopt 保存强类型 `route-adopt-delta-v2`：完整 before DayOccurrence、Node placement、generated Node
   metadata、DateOwnership/effective range、previous ACTIVE route 和 forward-created IDs。
3. legacy receipt 不补造 inverse data，明确返回 `UNDO_UNAVAILABLE`。
4. 新 Adopt 在 receipt 创建时固定 `undoExpiresAt`；窗口来自 `ROUTE_UNDO_WINDOW_SECONDS`。
5. Undo 与 Adopt 共用 owner advisory lock、Trip row lock、READ COMMITTED 和单事务边界。
6. 只有 current version 等于 target Adopt resulting version 时可 Undo；任何后续正式写入均冲突。
7. Undo 前重新验证 route/corridor/node/edge/history/ownership identity。ACTUAL 或新用户内容绝不删除，
   不一致统一 `UNDO_CONFLICT`。
8. `AdoptedRoute` 增加 UNDONE；同一 Trip/anchors 的 ACTIVE route 由 PostgreSQL partial unique index
   保证最多一个。Adopt 必须先 REPLACED prior route，再创建新 ACTIVE；Undo 反向执行 lifecycle。
9. target receipt 上的 unique self relation 保证最多一份成功 Undo。幂等 replay 在 version 校验前返回
   原 receipt，不重复版本或 outbox。
10. 成功 Undo 写入 `route-undo-delta-v1` receipt 和 ROUTE_UNDONE outbox；原 ROUTE_ADOPTED 事实保留。

## Consequences

- 新 Adopt 的 inverse basis 较大，但边界明确、可版本化，且无需持久化通用数据库快照。
- 旧 receipt 安全不可撤销；这是有意的保守兼容策略。
- 单步窗口内的最新 Route Adopt 可精确恢复；多步 Undo、Redo、历史事实纠错和 Provider 新事实迁移仍需
  后续独立设计。
