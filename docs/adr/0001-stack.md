# ADR-0001：P0 技术栈与工程形状

- 状态：Accepted for P0
- 日期：2026-09-17

## 决策

- Node.js 24 LTS；本机核验版本 24.19.0。
- pnpm workspace；本机核验版本 11.19.0，并写入 packageManager。
- TypeScript strict，采用 NodeNext ESM。
- Fastify 作为最小 HTTP 入口。
- PostgreSQL 17 容器作为 Dev/Staging/CI 基线；P0 通过 `pg` 驱动做真实 readiness。
- Vitest 做单元与 PostgreSQL 集成测试；ESLint 与 Prettier 做静态/格式检查。
- 模块化单体，API 与 Worker 独立进程；不引入 Redis、Kubernetes 或微服务。
- P0 不采用 ORM、迁移或业务表。Prisma 是否采用在 P1 首个真实持久化模型前重新核验。

P0 首次锁定的关键版本为 TypeScript 6.0.3、Fastify 5.12.5、`pg` 8.23.0、
Vitest 5.0.1、ESLint 10.10.0 与 Prettier 3.9.7；完整传递依赖以
`pnpm-lock.yaml` 为准。TypeScript 7.0.2 在首次安装时被发现与
`typescript-eslint` 8.70.0 不兼容，因此没有通过关闭 lint 来绕过，而是固定到
当前兼容的 6.x 版本。

## 理由

P0 需要验证进程边界、健康检查、工具链和数据库连接，而不是提前固定未来所有表。
直接用 PostgreSQL driver 能完成真实 readiness，避免为了一个 `SELECT 1` 引入空 ORM
模型。Node/pnpm 版本与本机事实一致；容器和 CI 使用相同 Node 补丁版本。

## 替代方案

- SQLite：拒绝，不能替代关键 PostgreSQL 集成行为。
- 内存任务队列：拒绝，P1 的关键 Job 必须持久化 PostgreSQL。
- 微服务/Redis/Kubernetes：拒绝，首版小于等于 5 人且单机 Compose。
- P0 建全量 Prisma schema：拒绝，会把未决产品语义固化成表结构。

## 复核条件

- P1 引入会话、邀请和持久 Job 前核验 ORM、PostgreSQL 和 Node 的兼容版本。
- CI 或容器构建发现 Node 24 / 依赖不兼容时，先缩小并记录问题，不静默换大版本。
- 进入 Production 前必须另做镜像固定、漏洞扫描、备份恢复、秘密管理与升级策略。
