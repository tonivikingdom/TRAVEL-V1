# P5 Audit Defect Repair Batch 2

- 开工 main：`59d641bec4f2593e0ab735cf5abc6eb905a75a7c`
- 分支：`feature/p5-assistance-capability-lifecycle`
- Draft PR：[#28](https://github.com/tonivikingdom/TRAVEL-V1/pull/28)
- 初始实现 commit：`5eb02ace6c7c2180d8dee7861f6508662adae370`
- 范围：仅修复审计 finding `F-01`、`F-02`、`F-10`
- migration：`20260926100000_p5_assistance_capability_lifecycle`

## Capability 模型

- `LOCATION_ASSISTANCE` 与 `AUTO_RECORD` 是 Trip scope；`FLIGHT_MONITORING` 是
  FlightBinding scope。不存在 capability row 即服务端权威的 `NOT_ENABLED`。
- 持久状态为 `ENABLED / PAUSED / STOPPED`；停止原因区分 `USER / NATURAL_END`。
- 每个 capability 使用独立单调 revision，不复用也不增加 Trip version。公开 mutation 仅允许
  `ENABLE / PAUSE / RESUME / STOP`；`NATURAL_END` 只由受信系统路径产生。
- 每次请求使用 owner-scoped durable idempotency receipt 与 request hash。相同 key/相同请求确定性 replay；
  相同 key/不同请求返回 `IDEMPOTENCY_CONFLICT`；相同 base revision 的竞争写由 owner advisory lock 和
  scope row lock 串行化。
- `PAUSED` 只能显式 `RESUME`，`STOPPED` 只能显式 `ENABLE`。heartbeat、详情读取、位置样本和航班状态
  都不能隐式重新开启。

## Location 与 Auto-record 分权

- `LOCATION_ASSISTANCE` 非 `ENABLED` 时，位置入口返回 `ASSISTANCE_INACTIVE`，不消费 watermark、不更新
  proximity/suppression、不写事实、不增加版本，也不触发风险、机场刷新或通知。
- Location enabled、Auto-record inactive 时，仍可更新短期派生 state/watermark、释放满足离开条件的
  suppression，并通过 `ARRIVAL_DETECTED / DEPARTURE_DETECTED` 表达“检测到但未记录”；不会写
  ExecutionEvent、ACTUAL、possibly-skipped durable state 或 Trip version。
- Auto-record enabled 不会反向开启 Location。只有二者均 enabled 才能自动记录。
- Location pause/stop 清除 `ExecutionLocationState`，保留 watermark、suppression、ExecutionEvent、ACTUAL
  与用户历史；resume 后必须由新样本重新建立 proximity evidence。
- observe 在读取 capability 时捕获两个 revision，并在 owner/Trip transaction lock 内重新验证；跨
  pause/resume generation 的旧请求返回 `CAPABILITY_CHANGED`，不会按新授权自动重试。
- `MANUAL_ARRIVAL / MANUAL_DEPARTURE / CONFIRM_SKIP / Undo` 保持显式用户操作，不依赖自动能力授权。

## Flight Monitoring fencing

- heartbeat 只扫描显式 `FLIGHT_MONITORING=ENABLED` 的 binding；历史 binding/monitor state 不产生默认授权。
- 每个 `FLIGHT_MONITOR` Job 持久绑定 capability revision。执行前、Provider 返回写事实前，以及 monitor
  state/notification/follow-up transaction 内均重新检查 state+revision。
- pause/stop 取消 queued job、为 running job 请求取消；已发出的 Provider call 可以返回，但跨 generation
  的结果被丢弃。pause→resume 后旧 revision job 仍 no-op，新 heartbeat 只创建新 revision job。
- 手工 flight refresh 不要求 monitoring enabled。机场到达只会面向已 enabled 的 FlightBinding；位置请求
  捕获的旧 monitoring revision 不能跨 pause/resume 触发 Provider。
- Provider observation 的 decision marker 与 time-driven baggage/cancellation tail 分开：同一 observation
  不重复通知，但 tail 到达既有上限时仍能自然终止。

## Natural End

- 当所有 itinerary target 已有 ARRIVAL 或已确认 SKIPPED，且执行 frontier 不再有未来 target 时，Trip 的
  Location/Auto-record 能力由当前事实 transaction 转为 `STOPPED/NATURAL_END`。最终节点 ARRIVAL 足够，
  不要求补 final departure，也不依赖服务器午夜。
- Flight capability 不因 `DEPARTED / EN_ROUTE` 单独停止；沿用 P5D3 已有取消与行李 tail 窗口。已实现的
  tail 到达终点且无 next check 时才转为 `STOPPED/NATURAL_END`。
- Natural End 只增加 capability revision，不增加 Trip version；之后 heartbeat 不会复活，必须由用户显式
  `ENABLE` 创建新 generation。

## Migration 与验证

- 新 migration 不回填 Trip 或 FlightBinding capability；已有事实、monitor state、Trip version 与历史 Job
  保持不变。旧 `FLIGHT_MONITOR` Job 的 `capabilityRevision` 为 null，runtime guard 会安全 no-op。
- 独立 migration tests 覆盖 clean deploy 与 populated main → 本 migration；CI 是隔离数据库的正式证据。
- 本机真实 PostgreSQL 已覆盖 capability API、owner/admin isolation、并发 revision、Location/Auto-record
  分权、pause/resume fencing、manual operation、Trip natural end、Flight late-result fencing 与 Flight
  natural end。Unit `41 files / 470 tests`、API PostgreSQL integration `9 files / 190 tests`、非 migration
  persistence integration `6 files / 50 tests`、Worker `4 files / 17 tests` 均通过。本机 PostgreSQL 账号无
  `CREATE DATABASE` 权限，因此 clean/populated 隔离 migration suite 与 Compose/P5B 以 Draft PR CI 为
  正式结果。

## Finding 状态与明确边界

本批完成后关闭：`F-01/F-02/F-10`。

仍未处理：`F-04/F-05/F-06/F-07/F-08/F-09/F-12`。`F-03/F-11/F-13` 的 Batch 1 regression 保持。
本批没有开始 P5E2、正式 Desktop/Mobile Client、Push、AeroDataBox webhook、Provider governance、
attachment/storage cleanup、Staging 或 Production 操作。
