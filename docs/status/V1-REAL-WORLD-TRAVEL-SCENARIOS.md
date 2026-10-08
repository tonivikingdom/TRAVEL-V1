# V1 Real-World Travel Scenario Acceptance

推荐模型：Sol / High；备选为客户端可用的同级模型。理由：验收跨 Provider 时间参数、正式写入和移动端交互；时序或事务复现有争议时提高推理强度。未声称切换实际模型配置。

## 范围与基线

- 指定并已 fetch 的基线：`feat/real-provider-bootstrap-cloud`，`4a2a5dfc0b2cabf5e1d2750b53043b0ca464bde8`。
- 独立 QA 分支：`qa/v1-travel-scenarios`。不写 #53 原分支，不创建 PR、不合并、不部署。
- 本轮仅增加验收测试、SYNTHETIC 夹具和证据/文档。产品代码、API、Domain、Provider、schema、migration、现有测试断言均未修改。
- 指定基线本身含 **27** 项 migration（包含 `20261008090000_provider_transport_modes`）。本轮 delta **0**；没有回退为旧任务的 26。
- 未来驾车场景冻结应用/Provider/浏览器时钟：`2026-10-08T04:00:00Z`（上海 10 月 8 日 12:00）。目标：上海 **10 月 10 日 18:00** = `2026-10-10T10:00:00Z` = UNIX 秒 `1791626400`。
- 发车后的负向场景单独推进受控时钟至 10 月 10 日 18:05；不是把未来驾车场景改成 NOW。数据库行的创建/更新 bookkeeping 使用 PostgreSQL 实际测试时钟；业务时间、snapshot/preview 有效期、Adopt/Undo 使用注入的时钟。
- 地点、坐标、时长、班次、HTTP 响应、SDK、账户均为 **SYNTHETIC**。Baidu/Google 正式 adapter 仅使用注入的 HTTP fixture；浏览器新夹具阻止所有非本机网络请求。实际 key 未设置，没有真实/付费 Provider 请求，没有购买或启用 API。

## 场景矩阵

PASS 只指指定基线在 SYNTHETIC 输入下的实测行为。FAIL 回归保持启用，不 skip、不改期望、不用真实数据兜底。

