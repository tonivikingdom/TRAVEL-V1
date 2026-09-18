# ADR 0003：P1B1 持久 Job、租约与 Magic Link 异步投递

- 状态：Accepted for P1B1
- 日期：2026-09-18
- 推荐模型 / 强度：GPT-5.6 Sol / High
- 安全与并发独立复核：GPT-5.6 Sol / Extra High
- 备选施工：GPT-5.6 Luna / Max
- 实际使用模型与强度：未知（仓库无法读取客户端实际设置）
- 升级条件：同一并发/安全问题连续两轮仍未解决，或必须改变已确认架构时，停止扩大改动并独立复核。

## 决策

PostgreSQL 是 P1B1 唯一队列事实来源，不增加 Redis。`Job` 保存类型、状态、计划时刻、
attempts/maxAttempts、租约、唯一键、类型化 `payloadRef` 与最小错误码；数据库约束限制尝试
次数、租约字段一致性和终态租约。Job 不接受任意 JSON payload。

领取使用单条 `WITH candidate ... FOR UPDATE SKIP LOCKED ... UPDATE ... RETURNING`：只选择
到期 QUEUED 或租约已过期的 RUNNING 任务，并在同一原子语句中设置 RUNNING、owner、有限
lease 和 attempts+1。多个 Worker 正常竞争时同一行只会由一个 Worker 获得；崩溃后由租约
到期恢复。终态不再领取。

## 重试、取消与关闭

- 失败采用 `baseDelay * 2^(attempts-1)` 的确定性指数退避，并受最大延迟限制。
- 达 maxAttempts 后进入 FAILED；数据库只保存归一化错误码，不保存 provider 响应、堆栈、
  DATABASE_URL、token 或其他秘密。
- QUEUED 可原子变为 CANCELLED；RUNNING 使用 `cancelRequested` 在外部 I/O 安全边界协作取消，
  不假装已经发生的副作用可以回滚。
- JobRunner 不用 `setInterval` 重入；停止时先停止领取、取消定时器、通知在途执行，再在有界
  时间内等待。WorkerRuntime 负责信号与资源关闭，不以 `process.exit(0)` 掩盖清理。

## Magic Link 异步化与凭证边界

`POST /auth/magic-link/request` 在同一 Serializable 事务中更新节流桶、创建
`MagicLinkDeliveryRequest` 并创建唯一 `MAGIC_LINK_EMAIL` Job，然后统一返回 202。同步路径
不查询账号资格，也不调用 `MailSender`。Worker 执行前重新检查 ACTIVE User 或仍有效的
PENDING Invitation；未知、禁用、撤销或过期对象安全 NO-OP。

原始 token 由 HMAC-SHA-256 派生：key 位于 Git/数据库/日志之外，消息使用固定 domain
separation `travel-v1/magic-link/v1/<deliveryRequestId>:<tokenGeneration>`。DeliveryRequest
持久保存 generation：首次为 1；token 未过期的投递重试复用同一 generation；token 过期后在
DeliveryRequest 行锁保护的事务内 generation+1，并原子替换唯一 MagicLinkToken 的 digest 与
expiry。旧 digest 被替换后不会因为重试而重新有效，数据库始终只有一个当前 token 记录。

Development/Test 使用明确 SYNTHETIC key。Staging/Production 要求 Git 外提供至少 32-byte、
由密码学安全随机源生成的 secret，并使用 canonical base64url 或 hex 编码；程序严格校验编码与
解码后的最小长度，但不声称能数学证明 secret 的生成熵。缺 key、使用 SYNTHETIC key 或格式不符
时启动失败。

数据库事务在邮件网络 I/O 前提交。如果邮件已经发送但成功标记前进程崩溃，可能重复发送
同一仍有效链接。因此 email delivery 明确为 **at-least-once**，不宣称 exactly-once。

## 边界

Dev/Test 可使用仅 SYNTHETIC 的文件捕获 adapter 做跨进程 Compose 验证，捕获文件不进入
Git、不会输出到 CI 日志并在测试清理。真实邮件 provider 仍为
`MAIL_PROVIDER_UNCONFIGURED`；P1B2 NotificationEvent / ObjectStorage、Production 部署与
正式 UI 均未实现、未授权。
