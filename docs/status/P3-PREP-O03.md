# P3 前置：O-03 timeline 与日期卡规则落档

- 当前状态：在 `feature/p3-prep-o03-timeline-days` 仅做规格落档；交付为 Draft PR，未 Ready、
  未合并，P3 代码未开始
- 基线 main：`50866c4aa4ec122e4522920dcf2e53b551de7dfb`
- 基线 main CI：Run `35353581612`，`verify` 与 `Compose verification` 均为 success
- 推荐模型 / 强度：GPT-5.6 Sol / High
- 备选：GPT-5.6 Luna / Max，仅用于范围明确的小修
- 升级条件：若需改变 P2B 代码、新增 migration、实现 DayOccurrence/sequence、处理 DST 或改变
  O-01/O-02，停止扩大范围并交由更强模型独立复核
- 实际使用模型与强度：未知（客户端实际配置无法从仓库证据确认）

## 已确认的 O-03 产品语义

- 真实先后顺序使用独立 timeline sequence；有明确 instant 时按 instant 判断。当地日期和钟点只
  负责显示，不能作为整趟旅行的最终排序真相。
- 只有真正发生时区变化的 Transport 显示时区切换。localDate 不变但当地钟点回拨时仍在同一
  日期卡继续，不篡改时间。
- 一条连续跨日 Transport 是单一业务实体，可投影到多个日期卡，但共享同一 ID、三层时间、费用、
  状态和备注。
- 被连续 Transport 完整覆盖的中间自然日必须有日期卡和 DateOwnership，且不能加入普通
  Place/FreeAction；“交通占用日”仅为规格概念，本轮不锁定 enum。
- 跨国际日期线导致 localDate 回拨时，按真实 sequence 生成日期回拨卡。同一 localDate 可以出现
  任意多张有独立身份的卡；`DayOccurrence` 是架构概念名，不是已确定数据库表名。
- 新增/编辑内容和 Transport 投影必须定位具体日期卡身份，不能只按 localDate 匹配。
- 重复日期卡不重复 DateOwnership；同一用户的自然日仍最多归属于一个 Trip。
- 执行阶段当前当地时区依次来自可靠设备定位、设备时区、行程地点时区上下文；不使用服务器默认
  时区，也不以时区/定位证据伪造到达、完成或 ACTUAL 事实。

## 仍未决

- DST 重复时间的手工输入选择规则。
- DST 不存在时间的输入处理。
- 没有明确 instant 的复杂当地时间消歧。
- DayOccurrence 的最终数据库结构。
- 当前 `localDate + position` 到独立 sequence 的迁移方案。
- 跨日 Transport 与日期卡关系的最终存储/投影实现。

因此 O-03 状态为“部分确认”，不是 resolved。O-07 未修改，P3 solver、P4 Provider、业务代码、
migration 和 Production 均不在本任务范围。

## 与 O-01/O-02 的关系

- O-01 的首尾空白日期收缩规则不变。
- O-02 的 Trip 自然日有效范围与 DateOwnership 唯一归属规则不变。
- DayOccurrence 可以重复显示同一 localDate，但不能据此重复创建 DateOwnership 或允许另一 Trip
  占用同一自然日。

## 验证

- 本任务只修改 Markdown 文档；`git diff --check` 已通过。
- 当前 Windows checkout 的全量 `pnpm format:check` 已运行但返回失败：本机
  `core.autocrlf=true`，Prettier 标出 24 个本次未修改、Git 仍视为 clean 的 P2B 基线文件；未将
  这些业务源码或历史文档纳入本次格式化修改。
- 对本次变更且属于项目 Prettier 清单的 `docs/architecture/*.md`、`docs/status/*.md` 做了聚焦
  检查，全部通过。最终以 Draft PR 的 clean-checkout GitHub CI 为准。
- 文档变动未触发业务代码 lint/typecheck 的本地修改需求；GitHub CI 仍按仓库流程执行完整检查。
- 本文中的新增验收场景仍是规格，不代表已经实现或测试通过。
