# P5C Planning Policy

- 当前状态：在 `feature/p5c-planning-policy` 实施，等待 Draft PR 验证与人工审查
- 正式基线 main：`49a76517ef7917678c8d2133977435a1854edd07`
- 基线 main CI：Run `35439640209`，三个核心 job 均为 success
- 推荐模型 / 强度：Sol / High；实际使用模型与强度：未知（仓库无法确认客户端配置）

## 停留时间

- `SystemDwellSuggestion` 是 Node 当前有效的系统建议值，独立于 `UserTimeIntent`。直接采用建议不会创建
  `MIN_DWELL`；只有用户主动编辑才形成硬的用户最低停留要求，移除该 Intent 即恢复使用系统建议。
- 当前预计停留始终是 `departure - arrival`。超过建议或用户最低值是正常结果；低于系统建议是
  `SOFT_DEVIATION`，低于用户最低值则必须结构化返回 `requiresUserAdjustment`。

## Query、排序与 Preview

- Route Query 默认从规划最早离开时刻向前扩展 15 分钟，但 ACTUAL、EXACT、NOT_BEFORE、固定班次事实
  等绝对硬边界仍不可突破。压缩用户最低停留的候选可以展示，但不能伪装为完全可行。
- 内部第一顺位按最早到达选择，不按路线自身 duration；effective total time 从用户可开始选择该段交通的
  时刻算到候选到达。第二顺位只在不超过第一顺位 effective time 的 140% 内选择同币种最低已知票价；
  `fare=null` 不参与最低价胜出，跨币种不直接比较金额。该排序不向产品 UI 暴露“最快/最优惠”标签。
- Preview 只突出最近相关下游节点：没有下游 anchor 时按建议/用户最低值推导预计离开；有 anchor 时重新计算
  projected dwell，并区分正常、软偏离、用户要求调整与不可行。

## Adopt、Undo 与兼容性

- 用户明确接受 `MIN_DWELL` 降低后，调整和 Adopt 共用一个 PostgreSQL transaction、Trip version、
  idempotency boundary 与 OperationReceipt。新 Adopt 使用 `route-adopt-delta-v3` 保存可逆调整。
- Undo 同一补偿事务恢复原路线与原用户最低停留，使用 `route-undo-delta-v2`。旧
  `route-adopt-delta-v2` / `route-undo-delta-v1` 仍可按既有语义读取和安全撤销，不伪造新 inverse data。

## Buffer foundation

- 系统建议余量、用户偏好余量与系统最低换乘时间是三种独立语义。前两者可被用户接受为软偏离；系统最低
  被突破时保持 `ONGOING_EXECUTION_RISK`，用户确认不能改写或消除该最低值。
- 外部到场默认值集中在纯 Policy 中。中国大陆、日本、美国、英国与澳大利亚机场国内/国际首版为
  120/180 分钟（英国欧洲分类暂按国际简化），新加坡国际为 180 分钟，印度与智利为 180/240 分钟；
  未知国家 fallback 也是 120/180 分钟。铁路、城市交通、长途巴士/渡轮按已确认首版值提供。邮轮首次
  登船保持 unknown，站内换乘必须使用 Provider/operator/hub 的结构化 minimum 或 unknown。

## 明确未实现

真实 Route Provider、实时监控、Push、后台定位、正式 Desktop/Mobile UI 与 Production deployment
均未实现或未授权。地点营业时间只有文档边界，本阶段没有为不可靠营业数据扩展 schema。
