# ADR 0005：P2A Trip Core、日期归属与乐观并发

- 状态：Accepted for P2A
- 日期：2026-09-18
- 推荐模型 / 强度：GPT-5.6 Sol / Extra High
- 备选施工：GPT-5.6 Luna / Max
- 实际使用模型与强度：未知（仓库无法读取客户端实际设置）
- 升级条件：实现必须改变 O-01/O-02，或必须先解决 O-03/O-07 时，停止对应部分并报告。

## 日期概念与事实来源

`Trip.planningAnchorDate` 只用于空 Trip 的规划/编辑定位；它不产生日期归属。
`effectiveStartDate` / `effectiveEndDate` 始终由最早和最晚 `ItineraryNode.localDate` 自动决定。
没有节点时两者均为 null，并删除该 Trip 的全部 `DateOwnership`。

`DateOwnership(ownerUserId, localDate, tripId)` 是唯一自然日归属事实，数据库主键
`(ownerUserId, localDate)` 保证同一账号同一自然日最多属于一趟 Trip。有效范围内部每一天都
持久化 ownership，包括没有节点的中间日；首尾空白编辑日不持久化。

P2A 不创建 `Day` 表。API 的 `days[]` 由有效范围对应的连续 DateOwnership 加上按
`localDate + position` 排序的节点即时投影，因此不存在 Day 与 DateOwnership 两套日期事实。

## 事务、日期冲突与版本

所有 Trip mutation 都先取得 owner-scoped PostgreSQL advisory transaction lock，再以
`SELECT ... FOR UPDATE` 锁定 owner 范围内的 Trip 并尽早校验 `baseTripVersion`。结构写入、
范围重算、完整 ownership reconciliation 与 Trip `version + 1` 位于同一数据库事务。

owner lock 使同一用户多 Trip 的日期 reconciliation 串行化；数据库唯一约束作为最终安全网。
冲突统一映射为 `DATE_OWNED`，不会暴露 Prisma/SQL 错误。版本过期映射为
`VERSION_CONFLICT`。失败事务不保留半个 Place、Node、ownership 或版本增量。

## Place、节点与排序

`Place` 是 owner 私有的地点身份；不会按名称或坐标自动合并，也不编造地址。多个
`PLACE_VISIT` 可以引用同一个 Place，但各自有独立 node ID、note 与 position。
`FREE_ACTION` 没有 placeId、坐标或假 Place。

同日排序使用整数 position 和事务内完整重排，数据库唯一约束
`(tripId, localDate, position)` 防止重复位置。P2A 只允许同日移动，不开放跨日移动。
`REPLACE_PLACE` 保持 node ID、日期与位置，并按已确认规则清空旧地点 note。

## 权限与阶段边界

所有 owner 都来自已验证 Session actor；查询和写入都使用 owner-scoped lookup。资源不存在与
属于其他 owner 时统一 `NOT_FOUND`，ADMIN 没有跨 owner 例外。

P2A 不实现 Transport、Provider、跨日移动、三层时间传播、生命周期自动推进、Trip merge、
Undo 或正式 UI。跨午夜、国际日期线、DST 与高级 Day 投影仍受 O-03 约束；自动生命周期收尾
仍受 O-07 约束。这些能力留给 P2B/P3 或后续单独授权。
