# Google 路线工具云端兼容服务重建验收

**当前续作（2026-10-04）：PARTIAL。** 最新 main 集成、精确请求来源修复及验收见 [V1 Japan Transit](V1-JAPAN-TRANSIT.md)。以下为历史批次，不能替代当前成功/失败证据。

模型建议：Sol／High；备选 Astra；复杂解析或安全边界问题再提高推理强度。实际客户端模型配置无法核验，未声称自动切换。

本批为 **REBUILT_COMPATIBLE_IMPLEMENTATION / PARTIAL**。原电脑源码未取得；这里是新写的兼容服务，不是原样迁移、原源码恢复或继承历史 live PASS。ARRIVE_BY 最终 Travel 全链复验仍未通过：2026-10-03 一次新查询走到 `response-verification`，未取得可验证响应后超时。没有修改生产实现或追加 live 请求。

## ARRIVE_BY 最终 Travel 复验（2026-10-03）

模型建议：Sol／High，备选 Astra；复杂诊断再提高强度。实际客户端配置无法核验。本轮仅验收，未开始功能开发或故障修复。

远端核对 `main@6871aa1f88964f8590ca61e3d368bb4da67072d3`、[Draft PR #41](https://github.com/tonivikingdom/TRAVEL-V1/pull/41) HEAD `246a50173ab53858217f9f4be6316d1a2b1d6ae8`；本地 HEAD 一致、工作区干净。当前网络为 enforced unrestricted；沿用个人开发范围、环境 proxy/CA 和回环连接。未修改 PR #40／P6A-2或同步其他未合并分支。

恢复冻结依赖安装后，新建临时 PostgreSQL 17 数据库 `travel_arrive_google_live_test`，仅监听回环端口，应用原有 24 个迁移；使用新隔离测试账号和 Trip。账号／Trip 标 SYNTHETIC；候选 Provider 必须是 GOOGLE_CONSUMER_EXPERIMENTAL。本次没有返回 live 候选，没有把 Google 数据标为 SYNTHETIC。

只执行一次 ARRIVE_BY 两跳实际 HTTP 调用。验收脚本指定 Hotel Mahoroba → The Lake View Toya Nonokaze Resort，`2026-10-05 15:00 Asia/Tokyo`。开始 `06:00:10.464Z`，结束 `06:00:24.228Z`；Travel HTTP 503／PROVIDER_UNAVAILABLE，sidecar `UPSTREAM_TIMEOUT:response-verification`。

| 本次脱敏诊断         | 实际结果                                 |
| -------------------- | ---------------------------------------- |
| stage                | response-verification                    |
| 页面 URL 类型        | GOOGLE_MAPS_DIRECTIONS；不保存完整 URL   |
| Directions main      | 存在                                     |
| Leave now            | 结束时不存在、不可见                     |
| blockedPage          | false                                    |
| Google HTTP 403／429 | 均未观察到；主导航 200                   |
| 匿名 Context         | close 事件确认，正常释放                 |
| 服务浏览器           | disconnected 事件确认，正常关闭          |
| Provider HTTP        | 恰好 1 次；没有 retry 或后续 Google 查询 |

控制流程已走过时间模式、日历和时间输入，但没有成功响应，不能声称请求回显、候选到达上限或完整时间语义已验收。本次没有复现 `time-mode` 超时，不构成该阶段的稳定复现证据；验证码、封禁、网络拒绝和具体根因均未确认。

数据库事后只读核对：1 个新账号、1 个 Trip、版本仍 3、2 个原始节点；Snapshot／Preview／AdoptedRoute／TransportEdge、ROUTE_ADOPT／ROUTE_UNDO receipt 均为 0。Query 未改版本；Snapshot、Preview、明确 Adopt、Undo 保持 NOT_REACHED。未载入旧 ARRIVE_BY 成功结果替代本次查询。

仅补必要验收脚本：全部候选到达上限、当前 fetchedAt／Provider、全部 Snapshot payload 与本次 HTTP 候选一致、Query／Preview 不改版本或计划、显式 Adopt +1、Undo +1 并恢复原计划事实及身份、后续无 Provider 调用、未知步行时刻保持 null。计划比较只排除版本和审计 updatedAt。只读观察器沿用原服务 launcher 参数，不改变查询操作、selector、deadline 或错误分类，只保存类型、布尔值和 HTTP 状态。新增六项 SYNTHETIC 回归检查 URL 脱敏。

本轮本地 `pnpm check`／`pnpm format:check` PASS：全仓 66 files／802 tests，新服务 4 files／62 tests；lint／typecheck／build 均通过。冻结依赖安装此次已恢复并通过，未改变锁文件或依赖策略。CI 以新 HEAD 再验，最终状态见 PR／最终回复，不继承旧 HEAD 的检查结论。

已停止真实请求，没有增大 timeout、改 selector、放宽 REQUEST_MISMATCH、登录或绕过验证。生产源码、适配器、Travel 核心、schema、前端及 CI 配置无改动。详细新证据见 [JSON](google-transit-cloud-evidence.json) 的 `arriveByFinalTravelRecheck`；最终新 HEAD／CI 见 PR及最终回复。临时数据库和进程已关闭，不建立长期运行配置。

## 分支和来源

- 仓库：`tonivikingdom/TRAVEL-V1`。
- 分支：`feat/google-consumer-transit-cloud-dev`。
- 起点：重新 fetch 并核对的 `origin/main@d5350fc051bd4a3ff7b50c1aae5605007e0a3ab2`。继续既有本地分支，没有重新创建或依赖 PR #40 未合并代码。交付前 main 更新到 `6871aa1f88964f8590ca61e3d368bb4da67072d3`，仅将已合并基线同步进本分支，解决 `.gitignore` 和锁文件两处配置冲突；PR 相对该 main 的 apps、packages、schema、CI 差异为空。
- 新服务版本：`@travel/google-consumer-transit@0.1.0`。精确交付 HEAD 与 Draft PR 由最终回复提供，避免文档自引用提交。
- 原 Travel 适配器路径：`packages/providers/src/google-consumer-transit-route-provider.ts`，引入提交 `34b25db8a7235fae8b94c837c9705e1e1ca35192`，最后修改提交 `bd693619016969e6b950491e9a6811735bc7c92d`。本批未修改它或其校验。

附件全部已读并保存为可追溯副本：[任务](../reference/google-transit-rebuild/CODEX_TASK.md)、[时间线](../reference/google-transit-rebuild/REFERENCE_TIMELINE.md)、[历史 README](../reference/google-transit-rebuild/reference/HISTORICAL_SIDECAR_README.md)、[Discovery Report](../reference/google-transit-rebuild/reference/ARRIVE_BY_DISCOVERY_REPORT.md)、[Discovery Summary](../reference/google-transit-rebuild/reference/ARRIVE_BY_DISCOVERY_SUMMARY.json)、[结构证据](../reference/google-transit-rebuild/reference/ARRIVE_BY_STRUCTURAL_EVIDENCE.md)。包含附件 README 和 MANIFEST；所有 7 个正文文件均按 MANIFEST SHA256 核对，一字节未改。

历史记录有先后版本：升级前 ARRIVE_BY 关闭，后续本地报告称已实现但未归档源码。本批没有把任一旧状态当成今天的证据。旧 parser offsets 用于定位，然后以当前匿名浏览器观察确认到发时刻、分段、站点及请求端点位置。

## 新实现与运行方式

源码位于 `services/google-consumer-transit/`：`src/contract.ts` 负责输入、时区、DST；`src/parser.ts` 负责私有结构守卫和语义核对；`src/browser.ts` 负责匿名浏览器和可见 UI；`src/config.ts`、`src/server.ts`、`src/main.ts` 负责环境、鉴权、并发、截止时间、取消和启动。

启动、关闭及联调命令见 [服务 README](../../services/google-consumer-transit/README.md)，环境模板见 [.env.dev.example](../../services/google-consumer-transit/.env.dev.example)，输入输出及必需／可空字段见 [CONTRACT](../../services/google-consumer-transit/CONTRACT.md)。默认关闭，只监听 127.0.0.1，专用 Bearer token，单个 Google operation；第二个请求 429 BUSY，不排队。无缓存，无重试；每次查询新的非持久 Context，指定 IANA 时区。

本批云端 Node `24.19.0`、pnpm `11.19.0`、Chromium `151.0.7922.173`，可执行文件 `/usr/bin/chromium`。网络状态和本机策略核对为已实施 unrestricted；使用环境原有 proxy 和 CA，未变更网络策略、替换凭证、关闭全局 TLS 或使用个人浏览器数据。适用范围由用户交接任务限定为个人开发低频查询，live 脚本需额外传入范围确认值。

新增远程依赖仅 `playwright-core@1.63.0`，不下载或打包浏览器。Fastify／Node 类型沿用仓库锁定版本；四个 Travel workspace 包仅作为联调脚本开发依赖。增加 services workspace、全仓单测和格式检查覆盖、忽略临时 evidence 目录；没有升级其他依赖、修改 CI 断言或数据库模型。

API 与 sidecar 在同一云端网络命名空间回环连接。未添加公网监听、浏览器调试端口、Tailscale 或现有 Compose 的地址白名单例外；原电脑服务与 PR #40、前端均未修改。

## 四层验收结论

| 层次                         | 结论                                   | 证据边界                                                                                                                  |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 新服务单测和契约             | PASS                                   | 56 项新服务测试，包含合成 positional fixture、真实 loopback HTTP、鉴权、并发、取消、超时和 Context 回收；不是 Google live |
| 浏览器在云端运行             | PASS                                   | 独立匿名 Chromium 实际打开 Google Maps，并通过可见 UI 选择日期、时刻及两种模式                                            |
| Google 查询和解析            | DEPART_AT PASS；ARRIVE_BY PASS         | 铁路和混合路线各两种模式的四个新查询均通过未修改的原适配器                                                                |
| Travel API／HTTP／PostgreSQL | DEPART_AT PASS；ARRIVE_BY NOT_VERIFIED | DEPART_AT 完整链通过；ARRIVE_BY 首轮 time-mode 超时，最新复验 response-verification 超时，未完成后端链路                  |

## 新真实查询证据

完整脱敏摘要保存在 [google-transit-cloud-evidence.json](google-transit-cloud-evidence.json)，只有查询条件、实际候选和分段摘要、核对布尔值、捕获时间和错误阶段；没有原始响应、完整私有 URL／pb、header、Cookie 或凭证。

四个服务级目标查询于 2026-10-03 04:49–04:50 UTC 串行运行。日期明确为 `2026-10-05`，当地时间与 IANA 时区由页面控件和 Context 核对。表中到发为 Asia/Tokyo 当地时间，不是宿主 UTC。

| 起终点                    | 请求            | 候选数 | 首条实际到发        |  总时长 | 模式及实际获取                                             |
| ------------------------- | --------------- | -----: | ------------------- | ------: | ---------------------------------------------------------- |
| 札幌站 → 小樽站           | DEPART_AT 10:00 |      6 | 10:00 → 10:41       | 2460 秒 | RAIL；fetchedAt 04:49:35.751Z；约 6860ms                   |
| 札幌站 → 小樽站           | ARRIVE_BY 10:00 |      6 | 09:10 → 09:45       | 2100 秒 | RAIL；fetchedAt 04:49:56.590Z；约 5818ms                   |
| Hotel Mahoroba → 景乃之风 | DEPART_AT 15:00 |      6 | 15:12:06 → 17:26:10 | 8044 秒 | WALK/BUS/WALK/RAIL/WALK/BUS/WALK；04:50:17.269Z；约 5683ms |
| Hotel Mahoroba → 景乃之风 | ARRIVE_BY 15:00 |      4 | 12:30:06 → 14:48:27 | 8301 秒 | WALK/BUS/WALK/RAIL/WALK/BUS/WALK；04:50:37.951Z；约 5676ms |

以上 fetchedAt 是首次服务级运行在验证完成时记录的观测时刻，未使用缓存。最终实现已细化为选中响应 body 的实际捕获时刻；后续后端验证使用该实现。全部候选通过绝对到发、时区、总时长、分段时间和精确坐标连续性校验；不是仅验证第一条或凑固定候选数。票价来自新响应；铁路首条为 JPY 1800，混合首条为 JPY 3910，未把历史票价写成断言。

最小 UI 调查实际遇到先返回旧日期／时刻的响应。新实现保留多响应选择和逐份校验，处理日期切换的未完成响应，不信任第一条；对应合成回归也覆盖错的首响应与后续正确响应。当前两种模式的页面时间状态片段均由 UI 生成并核对，不手工生成私有请求。

DEPART_AT 混合首条分段运动时间共 4637 秒，等待共 3407 秒，总和 8044 秒。步行时刻保持 null；公交和铁路到发为新响应提供的真实值，详见 JSON。ARRIVE_BY 首条运动共 5462 秒，等待共 2839 秒，总和 8301 秒。未把等待填成车程或补造步行时刻。

## Travel 真实 HTTP 与持久化

独立 PostgreSQL 17 测试库、全新隔离测试账号和行程；Google 候选为真实数据，账号／行程明确 SYNTHETIC。API 和 sidecar 两跳均使用实际 TCP HTTP，无 app.inject、无 mocked-fetch 替代 Provider。

DEPART_AT 15:00 Query 返回 6 候选；选取真实七段路线，Snapshot 入库，Preview 可采用，显式 Adopt 后版本 3→4，Undo 后 4→5，恢复两个原始节点和 MISSING 连接，Snapshot hash 保持不变。Query 恰好一次 Provider HTTP 请求；Preview/Adopt/Undo 没有再次访问 Google。原适配器、Domain、Application、schema、migration 均无改动。

真实混合路线只有公交／铁路共 6 个到发时间点；步行时刻未知。首次验收脚本错误要求 14 个时间点，已纠正为真实提供的时间点数量，没有改已有测试或补造事实。同日两个模式使用不同测试账户，遵守既有 DateOwnership。使用标准 workspace 包统一运行联调，避免测试脚本混用源码与构建包导致异常类识别不一致。

随后 ARRIVE_BY 在初始 Google 页面等待 time-mode 控件时出现 `UPSTREAM_TIMEOUT`；最终单模式复验返回 `UPSTREAM_TIMEOUT:time-mode`，Travel 正确降级为 PROVIDER_UNAVAILABLE。匿名页面诊断也未得到可交互元素。原因未确认，不能宣称 CAPTCHA、封禁或网络拒绝；没有继续追加 live 尝试，也没有用先前成功的服务级结果替代后端验收。

## 自动测试

- 改动前相关基线：8 files／138 tests PASS；全仓基线 60 files／720 tests PASS。
- 新服务：3 files／56 tests PASS。覆盖输入、DST、跨日、模式混淆、错首响应、端点／时区不匹配、空结果证据、结构破坏、鉴权／关闭／未开放／BUSY、错误分类、超时、真实 HTTP 取消、锁释放、匿名 Context 回收和延后出现的 challenge。
- 同步更新后的 main 前，全仓单测：63 files／776 tests PASS。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm format:check`、`pnpm prisma:validate` PASS。
- 隔离 PostgreSQL 17 原有 24 migrations deploy PASS；`pnpm test:integration`：持久化 23 files／102 tests，API 9 files／478 tests，全通过。未 skip 或修改断言。
- 独立 [Draft PR #41](https://github.com/tonivikingdom/TRAVEL-V1/pull/41) 已提交。main 同步后的本地依赖复验遇到 npm registry HTTP 503；未关闭依赖策略或假称复验通过。CI 最终状态见 PR／最终回复，不将此前本地结果写成 CI 已通过。未让 CI 执行 Google live 查询。

PostgreSQL 测试输出仍含既有 pg 并发 query 弃用提示，不影响本轮通过；本批未扩张为数据库修复任务。

## 未验证项与回退

ARRIVE_BY 完整 Travel 持久化链路尚未通过；真实跨日、可见日历以外月份、CAPTCHA／登录门槛、明确访问拒绝、确证无路线和 schema drift 未实际遇到。后五类有合成负例保护，但不能写成 live 已验证。当前 UI 日期选择仅限可见日历，其他月份明确不支持；这是新实现限制，不是声称恢复原工具能力。

不包含 reverse import、NOW、LAST_TRANSIT、长期可用性、多用户或商用保证。停止新进程只关闭它持有的浏览器；设 `ENABLE_GOOGLE_CONSUMER_TRANSIT=false` 可关闭新查询，API 切回 `ROUTE_PROVIDER=unconfigured` 后按正常方式重启。无需 schema 回滚，不影响原电脑服务。

仅提交独立 Draft PR；不合并、不部署、不开放公网、不购买服务或调用付费 Provider。提交后停止等待复核。后续真实复验需在页面访问恢复且使用范围／网络仍获准时进行。
