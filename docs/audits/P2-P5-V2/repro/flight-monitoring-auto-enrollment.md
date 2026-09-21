# Repro: 未显式启用时自动建立 Flight Monitor

状态：baseline 静态确认；需真实 PostgreSQL/Worker 环境执行。

1. 创建 Trip、FLIGHT TransportEdge 和未来 24 小时内的 `FlightBinding`。
2. 不创建任何用户 consent/preference（baseline schema 也没有对应表/字段）。
3. 等待一个 Worker heartbeat，或从受控测试直接调用 `FlightMonitoringService.ensureEligibleMonitoring()`。
4. 查询 `FlightMonitorState` 和 `Job(type=FLIGHT_MONITOR)`。

当前实现会根据航班时间/状态 upsert monitor state 并创建 Job。修复后，在 capability 未 enabled 时两者都不应产生；用户 pause/stop 后既有 Job 也必须原子 no-op，heartbeat 不得恢复它。