| 场景/检查                                                | 结果    | 证据/说明                                                                                                                              |
| -------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 未来驾车：时区正确的绝对时间                             | PASS    | Web `datetime-local=2026-10-10T18:00` → `hint.instant=2026-10-10T10:00:00.000Z`；真实 adapter fixture 请求带 UNIX 秒 `1791626400`      |
| 不采用 10 月 8 日当前路况，不静默转 NOW                  | PASS    | 区域 composition 与 Baidu/Google adapter 捕获请求；拒绝预测后仅一次请求，无当前路况重试                                                |
| 缺失高级权限、基础 entitlement、未启用、unsupported 时间 | PASS    | 显式 UNSUPPORTED/UNAVAILABLE；缺 gate、ARRIVE_BY、过去时间、超 7 天均零 HTTP 请求                                                      |
| 18:00 打车/驾车的正式普通 Web 搜索路径                   | FAIL    | RWS-01：请求遗漏 `travelMode`，区域 Provider 无法选择正确能力；不能称为端到端可用                                                      |
| 不编打车等待、票价或固定班次                             | PASS    | fixture 中额外等待字段被丢弃；`fare=null`、`fixedService=false`、`serviceLabel=null`；驾驶时长只是道路行程估算，不是叫车保障           |
| 到达与下一地点衔接                                       | PASS    | 显式 DRIVING API：18:00 出发、18:30 到站；保留最晚 18:45 要求、站点 19:30 出发；两地点各停留 60 分钟                                   |
| 同城公共交通聚合数据不编班次、站台、线路/转乘            | PASS    | 实际 Baidu adapter fixture 只产生一个 `TRANSIT` 聚合 leg；snapshot/preview/adopt 不补 BUS/RAIL 或假换乘点                              |
| 聚合公交候选的估算说明                                   | FAIL    | RWS-03：候选仅显示 `18:00 → 18:30 / 公共交通 · 30 分钟`，未标预计/估算，容易被理解为准确班次                                           |
| 明确结构化 bus → walk → metro 转乘                       | PASS    | 仅用明确 SYNTHETIC BUS/WALKING/RAIL legs；采用后内部 WALKING 保留 provenance，不重复创建交通边/计算时长                                |
| 起点要求 18:00 前不能离开：17:55 候选                    | PASS    | API 拒绝且零 snapshot；Web 禁用候选，零 Preview/正式写入                                                                               |
| 当前已 18:05，仍在前一地点：18:00 固定班次               | FAIL    | RWS-02：有 MANUAL_ARRIVAL/AT_NODE、无离开记录，Query 仍 HTTP 200；预览未过期时 Adopt 仍 HTTP 200 并正式写入                            |
| 每地点到达、出发、停留及 Query/Preview/Adopt/Undo        | PASS    | 显式正确 mode API 的完整 PostgreSQL 生命周期；Query 仅 snapshot，Preview 仅 preview，Adopt/Undo 各 +1 版本，Undo 恢复实质行程/时间     |
| 时间冲突、版本、owner、幂等保护                          | PASS    | 矛盾窗口在 Provider 前阻止；旧 Query/Preview basis 拒绝；USER/ADMIN 越权 404；同 key 重放零重复写入；原有 failure/concurrency 回归保留 |
| 只读 Trip/schedule/backup 不修改 Trip                    | PASS    | RepeatableRead 对比完整行内容，正式表/版本零变化；不把 Query snapshot 和 Preview 自身的存储称为“全库零写”                              |
| Today/Next 结构、只读行为                                | PASS    | 一个 next-step，无全量 timeline/自动 planning，零正式写入；不把 DOM 可见等同首屏可发现                                                 |
| Today/Next 首屏简洁、重要异常可发现                      | FAIL    | RWS-05：长地址/备注占据卡片，390×844 首屏只有部分 next-step；“查看影响”下沿超过 1500px                                                 |
| sheet 内部滚动、handle 短拖回弹/长拖关闭、草稿保护       | PASS    | 新 wheel/handle 与现有 capture、touch、map pan/pinch、草稿回归共同验证；不将 mouse/pointer 自动化称为真实手指验收                      |
| 地图加载/能力失败保持局部降级                            | PASS    | 地点时间与备注控件仍可用，关闭后路线搜索可达；既有 SDK failure/gesture suites 同时回归                                                 |
| 320/375/390/430px 长文、大字无横向溢出                   | PASS    | 实际根字体 24px，页面和 dialog 的 scrollWidth 检查；safe-area CSS 保留                                                                 |
| 375/390/430px 键盘模拟、保存可达、收起恢复               | PASS    | VisualViewport height=380/offsetTop=20；焦点控件可见、保存可滚动到、布局恢复、dirty guard 不丢备注                                     |
| 320px＋24px 根字体＋键盘模拟                             | FAIL    | RWS-04：sheet 能适配键盘，但长标题 sticky header 留给内容的空间不足，焦点 textarea 下沿越出可见 viewport                               |
| 真实 Provider 路况、叫车等待、真实线路/班次/平台         | BLOCKED | 本任务明确禁止真实 key/付费请求；SYNTHETIC 结果不能证明真实账户能力、交通预测质量或实际坐标精度                                        |
| physical iPhone Safari、真实软键盘/手势/native handoff   | BLOCKED | 实际运行的是 Linux 自动化 Chromium/WebKit；没有物理 iPhone，不能冒充 iOS Safari 验收                                                   |

## FAIL 复现与最小修复建议

### RWS-02：已发车固定班次仍能正式采用（优先处理）

1. SYNTHETIC Trip 10 月 10 日，前一地点 17:00 到达、18:00 不早于出发；下一地点最晚 18:45 到达。
2. 17:59 通过正式 `MANUAL_ARRIVAL` API 确认仍在前一地点；读取 `/in-trip` 为 `AT_NODE`，没有 DEPARTURE。
3. SYNTHETIC 固定 BUS 18:00 → 18:30，validUntil 未提供；Query 和 Preview 在 17:59 创建，Preview 18:09 到期。
4. 时钟推进至 18:05，版本仍一致。Adopt **HTTP 200**，Trip **10 → 11**，新建 **TransportEdge=1、AdoptedRoute=1、OperationReceipt=1、OutboxEvent=1、TemporalValue +2**；执行记录仍只有 arrival。
5. 独立负控：18:05 才 Query 同一 18:00 班次，也 **HTTP 200**，生成 snapshot；未触发正式写入。

证据：[Query footprint](assets/v1-travel-scenarios/postgres/already-departed-query.json)、[Adopt footprint](assets/v1-travel-scenarios/postgres/already-departed-adopt.json)、[Web 候选](assets/v1-travel-scenarios/chromium/already-departed-now-enabled.png)。两个 PostgreSQL 失败回归保持 active。

