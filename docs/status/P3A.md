# P3A DayOccurrence + timeline sequence foundation

- 当前状态：已通过 PR #9 Squash Merge 到 main
- 正式 main：`330f9f2d469f5ff1eda7a98d45457f9c21c7265f`
- main CI：Run `35409984734`，`verify` 与 `Compose verification` 均为 success
- 推荐模型 / 强度：GPT-5.6 Sol / High
- 备选：GPT-5.6 Sol / Medium
- 实际使用模型与强度：未知（客户端实际配置无法从仓库证据确认）

## 实现范围

- 新增持久 `DayOccurrence`，以 UUID 提供稳定日期卡身份，以 Trip-scoped sequence 表达真实顺序；
  同一 localDate 可以多次出现。
- `ItineraryNode` 改为通过复合 FK 归属同一 Trip 的 occurrence；正式排序改为 occurrence sequence
  加 node position，移除 node.localDate。
- ADD command 明确区分 EXISTING 与 NEW 日期卡目标；MOVE_NODE 明确目标 dayOccurrenceId，支持同卡
  和跨卡移动。legacy localDate-only 命令不再接受。
- current Transport adjacency、connection projection 与结构变化失效使用新顺序；Transport 历史、
  ACTUAL/FACT_PROTECTED、owner isolation 和一次 command 只递增一次 Trip version 的边界保持。
- 跨 occurrence MOVE_NODE 在受锁 Trip mutation 事务内保护 Node ACTUAL：有 ACTUAL 时返回
  FACT_PROTECTED 且不产生部分结构、Transport history、ownership 或 version 变化；同 occurrence
  重排以及仅有 PLANNED / ESTIMATED 的跨卡移动保持允许。
- O-01/O-02 保持：首尾空白 occurrence 收缩，中间空白 occurrence 保留；重复日期卡只共享一份
  DateOwnership；Trip 变空时 range、ownership 与 occurrences 全部清空。

## Migration

- 对每个旧非空 Trip 的 effective range 使用自然日序列回填 occurrence，包含没有节点的中间日。
- sequence 与旧 localDate 升序一致；旧 Node 通过 tripId + localDate 绑定，再删除 node.localDate。
- 增加 populated P2B-compatible database migration integration test，验证 Node/Transport 标识与旧顺序
  不变；clean DB 继续由标准 `prisma migrate deploy` 验证。

## 明确未实现

跨日 Transport 多日期卡投影、交通占用日、DST ambiguous/nonexistent 输入、完整 solver、
UserTimeIntent、TimeConstraint、双向时间传播、RecommendationPolicy、Provider、实时监控、自动
生命周期、回顾/分享、正式 UI 和 Production 均不在 P3A。UserTimeIntent 与只读约束评估随后在
单独授权的 P3B1 实施，不改变本阶段交付边界。

## 验证状态

- P3A PR 与合并后 main 的 PostgreSQL migration/integration、verify 和 Compose 验证均已完成；最终
  main CI 证据为 Run `35409984734`。
- 本机没有因此被宣称完成 Docker/PostgreSQL 部署验证；CI 容器验证与用户电脑实机验证继续区分。
