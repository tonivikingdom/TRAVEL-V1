# ARRIVE_BY Discovery Report

> Discovery only. 本报告不实现 `ARRIVE_BY`，不改变现有 `DEPART_AT` 行为，也没有执行新的 Google live 请求。证据仅来自 2026-09-20 工作树中的源码、测试、服务文档和既有脱敏 summary。本文不包含 token、Cookie、Authorization header、Chrome profile、完整 private response、完整 `pb` payload 或 debug capture。

## 1. Executive Summary

- 当前对外支持只有 `DEPART_AT`。`ARRIVE_BY`、`NOW`、`LAST_TRANSIT` 均会返回 HTTP 422 `UNSUPPORTED_MODE`，不会静默降级。
- `TransitTimeMode` 类型和请求体校验已经接受 `ARRIVE_BY`；direct search 的实际 feature gate 位于 `SearchCoordinator.search()`，不是 HTTP handler 或 domain validation。
- reverse import 的 URL parser 已把 `!6e1` 映射成 `ARRIVE_BY`，但这只是代码中的解析线索：仓库没有 ARRIVE_BY URL fixture、单测或 live evidence。随后 `GoogleTransitClient.importSelectedUrl()` 仍拒绝它，并把成功 import 的结果模式硬编码为 `DEPART_AT`。
- direct builder 只会构造已验证的 `DEPART_AT` 状态。它把 resolved transit URL 中的固定片段替换为含 `!6e0!7e2!8j<wall-clock>!3e3` 的状态；没有独立的 `pb`/private request builder，`/maps/preview/directions` 请求由 Google Maps 页面自身产生。
- parser 没有 `timeMode` 参数，核心 positional offsets 表面上可复用；但没有 ARRIVE_BY response 样本，无法证明 response root、route/time offsets 与关系索引不变。
- search sentinel 与 response selector 明确耦合 `DEPART_AT`：要求 `!6e0` 页面状态，且最早候选的本地出发 wall-clock 必须 `>= requested`。因此不能把 ARRIVE_BY 简化为只添加一个 marker。
- 缓存 key 已包含起点、终点、日期、时间、`timeMode` 和时区；`DEPART_AT 10:00` 与 `ARRIVE_BY 10:00` 不会碰撞。
- 推荐结论：**CASE B+C**。B 已由源码直接证明；C 来自关键私有编码和 response schema 缺少 ARRIVE_BY 实证。实施前只需最小、脱敏的结构差异证据，不需要任何账号、Cookie、header、完整 payload 或完整 response。

审计时 Git 状态：repository root 当前在 `feature/p5d2-flight-facts`，HEAD `63c9317aa886aee6d9eb10c2608750bac42ec526`；工作树已有大量与本任务无关的修改，Transit sidecar 也仍是未跟踪目录。本任务不切分支、不暂存、不 commit、不 push。

## 2. Repository Map

### 基本位置

| 项目                               | 位置 / symbol                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Repository root                    | `D:/TRAVEL-V1/旅途计划_首轮开发要求_v1.0_产品基线v0.6_完整包/旅途计划_首轮开发要求_v1.0_产品基线v0.6`                         |
| Workspace declaration              | `pnpm-workspace.yaml`：`apps/*`、`packages/*`、`services/*`                                                                   |
| Root package                       | `package.json`，package name `travel-v1`                                                                                      |
| Sidecar                            | `services/google-consumer-transit/`                                                                                           |
| Sidecar package                    | `@travel/google-consumer-transit`，见 `services/google-consumer-transit/package.json`                                         |
| Library entrypoint                 | `services/google-consumer-transit/src/index.ts`                                                                               |
| HTTP process entry                 | `services/google-consumer-transit/src/server/index.ts`                                                                        |
| HTTP routes                        | `services/google-consumer-transit/src/server/routes.ts:43`，`buildServer()`                                                   |
| Browser/Chromium                   | `src/browser/browser-manager.ts:9`，`BrowserManager`; `src/browser/google-page.ts:39`，`captureDirectSearch()`                |
| Query builder / URL import parser  | `src/google/url-builder.ts`                                                                                                   |
| Capture, selection, result adapter | `src/google/directions-capture.ts:274`，`GoogleTransitClient`                                                                 |
| Response parser                    | `src/google/response-parser.ts:217`，`parseDirectionsResponse()`                                                              |
| Schema Sentinel                    | `src/google/schema-sentinel.ts:67` / `:204`                                                                                   |
| Domain query / cache key           | `src/domain/transit-query.ts:72` / `:124`                                                                                     |
| Tests / fixtures                   | `tests/parser.test.ts`、`tests/server.test.ts`、`tests/fixtures.ts`                                                           |
| Live harness                       | `scripts/live-validation.ts`                                                                                                  |
| Existing live evidence             | gitignored `artifacts/live-validation-summary.json`；本审计只读取了选择后的脱敏字段                                           |
| Reverse import                     | route `src/server/routes.ts:96`; URL parsing `src/google/url-builder.ts:70`; execution `src/google/directions-capture.ts:381` |

### Transit 相关目录树