最小建议：在旅行执行状态/可靠未离开起点的上下文中，将可信当前 instant 纳入固定班次的可出发下界；Query/Preview 复核，Adopt 在已有 owner/Trip 事务锁内再次复核提交时刻。不要只缩短 TTL 或只禁用 Web 按钮，也不要改写原班次为 NOW、覆盖事实、取消版本/幂等。历史行程编辑与“此刻可乘坐方案”需维持语义区别，不能把所有过去日期编辑一律禁止。涉及正式时间规则，需另行授权修复，本轮未改。

### RWS-01：普通路线搜索遗漏 mode

1. 从已选 DRIVING（或聚合 TRANSIT）交通详情打开“搜索路线”。日期/时区为 10 月 10 日 18:00 / Asia/Shanghai。
2. 请求只有 `basisVersion/fromNodeId/toNodeId/hint`，**没有 `travelMode`**。
3. 正式 API 把 undefined 传给 adapter，显式 `ROUTE_QUERY_UNSUPPORTED`/422，零 Provider HTTP、零正式写入。浏览器严格 fixture 使用同一拒绝条件。旧宽松 UI fixture 可以返回候选，因此原浏览器测试通过不代表实际区域链路可用。

证据：[DRIVING 请求](assets/v1-travel-scenarios/chromium/missing-mode-driving.json)、[TRANSIT 请求](assets/v1-travel-scenarios/chromium/missing-mode-transit.json)、[错误 UI](assets/v1-travel-scenarios/chromium/missing-mode-driving.png)。

最小建议：在既有请求中传递明确、受支持的交通查询意图，复用现有 contract；已有 DRIVING 选择不应丢失。无法可靠确定 mode 时明确说明局部不可查询，不默认为 walking/driving，不以地名/语言猜测，也不在本 QA 扩建 mode UI/入口。定位：`apps/web/src/main.ts` 的 `route-search` 提交与 `packages/providers/src/regional-router.ts` 的必需 mode 检查。

### RWS-03：聚合时间缺少估算标签

实际 Baidu adapter fixture 仅给 duration=1800 秒、同城可靠端点；归一化为非固定 `TRANSIT`。Web 候选却没有预计/估算说明。[候选及归一化数据](assets/v1-travel-scenarios/chromium/aggregate-transit-clock.json)、[截图](assets/v1-travel-scenarios/chromium/aggregate-transit-clock.png)。未发现伪造 serviceLabel/platform，问题是时间展示语义。

最小建议：在现有候选/Preview/已保存交通的时间展示中明确非固定聚合路线为“预计/估算；不代表具体班次”。保留 fixedService 和未知字段；不凭聚合耗时补发车时刻、站台或转乘详情。定位：`main.ts` 的 `showCandidates()` 与非固定 leg 时间展示。

### RWS-04：320px 大字键盘下焦点框被遮挡

320×844、根字体 24px、长地点名；打开地点详情，输入备注、聚焦，然后模拟 VisualViewport height=380/offsetTop=20。详情 panel 底部已适配到 400 附近，但 textarea 下沿超出。375/390/430 的同一断言通过。

证据：[Chromium 几何](assets/v1-travel-scenarios/chromium/mobile-320-keyboard-before-visibility-check.json)、[Chromium 截图](assets/v1-travel-scenarios/chromium/mobile-320-keyboard-before-visibility-check.png)、[WebKit 几何](assets/v1-travel-scenarios/webkit/mobile-320-keyboard-before-visibility-check.json)。这是键盘**模拟**，不是实际 iPhone 键盘结果。

最小建议：让键盘下的 sticky header/长标题保留足够的可滚动内容空间，必要时把标题正文纳入内容滚动；保持 44px handle/close、原 discard guard 和字号。依据实际 VisualViewport 与 scroll padding 复核焦点可视区域，不能用减小字体、加高 z-index 或只用 100vh 掩盖问题。定位：`drawer.ts` 的 `fitViewport()` 与 `styles.css` 的 `.sheet-head`/dialog scroll padding。

### RWS-05：长内容把重要异常推到 Today/Next 首屏外

390×844、普通字号、10 月 10 日 17:50；SYNTHETIC 前一地点包含长地址和用户备注，Impact 明确返回 VIOLATED 交通衔接冲突。进入“今天 / 下一步”，不预先滚动。“查看影响”虽然在 DOM 中可见，Chromium 实测 top=1515.47、bottom=1559.47；WebKit top=1486.5、bottom=1530.5，均超出 844px 首屏；Next card 本身也只显示了一部分。两浏览器保留独立的首屏位置回归，不能用 `toBeVisible()` 代替 viewport 断言。

