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
- same-timestamp replay 也必须通过 owner/Trip transaction 内的 state+revision+watermark fence；机场触发
  claim 再次核验自动位置记录 generation。generation 不变时仍可恢复 pending airport trigger，变化后旧
  replay 不会触发 risk、Provider 或 notification，pending 历史保持可恢复。
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
- `commitRefresh` 与 `commitProviderFailure` 共用同一个 Flight tail Natural End helper：当既有
  `BAGGAGE/CANCELLED` tail 已无 `nextCheckAt` 时，在当前 capability generation 内停止 capability、取消
  queued monitor job，且不延长既有 tail、不增加 Trip version 或制造新通知。尚未到终点的 Provider failure
  保持 enabled 并沿用既有 fallback schedule。
- Flight effective state 同时考虑初始 T-24 eligibility 与既有有效 monitor work。`ARRIVED/LANDED` 后仍在
  `BAGGAGE/CANCELLED` tail 或仍有同 revision queued/running job 时保持 `effectiveEnabled=true`；tail 真正
  结束后才随 capability 的 `STOPPED/NATURAL_END` 变为 false。

## Natural End

- Trip Natural End 复用 `resolveExecutionFrontier` 的统一 domain predicate：timeline 非空、frontier 一致、
  至少存在 ARRIVAL/DEPARTURE/confirmed SKIPPED execution evidence，且已无 future target。它不要求所有
  历史节点补 ARRIVAL，允许合法 first-node departure-only，也不要求 final departure 或依赖服务器午夜。
- 同一个 persistence helper 同时用于 execution fact transaction 与 Trip command transaction；删除最后 future
  target 会自然停止能力，保留 future target、空 Trip、纯计划 Trip 或 inconsistent frontier 均不会停止。
  Natural End 后再添加 future node 也不会静默重新开启。
- 合法公开 `USER_VALUE / ACTUAL` TemporalValue 写入也复用同一个 Trip helper；因此 final ACTUAL arrival
  可以完成辅助，但 PLANNED/ESTIMATED、仍有 future target 或 inconsistent frontier 都不会触发 Natural End。
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
  natural end。Unit `41 files / 472 tests`、API PostgreSQL integration `9 files / 201 tests`、非 migration
  persistence integration `6 files / 54 tests`、Worker `4 files / 17 tests` 均通过。本机 PostgreSQL 账号无
  `CREATE DATABASE` 权限，因此 clean/populated 隔离 migration suite 与 Compose/P5B 以 Draft PR CI 为
  正式结果。

## Finding 状态与明确边界

本批完成后关闭：`F-01/F-02/F-10`。

仍未处理：`F-04/F-05/F-06/F-07/F-08/F-09/F-12`。`F-03/F-11/F-13` 的 Batch 1 regression 保持。
本批没有开始 P5E2、正式 Desktop/Mobile Client、Push、AeroDataBox webhook、Provider governance、
attachment/storage cleanup、Staging 或 Production 操作。