```text
package.json
pnpm-workspace.yaml
services/
└── google-consumer-transit/
    ├── package.json
    ├── README.md
    ├── INTEGRATION_STATUS.md
    ├── scripts/
    │   ├── generate-token.ts
    │   └── live-validation.ts
    ├── src/
    │   ├── index.ts
    │   ├── api/
    │   │   ├── health.ts
    │   │   └── search.ts
    │   ├── browser/
    │   │   ├── browser-manager.ts
    │   │   └── google-page.ts
    │   ├── domain/
    │   │   ├── transit-errors.ts
    │   │   ├── transit-query.ts
    │   │   └── transit-result.ts
    │   ├── google/
    │   │   ├── directions-capture.ts
    │   │   ├── response-parser.ts
    │   │   ├── schema-sentinel.ts
    │   │   └── url-builder.ts
    │   └── server/
    │       ├── auth.ts
    │       ├── index.ts
    │       ├── routes.ts
    │       └── runtime-config.ts
    └── tests/
        ├── fixtures.ts
        ├── parser.test.ts
        └── server.test.ts
docs/status/
├── ARRIVE_BY_DISCOVERY_REPORT.md
└── ARRIVE_BY_DISCOVERY_SUMMARY.json
```

## 3. TimeMode Handling

| 文件 / symbol                                                  | 处理内容                                                           | ARRIVE_BY 含义                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `src/domain/transit-query.ts:9`，`TransitTimeMode`             | union 包含 `DEPART_AT                                              | ARRIVE_BY                                          | NOW | LAST_TRANSIT` | 类型层已接受 |
| `src/domain/transit-query.ts:72`，`parseTransitQuery()`        | `:106` 的 allow-list 接受上述四值；其他值为 400 `VALIDATION_ERROR` | domain validation 不拒绝 ARRIVE_BY                 |
| `src/server/routes.ts:65`，search handler                      | auth → `parseTransitQuery()` → `coordinator.search()`              | handler 无 mode-specific reject                    |
| `src/api/search.ts:25`，`SearchCoordinator.search()`           | `:31` 要求 `query.timeMode === 'DEPART_AT'`                        | direct search 的精确拒绝层；422 `UNSUPPORTED_MODE` |
| `src/api/health.ts:13`，`health()`                             | 只宣告 `supportedTimeModes: ['DEPART_AT']`                         | feature capability 未开放                          |
| `src/google/url-builder.ts:26`，`applyDepartAtState()`         | 只构造 DEPART_AT URL state                                         | ARRIVE_BY builder 未实现                           |
| `src/google/url-builder.ts:70`，`parseSelectedGoogleMapsUrl()` | `:85-87` 静态映射 `!6e0/1/2` 为 DEPART_AT/ARRIVE_BY/LAST_TRANSIT   | 存在未实证的 ARRIVE_BY reverse-parse 线索          |
| `src/google/directions-capture.ts:381`，`importSelectedUrl()`  | `:399` 只接受 parsed `DEPART_AT`                                   | reverse import 的第二个精确拒绝层；422             |
| `src/google/directions-capture.ts:478`                         | import 成功后构造的 `TransitQuery.timeMode` 固定为 `DEPART_AT`     | ARRIVE_BY import 结果语义未实现                    |
| `src/google/schema-sentinel.ts:67`，`runSearchSentinel()`      | page URL 与 itinerary 时序按 DEPART_AT 校验                        | verification 明确耦合                              |
| `tests/server.test.ts:130`                                     | 参数化验证 ARRIVE_BY/NOW/LAST_TRANSIT 全部 422，且 client 未调用   | 唯一 ARRIVE_BY 行为测试是“应拒绝”                  |

精确回答：

1. ARRIVE_BY direct search 在 `SearchCoordinator.search()` 被拒绝；reverse import 在 `GoogleTransitClient.importSelectedUrl()` 被拒绝。
2. HTTP handler 本身不拒绝，只传播下层 `TransitError`。
3. domain validation 不拒绝；它把 ARRIVE_BY 视为合法枚举值。
4. Google query builder 没有 ARRIVE_BY 构造路径，只有 `applyDepartAtState()`。
5. browser capture 没有通用 time-mode builder；search sentinel/selector 明确写死 DEPART_AT。parser 本身不禁用；import client 明确禁用。
6. 是，存在部分支持：类型/schema 接受，reverse URL parser 认识 `!6e1`；但 direct builder、verification、feature gate 和 import result 都未完成。

## 4. Search Call Chain

`POST /v1/transit/search` 的逐步调用链如下：

