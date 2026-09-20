# Google Consumer Experimental Transit RouteProvider Integration

## 结果

- RESULT：PARTIAL
- 分支：`feature/google-consumer-transit-integration`
- HEAD：随本状态文档所在分支提交交付；精确 SHA 以最终交付回复为准，避免为文档自引用追加提交
- 基线：`ddfa4cb558ea4dabec032189f2f66129f1f6f0f8`（P5D2 已 Squash Merge 的当前 main）
- Provider：`GOOGLE_CONSUMER_EXPERIMENTAL`
- Sidecar base URL：`http://127.0.0.1:8787`（仅 loopback）
- Token：仅服务端环境变量使用；不会进入 contracts、Debug Web、数据库或日志；实测日志已确认脱敏
- 数据库：无 Prisma schema 变更、无 migration

## 边界

- Travel 继续只暴露 `POST /trips/:id/routes/query`；客户端不能直接调用 sidecar。
- Provider adapter 只接收业务查询字段，将 explicit instant 按 IANA timezone 转成 sidecar 的
  `date + time + timeMode`。`NONE` 明确返回 `UNSUPPORTED_QUERY`。
- Google Consumer 私有 URL、`pb`、Cookie、`!5i/!6e/!8j` 与 raw response 只属于 sidecar，未进入主项目。
- Sidecar response 先做运行时校验，再映射为现有 `NormalizedRouteCandidate`；Application 保留 hard-window
  二次校验，Snapshot/Preview/Adopt/Undo 无 Google-specific 分支。
- `ARRIVE_BY` adapter mapping 已实现；sidecar 当前仍标记为未 live 验证，不能宣称完整可用。
- `intermediateStops` 暂不进入主项目 Domain/Contracts/DB，也不生成 itinerary node。
- 本能力仅供个人 Development 实验；Staging/Production 启动时拒绝该 provider。

## 验证状态

- `DEPART_AT` adapter / live sidecar：PASS。
- `ARRIVE_BY` adapter mapping：PASS；live sidecar 明确返回 `UNSUPPORTED_QUERY`，状态为 `NOT_LIVE_VERIFIED`。
- Scenario A，Hotel Mahoroba → 洞爷湖景乃之风，2026-09-23 15:00 Asia/Tokyo：6 candidates；
  adapter 约 7,448 ms，sidecar 约 7,336 ms。首条为 WALKING/BUS/WALKING/RAIL/WALKING/BUS/WALKING，
  JPY 3,910，班次 legs 正确标记 `fixedService=true`。
- Scenario B，札幌駅 → 小樽駅，2026-09-22 09:00 Asia/Tokyo：6 candidates；adapter 约 7,339 ms，
  sidecar 约 7,273 ms。首条为单段 RAIL，JPY 1,800。
- 两次 live query 平均 adapter 约 7,394 ms、sidecar 约 7,305 ms；均为低频串行调用。
- 多段边界标准化与精确坐标连续性：Provider 层 PASS；不按名称或距离合并站点。
- Fare canonicalization、mode、serviceLabel、fixedService、duplicate candidate、时区/跨日转换、timeout、network、
  HTTP 401/429/500 与 sidecar error mapping：unit PASS。
- Unit：36 files / 409 tests，PASS；包含 synthetic RouteProvider、Flight、ExecutionRisk、Query/Preview/Adopt/Undo 回归。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm prisma:validate`：PASS。
- 修改文件的 Prettier 检查：PASS。全仓 `format:check` 仍受既有 Windows CRLF 基线影响，未批量改写无关文件。
- PostgreSQL integration：未通过本机执行；机器没有 Docker/PostgreSQL 且没有 `TEST_DATABASE_URL`，命令按预期在
  环境闸门失败，未跳过或伪报成功。
- Travel HTTP Query → Snapshot → Preview → Adopt → Undo live E2E：未验证；同样被本机 PostgreSQL 环境阻塞。
- CI：待本 Draft PR 创建并执行；GitHub CI 将作为 PostgreSQL integration 与通用
  Query → Snapshot → Preview → Adopt → Undo 持久化链路的正式验收环境。
- Prisma schema/migration：0 变更。

## 修改文件

- `packages/providers/src/google-consumer-transit-route-provider.ts`
- `packages/providers/src/config.ts`
- `packages/providers/src/index.ts`
- `packages/providers/test/google-consumer-transit-route-provider.test.ts`
- `packages/providers/test/config.test.ts`
- `apps/api/src/main.ts`
- `.env.dev.example`
- `docs/architecture/responsibilities.md`
- 本状态文档

## 未解决事项

- Sidecar `ARRIVE_BY` 尚未 live 验证。
- 本机缺少 PostgreSQL/Docker，Snapshot/Preview/Adopt/Undo 的真实持久化链路仍需在具备隔离 PostgreSQL 的环境补验。
- 不包含 reverse import、正式 UI、公网/Tailscale、真实多人并发、Production enablement 或商业可用性承诺。