证据：[首屏截图](assets/v1-travel-scenarios/chromium/today-next-exception.png)、[控件位置](assets/v1-travel-scenarios/chromium/today-next-exception.json)、[WebKit 对照](assets/v1-travel-scenarios/webkit/today-next-exception.json)。

最小建议：在现有 Today/Next 布局中，让重要冲突提示和现有“查看影响”控件先于长地址/完整备注；首屏保留下一步名称与关键时间，完整文本继续通过现有详情呈现。不得删除用户备注、缩小字体或新增导航入口。定位：`main.ts` 的 Today/Next card 内容顺序。

## 测试与证据

新增：Provider Unit **10**、真实 PostgreSQL API **11**、浏览器 **14/engine**；复用已有 acceptance footprint/gesture helpers，未改其断言。

| 验证                                     | 结果                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Frozen install、Prisma generate/validate | PASS                                                                                              |
| lint、typecheck、build                   | PASS                                                                                              |
| 全量 Unit                                | **1071 PASS**                                                                                     |
| 全量 PostgreSQL                          | **692 PASS / 2 FAIL**；原有 683 全通过，新增 9 PASS / 2 FAIL（RWS-02）                            |
| Chromium / WebKit                        | 原有 **327/engine 全通过**；最终新增 **8 PASS / 6 FAIL / engine**，零 skip/flaky；失败保持 active |
| 格式 / diff check                        | PASS                                                                                              |
| Compose / P5B / 远程 CI                  | 本任务未要求启动；没有 PR，既有 workflow 只在 main push/PR 触发，不借用旧 CI 冒充本 QA 验收       |

浏览器全量先运行 680 项：670 PASS / 10 FAIL（每 engine 原有 327 PASS，加新增 8 PASS / 5 FAIL）。实际看图后新增独立首屏回归，并修正夹具的受控当前时刻/有效期一致性；最终定点重跑 28 项：16 PASS / 12 FAIL（每 engine 8 PASS / 6 FAIL）。两次结果合计每 engine **341 个唯一用例：335 PASS / 6 FAIL**；不描述为一次最终全量运行。生产代码与原有浏览器用例在两次运行之间均未修改。FAIL 来自 5 个产品问题（DRIVING/TRANSIT 缺 mode 各占一个浏览器失败），不是跳过或弱化断言后的绿灯。

复现命令（从仓库根目录；TEST_DATABASE_URL 必须指向新建隔离 SYNTHETIC PostgreSQL，27 项 migration 已 deploy；不使用未知/生产 DB）：

```sh
pnpm exec vitest run packages/providers/test/v1-travel-scenarios.test.ts
pnpm --filter @travel/api exec vitest run --config vitest.integration.config.ts test/v1-travel-scenarios.integration.test.ts
WEB_TEST_WEBKIT=true pnpm test:web v1-travel-scenarios.browser.ts
```

完整回归运行 `pnpm test`、`pnpm test:integration`、`WEB_TEST_WEBKIT=true pnpm test:web`。本机 Chromium 使用 `/usr/bin/chromium`；WebKit 为实际 Playwright WebKit 2248，额外动态库通过 task 环境提供；跳过的是 host dependency probe，实际浏览器启动/页面断言没有跳过。软键盘以 VisualViewport 属性/resize 模拟；内容滚动用 wheel，drawer 用 pointer/mouse，现有地图 pan/pinch 使用测试事件，均不等同于真实设备触控。

证据目录：[SYNTHETIC assets](assets/v1-travel-scenarios/)。[远程复核 contact sheet](assets/v1-travel-scenarios/review-contact-sheet.jpg)；[机器可读结果](assets/v1-travel-scenarios/test-results.json)。截图按当前浏览器 viewport 捕获，不把 dialog 背后的整页长图冒充实际首屏。contact sheet 由实际打开检查的截图生成，RGB JPEG、1600×2910px、635,229 bytes、quality 88，保留比例与 SYNTHETIC 标记。日志在本机 `/workspace/scratch/qa-v1-travel-scenarios/`，关键结果另附脱敏汇总；没有会话/真实凭据入库证据或 Git artifact。

最终停止点：QA 发现仍未修复的失败；不宣称 V1 真实旅行全面可用。本轮不扩大 UI、不改 #53/G、不创建 PR、不合并、不部署，等待人工复核和独立修复授权。