1. `src/server/routes.ts:65` — Fastify route；`authorize()` 后调用 `parseTransitQuery()`。
2. `src/domain/transit-query.ts:72` — `parseTransitQuery()` 验证地点、真实日期、`HH:mm`、IANA timezone、四值 `timeMode`。
3. `src/api/search.ts:25` — `SearchCoordinator.search()` 检查 provider、DEPART_AT gate、cache，再通过 `exclusive()` 强制单并发。
4. `src/google/directions-capture.ts:280` — `GoogleTransitClient.search()` 通过 `encodeGoogleWallClock()` 得到无宿主机时区偏移的 wall-clock 数字。
5. `src/browser/browser-manager.ts:24` — `BrowserManager.runWithPage()` 复用 service-owned Chrome，按 query timezone 创建全新 BrowserContext 和 Page。
6. `src/browser/google-page.ts:39` — `captureDirectSearch()` 导航到 `buildSeedDirectionsUrl()` 生成的公开 `/maps/dir/?api=1&origin=...&destination=...&travelmode=transit`。
7. `src/browser/google-page.ts:50` — 等待 Google 把页面解析为包含 `/@`、`/data=`、`!3e3` 的 transit directions URL。
8. `src/google/url-builder.ts:26` — `applyDepartAtState()` 将 resolved URL 的固定 transit state 替换为 DEPART_AT state。
9. `src/browser/google-page.ts:66-82` — 在 target navigation 前注册 `/maps/preview/directions` 200 response listener；等待至少一个 response，再额外收集 1.2 秒内的全部匹配 body。
10. `src/google/directions-capture.ts:168` — `selectMatchingSearchResponse()` 逐个尝试 captured response，而非相信第一个。
11. `src/google/response-parser.ts:217` — `parseDirectionsResponse()` 去 XSSI prefix、解析 positional arrays，生成 `ParsedDirections`。
12. `src/google/schema-sentinel.ts:67` — `runSearchSentinel()` 同时做 schema guards、起终点匹配、DEPART_AT 页面状态、行程时间语义和 rendered marker cross-check。
13. `src/google/directions-capture.ts:168` — 第一个完整 PASS 的 parsed response 被选中；全部 parsed-but-mismatched 为 `REQUEST_MISMATCH`，全部无法解析为 `SCHEMA_CHANGED`。
14. `src/google/directions-capture.ts:321` — 对已选 response 再跑一次 sentinel，fail closed。
15. `src/google/directions-capture.ts:67` / `:107` — `candidate()` 将 parsed routes 转成 Travel-owned types；`result()` 生成 `TransitSearchResult`。
16. `src/api/search.ts:46` — 可选写入短期内存 cache；route 返回 JSON。

没有显式 private request 或 `pb` builder：sidecar 只改变页面 URL state，真正的 `/maps/preview/directions` 请求由 Google Consumer 页面发出并被 Playwright 拦截。

## 5. DEPART_AT Request Construction

### 已由代码/测试确认

- `buildSeedDirectionsUrl()` (`src/google/url-builder.ts:11`) 使用 `https://www.google.com/maps/dir/`，query params 只有 `api=1`、起点坐标、终点坐标和 `travelmode=transit`。它不编码日期、时间或 `timeMode`。
- `encodeGoogleWallClock()` (`:3`) 把输入日期和时间分量传给 `Date.UTC(...) / 1000`。这是“wall-clock-as-UTC-components”编码，不是把 Japan local time 换算成真实 UTC instant。
- `tests/parser.test.ts:131` 固定验证 2026-09-23 的 09:00、10:04、15:00、18:30，证明编码不受 Windows 当前 timezone 影响。没有跨日专用测试。
- `BrowserManager.runWithPage()` 给 BrowserContext 设置 `timezoneId: query.timezone`；编码器本身不读取 timezone。
- `applyDepartAtState()` (`src/google/url-builder.ts:26`) 要求 resolved URL 含 `!4m2!4m1!3e3`，并替换为 `!4m6!4m5!2m3!6e0!7e2!8j<encodedWallClock>!3e3`。
- `pageUrlMatchesDepartAt()` (`:41`) 和 `runSearchSentinel()` (`src/google/schema-sentinel.ts:161`) 都要求完全相同的时间/模式片段。

### Marker 证据等级

| Marker                      | 当前代码中的用途                                                                  | 证据等级                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `!3e3`                      | seed resolve 等待条件、reverse URL transit-mode 检测、DEPART_AT state 尾部        | **代码 + 单测/现有 live 路径确认**为 transit directions marker；不推断 Google 内部字段名 |
| `!6e0`                      | direct builder 生成；page/sentinel 要求；reverse parser 映射 DEPART_AT            | **代码 + DEPART_AT 测试/既有 live 确认**                                                 |
| `!6e1`                      | reverse parser 静态映射 ARRIVE_BY                                                 | **仅代码线索**；无 fixture/live 证明                                                     |
| `!6e2`                      | reverse parser 静态映射 LAST_TRANSIT                                              | **仅代码线索**；无 fixture/live 证明                                                     |
| `!7e2`                      | 和 `!6e0`、`!8j` 一起生成/匹配                                                    | 只确认它是当前已验证 DEPART_AT state 的必要片段；**独立语义 UNKNOWN**                    |
| `!8j<number>`               | builder 承载 encoded wall-clock；reverse parser 读 9–12 位数字并转换展示值        | **代码 + encoder tests 确认**；Google 的正式字段定义 UNKNOWN                             |
| `!5i<number>`               | reverse parser 读取 selected route index；既有 index 0/1 import evidence 保持选择 | **代码 + 既有 live 结果确认**                                                            |
| `!4m2!4m1` / `!4m6!4m5!2m3` | 前者是替换前置条件，后者是生成 state 的结构包装                                   | 仅确认精确结构作用；子字段语义 **UNKNOWN**                                               |

仓库没有 ARRIVE_BY `pb`、request body 或 URL 差异样本。因此不能仅凭 `!6e1` 的解析映射断言完整 ARRIVE_BY 构造应当如何写。

## 6. Reverse Import

