# Compose 运行说明

Dev 与 Staging 使用同一份 Compose 定义，但必须使用各自环境文件与
`COMPOSE_PROJECT_NAME`。这会隔离容器、网络和命名卷。所有宿主机端口只绑定
`127.0.0.1`；P0/P1A 不开放公网入口。Compose 会先运行一次性 `migrate` 服务，
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

Production 文件只描述配置形状。P0 不部署 Production，也不配置域名、HTTPS、
邮件、内网穿透或外部 Provider。P1A 的 Dev 邮件只写入进程内 SYNTHETIC 捕获器；
Staging 的真实邮件 provider 仍为 `unconfigured`，提供凭证前不能宣称邮件可发送。
