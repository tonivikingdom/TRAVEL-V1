# Compose 运行说明

Dev 与 Staging 使用同一份 Compose 定义，但必须使用各自环境文件与
`COMPOSE_PROJECT_NAME`。这会隔离容器、网络和 PostgreSQL/对象存储命名卷。所有宿主机端口只绑定
`127.0.0.1`；P0/P1A/P1B1/P1B2 不开放公网入口。Compose 会先运行一次性 `migrate` 服务，
成功应用仓库中的 Prisma migration 后才启动 API 与 Worker。

## Dev

```bash
cp .env.dev.example .env.dev
docker compose --env-file .env.dev -f infra/compose/compose.yml up --build -d
docker compose --env-file .env.dev -f infra/compose/compose.yml ps
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
```

## Staging

先在 Git 之外替换所有 `CHANGE_ME`，再运行：

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -f infra/compose/compose.yml up --build -d
```

普通 `restart`、`stop` 或重新创建容器不会删除 PostgreSQL 或 Development/Test 私有对象
命名卷。不要用
`down --volumes` 作为日常操作；本项目没有自动 drop/reset 数据库的启动脚本。

P1B1 Worker 需要 Job 租约、轮询、重试与执行超时配置。Dev 使用明确的 SYNTHETIC
`MAGIC_LINK_TOKEN_KEY` 和容器内临时邮件捕获文件；该文件不进入 Git，不可用于
Staging/Production。API 只持久入队，Worker 才检查资格、派生 token 并发送。

Production 文件只描述配置形状。P1B1 不部署 Production，也不配置域名、HTTPS、邮件、
内网穿透或外部 Provider。Staging 的真实邮件 provider 仍为 `unconfigured`，并且必须在
Git 外提供至少 32-byte、由密码学安全随机源生成并以 canonical base64url 或 hex 编码的
`MAGIC_LINK_TOKEN_KEY`。程序校验编码与解码长度，不证明生成熵；提供真实 provider 与凭证前
不能宣称邮件可发送。

P1B2 的 API 容器挂载 `/var/lib/travel-objects` 私有命名卷；对象 key 由服务端生成，目录不映射
到 Web public root。Compose CI 写入明确标记为 SYNTHETIC 的对象，重新创建 API 容器后核对
文件和 PostgreSQL 元数据仍存在，再执行幂等删除并确认不可读取。Staging/Production 不启用
Local Filesystem adapter，真实 ObjectStorage provider 仍为
`OBJECT_STORAGE_PROVIDER_UNCONFIGURED`。

## P5B synthetic 内部验收与 reset

P5B 验收使用单独 env file 和独立 `travel-v1-p5b-*` Compose project：

```bash
pnpm p5b:acceptance -- --env-file /absolute/path/to/p5b.env
```

它只允许 `APP_ENV=test`、capture mail 和 synthetic Route Provider，结束时只清理自己的
容器、网络与命名卷，不会动 Dev/Staging project。

`pnpm p5b:reset` 默认 dry-run，只显示 APP_ENV、数据库 host/name 和严格命名空间的
匹配数。实际删除必须加 `--confirm-synthetic-p5b-reset`；Staging 还必须加
`--allow-staging`；Production 永久拒绝。`down --volumes` 不是普通 Dev/Staging 的 reset
方法，不得用它替代 allowlist reset。