调用链：`POST /v1/transit/import` (`src/server/routes.ts:96`) → `SearchCoordinator.importSelectedUrl()` (`src/api/search.ts:55`) → `GoogleTransitClient.importSelectedUrl()` (`src/google/directions-capture.ts:381`) → `parseSelectedGoogleMapsUrl()` → `captureSelectedUrl()` → `parseDirectionsResponse()` → `inferSelectedIndex()` → `runImportSentinel()` → `result()`。

- 时间模式识别：`parseSelectedGoogleMapsUrl()` 在 serialized path/search/hash 中解析 `!6eN`，映射 0/1/2；解析 `!8j` wall-clock、`!3e3` transit mode 和 `!5i` selected index。
- ARRIVE_BY 解析线索：有，`!6e1 → ARRIVE_BY`。但没有 ARRIVE_BY URL test/fixture/live sample，故只能称为“syntactic parse branch”，不能称已验证支持。
- direct builder 与 import parser 不对称：parser 认识三个 marker 值，builder 只生成 DEPART_AT。这正是“parse support 部分存在、direct builder 尚未实现”的代码形态。
- selected index：优先使用 `!5iN`。缺失时 `inferSelectedIndex()` (`src/google/directions-capture.ts:240`) 先寻找唯一 `data-trip-index` 且 `aria-selected/current=true` 的元素；若处于 detail view，则按 selected route 的时间、票价、线路/服务 visible markers 计分，唯一且至少 3 分才接受，否则返回 null。
- direct 与 import 共用 `parseDirectionsResponse()`，但不共用最终 sentinel：direct 用 `runSearchSentinel()`；import 用 `runImportSentinel()`。
- capture 也不同：direct 收集一个时间窗内所有 matching responses；import 的 `captureSelectedUrl()` 只等待并读取一个 matching response。
- import 目前在 capture 之前拒绝非 DEPART_AT；成功 result 也把 `timeMode` 固定为 DEPART_AT。因此真正支持 ARRIVE_BY reverse import 至少要调整 gate、结果构造和相应 verification。

相关测试：

- `tests/parser.test.ts:59`：selected index 1 的 import sentinel 遇到被破坏的 leg shape 必须 fail closed。
- `tests/server.test.ts:236`：import route 保持鉴权 auxiliary endpoint；使用 fake client，不验证真实 URL parsing。
- `scripts/live-validation.ts:81`：既有 harness 验证 selected index 1 和 0；已有 summary 均为 PASS。

## 7. Browser Response Capture

### Lifecycle

- `src/server/index.ts` 在 provider enabled 时启动 Chrome；失败后服务继续运行，搜索由 `BrowserManager` 返回 `BROWSER_UNAVAILABLE`。
- `BrowserManager.ensureBrowser()` 只维护一个 service-owned Chrome process，并在 disconnected 时清引用；服务 shutdown 调 `browsers.close()`。
- 每次 operation 使用全新 BrowserContext（locale `ja-JP`、指定 timezone、固定 viewport）和 Page；`finally` 关闭 context。未指定任何用户 profile 路径，也不触碰用户 Chrome profile。

### Direct capture

1. 首先打开公开 seed URL；等待 Google resolve 成 transit `/maps/dir/.../@.../data=...!3e3`。
2. blocked detector 在 seed 和 target navigation 后检查页面文本中的 CAPTCHA、unusual traffic、human verification 或 login gate 信号；命中为 502 `UPSTREAM_BLOCKED`。
3. target navigation 前安装 response listener。`isDirections()` (`src/browser/google-page.ts:18`) 只接受 pathname 精确为 `/maps/preview/directions` 且 HTTP 200。
4. `waitForResponse()` 保证至少捕获一个，之后继续 1.2 秒；listener 把窗口内所有 matching response body 加入 `rawCandidates`。数量不是固定值。
5. `selectMatchingSearchResponse()` 逐个 parse + sentinel；第一个 PASS 才可信。wrong first response 会被忽略，见 `tests/parser.test.ts:113`。
6. 若 parsed candidate count 为 0，只有页面 URL 精确匹配 DEPART_AT state、响应端点坐标匹配、页面可见 no-route 文案三者同时成立才返回 `NO_ROUTES`；否则继续寻找下一 response。

默认 timeout 来自 runtime config（45 秒）；Playwright timeout 最终映射为 504 `UPSTREAM_TIMEOUT`。取消请求关闭 context并映射 499 `UPSTREAM_ERROR`。

### ARRIVE_BY 影响

- **明确受影响**：target URL 构造、DEPART_AT page URL match、zero-route verification、`runSearchSentinel()` 的 page state 与时间语义。
- **可能受影响/UNKNOWN**：ARRIVE_BY 是否产生相同数量/顺序的 preview responses、是否仍为相同 path/status、初始 transient response 特征、no-route rendered marker。当前 capture path filter 很可能可复用，但仓库没有证据可确认。
- 因此 response selection 与 DEPART_AT 明确耦合；“first response is not automatically trusted”机制本身可复用，但其 pass predicate 必须 mode-aware。

## 8. Query Verification

`runSearchSentinel()` 是主要实现；`selectMatchingSearchResponse()` 用它选 response，`GoogleTransitClient.search()` 再执行一次 fail-closed 检查。

