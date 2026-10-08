# V1 Release Readiness Integration — Round 1

推荐模型：GPT-5.6 Sol / High；备选为实际可用的同级 Sol / High。事务锁、提交时钟或跨层契约发生冲突时提高推理强度；实际客户端模型配置未知，未声称自动切换。

本轮只建立可重复验证的集成候选，所有新运行的 Provider 验收均为 **SYNTHETIC**，真实/收费 Provider 请求数 **0**。不合并 main、不部署、不自动启用真实 Provider。最终保持 Draft，等待独立整合复核。

## 精确基线与提交来源

分支：`integration/v1-release-readiness`。Draft PR base：`fix/v1-real-provider-contracts`。

起点为 PR #55 的已复核精确 HEAD `b5523548340d421443afeb1c99dcc6d3afb26f59`。该提交已继承 #53 `4a2a5dfc0b2cabf5e1d2750b53043b0ca464bde8` 和 #54 `9d32c0b23198d35b6f2873d7d9016365f934d635`；本轮没有重复引入它们。

开工 fetch 后，#55/#56/#57 的远程 HEAD 均与授权 SHA 一致。以 #54 为共同基线的专属范围分别只有 #57 两个提交、#56 一个提交，按以下顺序 `cherry-pick -x`：

| 顺序 | 来源                                       | 原提交                                     | 集成提交                                   |
| ---- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| 1    | #57 执行安全修复                           | `ed133e368256ece652dca7e158367c3e011347dc` | `ff3e1e3bcf8c12c3d59cb5dc203bb08b92517317` |
| 2    | #57 Compose 过期 suffix 负例与显式后续班次 | `d68540e3c647e91022b42ce8f8ae4a0e25b65cc7` | `d14a76f0612c3168bc7781a2551bd7888f7a18b2` |
| 3    | #56 Web 验收修复                           | `7fca2ab7b05f71b6746365949ba5ff50df1d51ac` | `bf0d1ec6a831e3f036356f1a0c1f1e484f840fed` |

三个集成提交的 `git patch-id --stable` 分别与原提交一致，并且三者互不重复。#55 的 10 个修改文件、#57 的 17 个、#56 的 156 个没有相互重叠；每个文件的最终 Git blob 均与其来源 HEAD 相同。**没有 cherry-pick 冲突，没有额外业务重写，没有删除或弱化测试。** 最后只追加本集成记录。

没有合并整个 `qa/v1-travel-scenarios`。来源分支已有的选择性 QA 回归继续保留。未引入独立的 `investigate/v1-provider-route-access`，未修改 #53/#54/#55/#56/#57 的源分支。

## 统一验收与权威边界

| 项目                   | 最终组合中的保护与验收位置                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RWS-01                 | Web 明确传递已选交通意图；未知/歧义 mode 要求明确选择，零默认 Query。`route-query-mode.test.ts`、`travel-web-acceptance.browser.ts`、既有 Regional Query PostgreSQL 回归共同覆盖。                                                                                          |
| RWS-02 Query           | Provider I/O 后重新采样服务器时钟；保存 Snapshot 在 owner/Trip 锁内重读执行事实并复核，提交边界跨越则整体回滚。错过固定班次返回 `NO_MATCHING_CANDIDATE`。                                                                                                                   |
| RWS-02 Preview         | 创建、锁内持久化、提交边界、readonly retrieval 都拒绝已错过固定班次，返回既有 `PREVIEW_STALE`，不改 TTL 或班次时间。                                                                                                                                                        |
| RWS-02 Adopt           | 幂等 receipt replay 保持原优先级；新采用在现有 owner/Trip 事务锁内重读并复核，事务返回前再检查服务器时钟。拒绝时 Trip.version、正式表、receipt、outbox 全部回滚。                                                                                                           |
| RWS-02 并发/历史       | 20 个 Unit、13 个专属 PostgreSQL、4 个外部起点 PostgreSQL 覆盖 lock wait、慢 Provider、提交时钟越界、owner/version 优先级、幂等回放、Undo、历史编辑及非固定 TRANSIT。                                                                                                       |
| RWS-03                 | 非固定聚合 TRANSIT 的候选、Preview、保存详情显示“预计/聚合预计，不代表具体班次”；不改 PLANNED 数据层，不把总耗时当班次。固定与混合端点保留各自证据。                                                                                                                        |
| RWS-04                 | 320/375/390/430px、24px 根字体、长标题与模拟 VisualViewport 键盘，焦点输入可见、保存可达；44px handle、safe-area、drag/cancel/lost capture 与 dirty draft 保护不变。                                                                                                        |
| RWS-05                 | 同版本权威重要 Impact 入口提前到手机首屏，关键时间保留；完整备注/地址仍在既有详情。查看 Today/Impact 零 Query/正式写入。                                                                                                                                                    |
| Google Places          | Google LatLng 仅传 latitude/longitude，不带应用地点字段；SYNTHETIC HTTP 请求契约回归。                                                                                                                                                                                      |
| Google NOW / DEPART_AT | NOW 不发送捕获的 departureTime；明确未来时间保留绝对 instant。无效/过去/违反独立下界的时间在请求前拒绝，不隐式改 NOW。                                                                                                                                                      |
| HTTPS Proxy / Secret   | Doctor 启动保留 Node `--use-env-proxy`；本机 HTTPS CONNECT + 临时测试 CA 证明代理路径，拒绝不受信任 CA。所有诊断使用白名单，无原始 Key/异常/响应输出；真实四个 key 在本轮测试与 build 子进程中 unset。                                                                      |
| Endpoint / 百度 1002   | Google/Baidu 坍缩、倒置、平行道路、超阈值仍 fail closed；snapping provenance 保留。仅确认的百度 TRANSIT HTTP 200/numeric status 1002 分类为 UNSUPPORTED_QUERY/Doctor UNSUPPORTED，其他错误不泛化。                                                                          |
| 正式 Travel chain      | 全量 PostgreSQL 覆盖 Snapshot → Preview → Adopt → Undo、版本、owner、幂等、事务完整性；canonical Tokyo midnight、原无效 fixture 负控、failure hardening、P6C、Place Search、Mini Map 保留。Compose suffix 保留过期固定班次零写入负控和明确搜索后续 SYNTHETIC 班次的正向链。 |

