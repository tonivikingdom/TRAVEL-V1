# P5A Debug Web 薄测试台

- 当前状态：已通过 PR #16 Squash Merge，P5A completed
- 正式基线 main：`cbf9fe2a727011e4708585ef259c3324c05b4362`
- 基线 main CI：Run `35435976817`，`verify` 与 `Compose verification` 均为 success
- 推荐模型 / 强度：GPT-5.6 Sol / High；备选 GPT-5.6 Terra / High
- 实际使用模型与强度：未知（客户端实际配置无法从仓库证据确认）

## 定位

`apps/debug-web` 是 Development/Test 人工验收工具，不是正式产品界面，也不决定未来 Desktop 或
Mobile 客户端技术栈。它使用 Vite、Vanilla TypeScript、原生 HTML/CSS 与 `@travel/contracts`，
通过开发期 `/api` proxy 连接 Fastify API，不要求 API 开启宽泛 CORS。

## 可操作能力

- Magic Link landing、sessionStorage bearer Session、`/me` 与 logout。
- Trip 列表/创建、DayOccurrence sequence 时间轴、重复 localDate 独立日期卡。
- Place Visit、FreeAction、MOVE/DELETE/REPLACE、Manual Transport 与 Transport History。
- PLANNED / ESTIMATED / ACTUAL 测试事实输入，UserTimeIntent、MIN_DWELL、lock/remove。
- Schedule Projection 的窗口、依据、violations 与 conflicts。
- Route Query、Candidate、Preview、Adopt、OperationReceipt 与单步 Undo。
- Notification 分页与 dismiss。

## 可靠性与安全边界

- Magic Link token 只从 URL fragment 读取并立即清除；不写 localStorage、日志或页面。
- sessionStorage 只保存 credential、当前 Trip ID、最近 Adopt/Undo receipt；不缓存整份 Trip。
- 核心 API/DB 不可用时隐藏旧 Trip、禁用正式操作；恢复后重新执行 ready、me 和 Trip 同步。
- `VERSION_CONFLICT` 不自动覆盖或重试，同时清除基于旧版本的 Candidate/Preview。
- Provider unavailable 只降级 Route Query，不影响已有 Trip。SYNTHETIC candidate/route 使用常驻醒目标识。
- Debug Web 不提供 auth 绕过、admin token、offline queue、Service Worker、IndexedDB 或 background sync。

## 明确未实现

RecommendationPolicy、自动最佳方案、实时风险监控、quiet-assist 状态机、snooze、Push、后台定位、
真实 Route Provider、正式 Desktop/Mobile 客户端与 Production 部署均未实现或未授权。