| README 声明 / check   | 实际逻辑                                                                                                              | 失败路径                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| origin                | `coordinatesMatch()`，lat/lng 各自误差 `<= 0.005`                                                                     | selection 中全部失败为 502 `REQUEST_MISMATCH`                                               |
| destination           | 同上                                                                                                                  | 同上                                                                                        |
| date + time           | `encodeGoogleWallClock(date,time)`；页面 URL 必须含精确 `!8j<value>`；候选时间再以 route timezone 转成本地 wall-clock | 同上                                                                                        |
| DEPART_AT mode        | 页面 URL 必须含 `!6e0!7e2!...!3e3`                                                                                    | 同上                                                                                        |
| itinerary timing      | 所有 route 到达不早于出发；最早候选本地出发时间 `>= requested` 且 `<= requested + 172800s`                            | 同上；二次 sentinel 中 query checks 为 `REQUEST_MISMATCH`                                   |
| rendered page markers | 至少一条 route 的 departure/arrival display 都出现在页面；有 line/service 时至少一个也出现                            | selection 中为 `REQUEST_MISMATCH`；理论上的二次 sentinel 非 query check 为 `SCHEMA_CHANGED` |

重要限制：query timezone 用于 BrowserContext；route 自带 timezone 用于 itinerary wall-clock 计算，但 sentinel **没有显式比较** `route.timezone === query.timezone`。日期/时间验证通过 encoded URL state 与 itinerary local-wall-clock 间接完成。

ARRIVE_BY 不能沿用 `depart-at-semantics`。最直观候选是验证某个/所有可接受候选的 arrival local wall-clock 不晚于 requested time，但“取最晚到达、允许多少天窗口、Google 是否返回跨日候选、边界是否含等号”都没有仓库证据。本报告不把 `arrival <= requested` 当作已确定规格；它是必须由脱敏实证和产品语义确认的设计问题。

## 9. Schema Sentinel

### 入口与 checks

`runSearchSentinel()` (`src/google/schema-sentinel.ts:67`) 覆盖：

- `root-shape`：data format tag；实际 JSON root positional shape 先由 parser fail closed。
- `candidate-array` / `candidate-count`：routes 数量一致且大于零。
- `time-shape`：`routeShape()` 要求 route 到发 epoch、到达不早于出发、时长 60–172800 秒、至少一 leg、无 `OTHER` mode。
- `legs-exist`、`mode-marker`。
- `fare-marker`：若 amount 非 null，则 currency/display 必须同时存在。
- `stop-marker`：每个 transit leg 有 from/to。
- `line-marker`：每个 transit leg 有 line name。
- `start-end-relationship`：arrival >= departure。
- origin/destination coordinate checks。
- `page-url-query-state`：硬编码 DEPART_AT marker + wall-clock。
- `depart-at-semantics`：最早 departure 的本地 wall-clock 范围。
- `page-visible-marker-cross-check`：候选时间与 line/service 对照 rendered page。

`runImportSentinel()` (`:204`) 覆盖 transit marker、candidate count、selected index offset 范围、全部 candidate shapes、origin/destination label/place ID match、selected route visible markers。

### Fail-closed

- parser 找不到 verified root/route positional shape就抛错；search 归类 `SCHEMA_CHANGED`。
- sentinel 任一 check false 即返回 `SCHEMA_CHANGED` 状态；selector 不接受该 response。
- 全部 captured response 无法 parse → 502 `SCHEMA_CHANGED`；至少一个能 parse 但没有完整 match → 502 `REQUEST_MISMATCH`。
- import sentinel 失败或 selected index 不唯一/不存在 → 502 `SCHEMA_CHANGED`。

### ARRIVE_BY 未知项

| 项目                                                    | 判断                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| page marker                                             | **确定会不同或至少不能继续要求 `!6e0`**；实际完整 marker UNKNOWN            |
| query-time relationship                                 | **确定必须 mode-aware**；现有 earliest-departure 语义不适用                 |
| response positional schema                              | **UNKNOWN**；无 ARRIVE_BY response evidence                                 |
| candidate root shape                                    | **UNKNOWN**                                                                 |
| route time offsets                                      | **UNKNOWN**                                                                 |
| leg/stop relationship indices                           | **UNKNOWN**                                                                 |
| generic arrival >= departure、fare/line/stop invariants | 代码上与 mode 无关，可能复用；但仍需 ARRIVE_BY fixture 验证，不能宣称已证明 |

## 10. Parser Coupling

`parseDirectionsResponse(raw)` 没有 query 或 `timeMode` 参数；它只解析 response positional arrays，因此**没有直接 TimeMode 耦合**。

核心 offsets：

| 输出                          | 提取逻辑                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| response root                 | routes `[0,1]`; endpoints `[0,0]`                                                  |
| route summary / legs          | summary `route[0]`; leg values `route[1,0,1]`                                      |
| candidate departure / arrival | summary `[5,0]` / `[5,1]`；epoch 在子项 `[0]`，display 在 `[2]`，timezone 在 `[1]` |
| candidate duration            | summary `[3,0]`                                                                    |
| fare                          | summary `[11,0]` amount、`[11,1]` display、`[11,2]` currency                       |
| leg mode                      | summary `[14,0,2,3]` label 与 `[14,0,2,1]` icon 文本分类                           |
| walking duration / distance   | summary `[3,0]` / `[2,0]`                                                          |
| transit payload               | `leg[5]`; from `[0]`、to `[1]`、stop count `[2]`、intermediate stops `[7]`         |
| stop                          | name `[0]`、坐标 `[4,2/3]`、arrival/departure slot `[2]/[3]`                       |
| transit leg time              | from departure 到 to arrival；fallback duration `transit[19,0]`                    |
| line / service / headsign     | summary tag list中的 tag 5 / 6 / 7                                                 |

