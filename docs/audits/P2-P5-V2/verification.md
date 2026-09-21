# 验证记录

## 固定环境

| 项目                | 值                                         |
| ------------------- | ------------------------------------------ |
| Audit baseline      | `317a08ed4c9d5ff0fcb455573a012762269eaaf7` |
| OS / shell          | Windows / PowerShell                       |
| Node.js             | `v24.19.0`                                 |
| pnpm                | `11.19.0`                                  |
| Git                 | `2.53.0.windows.3`                         |
| PostgreSQL service  | `postgresql-x64-17` 正在运行               |
| `psql`              | 未在 PATH 中                               |
| Docker CLI          | 不可用                                     |
| `TEST_DATABASE_URL` | 未设置                                     |
| `DATABASE_URL`      | 未设置                                     |

## 本机命令结果

| 命令                                    | Exit | 结果                                                                                                                                                           |
| --------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm prisma:validate`                  |    0 | Prisma schema valid                                                                                                                                            |
| `pnpm format:check`                     |    1 | Prettier 在 21 个 baseline 文件报告格式差异；均为本次审计前已存在的 P5E1/Windows CRLF 相关文件，本审计没有批量改写业务文件。同一 SHA 的 Linux CI format 成功。 |
| `pnpm lint`                             |    0 | success                                                                                                                                                        |
| `pnpm typecheck`                        |    0 | success；Prisma generate 成功，workspace projects 全部通过                                                                                                     |
| `pnpm test`                             |    0 | **40 files / 459 tests** passed                                                                                                                                |
| `pnpm exec vitest run apps/worker/test` |    0 | **4 files / 17 tests** passed                                                                                                                                  |
| `pnpm test:integration`                 |    1 | 环境阻塞：13 个 persistence suite 在加载时因 `TEST_DATABASE_URL is required` 失败，1 file / 2 tests skipped；API stage 未开始。不是产品断言失败。              |
| `pnpm build`                            |    0 | 全 workspace build 成功，包含 Debug Web Vite production build                                                                                                  |

`pnpm --filter @travel/worker test` 没有执行测试，因为 worker package 没有 `test` script；因此使用上表的显式 Vitest 命令，未把空输出算作通过。

## 正式 main CI 证据

- Workflow run：[35554823250](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35554823250)
- Commit：`317a08ed4c9d5ff0fcb455573a012762269eaaf7`
- Trigger：push to `main`
- Overall：success
- `verify`：success（PostgreSQL 17、migration deploy、format、lint、typecheck、unit、PostgreSQL integration、build）
- `Compose verification`：success
- `P5B acceptance`：success
- CI 记录的测试规模：unit **40 files / 459 tests**；PostgreSQL integration **22 files / 221 tests**（persistence 14/59，API 8/162）。

工作流定义见 `.github/workflows/ci.yml:12-139`。CI 页面同时提示 GitHub Actions v4 内置 Node 20 的弃用迁移和 `ubuntu-latest` 迁移警告；这是 CI 维护项，不是本次产品 correctness failure。

## 未能在本机执行的项目

1. PostgreSQL integration：缺少 `TEST_DATABASE_URL`。
2. clean/populated migration：同上；由 main CI `verify` 提供基线证据。
3. Compose verification：Docker CLI 不可用；由 main CI 提供证据。
4. P5B acceptance：Docker CLI 不可用；由 main CI 提供证据。

这些项目均标为“CI 已验证 / 本机未验证”，没有用 mock 或 unit test 替代真实 PostgreSQL/Compose 结论。

## 测试盘点结果

- 唯一显式条件 skip：`packages/persistence/test/p5b-reset.integration.test.ts:14` 的 `describe.skipIf(databaseUrl === undefined)`；它只在没有数据库 URL 时跳过 reset integration。
- 未发现 `test.only`、注释掉整套 suite 或通过弱化 assertion 绕过 P2–P5 核心行为。
- 多处 `as unknown as` 用于 Prisma JSON → versioned contract 的边界。本审计只在能形成具体触发与后果时立项，未把类型转换数量当 finding 数量。

## 外部 Provider 官方来源

查询日期：**2026-09-21**。只查看官方公开资料；没有发起付费 API 调用、购买订阅或假定账户 entitlement。

1. [Google Routes API policies](https://developers.google.com/maps/documentation/routes/policies)：Routes 内容缓存、归因、隐私和 Terms 边界；Place ID 有单独规则。
2. [Google Maps Platform service-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)：Routes 等服务的缓存/使用限制；具体许可仍取决于账户合同和当期条款。
3. [AeroDataBox Flight Alert API guide](https://aerodatabox.com/flight-alert-api-2026)：官方说明按 flight number/airport 建立 webhook subscription、交付重试和 credit-based billing；覆盖和余额会影响通知。
4. [AeroDataBox API](https://aerodatabox.com/api) 与 [pricing](https://aerodatabox.com/pricing/)：能力、配额、覆盖和数据使用随计划变化。
5. [AeroDataBox 2026 terms update](https://aerodatabox.com/2026-09-terms-update)：官方说明默认数据留存上限和扩展计划差异；实际账户计划未知。

由此只能得出：仓库需要一份与实际 provider plan 绑定的 retention/attribution/acquisition capability matrix。不能仅凭公开网页断言当前账户已经违规，或承诺 webhook 一定免费、完整、可靠。

## 审计自身验证

提交前执行：

```text
pnpm exec prettier --check "docs/audits/P2-P5-V2/**/*.md" "docs/audits/P2-P5-V2/**/*.ts"
pnpm exec tsx docs/audits/P2-P5-V2/repro/location-single-sample.repro.ts
git diff --check
```

最终实际结果记录在 Draft PR 正文和提交后的审计 HEAD。
