# V1 Travel Web Acceptance Fixes

推荐模型：Sol / High；备选为客户端可用的同级模型。跨查询意图、时间证据和移动端滚动；若时间语义或异步回归出现争议，提高推理强度。未声称切换实际运行模型。

## 基线与范围

- 仓库：`tonivikingdom/TRAVEL-V1`。
- 精确起点：`fix/pr53-review-findings` / `9d32c0b23198d35b6f2873d7d9016365f934d635`，开工前 fetch 并核对。
- 新分支：`fix/v1-travel-web-acceptance`；Draft PR base 为 `fix/pr53-review-findings`。
- QA 来源：`qa/v1-travel-scenarios` / `67c7fdc5fc2b5d89f58f7fc8532529af6bbf59cb`。仅取浏览器夹具及本批相关回归，没有 merge/cherry-pick 整个 QA commit，没有引入其 PostgreSQL/Provider 测试或 RWS-02 失败断言。
- 正式修改只在 `apps/web/src`。不修改 #53/#54、B 源分支、执行/Adopt Domain、Provider 实现、Region policy、API/contract、Prisma 或部署配置。
- 指定基线已有 **27** 项 migration，包含 `20261008090000_provider_transport_modes`。本批 migration delta **0**；不是旧阶段的 26。
- 所有地点、坐标、时间、Provider 响应、账户与截图均为 **SYNTHETIC**。实际 browser/server key 未设置；新浏览器夹具阻止所有非本机网络请求。没有真实/付费 Provider 请求，没有启用 key 或 billing。

## 修复矩阵

移植回归先在精确基线上执行：Chromium、WebKit 各 **8 PASS / 5 FAIL**，零 skip/flaky。5 个失败对应 RWS-01 的 DRIVING/TRANSIT 两例及 RWS-03/04/05。原失败断言继续保留，没有缩小字体或弱化 viewport 期望。

| 问题            | 修改前                                                                          | 修改后与保护                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RWS-01          | 普通搜索遗漏 `travelMode`，严格区域 Provider 拒绝                               | 从有效已选交通继承明确查询意图；DRIVING/TAXI → DRIVING，WALKING、CYCLING、TRANSIT 保留；明确公共交通分段及步行转乘 → TRANSIT。不存在 Region 判断或 Provider 默认方式                                                                                  |
| RWS-01 未知方式 | 无明确意图却仍请求                                                              | 未选交通、OTHER、FLIGHT、不兼容混合或非 ACTIVE 连接不猜 mode；现有搜索表单显示说明及一个无默认值的原生选择框。未经明确选择零 Query，绕过 HTML validation 仍 fail closed。修改查询方式沿用 epoch 失效保护，晚到响应不展示                              |
| RWS-03          | 非固定 TRANSIT 聚合候选显示精确钟点而无预计标识                                 | 候选、Preview、保存分段显示简短“预计”；聚合详情说明“不代表具体班次”。固定 BUS/RAIL 等仍使用保存的计划标签；混合方案按各端点/分段判定，不把固定端点整体误标预计                                                                                        |
| RWS-04          | 320px / 根字体 24px / VisualViewport 380 高、offsetTop=20，焦点框下沿超出 panel | 当 sticky 长标题与焦点控件无法同处可见空间时，让原 header 随内容滚动，并复用 scrollIntoView。没有更换 scroll container、缩小字号、提高固定 z-index 或裁掉标题。键盘收起后恢复原 header 行为；44px handle、safe-area、drag/close 与 discard guard 保留 |
| RWS-05          | 长地址/完整备注把异常入口推到 844px 首屏外（Chromium bottom≈1559，WebKit≈1530） | Now/progress、Next 名称与关键时间继续展示；权威冲突/变化的既有“查看影响”卡提前并简化。完整地址与备注留在已有地点详情，未从 Trip 删除。普通影响仍在 Next 后，不新增入口或导航                                                                          |

`route-query-mode.ts` 只把已选交通类型表达为已有 Query contract 中的四种明确意图；交通方案本身不改变。TAXI 的 DRIVING 查询只找道路行程，不生成叫车、等车或费用承诺。选择查询方式只修改本地搜索输入；Query 不等于 Adopt。

“预计”是时间展示限定语，不把原 PLANNED 层改为 ESTIMATED，也不改 Provider instant、fixedService、serviceLabel、platform 或任何原始证据。来源/layer/已有实际车辆记录的原有区别保留。没有班次/站台信息就继续未知。