Provider ACTUAL、raw GPS、位置缓存不等于用户登车。仅已提交、未撤销的可靠用户执行事实（或既有确认外部事实）激活实际执行判断；显式地点时区用于日历分类，不用服务器默认时区。历史/纯计划编辑仍可用。`fixedService=false` 的聚合 TRANSIT 不参与固定班次错过判断。

公开 HTTP API、公开 contract、Prisma schema、migration delta 均为 **0 / 0 / 0 / 0**（相对 #55）。内部 planning repository 继承 #57 的既有 `NO_MATCHING_CANDIDATE` 返回分支。Migration 总数 **27**，没有第 28 项。

## 可重复验证

在新建的任务专用 PostgreSQL 17 数据库执行 clean migration deploy，随后顺序执行 persistence 与 API Integration，避免多个独立测试进程共享 reset。所有 HTTP/SDK Provider 样本均为 SYNTHETIC；没有执行 Doctor `--live` 或 Provider probe live。

```sh
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:validate
DATABASE_URL='<task-owned SYNTHETIC PostgreSQL>' pnpm db:migrate:deploy
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
TEST_DATABASE_URL='<task-owned SYNTHETIC PostgreSQL>' pnpm test:integration
pnpm build
pnpm exec tsx scripts/google-transit-browser-validation.ts
WEB_TEST_WEBKIT=true pnpm test:web
```

本地 Unit **1,171 PASS**，92 files；frozen install、Prisma generate/validate、format、lint、typecheck、build 和 clean deploy **27** 已实际通过。正式 Web bundle 检查未发现 server key 变量或 SYNTHETIC secret marker。Google browser lifecycle 验证为 SYNTHETIC，两个时间模式、上下文清理通过，零 live 请求。

本地 Chromium 使用 `/usr/bin/chromium`。本地 WebKit 实际启动已验证；GLES 库来自现有任务环境库，因系统 `ldconfig` 探测不识别额外库路径，本地绕过的仅是 host dependency probe，不跳过浏览器、测试或断言，不改 TLS。完整本地双引擎使用两个 worker；最终 CI 按未修改的仓库配置安装依赖并使用一个 worker。

**最终交付以 Draft PR body 中精确 HEAD 对应的新 CI 和完整数字为准。** verify（含 Unit/PostgreSQL/Chromium/WebKit）、Compose verification、P5B acceptance 都必须 completed/success；来源 PR 的旧 CI 不作为集成证据。该文档不嵌入自身提交 SHA，避免文档提交后引用旧 HEAD。

## Production gates 与仍未解决的风险

`.env.provider.example`、Regional Provider 配置、Japan sidecar 配置、地图配置、infra/CI、公开 contracts、schema/migrations 相对 #55 均无 delta。所有 Production approval gates 保留原值，默认全部 false；Japan Consumer Transit staging/production prohibition 保留。SYNTHETIC 通过不是 production approval。

- **真实 Provider：** #55 的历史低频 live 记录原样保留，本轮未重跑。Google Places 历史 LIVE_CONTRACT_PASS 不等于 F-05/F-06 关闭；Google WALKING/DRIVING 仍在严格 endpoint binding 被阻止，需要另行授权的可信接驳证据设计，不能扩大容差或虚构接驳。百度 Place 非 JSON 响应、各路线服务账号/业务码/未来驾车权限仍待独立调查；未混入 A 的未验证结果。
- **Japan Transit：** 已记录场景 functional/Region acceptance 与 production approval 分层不变。上游历史 503、长期可靠性、real cross-midnight、运营商时刻表/票价真相仍 OPEN/PARTIAL；不重跑 live matrix。
- **地图 SDK：** SYNTHETIC Mini Map 不证明真实 Google/Baidu SDK、浏览器 key 限制或百度官方坐标转换实测完成；既有 PARTIAL/BLOCKED 与 SDK 开关保持不变。
- **F-05/F-06：** entitlement、存储/留存、TTL、删除、归因、quota、pricing、coverage、生产批准以及供应商推送/轮询能力继续 OPEN/PARTIAL。
- **iPhone：** 物理 iPhone / iOS Safari / 实际软键盘 / native navigation handoff 未验证；Linux WebKit、模拟 touch/VisualViewport 不替代真机验收。
- **执行安全：** 没有新增显式 live-vs-history API 意图或持久化 lifecycle。可信服务器时钟同步仍是运营前提；事务返回前检查不能消除有限的真实数据库提交延迟，也不能发现未上报的延误、取消、容量或用户登车事实。
- **其他边界：** 完整 before/after schedule delta、缺 evidence 的更细 blocker reason 等既有 BLOCKED 不因整合解除；通知/后台定位、完整离线与产品全面完成均未声明。

保持 Draft；等待下一轮独立整合复核。
