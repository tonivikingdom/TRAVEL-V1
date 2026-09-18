# TRAVEL-V1

全新构建的多终端旅行规划后端。main 已包含 P0 与 P1A；当前 P1B1 分支增加：

- Fastify API：`GET /health/live` 与依赖 PostgreSQL 的 `GET /health/ready`
- 邀请制 Magic Link、可撤销多设备 Session 与集中账号管理授权
- PostgreSQL 持久 Job：原子领取、有限租约、重试退避、取消与崩溃恢复
- 独立 Worker：数据库健康心跳与 `MAGIC_LINK_EMAIL` 异步执行
- 平台无关的 `domain`、`contracts` 与 `persistence` 边界
- Dev / Staging 隔离的 Docker Compose 配置
- lint、typecheck、unit test、build 与 CI 基础

当前不包含 P1B2 NotificationEvent/ObjectStorage、行程 CRUD、交通 Provider、正式 UI、
真实邮件 Provider 或 Production 部署。详细边界见 [`docs/architecture/`](docs/architecture/)
与 [`docs/status/P1B1.md`](docs/status/P1B1.md)。

## 本地检查

要求 Node.js 24 和 pnpm 11：

```bash
pnpm install --frozen-lockfile
pnpm check
```

复制相应环境模板后可启动单个进程：

```bash
cp .env.dev.example .env.dev
pnpm dev:api
pnpm dev:worker
```

容器启动与验证命令见 [`infra/compose/README.md`](infra/compose/README.md)。
