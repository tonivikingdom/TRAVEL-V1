# P5B Development/Test 内部验收

## 运行

准备一份只包含 SYNTHETIC 值的独立 env file，其中 `APP_ENV=test`、
`MAIL_PROVIDER=capture`、`ROUTE_PROVIDER=synthetic`，并使用未被其他 Compose project
占用的 API/PostgreSQL host ports：

```bash
pnpm p5b:acceptance -- --env-file /absolute/path/to/p5b.env
```

Harness 使用 `travel-v1-p5b-*` 独立 project name，在 `finally` 中只对自己的 project
执行 `down --volumes --remove-orphans`。超时会报告 scenario/expected/actual，不输出 bearer、
Magic Link token、capture mail 或私有 payload。

## 覆盖

- bootstrap admin、邀请、Worker 异步 Magic Link、consume 与 `/me`。
- 5 个 synthetic 用户各自创建 Trip，设置 UserTimeIntent，执行 schedule evaluate。
- Route Query → Preview，至少两个 Adopt，至少一个 Undo，以及 Adopt/Undo replay 幂等性。
- 普通账号与 ADMIN 的跨 owner 隔离，真实 HTTP + PostgreSQL VERSION_CONFLICT。
- Worker 停止后持久 Job 恢复，PostgreSQL outage 期间 live/ready 分离与数据恢复。
- unconfigured Route Provider 只导致 Route Query 局部错误，不使整个 Trip API 不可用。
- 每用户 10 轮轻量 `/me`、Trip、schedule evaluate 和 notifications 并发观察。

## Reset

```bash
pnpm p5b:reset
pnpm p5b:reset -- --confirm-synthetic-p5b-reset
pnpm p5b:reset -- --confirm-synthetic-p5b-reset --allow-staging
```

第一条是 dry-run。Staging 必须同时提供两个 flag。Production 不存在可启用路径。

## 未覆盖 / NOT IMPLEMENTED

Real Provider、Push、实时监控、真实邮件、正式 Desktop/Mobile 客户端、
RecommendationPolicy、quiet-assist、snooze 与 Production 部署均不在本验收中。
