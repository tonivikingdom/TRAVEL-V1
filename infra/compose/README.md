# Compose 运行说明

Dev 与 Staging 使用同一份 Compose 定义，但必须使用各自环境文件与
`COMPOSE_PROJECT_NAME`。这会隔离容器、网络和命名卷。所有宿主机端口只绑定
`127.0.0.1`；P0/P1A/P1B1 不开放公网入口。Compose 会先运行一次性 `migrate` 服务，
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

普通 `restart`、`stop` 或重新创建容器不会删除 PostgreSQL 命名卷。不要用
`down --volumes` 作为日常操作；本项目没有自动 drop/reset 数据库的启动脚本。

P1B1 Worker 需要 Job 租约、轮询、重试与执行超时配置。Dev 使用明确的 SYNTHETIC
`MAGIC_LINK_TOKEN_KEY` 和容器内临时邮件捕获文件；该文件不进入 Git，不可用于
Staging/Production。API 只持久入队，Worker 才检查资格、派生 token 并发送。

Production 文件只描述配置形状。P1B1 不部署 Production，也不配置域名、HTTPS、邮件、
内网穿透或外部 Provider。Staging 的真实邮件 provider 仍为 `unconfigured`，并且必须在
Git 外提供至少 32-byte、由密码学安全随机源生成并以 canonical base64url 或 hex 编码的
`MAGIC_LINK_TOKEN_KEY`。程序校验编码与解码长度，不证明生成熵；提供真实 provider 与凭证前
不能宣称邮件可发送。