Today/Next 的异常等级仍由同版本权威 Impact 决定；没有在 Web 用当前时间重新实现冲突规则。完整原因仍在现有 Impact detail，查看影响和详情零 Query/Adopt/Trip 写入。

## 回归与验证

- 新浏览器验收 **24 / engine**：保留移植的失败断言，新增未知 mode 的原生/程序化 fail-closed、TAXI 意图、晚到 mode 响应、非固定/固定候选＋Preview＋保存详情、四宽度首屏关键时间与完整备注保留。
- 新 Unit **14**：意图继承/歧义、固定与聚合标签、混合方案端点及证据不可变。
- 既有 missing-connection 浏览器测试现在显式选择其 SYNTHETIC WALKING 查询意图。只补用户动作，不替换正式 Trip fixture 为已采用交通，也不删除/弱化原 failure、owner、version、draft、idempotency 断言。

| 检查                                                     | 结果                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Frozen install                                           | PASS                                                                                                                    |
| Prisma generate / validate；隔离 PostgreSQL clean deploy | PASS；27 migrations                                                                                                     |
| Format / lint / typecheck / build                        | PASS                                                                                                                    |
| 全量 Unit                                                | **1096 PASS**                                                                                                           |
| 全量真实 PostgreSQL                                      | **687 PASS**（106 persistence + 581 API）                                                                               |
| 初次定点 Chromium / WebKit                               | **24 / 24 PASS**，零 skip/flaky                                                                                         |
| 最终全量 Chromium / WebKit                               | **351 / 351 PASS**（合计 702），零 fail/skip/flaky                                                                      |
| Draft PR exact-HEAD CI                                   | 交付时核对 verify / Compose verification / P5B acceptance；最终状态与链接在 PR 和最终交付报告，不能借用 #53/#54 的旧 CI |

数据库为本任务新建、仅绑定本机端口的 PostgreSQL 17 SYNTHETIC 容器；没有使用未知/生产数据库。API/contract/schema/migration delta = **0 / 0 / 0 / 0**。

复现命令：

```sh
pnpm install --frozen-lockfile
pnpm prisma:validate
pnpm lint
pnpm typecheck
pnpm test
TEST_DATABASE_URL='<isolated SYNTHETIC PostgreSQL URL>' pnpm test:integration
pnpm build
WEB_TEST_WEBKIT=true pnpm test:web travel-web-acceptance.browser.ts
WEB_TEST_WEBKIT=true pnpm test:web
```

本机 Chromium 使用 `/usr/bin/chromium`；WebKit 为实际 Playwright WebKit 2248，并提供缺少的动态库。跳过的是 Linux host dependency probe，未跳过实际 WebKit 启动/断言。VisualViewport 键盘、pointer/touch/pinch 模拟不是物理 iPhone。

## 视觉证据

目录：[SYNTHETIC assets](assets/v1-travel-web-acceptance/)。`before` 来自精确基线，`after` 来自修复后源码；均为实际 viewport 截图，保持比例，不裁掉 UI。新证据不覆盖历史阶段的截图。

- [修改前后 JPEG contact sheet](assets/v1-travel-web-acceptance/review-contact-sheet.jpg)
- [320/375/390/430px 大字键盘对照](assets/v1-travel-web-acceptance/mobile-widths-contact-sheet.jpg)
- [机器可读测试结果](assets/v1-travel-web-acceptance/test-results.json)
- 各 engine 的四宽度 Today 首屏、键盘聚焦/保存可达/dirty guard、未知 mode、聚合与固定 Preview/保存详情均在 `after` 下。

截图与 contact sheets 均实际打开检查。JPEG 为 RGB，宽 1600px，quality 88；不将 SYNTHETIC 地图或交通当作真实 Provider 验收。

## 未解决风险与停止点

- **RWS-02 OPEN / B owned**：已发车固定班次仍可被 Query/Adopt 的服务端问题不在本批；未修改执行/Adopt Domain，未以 UI 修复冒充服务端解决。原 QA 分支的两个 PostgreSQL 失败回归未改。
- 真实 Provider/account entitlement、未来路况预测质量、公交/地铁准确班次及站台均未实测；本批只使用 SYNTHETIC HTTP/SDK fixtures。
- Physical iPhone / iOS Safari / actual soft keyboard / native handoff **UNVERIFIED**，Linux WebKit 不代表通过。
- Google/Baidu real SDK、Baidu 反向坐标转换、Japan Transit 等既有 PARTIAL/BLOCKED 未因本批关闭。
- 保持 Draft；不 Ready、不合并、不部署、不启用真实 key，不扩大首页或开始下一批。
