# Real Provider Integration Bootstrap

推荐模型：GPT-6.1 Sol / XHigh；备选 GPT-6 Astra。理由：本任务涉及跨层契约、坐标误差、凭据隔离和官方 API 核对；官方契约或坐标审批存在争议时升级复核。实际运行模型配置未确认。

## 交付范围

- 仓库：`tonivikingdom/TRAVEL-V1`。
- 已 fetch 并确认开始时 `origin/main`：`7ed43747c9da17bc8eec6bd71374ea7321aab147`。
- 分支：`feat/real-provider-bootstrap-cloud`。实现提交：`f3b0d43`；精确交付 HEAD 见最终交付消息及分支记录。远程同名原分支已含其他提交，因此本次使用独立新分支，未覆盖它。
- 远程分支已推送：`origin/feat/real-provider-bootstrap-cloud`。Draft PR：**BLOCKED / 未创建**。实际 `gh pr create --draft --base main --head feat/real-provider-bootstrap-cloud` 返回 `Post https://api.github.com/graphql: Forbidden`；Git HTTPS 推送成功不代表 API 可用。需要在 Cloud Environment 网络设置中放行 `api.github.com` 后继续，不能请求或提取 GitHub token。
- 没有合并、production 部署或 production gate 自动审批；本任务不修改 Cloud Environment 配置。

## 实现与能力边界

| 能力                                 | 实现与本地验证                                                                                                                | 仍需真实账号验证                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 四项配置 / doctor                    | 空模板、全 gate 默认 false；默认零请求；仅 SET/UNSET；固定错误分类；live 每能力一次、九项总预算、无重试                       | 四项凭据、网络目标及账户启用状态                         |
| Google Places / WALKING / DRIVING    | 既有适配器接入 doctor；snapping 两端各 ≤100 米且防对调；不放宽 Domain 可信端点检查                                            | API 启用、账单、真实 snapping、Provider 合同             |
| Baidu Place / WALKING / 当前 DRIVING | v2 正确响应字段、WGS84 入参 / BD09LL 出参；请求与绑定回归                                                                     | 实际响应及非权威逆变换误差                               |
| Baidu CYCLING                        | `riding_type=0`；正式查询、snapshot、Preview、Adopt、PostgreSQL enum 和展示标签                                               | 真实骑行结果                                             |
| Baidu TRANSIT                        | 同城 `city_id` 必须明确相同；聚合预计耗时；正式存储模式，不编造固定班次 / BUS / RAIL 分段                                     | 同城公交 / 地铁真实结果；跨城为 PARTIAL/UNSUPPORTED      |
| Baidu FUTURE DRIVING                 | 未来指定 UNIX 秒、≤7天；独立高级权限 gate；无当前路况 fallback；doctor 请求明日指定时间                                       | 高级账号权限及真实预测语义；HTTP 200 不证明 entitlement  |
| Baidu ARRIVE_BY                      | 明确 UNSUPPORTED，不做 Web 倒推                                                                                               | 建议出发高级契约及账户权限尚未验收                       |
| Browser Mini Map                     | Google 独立 Browser key；Baidu 默认注入官方 JSAPI 4 `BMap.Convertor`，取消 / 超时 / 错误回调局部降级；pin/pan/zoom 边界不扩展 | 两个真实 SDK、域名限制、底图及转换实际误差；状态 PARTIAL |
| Server key 隔离                      | Web 显式浏览器变量白名单；实际生产构建 HTML/JS/source map 排除服务端及意外 VITE secret fixture                                | 没有真实 Key 进入本次构建                                |

Google 100 米 / Baidu 30 米是项目安全策略，不是官方准确性保证；超界仍 fail closed。Baidu 服务端 BD09→WGS84 仍为 approximate/non-authoritative，不称为官方 round-trip。Browser 正向转换使用官方在线能力。官方来源、精度限制和所有 gate 见 [环境文档](../provider-environment-setup.md)。

Mainland China 仍统一 Baidu；Japan TRANSIT 保留 Google Consumer Transit sidecar；Japan / Global ordinary policy 不变，没有跨区域 fallback。无新 UI 入口或推荐策略。

## API / contract / schema delta

- HTTP endpoints：**+0**。既有 route query / external-origin query 的 `travelMode` 增加 `CYCLING`。
- 正式 Domain、contract、snapshot、authoring、adoption 与持久化 `TransportMode`：增加 `CYCLING` 和聚合 `TRANSIT`；不新增班次、价格、轨迹或车辆实际事实。
- Prisma enum：**+2**；无新表 / 字段。迁移 **+1，总数 27**：`20261008090000_provider_transport_modes`，仅 additive enum 扩展。
- 真实隔离 PostgreSQL 17 已部署全部 27 项迁移；clean migration 测试还校验新 enum、原 owner-trip FK 与幂等，原历史 25→26 数据保留断言不变。
- `provider:doctor` 是新的开发验收命令；旧 probe 统一 Google 凭据名称，并抑制未脱敏异常输出。

