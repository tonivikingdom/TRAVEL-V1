# P3 前置：O-03 / O-04 / O-07 产品规则落档

- 当前状态：在 `feature/p3-prep-o03-timeline-days` 仅做规格落档；交付为 Draft PR，未 Ready、
  未合并，P3 代码未开始
- 基线 main：`50866c4aa4ec122e4522920dcf2e53b551de7dfb`
- 基线 main CI：Run `35353581612`，`verify` 与 `Compose verification` 均为 success
- 推荐模型 / 强度：GPT-5.6 Sol / High
- 备选：GPT-5.6 Luna / Max，仅用于范围明确的小修
- 升级条件：若需改变业务代码、新增 migration、实现 DayOccurrence/sequence、生命周期、预约保护
  或 DST command/UI，停止扩大范围并交由更强模型独立复核
- 实际使用模型与强度：未知（客户端实际配置无法从仓库证据确认）

## O-03：产品规则 RESOLVED

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
- 可靠结构化数据已有明确 instant 或 UTC offset 时，系统直接确定 DST occurrence，不询问用户。
- 手工输入 DST 回拨日重复的当地钟点时，用户必须选择前一个或后一个 occurrence；不默认选择。
- 手工输入 DST 跳时中不存在的当地钟点时明确拒绝，不自动平移或静默接受。
- 只有当地钟点且信息不足以唯一确定 instant 时保持歧义，不猜测。

### O-03 尚未实现的工程工作

- DayOccurrence 的最终数据库结构。
- 当前 `localDate + position` 到独立 sequence 的迁移方案。
- 跨日 Transport 与日期卡关系的最终存储/投影实现。
- DST 重复/不存在时间的输入解析 command 与 UI。

因此 O-03 已在产品规则层面解决；上述事项是实现设计，不代表功能已经完成。

## O-04：产品规则 RESOLVED

- 不解析备注、附件、待办或自然语言猜预约/购票状态；备注写“已订”仍不能自行建立保护。
- 受保护安排只来自可靠结构化事实（例如已采用固定班次、结构化预约/门票确认）或用户主动明确
  标记“已预订 / 时间固定”。
- V1 保持轻量，不要求订单号、截图、付款凭证、OCR 或完整订单模块。
- 冲突时优先尝试保住受保护时间，但保护不是绝对禁止修改；无法满足时展示冲突并让用户决定，
  不伪造已解决。
- Provider/Booking 如何产生结构化确认属于后续实现和外部服务问题；保护安排代码尚未实现。

## O-07：产品规则 RESOLVED

- 计划日期结束后，Trip 自然进入“已结束”，不要求用户证明旅行发生。
- 未打开 App、无定位、无 Actual 或未补记录都不产生“是否去过”追问或待确认任务。
- Actual/定位/App 证据用于提醒、风险、调整和历史回看；有多少保存多少，缺少部分保持 unknown，
  但不是旅行结束门槛。
- 只有用户主动明确表示没去，才标记 `NOT_TAKEN`；系统不得从无数据推断未执行。
- 用户可见状态保持计划中、进行中、已结束、未执行。自动生命周期代码尚未实现。

O-03/O-04/O-07 解决的是产品判断，不等于 DayOccurrence、solver、生命周期、保护安排或 Provider
功能已经实现。P3 solver、P4 Provider、业务代码、migration 和 Production 均不在本任务范围。

## 与 O-01/O-02 的关系

- O-01 的首尾空白日期收缩规则不变。
- O-02 的 Trip 自然日有效范围与 DateOwnership 唯一归属规则不变。
- DayOccurrence 可以重复显示同一 localDate，但不能据此重复创建 DateOwnership 或允许另一 Trip
  占用同一自然日。

## P3 前置产品逻辑状态

O-03/O-04/O-07 已确认后，当前没有已知的 P3 核心产品逻辑阻塞。仍需单独授权和完成数据结构、
migration、command/UI 与 solver 实施；O-05/O-06 等继续约束后续 Recommendation/Provider，
不因本次文档落档而自动解决或授权。

## 验证

- 本任务只修改 Markdown 文档；`git diff --check` 已通过。
- 当前 Windows checkout 的全量 `pnpm format:check` 已运行但返回失败：本机
  `core.autocrlf=true`，Prettier 标出 22 个本次未修改、Git 仍视为 clean 的 P2B 基线文件；未将
  这些业务源码或历史文档纳入本次格式化修改。
- 对本次变更且属于项目 Prettier 清单的 `docs/architecture/*.md`、`docs/status/*.md` 做了聚焦
  检查，全部通过。最终以 Draft PR 的 clean-checkout GitHub CI 为准。
- 文档变动未触发业务代码 lint/typecheck 的本地修改需求；GitHub CI 仍按仓库流程执行完整检查。
- 验收清单扩展到 119 个规格场景；新增场景仍只是规格，不代表已经实现或测试通过。