从结构看，ARRIVE_BY 更可能首先影响 query/verification 层；但由于私有 positional schema 没有兼容承诺，不能由“parser 无 mode 参数”直接推出“parser 无需改”。在取得 ARRIVE_BY shape signature/fixture 后才能把 parser 归入无需修改。

## 11. Error Model

| Code                  | 产生位置                                                                        |            HTTP | 含义                                                        |
| --------------------- | ------------------------------------------------------------------------------- | --------------: | ----------------------------------------------------------- |
| `VALIDATION_ERROR`    | query parser、import body/URL parser                                            |             400 | 输入格式、日期、地点、timezone 或 URL 无效                  |
| `UNAUTHORIZED`        | `src/server/auth.ts`                                                            |             401 | protected endpoint 鉴权失败                                 |
| `UNSUPPORTED_MODE`    | `src/api/search.ts:31`; `src/google/directions-capture.ts:399`                  |             422 | 合法枚举值但当前未经验证/未开放                             |
| `BUSY`                | `src/api/search.ts:76`                                                          |             429 | 已有一个 Google operation；不排队                           |
| `PROVIDER_DISABLED`   | `src/api/search.ts:66`                                                          |             503 | kill switch 未启用                                          |
| `BROWSER_UNAVAILABLE` | `src/browser/browser-manager.ts:90`                                             |             503 | service-owned Chrome 无法启动                               |
| `UPSTREAM_TIMEOUT`    | `src/google/directions-capture.ts:366`                                          |             504 | browser/navigation/response timeout                         |
| `UPSTREAM_BLOCKED`    | `src/browser/google-page.ts:58,86,122`                                          |             502 | 匿名 session 出现 challenge/block/login gate                |
| `UPSTREAM_ERROR`      | browser/client generic error、取消、import 未捕获 response                      | 502；取消为 499 | 非已分类 upstream failure                                   |
| `REQUEST_MISMATCH`    | response selector；二次 sentinel query checks                                   |             502 | 有可解析 response，但没有一份同时匹配请求与验证条件         |
| `SCHEMA_CHANGED`      | 无 response 可按 verified offsets parse；非 query sentinel/import sentinel 失败 |             502 | private positional schema 或 page relationship 不再符合守卫 |
| `NO_ROUTES`           | `selectMatchingSearchResponse()` 的严格 verified-empty 分支                     |             404 | 页面状态、端点与可见 no-route 文案共同确认零路线            |

ARRIVE_BY 目前产生 `UNSUPPORTED_MODE` 是主动 feature gate，而不是 Google 返回错误：direct 在任何 cache/browser/client 调用前就停止；import 在 URL parse 后、browser capture 前停止。

## 12. Cache

`queryCacheKey()` (`src/domain/transit-query.ts:124`) 按顺序包含：

1. origin lat/lng（各 6 位小数）
2. destination lat/lng（各 6 位小数）
3. date
4. time
5. `timeMode`
6. timezone

结论：`cacheIncludesTimeMode = true`。`DEPART_AT 10:00` 与 `ARRIVE_BY 10:00` 不会命中同一条目；缓存 key 不是升级 blocker。缓存发生在 mode gate 之后，目前 unsupported modes 不会创建或读取 cache entry。

## 13. Test Inventory