## 验证证据

| 命令 / 工作流                                          | 本次结果                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| frozen lockfile 安装 / Prisma generate / validate      | PASS；未修改 lockfile，checksum / TLS 验证未关闭                                                                            |
| `pnpm check`                                           | PASS：lint、typecheck、86 文件 / 1061 个单元测试、全仓 build                                                                |
| `pnpm test:integration`                                | PASS：持久层 25 文件 / 106 测试；API 16 文件 / 577 测试；合计 683 个真实 PostgreSQL 集成测试                                |
| `pnpm test:web`，系统 Chromium                         | PASS：327 个浏览器测试；不包含真实 Provider SDK                                                                             |
| `p6a1-browser-postgres.ts`，独立 task-owned 本地数据库 | PASS：真实 PostgreSQL + HTTP + Chromium；Query/Preview 只读、Adopt/Undo 各 +1 版本、恢复 / 并发 / 私有权限 / 保存后导航回归 |
| `pnpm provider:doctor`                                 | PASS：四项 UNSET、CONFIG_ONLY、0 请求                                                                                       |
| `pnpm provider:doctor --live`，四项缺失                | 如预期退出 1：SECRET_UNSET、0 请求；没有真实 API 验收                                                                       |
| `pnpm format:check` / `git diff --check`               | PASS；新增环境文档另经显式 Prettier 检查                                                                                    |

验证在 dev/test 隔离数据库进行，Provider fixtures 明示 SYNTHETIC。测试生成截图保存在 checkout 外，仓库历史 PNG 已恢复，不把本地截图刷新混入本次变更。PG 驱动对既有并发 query 输出 deprecation warning，不影响断言结果。本地 WebKit 未运行，远程 CI 因 API 受限未查询确认；不能将本地 Chromium 或 mock SDK 等同真实跨浏览器 / Provider 验收。

## 修改文件

完整改动清单按职责列出（不包含任何真实凭据文件）：

- 配置与说明：`.env.provider.example`、`package.json`、`README.md`、`docs/provider-environment-setup.md`、本报告。
- Doctor / 旧 probe：`scripts/provider-doctor.ts`、`scripts/provider-doctor-cli.ts`、`scripts/provider-doctor.test.ts`、`scripts/provider-probe/cli.ts`、`scripts/provider-probe/providers/google-routes.ts`。
- Server Providers：`packages/providers/src/endpoint-binding.ts`、`regional-route-adapters.ts`、`regional-config.ts`、`baidu-coordinates.ts`；`packages/providers/test/provider-bootstrap.test.ts`、`regional-providers.test.ts`。
- Domain / Contracts：`packages/domain/src/route-query.ts`、`packages/contracts/src/routes.ts`、`trips.ts`。
- Application：`packages/application/src/route-ports.ts`、`route-query-service.ts`、`route-snapshot.ts`、`trip-service.ts`。
- API 与真实数据库验收：`apps/api/src/app.ts`、`apps/api/test/route-query.integration.test.ts`、`scripts/p6a1-browser-postgres.ts`、`packages/persistence/test/static-backup-migration.integration.test.ts`。
- Schema：`prisma/schema.prisma`、`prisma/migrations/20261008090000_provider_transport_modes/migration.sql`。
- Browser：`apps/web/src/baidu-browser-coordinates.ts`、`provider-map-adapters.ts`、`map-sdk-loader.ts`、`main.ts`、`model.ts`；`apps/web/test/baidu-browser-coordinates.test.ts`、`map-sdk.test.ts`、`map-secret-boundary.test.ts`。

## 用户只需做什么

1. 在 Environment 安全设置中填四项 Key；服务端 secret 绑定 HTTPS 目标，Browser build variables 使用独立域名受限 Key。不发到对话、不写入文件。
2. Save，然后 Publish/Republish environment；网络目标清单见环境文档。
3. 新建任务，明确选择已发布 TRAVEL-V1 environment；合并前选择本 feature branch。
4. `pnpm provider:doctor`。
5. `pnpm provider:doctor --live`。

完成上述步骤后仍需单独做真实 Browser map / 坐标准确性与许可证审核；所有 production gates 保持 false，直到逐项审核。停止点：Draft PR 尚未创建，远程 CI 未确认。需要 Cloud 网络放行 `api.github.com`，然后继续创建 Draft PR 并等待 CI；不需要用户提供 GitHub token。
