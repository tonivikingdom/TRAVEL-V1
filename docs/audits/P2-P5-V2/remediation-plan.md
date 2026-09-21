# Remediation Plan

## P5E2 开始前的硬闸门

### 1. 冻结 AssistanceCapability 产品状态机（F-01、F-02、F-10）

先决策、再 migration。至少回答：

- capability 粒度：flight monitoring、location assistance、auto-record 是否按 user/trip/binding/node 分层；
- 初始状态和明确 opt-in；
- `PAUSED` 与 `STOPPED` 的区别，何种用户动作可恢复；
- Trip end 信号、普通协助清理与 baggage/到达后短尾窗口；
- 已排队 Job 在 pause/stop 后如何原子 no-op/cancel；
- 不用自然日午夜作为隐式生命周期边界。

实现时应让 Worker eligibility 查询 capability state，而不是由客户端隐藏开关模拟停止。

### 2. 分离位置使用与自动记录授权（F-02）

- location assistance consent 允许使用样本做当前提示；
- auto-record consent 才允许创建 ExecutionEvent/ACTUAL；
- 两者可独立 pause/stop；
- 事实记录保存 capability basis/provenance；
- 关闭以后不删除历史事实，也不静默重开。

### 3. 修复 Undo 后 observation 重放（F-03）

引入不随事实 Undo 删除的 observation watermark/tombstone；用真实 PostgreSQL 覆盖：

- arrival → Undo → 相同样本；
- arrival → Undo → 更旧样本；
- arrival → Undo → 合法更新样本；
- 并发 Undo 与 observe；
- airport trigger claim 不重复。

### 4. 决定并实现可解释 arrival evidence policy（F-04）

产品需定义机场/车站/普通地点的最小证据。实现可采用连续样本、dwell、运动状态或不同目标策略，但不能为通过测试任意选择数字。输出至少包含 evidence refs、decision policy version、confidence/quality，并保留快速 Undo。

### 5. 增加 P5E 跨层 acceptance（F-09）

在 synthetic API+PostgreSQL+Worker 环境验证 Location → ACTUAL → Risk → Airport Flight trigger/monitor；必须有 replay 和 no-duplicate assertion。完成前 P5E2 只能做接口原型，不能宣称后台到达链路完成验收。

## 真实 Provider / Staging 前

### 6. Provider governance（F-05）

- 对每个 provider/plan 列出允许保存字段、TTL、attribution、删除机制和审计证据；
- Snapshot expiry 与物理 retention 分开；
- Worker cleanup 必须有界、幂等、可观察；
- 正式 client 显示所需 attribution；
- staging/production config 只有在 matrix 审核通过后开启。

### 7. 航班 acquisition 策略（F-06）

确认 AeroDataBox 计划是否包含适用 webhook，决定 push 主链、polling fallback 和 query-on-demand。若用 webhook，需签名验证、provider observation idempotency、乱序/重放处理、失联 backfill 与成本上限。

### 8. ObjectStorage stale PENDING reconciliation（F-07）

在公开 Attachment/upload 或 staging storage 前完成过期 reservation、quota 释放和 provider orphan cleanup。不要用 `down --volumes` 代替业务恢复。

## 低风险维护

### 9. 文档/Debug 文案纠偏（F-08）

精确表述“server-side flight monitoring 已实现；Push、后台定位客户端、完整 capability lifecycle 未实现”，并把 P5E1 状态更新为当前 main 基线。

### 10. CI runtime 维护

跟进 GitHub Actions Node 20 和 `ubuntu-latest` 警告；单独维护，不与产品 finding 混合提交。

## 建议交付顺序

1. 产品决策 ADR：capability lifecycle + auto-record + post-trip tail。
2. 持久 capability schema/migration 与服务端 guard。
3. observation watermark 修复。
4. arrival evidence/confidence policy。
5. P5E synthetic cross-layer acceptance。
6. P5E2 client（只消费已经存在的服务端状态）。
7. Provider governance/acquisition 与 ObjectStorage 上线闸门。

任何一步若需要把 Notification 当作 Push 成功、把 client toggle 当作服务端授权、或用 mock 代替 PostgreSQL/Worker 证据，应停止而不是扩大范围。
