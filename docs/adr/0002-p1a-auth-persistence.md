# ADR 0002：P1A 身份持久化与认证凭证边界

- 状态：Accepted for P1A
- 日期：2026-09-18
- 推荐模型 / 强度：GPT-5.6 Sol / High
- 独立安全复核：GPT-5.6 Sol / Extra High
- 备选施工：GPT-5.6 Luna / Max
- 实际使用模型与强度：未知（仓库无法读取客户端实际设置）
- 升级条件：同一安全/事务问题连续两轮未解决，或修复要求改变已确认架构时，停止扩大改动并独立复核。

## 决策

P1A 固定使用 Prisma ORM `7.10.0`、`@prisma/client` `7.10.0` 与
`@prisma/adapter-pg` `7.10.0`。Prisma 8 在本次核验时仍为 release candidate，
不作为本阶段稳定依赖。Prisma 7 官方系统要求覆盖 Node.js 24，最低 TypeScript
版本为 5.4；官方数据库矩阵覆盖 PostgreSQL 17。当前工程的 Node 24、TypeScript 6、
PostgreSQL 17 与 ESM pnpm workspace 因此兼容。

Prisma 7 的 PostgreSQL 运行时使用官方 `pg` driver adapter。P0 的独立 `pg` 健康探针
继续保留，业务 ORM 不能把 readiness 固化成恒定成功。

## 迁移

- 数据模型位于 `prisma/schema.prisma`。
- 所有数据库变更通过 `prisma/migrations/` 中的可追踪 SQL 迁移提交。
- CI 和 Compose 使用 `prisma migrate deploy`；禁止以 `db push` 替代正式迁移。
- CI 只连接标记为 `SYNTHETIC` 的 PostgreSQL 17 数据库。
- Compose 在 API 与 Worker 启动前运行一次性 `migrate` 服务。
- 不提供自动 drop、生产 reset 或未知数据库清理入口。

## Magic Link 与 Session

- 原始 Magic Link token 和 Session credential 均由 32 字节密码学随机数生成。
- PostgreSQL 只保存 SHA-256 digest；原始值只在邮件构造或 Session 建立响应中短暂存在。
- Magic Link 兑换通过数据库事务和条件更新声明 token，保证并发最多一次成功。
- Session 为服务端可撤销记录；每台设备拥有独立记录，不做“新设备踢旧设备”。
- 禁用账号在同一事务中撤销现有 Session 并使未消费 Magic Link 失效。
- TTL 与请求节流窗口均为环境配置，不作为永久产品规则。

## 传输与权限

Application 只处理 opaque credential，不依赖 Cookie 或浏览器 API。P1A HTTP adapter 使用
`Authorization: Bearer <opaque credential>`；未来 Web 的 HttpOnly Cookie 和原生端安全存储
可以替换 transport adapter，而无需重写 Session 逻辑。

集中 `authorize(actor, action, resource)` 只允许管理员执行账号管理动作。私人资源读取始终
校验 owner；`ADMIN` 不是未来 Trip、费用、附件、位置或任务的万能通行证。

## 邮件边界

`MailSender` 是 Application port。P1A 的同步调用边界已由 P1B1 ADR 0003 替代：API 只做
持久入队，Worker 调用 MailSender。Development/Test 使用 SYNTHETIC capture；
Staging/Production 默认为 `unconfigured`。没有绑定商业邮件供应商，也不记录原始 token。
未配置真实 provider 时不得宣称邮件可发送。

## 基本滥用防护

Magic Link request 的计数窗口持久化在 PostgreSQL 的摘要键中，不使用进程内 Map 作为
唯一安全措施。对已知和未知邮箱先执行同一节流路径，正常响应保持一致，避免泄露账号或
邀请状态。本机制是首版轻量防护，不是完整反滥用平台。
