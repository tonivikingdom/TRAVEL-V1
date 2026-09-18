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
- Worker 从 DeliveryRequest ID、持久 tokenGeneration 和 Git 外 `MAGIC_LINK_TOKEN_KEY` 派生
  可重试的原始 token，PostgreSQL 仍只保存 SHA-256 digest。TTL 内重试保持 generation；过期
  重试在行锁事务内轮换 generation 与 digest，旧链接不会复活。
- Staging/Production 要求至少 32-byte、由密码学安全随机源生成且以 canonical base64url 或
  hex 编码的 key。程序只验证格式与解码长度，不宣称能证明随机熵。

P1B1 在 P0 健康心跳之上增加 JobRunner；WorkerRuntime 只负责进程生命周期，Runner 负责
poll/claim/lease/timeout/retry，Handler 只处理 `MAGIC_LINK_EMAIL`。P1B2 的
NotificationEvent / ObjectStorage 已获单独授权并在独立功能分支实施。

## 站内通知（P1B2）

- `NotificationEvent` 是用户私有、不可由客户端任意创建的持久事件；可信 application / worker
  用例以明确 owner 和 `(ownerUserId, dedupeKey)` 幂等边界创建。
- `GET /notifications` 只列出当前 Session actor 的通知，按 `createdAt + id` 稳定倒序分页；
  已 dismiss 的事件保留并返回 `dismissedAt`，不物理删除证据。
- `POST /notifications/:id/dismiss` 只能操作 actor 自己的记录并保持幂等。ADMIN 身份不获得
  其他用户通知的读取或修改权。
- P1B2 不生成风险业务语义、不实现 Push、偏好或正式通知 UI。

## 私有对象存储（P1B2）

- `packages/storage` 定义流式 `put/open/delete/stat/exists` port；application 只依赖 port，
  不接触文件系统路径或未来 S3 SDK。
- `StoredObject` 只保存 owner、服务端随机 key、状态、展示元数据、真实 byte size 和 SHA-256；
  PostgreSQL 不保存二进制内容，P2 前也不创建虚假 Trip 关联。
- owner 来自已验证 actor；ADMIN 无跨用户通配权。只有 `READY` 可读，`DELETED` 不可恢复为
  可读状态。
- Development/Test 的本地适配器限定私有 root、UUID key、临时文件、实际大小/hash 校验与
  atomic rename，并拒绝 traversal、绝对路径和 symlink。Staging/Production provider 未配置。
- 单文件、用户总量和 MIME allowlist 均为环境配置；用户总量预留在 PostgreSQL 事务中按 owner
  advisory lock 串行化，避免并发明显超卖。O-09 正式产品数值仍未决定。

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
