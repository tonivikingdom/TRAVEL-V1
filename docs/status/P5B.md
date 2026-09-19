# P5B Internal Acceptance & Environment Guardrails

- 当前状态：Draft PR #17 已创建，保持 Draft，不合并
- 正式基线 main：`cbf9fe2a727011e4708585ef259c3324c05b4362`
- 基线 main CI：Run `35435976817`，`verify` 与 `Compose verification` 均为 success
- 模型建议：Sol / High；备选 Terra / High
- 实际使用模型与强度：未知（仓库无法确认客户端配置）

## 验收边界

`scripts/p5b-acceptance.mjs` 使用独立 Compose project、PostgreSQL 17、API 和 Worker，
串联邀请制 Magic Link、5 个固定命名空间的 synthetic 用户、Trip/时间约束、
Route Query/Preview/Adopt/Undo、私有资源隔离、VERSION_CONFLICT、Worker 恢复、
PostgreSQL 中断恢复和 Provider 局部故障。轻量并发的延迟只作观察数据，
不构成性能 SLA 或容量承诺。

## 实际验证证据

- 初始实现验证 CI Run `35437285119`：`verify`、`Compose verification`、
  `P5B acceptance` 均为 success。
- Unit：26 files / 217 tests success。
- PostgreSQL integration：15 files / 161 tests success（persistence 9/31，API 6/130）。
- P5B acceptance：5 users，200/200 观察请求成功，isolation failures = 0，
  unexpected 5xx = 0，network failures = 0。
- 延迟观察：median `383.18ms`，p95 `589.24ms`，max `607.79ms`。这些数值不是 SLA。
- 本机未安装 Docker/PostgreSQL；容器与数据库证据来自隔离的 GitHub CI。

## 数据安全

`scripts/reset-p5b-synthetic.ts` 只允许严格匹配
`^synthetic-p5b-[a-z0-9-]+@synthetic\.example\.test$` 的账号。未提供
`--confirm-synthetic-p5b-reset` 时只 dry-run；Staging 还必须提供 `--allow-staging`；
Production 永久拒绝。工具不使用全局 truncate，不会删除其他阶段 fixture 或普通用户。

## 定位限制

P5B 通过只表示 Development/Test 环境的 ≤5 synthetic 用户内部验收基线。
它不是 Staging 上线许可、Production readiness、正式性能容量认证，也不代表
真实 Mail/Route/ObjectStorage Provider、Push、实时监控或正式客户端已实现。
