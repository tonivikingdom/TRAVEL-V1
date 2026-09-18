# 关键责任与事务边界

## 账号与 Session（P1A）

- Invitation 控制可注册邮箱；Magic Link 短期、单次、只保存摘要，并在事务中条件消费。
- Session 由服务端过期和撤销；多设备各有独立 Session，账号禁用使现有会话全部失效。
- actor/owner 来自已验证 Session，不接受客户端传入 ownerId。
- 管理员只能做账号管理；不因此获得读取他人 Trip、附件、位置或费用的权限。
- `authorize(actor, action, resource)` 是集中授权入口；管理员没有私人资源通配规则。
- Session 验证与 credential 的 HTTP 携带方式分离。P1A 测试 API 使用 opaque bearer；
  未来 Cookie / 原生安全存储属于 transport adapter。
- Magic Link request 的节流状态保存在 PostgreSQL；已知和未知邮箱返回相同通用响应。
- Development/Test 邮件只进入 SYNTHETIC 捕获器；真实 staging provider 尚未配置。

P1A 已实现上述数据表、迁移和最小端点；不包含任何 Trip 私有资源实现。

## Job 与 Worker（P1B1，已授权）

- Job 持久化到 PostgreSQL，至少包含 runAt、status、attempts、leaseUntil、
  uniqueKey 和 payloadRef。
- Worker 通过租约/行锁领取，任务幂等、有限重试、退避、超时、失败可见并支持撤销。
- Magic Link 的节流状态、DeliveryRequest 与 Job 在同一事务写入；外部邮件副作用为
  at-least-once，不宣称 exactly-once。
- Worker 调用 application 用例，不绕过资源归属、Trip 版本或监控开关。
- `Job.payloadRef` 只引用类型化业务记录；不保存任意 JSON、原始登录 token 或完整链接。
- Worker 从稳定 DeliveryRequest ID 和 Git 外 `MAGIC_LINK_TOKEN_KEY` 派生可重试的原始 token，
  PostgreSQL 仍只保存 SHA-256 digest。

P1B1 在 P0 健康心跳之上增加 JobRunner；WorkerRuntime 只负责进程生命周期，Runner 负责
poll/claim/lease/timeout/retry，Handler 只处理 `MAGIC_LINK_EMAIL`。P1B2 的
NotificationEvent / ObjectStorage 未授权、未实现。

## Trip 版本（P2 起）

- 每次正式写入递增服务端版本。
- 多设备写操作携带 baseTripVersion；旧版本返回 VERSION_CONFLICT。
- Query 与 Preview 不递增正式 Trip 版本。
- 已执行事实和后来的可靠证据不会被排程重算或 Undo 覆盖。

## Query / Preview / Adopt（P4）

| 操作    | 正式 Trip 写入 | 必须校验                                            |
| ------- | -------------- | --------------------------------------------------- |
| Query   | 否             | 权限、输入语义、Provider 状态；返回来源和有效期     |
| Preview | 否             | 权限、baseTripVersion、输入/Provider/策略快照       |
| Adopt   | 是，单一事务   | 权限、当前版本、预览有效期、Provider 适用性、幂等键 |

Adopt 一次事务写入节点、交通、来源、版本和 outbox。同一幂等键不同 payload 必须
拒绝；两台设备基于同一版本时最多一个成功。外部 API 调用不放进长数据库事务。

Undo 是受约束的新操作：它不倒退外部世界，不覆盖 Adopt 后的新事实或其他设备修改。