| 文件 / test                                                     | 验证 invariant                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tests/parser.test.ts:34` — preserves both route indexes...     | 两个 route source index；TRAIN line/service/headsign/stopCount；上下车站坐标；intermediate stop 到发时间 |
| `:59` — rejects a schema mutation...                            | selected import 遇到空 legs 必须 `SCHEMA_CHANGED`；fixture 带 `!5i1`                                     |
| `:75` — accepts a fully matched direct DEPART_AT query          | 正确 `!6e0!7e2!8j...!3e3`、行程时间和 page markers 全 PASS；fixture fare 也经过一致性 guard              |
| `:88` — rejects zero candidates and a mismatched requested time | zero candidates fail；18:30 请求不能接受更早的 fixture departures                                        |
| `:113` — ignores a wrong first response...                      | 第一个 directions response 不自动可信；选择后续 query-matched response                                   |
| `:132` — wall-clock encoder                                     | 09:00、10:04、15:00、18:30 不受 Windows timezone 影响                                                    |
| `tests/server.test.ts:69`                                       | health 只宣告 DEPART_AT 且不调用 Google                                                                  |
| `:112`                                                          | malformed date / coordinates → 400 validation                                                            |
| `:130`                                                          | ARRIVE_BY/NOW/LAST_TRANSIT → 422 `UNSUPPORTED_MODE` 且 client 未调用                                     |
| `:147`                                                          | 同 query 的 cache repeat 不再调用 browser client                                                         |
| `:161`                                                          | 第二个 operation 立即 429 BUSY                                                                           |
| `:191`                                                          | cancellation signal 向下传递                                                                             |
| `:208`                                                          | timeout/browser/block/mismatch/schema/no-routes 错误码与 status 保持，不被误转成 NO_ROUTES               |
| `:236`                                                          | reverse import 是 authenticated endpoint（fake client）                                                  |
| `scripts/live-validation.ts`                                    | 三个 DEPART_AT direct scenarios；selected index 1/0 import；真实结果必须 verified 且非空                 |

覆盖缺口：

- `ARRIVE_BY` 只有“应拒绝”测试；没有 skipped/todo test、fixture、注释实现、disabled branch 或 reverse import sample。
- 没有 cross-day itinerary 专用测试。
- TRAIN 与 intermediate stops 有明确 unit assertions；BUS 仅出现在既有脱敏 live result，不是 synthetic unit fixture。
- fare 在 fixture 和 sentinel acceptance 中被间接覆盖，但没有单独针对 amount/currency/display extraction 的断言。
- selected index 0/1 的真实保持仅在既有 live harness/results；unit import sentinel 显式覆盖 index 1。
- malformed root/JSON 没有专门 test；被移除 legs 的 mutation 覆盖 route-shape fail closed。

### Live harness（未在本审计中运行）

命令为 `pnpm --filter @travel/google-consumer-transit test:live`。`scripts/live-validation.ts` 直接构造 `BrowserManager` + `GoogleTransitClient`，执行：

1. Mahoroba → Toya，2026-09-23 15:00，DEPART_AT。
2. Mahoroba → Toya，2026-09-22 10:00，DEPART_AT。
3. Sapporo Station → Otaru Station，2026-09-22 09:00，DEPART_AT。
4. reverse import selected index 1。
5. reverse import selected index 0。

它把 summary 写到 gitignored `artifacts/live-validation-summary.json`，`debugCapture: false`，不写 raw Google response。现有 summary 含 normalized result 字段，仍不应整体复制到审计报告；本报告只摘录验证所需的路线数量、首条时刻/时长/票价、mode 和耗时。harness 源码内存在完整 selected Google URL，属于既有代码；报告未复制该 URL。

## 14. Existing Live Evidence

既有 `INTEGRATION_STATUS.md` 与 2026-09-20 脱敏 summary 证明：

| Scenario                                           | 已确认结果                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Mahoroba → Toya，2026-09-23 15:00 Japan wall clock | 6 candidates；首条 15:12:06 → 17:26:10；8044 秒；JPY 3910；WALK/BUS/TRAIN |
| Mahoroba → Toya，2026-09-22 10:00                  | 5 candidates；首条 10:12:38 → 12:13:30；7252 秒；JPY 3910；WALK/BUS/TRAIN |
| Sapporo → Otaru，2026-09-22 09:00                  | 6 candidates；首条 09:10 → 09:45；2100 秒；JPY 1800；TRAIN                |
| Reverse import                                     | index 1 和 index 0 均保持；各 6 candidates                                |

这只证明列出的 `DEPART_AT` 查询、当时 Google frontend 和该 anonymous session 的行为，不是可用性 SLA。

ARRIVE_BY 的仓库实证只有：`DISABLED / UNVERIFIED`、direct/import 的 `UNSUPPORTED_MODE`、以及 URL parser 中未被 fixture 验证的 `!6e1` 映射。仓库**没有证明** Google ARRIVE_BY 的完整 marker、preview request 差异、response schema、candidate ordering 或正确 verification invariant。

## 15. ARRIVE_BY Impact Matrix

分类定义：A = 必须修改；B = 可能需要修改；C = 大概率无需修改。这里的 A/B/C 是影响面分类，不等同于下一节总体 CASE。

| 模块                                          |     分类      | 依据                                                                                    |
| --------------------------------------------- | :-----------: | --------------------------------------------------------------------------------------- |
| `TransitTimeMode` type / request schema       |       C       | 已包含并接受 ARRIVE_BY；可能只需文档化，不需扩 enum                                     |
| search HTTP handler                           |       C       | handler 已 mode-agnostic 地 parse 并委托；错误 handler 也通用                           |
| health capability advertisement               |       A       | 当前只宣告 DEPART_AT；真正开放后必须与能力一致                                          |
| `SearchCoordinator.search()` feature gate     |       A       | 当前在 browser 前直接拒绝所有非 DEPART_AT                                               |
| Google URL builder                            |       A       | 只有 `applyDepartAtState()`，marker 写死 DEPART_AT                                      |
| `pb`/private request builder                  | A（现有形态） | 没有独立 builder；页面 URL state 是唯一控制入口，必须引入经过证据验证的 mode-aware 构造 |
| Browser direct capture orchestration          |       A       | 直接调用 `applyDepartAtState()`；需要 mode-aware target state                           |
| `/maps/preview/directions` path/status filter |       B       | 可能保持不变，但无 ARRIVE_BY capture evidence                                           |
| Browser response selection                    |       A       | 每个 response 都用 DEPART_AT sentinel；zero-route 也要求 DEPART_AT page state           |
| page marker verification                      |       A       | 两处硬编码 `!6e0!7e2!8j...!3e3`                                                         |
| query verification                            |       A       | `earliest departure >= requested` 是 DEPART_AT 专属                                     |
| response parser                               |       B       | 无直接 mode coupling，但 ARRIVE_BY positional offsets 没有证据                          |
| generic Schema Sentinel guards                |       B       | shape/fare/stop/line checks可望复用，但必须用 ARRIVE_BY fixture确认                     |
| search sentinel mode/page/time checks         |       A       | page state 与 `depart-at-semantics` 明确写死                                            |
| cache key                                     |       C       | 已包含 `timeMode`，不会跨模式碰撞                                                       |
| reverse URL parser                            |       B       | 已识别 `!6e1`，但映射未经验证；可能需按实证修正                                         |
| reverse import gate/result                    |       A       | 目前拒绝 ARRIVE_BY且结果硬编码 DEPART_AT                                                |
| unit fixtures/tests                           |       A       | 当前没有 ARRIVE_BY positive、mismatch、wrong-first、zero-route、cross-day evidence      |
| live harness                                  |       A       | 只执行 DEPART_AT；升级验收必须加入受控 ARRIVE_BY scenario，且继续脱敏                   |
| README / status docs                          |       A       | 当前明确声明 ARRIVE_BY disabled/unverified                                              |

## 16. Case A/B/C Conclusion

**推荐：CASE B+C。**

- **CASE B 已确认**：ARRIVE_BY 不只影响 request。`selectMatchingSearchResponse()`、verified-empty 判定、`page-url-query-state`、`depart-at-semantics` 和 import result 都明确依赖 DEPART_AT。
- **CASE C 也成立**：仓库没有 ARRIVE_BY sanitized request diff、URL fixture 或 response shape evidence。虽然 reverse parser 把 `!6e1` 命名为 ARRIVE_BY，但这不足以安全设计 builder，也不能证明 parser offsets 可复用。
- 不推荐单独 CASE A。parser/general guards 最终可能大部分复用，但目前证据不足，且 verification 一定要改。

## 17. Required External Evidence

需要一次最小、人工受控、脱敏的结构采集。只采集：

1. 同一 origin/destination/date/time 下 DEPART_AT 与 ARRIVE_BY resolved page URL 的**时间相关 marker 片段差异**；只保留 marker 名、顺序、类型/长度和脱敏值占位符。
2. 确认 ARRIVE_BY 的 mode discriminator、wall-clock 所在 marker，以及 DEPART_AT 中 `!7e2` 是否保持/变化；不提交完整 URL 或完整 payload。
3. 两种模式是否触发同一 `/maps/preview/directions` pathname、请求次数/顺序是否变化；只记录 count、relative timing、method/path、body 是否存在及结构 hash/shape，不记录 headers 或 body。
4. 一份 ARRIVE_BY response 的脱敏 **shape signature**：root/route/summary/leg/stop 数组长度、所用索引的值类型、nullability；不保留地点文本、完整数组或原始 response。
5. 候选的 normalized departure/arrival 时间关系，用于确认“哪个 arrival 应与 requested time 比较”、跨日行为和容许窗口。
6. ARRIVE_BY 页面可见时间/line markers 与 zero-route 页面文案是否和 DEPART_AT 相同；仅保存布尔/枚举结果或脱敏标签。
7. 一个 selected ARRIVE_BY URL 的最小 marker slice，用于验证 `!6e1` 与 `!5i` 组合；不保存完整 URL。

明确不需要且不得采集：Cookie、登录账号、Authorization、任何 token、Chrome profile、完整 private response、完整 `pb`、完整请求 header/body。

## 18. Recommended Upgrade Sequence

1. 先采集并 reviewer 审核上一节的 sanitized structural diff；把 UNKNOWN 项变为有证据的事实。
2. 以脱敏 shape 构造最小 ARRIVE_BY synthetic fixture；先写 URL parse/build、page marker、positive/mismatch、wrong-first、zero-route、cross-day tests。
3. 把 URL state builder 改为显式 mode-aware，保持 DEPART_AT exact regression 不变；不要仅用字符串替换猜测 ARRIVE_BY。
4. 把 response selector 与 zero-route verification 改为使用 mode-aware page predicate。
5. 将 sentinel 拆成可复用的 schema guards和 mode-specific query semantics；为 ARRIVE_BY 明确定义 arrival 边界、候选选择与跨日窗口。
6. 用 fixture 验证 parser offsets；仅在 shape diff 证明需要时修改 parser，未知字段继续返回 null/fail closed。
7. 对 reverse import 校验实际 marker mapping，再修改 import gate、result `timeMode` 和 selected index tests。
8. 保持 cache key 的 `timeMode` 维度；添加跨模式不碰撞测试。
9. 更新 health、README/status，再执行 unit/typecheck/build。
10. 最后才运行一次低频、anonymous、debug capture 关闭的 ARRIVE_BY live validation；只保存脱敏 summary，并重跑全部 DEPART_AT regression。任何 challenge/block 都停止，不绕过。

当前 blocker：缺少经过脱敏的 ARRIVE_BY URL/request/response 结构证据；此外共享工作树处于其他 feature branch 且有大量并行未提交改动。前者阻止安全设计，后者阻止本任务做 Git 提交（本任务本来也明确禁止 commit/push）。
