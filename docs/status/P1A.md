# P1A 身份、权限、Magic Link 与多设备 Session 交付记录

- 当前状态：P1A 已通过验收并 Squash Merge 到 main
- 推荐模型 / 强度：GPT-5.6 Sol / High
- 独立安全复核：GPT-5.6 Sol / Extra High
- 备选施工：GPT-5.6 Luna / Max
- 实际使用模型与强度：未知（客户端实际配置无法从仓库证据确认）
- 仓库：`https://github.com/tonivikingdom/TRAVEL-V1.git`
- 分支：`feature/p1a-auth`
- base：`93741a4c8641a1225632eaee381b6f706678245b`
- PR：[#2](https://github.com/tonivikingdom/TRAVEL-V1/pull/2)，状态为 merged

## 当前合并事实

- P1A main commit：`17591cfc2bf8eb4bdd753c321a7572fd10bf8322`。
- main CI：[`Run 35309420185`](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35309420185)，
  `verify` 与 `Compose verification` 均为 success。
- P1B1 持久 Job、Worker 执行框架与 Magic Link 异步邮件已获单独授权。
- P1B2 NotificationEvent / ObjectStorage 已获单独授权并在功能分支实施；P2 仍未授权。

## 本轮测试基础设施修正

- 根因：`packages/persistence/vitest.integration.config.ts` 未加载根 Vitest 的 workspace
  source aliases；integration 在 build 前运行时，`@travel/application` 回退到 runtime
  `dist/index.js`，导致干净 checkout 中找不到入口。
- 修复：新增根级 `vitest.workspace-aliases.ts`，由根配置、persistence integration
  配置和 API integration 配置共同引用；正式 package exports 仍保持 `dist` 语义。
- 回归边界：CI 的 verify job 继续在 `pnpm build` 前运行 `pnpm test:integration`，因此
  PostgreSQL integration 会在无 workspace `dist` 的干净 checkout 中验证 source alias。
- 本机 `pnpm test:integration` 已进入 persistence Vitest 并正确解析 workspace source；因
  本机未配置 `TEST_DATABASE_URL` / 隔离 PostgreSQL，在数据库测试开始前停止，未宣称通过。
- 修复提交：`1a0e45664744acd32e1558190692abcc790d4327`。
- 对应 CI：[`Run 35300426429`](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35300426429)，
  `verify` 与 `Compose verification` 均通过。

## 本轮 Magic Link 契约修正

- 邮件链接现在使用独立配置 `AUTH_MAGIC_LINK_LANDING_URL`，指向客户端登录落地页；
  当前没有新增正式 UI。
- 原始登录 token 只放在落地页 URL fragment，例如
  `https://example.test/login/magic#token=...`；邮件 URL 的 query 不包含 token。
- `POST /auth/magic-link/consume` 只接受 JSON body 的 `{ "token": "..." }`，不接受
  query token，也没有新增会直接创建 Session 的 GET consume 路由。
- development/test 可使用 localhost HTTP；staging/production 必须配置明确的 HTTPS
  landing URL。真实邮件 provider 仍未配置，不能宣称生产登录已可用。

## P1B 安全闸门：邮件发送时序差异

- 当前 `requestMagicLink` 对合法账号会调用 `MailSender`，未知账号不会调用；未来接入
  真实同步邮件 provider 后，公开 request endpoint 可能产生响应时间差。
- 不在 P1A 用固定 sleep 或随机延迟伪装修复。P1B 引入持久 Job / outbox 后，必须将真实
  邮件发送异步化，使公开 request endpoint 不等待真实邮件网络调用。
- 在该问题解决且真实邮件服务配置完成前，不得宣称 Magic Link 登录适合公网正式部署。

## 最终 CI 验证

- 最终提交：`9adb8991f003f039a68d0bafd17f42248330aa3f`。
- 最终 CI：[`Run 35303783128`](https://github.com/tonivikingdom/TRAVEL-V1/actions/runs/35303783128)。
- `verify`：success；`Compose verification`：success。
- 以上为最终验证补充；此前的 CI 记录（包括 Run `35300426429`）保留不变。

## 已实现

- 固定 Prisma ORM / Client / PostgreSQL adapter `7.10.0`，提交正式 migration；不用
  `db push`。
- 实体：User、Invitation、MagicLinkToken、Session、UserPreference，以及 PostgreSQL
  持久节流桶。
- API：Magic Link request / consume、logout、`GET /me`、管理员邀请、最小账号列表、
  禁用、启用和撤销指定用户全部 Session。
- Magic Link 与 Session 均使用 32 字节随机原始值，数据库只存 SHA-256 digest。
- Magic Link 单次消费由 PostgreSQL 事务与条件更新保证；TTL、Session TTL、邀请 TTL、
  节流窗口和次数均可配置。
- 多设备同时保留独立可撤销 Session；账号禁用立即撤销现有 Session 和未消费登录链接，
  重新启用不会恢复旧 Session。
- 集中授权明确限制管理员能力为账号管理，不授予未来私人资源读取权。
- bearer 仅为 P1A HTTP transport adapter；Application 不依赖 Cookie 或浏览器。
- CLI bootstrap 有显式允许开关、环境 guard、重复执行规则，且没有公开 create-admin API。
- Dev/Test 使用内存 SYNTHETIC 邮件捕获器；Staging/Production 真实邮件 provider 未配置。

## 本地验证

| 检查                                     | 当前结果                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`         | 通过；锁文件固定 Prisma 7.10.0                                                                                  |
| Prisma schema validate / client generate | 通过                                                                                                            |
| TypeScript typecheck                     | 通过（6 个 workspace）                                                                                          |
| ESLint                                   | 通过                                                                                                            |
| 单元测试                                 | 通过：7 files / 26 tests（含 P0 回归与 Magic Link 契约回归）                                                    |
| PostgreSQL integration                   | 本机未运行：本机没有隔离 PostgreSQL / Docker；已编写 22 项 P1A integration cases，交由 CI 的 PostgreSQL 17 执行 |
| Compose                                  | 本机未运行：本机没有 Docker；CI 将执行现有 P0 Compose 回归，并先运行正式 migration                              |
| `pnpm build` / `pnpm format:check`       | 通过                                                                                                            |

## CI 关键证据目标

- 从干净 checkout 执行冻结安装、Prisma validate、`prisma migrate deploy`。
- 在真实 PostgreSQL 17 上运行原 P0 readiness integration 与 P1A auth integration。
- 验证 Magic Link 并发单次消费、禁用/启用、全设备撤销、过期、登出、多设备并存、
  PostgreSQL 持久节流和 migration 表。
- 继续运行镜像构建、Compose live/ready、数据库中断恢复、命名卷持久化与 Worker SIGTERM。

## 明确限制与停止点

- 未配置真实 Staging 邮件服务和凭证；本阶段不能宣称真实邮件已发送。
- Production 初始化与部署未完成，也未授权。
- 本机无 Docker/PostgreSQL，因此本机真实数据库和容器未验证；须与 CI 结果分开报告。
- 本文记录 P1A 的历史交付范围；P1B1 的当前实施状态另见 `docs/status/P1B1.md`。
- P1B2 的当前实施状态另见 `docs/status/P1B2.md`；P2～P5 仍未授权。
