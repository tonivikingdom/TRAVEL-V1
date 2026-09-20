# TRAVEL-V1

全新构建的多终端旅行规划后端。main 已包含 P0 至 P5D2、Japan Transit DEPART_AT/ARRIVE_BY
实验接入与可复用 Provider Probe；当前 P5D3 分支实现航班监控 V1。Development/Test 薄测试台用于
人工串联已经落地的能力：

- Fastify API：`GET /health/live` 与依赖 PostgreSQL 的 `GET /health/ready`
- 邀请制 Magic Link、可撤销多设备 Session 与集中账号管理授权
- PostgreSQL 持久 Job：原子领取、有限租约、重试退避、取消与崩溃恢复
- 独立 Worker：数据库健康心跳、`MAGIC_LINK_EMAIL` 与持久 `FLIGHT_MONITOR` 异步执行
- Trip / DayOccurrence / Visit / FreeAction、DateOwnership 与版本并发控制
- 相邻 Transport、强类型时间事实、UserTimeIntent、约束评估与确定性时间窗口传播
- provider-neutral Route Query、持久 Preview、事务 Adopt 与短时单步 Undo
- 确定性 RecommendationPolicy、停留/Buffer 策略与可逆用户调整
- 显式执行风险评估、持久风险生命周期、acknowledge/snooze 与通知抑制
- FlightBinding、运行事实及起飞前定点/延误/取消监控、重要变化合并事件与落地行李短轮询（P5D3 Draft）
- 私有 `NotificationEvent` 列表/dismiss API、ObjectStorage 边界与 owner 隔离
- `apps/debug-web`：Vite + Vanilla TypeScript 测试台，消费真实 API，不作为正式产品 UI 技术决策
- 平台无关的 `domain`、`contracts` 与 `persistence` 边界
- Dev / Staging 隔离的 Docker Compose 配置
- lint、typecheck、unit test、build 与 CI 基础

当前仍不包含通用实时定位、Push、自动重排/下一班查询、正式 Desktop/Mobile 客户端、真实
Mail/ObjectStorage Provider 或 Production 部署。航班监控不等于完整出行监控或 Push 投递。
详细边界见 [`docs/architecture/`](docs/architecture/) 与 [`docs/status/P5D3.md`](docs/status/P5D3.md)。

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
