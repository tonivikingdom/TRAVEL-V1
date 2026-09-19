# TRAVEL-V1

全新构建的多终端旅行规划后端。main 已完成 P0 至 P4B3；当前 P5A 分支增加一个明确限定在
Development/Test 的薄测试台，用于人工串联已经落地的能力：

- Fastify API：`GET /health/live` 与依赖 PostgreSQL 的 `GET /health/ready`
- 邀请制 Magic Link、可撤销多设备 Session 与集中账号管理授权
- PostgreSQL 持久 Job：原子领取、有限租约、重试退避、取消与崩溃恢复
- 独立 Worker：数据库健康心跳与 `MAGIC_LINK_EMAIL` 异步执行
- Trip / DayOccurrence / Visit / FreeAction、DateOwnership 与版本并发控制
- 相邻 Transport、强类型时间事实、UserTimeIntent、约束评估与确定性时间窗口传播
- provider-neutral Route Query、持久 Preview、事务 Adopt 与短时单步 Undo
- 私有 `NotificationEvent` 列表/dismiss API、ObjectStorage 边界与 owner 隔离
- `apps/debug-web`：Vite + Vanilla TypeScript 测试台，消费真实 API，不作为正式产品 UI 技术决策
- 平台无关的 `domain`、`contracts` 与 `persistence` 边界
- Dev / Staging 隔离的 Docker Compose 配置
- lint、typecheck、unit test、build 与 CI 基础

当前仍不包含 RecommendationPolicy、实时风险监控、Push、正式 Desktop/Mobile 客户端、真实
Route/Mail/ObjectStorage Provider 或 Production 部署。详细边界见
[`docs/architecture/`](docs/architecture/) 与 [`docs/status/P5A.md`](docs/status/P5A.md)。

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
pnpm dev:debug-web
```

Debug Web 默认运行在 `http://127.0.0.1:5173`，通过 Vite `/api` proxy 连接本地 API；开发环境
Magic Link landing 也指向 `/login/magic`。它不使用 Service Worker、IndexedDB 或离线 Trip cache。

容器启动与验证命令见 [`infra/compose/README.md`](infra/compose/README.md)。
