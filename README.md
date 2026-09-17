# TRAVEL-V1

全新构建的多终端旅行规划后端。本仓库当前只落地 **P0 工程与架构基线**：

- Fastify API：`GET /health/live` 与依赖 PostgreSQL 的 `GET /health/ready`
- 独立 Worker：定期检查 PostgreSQL 并写入进程健康心跳
- 平台无关的 `domain`、`contracts` 与 `persistence` 边界
- Dev / Staging 隔离的 Docker Compose 配置
- lint、typecheck、unit test、build 与 CI 基础

当前不包含登录、行程 CRUD、交通 Provider、正式 UI 或生产部署。详细边界见
[`docs/architecture/`](docs/architecture/) 与 [`docs/status/P0.md`](docs/status/P0.md)。

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
