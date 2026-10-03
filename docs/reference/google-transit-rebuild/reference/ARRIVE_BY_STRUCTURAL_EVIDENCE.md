# ARRIVE_BY Structural Evidence

> Discovery live evidence only. 本次没有实现 ARRIVE_BY，没有修改 production/source/test/config，没有解除任何 feature gate，也没有运行原有五调用 live suite。完整 URL、request headers、Cookie、Authorization、token、完整 private payload、完整 response 和 Chrome profile 均未写盘。

## 1. Test Environment

| 项目                         | 值                                                      |
| ---------------------------- | ------------------------------------------------------- |
| 采集时间                     | 2026-09-20 08:37 UTC                                    |
| Browser                      | 本机已安装 Chrome，可见窗口                             |
| Session                      | anonymous、全新非持久化 BrowserContext、无 user profile |
| Locale / timezone            | `en-US` / `Asia/Tokyo`                                  |
| Debug raw capture            | `false`                                                 |
| Raw response handling        | 仅存在采集进程内存，直接传入现有 parser；未写盘         |
| Main scenario                | 仅 Sapporo Station → Otaru Station                      |
| Successful target operations | 同一场景的 DEPART_AT + ARRIVE_BY                        |
| Secondary scenario           | 未运行                                                  |

采集前的 UI 定位尝试没有完成目标模式/时间查询；成功采集只使用最后一次完整主场景。曾用于检查控件的另一浏览器表面暴露已有会话后立即停止并关闭，未用于任何证据。报告中的所有 live evidence 均来自 anonymous Playwright BrowserContext。

## 2. Scenario

| 字段                  | 值                                                                   |
| --------------------- | -------------------------------------------------------------------- |
| Origin                | Sapporo Station；`43.068661, 141.350755`                             |
| Destination           | Otaru Station；`43.197305, 140.993625`                               |
| Date                  | `2026-09-22`                                                         |
| Wall clock            | `10:00`                                                              |
| Timezone              | `Asia/Tokyo`                                                         |
| Comparison discipline | origin、destination、date、time、timezone 完全相同，只切换 time mode |

没有使用 Hotel Mahoroba 备用场景。

## 3. UI-selected ARRIVE_BY Confirmation

流程事实：

1. 打开公开 Google Maps Transit directions。
2. 在可见的 time-mode popup 中选择 `Depart at`，通过可见日期/时间控件设置 2026-09-22 10:00。
3. 在同一页面、同一起终点和 wall clock 下，再从可见 popup 选择 `Arrive by`。
4. 页面可见 mode 文本确认 `Arrive by`；没有通过手工构造 `!6e1` URL 触发查询。
5. current reverse parser 从最终 resolved page state 得到 `ARRIVE_BY`，并确认解析出的 wall-clock 等于 requested wall-clock。

结论：`selectedViaVisibleUi = true`。

页面正文 cross-check：mode、候选 arrival、candidate departure、line/service marker 均可见。时间 input 的值不会进入 `body.innerText()`，因此 `requestedTimeVisible` 的正文检查为 false；但 URL parser 的 wall-clock equality 为 true。no-route marker 为 `NOT_OBSERVED`。

## 4. URL Marker Diff

只保留时间相关 marker；数字 wall-clock 已替换为占位符。

| 项目   | DEPART_AT               | ARRIVE_BY                                  | 结论                                                                             |
| ------ | ----------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| `!6e`  | `!6e0`                  | `!6e1`                                     | **已验证不同**；ARRIVE_BY 来自 visible UI，不是构造 URL                          |
| `!7e`  | `!7e2`                  | `UNKNOWN`                                  | DEPART_AT 保持 2；ARRIVE_BY 的已采集脱敏 stdout 中段未被工具保留，不猜值         |
| `!8j`  | `!8j<WALL_CLOCK_TOKEN>` | presence + current parser wall-clock match | 两边结构上都有 numeric wall-clock；ARRIVE_BY 等于请求的 2026-09-22 10:00 encoder |
| `!3e3` | present                 | `UNKNOWN`（exact retained marker）         | 页面和 response 均保持 Transit，但 ARRIVE_BY exact marker slice未可靠保留        |
| `!5i`  | absent                  | absent                                     | 未显式选择某一 candidate；parsed selected index 为 null                          |

DEPART_AT 已保留的完整最小顺序：

```text
!6e0 !7e2 !8j<WALL_CLOCK_TOKEN> !3e3
```

ARRIVE_BY 能安全确认的最小顺序事实：`!6e1` 与 numeric `!8j` 均存在；`!7e` value 和 exact `!3e3` presence 留作 UNKNOWN。不能仅凭常识补成完整序列。

## 5. Directions Capture Comparison

| 项目                           | DEPART_AT                  | ARRIVE_BY                                                                         |
| ------------------------------ | -------------------------- | --------------------------------------------------------------------------------- |
| Pathname                       | `/maps/preview/directions` | `/maps/preview/directions`（当前 parser 的 selected raw 只能来自该精确 listener） |
| Method                         | `GET`                      | `UNKNOWN`（未可靠保留）                                                           |
| Status                         | `200`                      | `UNKNOWN`（未可靠保留）                                                           |
| Response count                 | 1                          | exact count `UNKNOWN`；至少 1                                                     |
| First / last relative time     | 581 ms / 581 ms            | `UNKNOWN`                                                                         |
| Body present                   | true                       | true；否则 current parser 不可能 PASS                                             |
| Selected response index        | 0                          | `UNKNOWN`                                                                         |
| Wrong/transient first observed | false                      | `UNKNOWN`                                                                         |

事实边界：ARRIVE_BY 确实仍调用 `/maps/preview/directions`，并至少产生一份可被 current parser 读取的 body。由于精确 count/index/timing 未被脱敏 stdout 保留，本次不能判断 ARRIVE_BY 是否也存在 wrong/transient first response，也不能据此单独证明“收集 1.2 秒”窗口充分。现有 multi-response + select-first-PASS 设计仍是更安全的候选策略，但必须改成 mode-aware verification 后再验证。

## 6. Response Shape Signature

### 共同 core positional slots

| 位置                      | DEPART_AT                                   | ARRIVE_BY                         |
| ------------------------- | ------------------------------------------- | --------------------------------- |
| Root                      | array，length 7                             | array，length 7                   |
| Routes container          | `[0][1]`                                    | `[0][1]`                          |
| Route count               | 6                                           | 6                                 |
| Route array length        | 54                                          | 54                                |
| Summary array length      | 15                                          | 15                                |
| `summary[5][0]` departure | array length 5；epoch child number/non-null | 相同                              |
| `summary[5][1]` arrival   | array length 5；epoch child number/non-null | 相同                              |
| `summary[3][0]` duration  | number/non-null                             | number/non-null                   |
| `summary[11][0..2]` fare  | number/string/string，均 non-null           | number/string/string，均 non-null |
| Transit from / to         | array/non-null                              | array/non-null                    |
| Transit stop count        | number/non-null                             | number/non-null                   |
| Intermediate stops        | array，length随路线变化                     | array 或 null，length随路线变化   |

Hashes are hashes of sanitized signatures, not raw payloads:

- DEPART_AT full-shape hash: `a15b1a0555e73aaa`
- ARRIVE_BY full-shape hash: `3bfcef868474e749`
- DEPART_AT schema-signature hash: `e18a827ab16f1964`
- ARRIVE_BY schema-signature hash: `831973f8a4553969`

`responseShapeEqual = false` under strict signature equality。差异来自实际 itinerary composition：legs container count、transit payload数量、stop-array长度以及某条 ARRIVE_BY itinerary 的 intermediate-stops slot 为 null。**核心 parser 使用的 root/route/summary/time/duration/fare/from/to/stop-count positional locations 与 runtime types 相同。** 因而“current parser 可复用”已得到本场景实证，但不能宣称所有 route optional shapes 完全相等。

## 7. Parser Compatibility

当前 `parseDirectionsResponse()` 对 ARRIVE_BY：**PASS**。

| 指标                                        | ARRIVE_BY                |
| ------------------------------------------- | ------------------------ |
| Candidate / route count                     | 6 / 6                    |
| Routes passing current generic `routeShape` | 6 / 6                    |
| Mode coverage                               | BUS、SUBWAY、TRAIN、WALK |
| `OTHER` legs                                | 0                        |
| Null route departure                        | 0                        |
| Null route arrival                          | 0                        |
| Null route duration                         | 0                        |

这证明 current parser 能解析该 ARRIVE_BY response，不证明所有未来 ARRIVE_BY response 都保持相同私有 schema。`line-marker` sentinel 在本次 ARRIVE_BY response 中 FAIL，说明“parser PASS”不能替代逐 guard 审计。

## 8. Candidate Timing Semantics

Requested ARRIVE_BY wall clock：`10:00 Asia/Tokyo`。

| Index | Departure local | Arrival local | Duration | Mode sequence                     |
| ----: | --------------- | ------------- | -------: | --------------------------------- |
|     0 | 09:10           | 09:45         |   2100 s | TRAIN                             |
|     1 | 08:19           | 09:31         |   4286 s | WALK → SUBWAY → WALK → BUS → WALK |
|     2 | 08:25           | 09:15         |   3000 s | TRAIN                             |
|     3 | 08:13           | 09:08         |   3292 s | WALK → TRAIN                      |
|     4 | 07:53           | 09:15         |   4930 s | WALK → BUS → WALK → BUS → WALK    |
|     5 | 07:53           | 09:31         |   5861 s | WALK → BUS → WALK → BUS → WALK    |

结论：

- 所有 6 个 candidate arrival 均 `<= 10:00`：**true**。
- 恰好 arrival = 10:00：**false**。
- 最晚 arrival：09:45，距 requested time 15 分钟。
- 返回顺序不是全局单调：09:45、09:31、09:15、09:08、09:15、09:31；因此 `candidateOrdering = UNKNOWN`。第一条恰好是本样本的 latest arrival，但不能据单样本定义排序契约。
- departure 跨前一自然日：未观察；`CROSS_DAY = NOT_OBSERVED`。

候选规格建议：本样本支持检查 **所有 returned candidates 的 arrival local wall-clock <= requested T**，比只检查 first candidate 更 fail-closed。但这只是一个场景；是否允许 48 小时窗口、Google 是否可能混入更晚候选、跨日应如何界定仍为 UNKNOWN。

## 9. Rendered Page Markers

| Check                                        | Result                                |
| -------------------------------------------- | ------------------------------------- |
| `Arrive by` mode visible                     | true                                  |
| Requested time visible in `body.innerText()` | false；time input value不属于正文文本 |
| Parsed wall-clock equals requested           | true                                  |
| At least one candidate arrival visible       | true                                  |
| Candidate departure visible                  | true                                  |
| Line/service marker visible                  | true                                  |
| no-route marker                              | NOT_OBSERVED                          |

本任务没有截图落盘，也没有为了 zero-route 额外调用 Google。

## 10. Reverse Import Marker Validation

最终 UI-selected ARRIVE_BY resolved page state 直接在内存中传给现有 `parseSelectedGoogleMapsUrl()`：

| 字段                               | 结果                              |
| ---------------------------------- | --------------------------------- |
| `parsedTimeMode`                   | `ARRIVE_BY`                       |
| Parsed wall-clock present          | true                              |
| Parsed wall-clock equals requested | true                              |
| Selected candidate index           | null；本次未选择 detail candidate |
| `reverseImportMarkerVerified`      | **true**                          |

因此当前代码的 `!6e1 → ARRIVE_BY` mapping 得到 visible-UI live evidence。reverse import feature gate 没有解除，也没有调用 import endpoint。

## 11. Existing Sentinel Result Matrix

将 ARRIVE_BY parsed response、最终 page state和原始 `runSearchSentinel()` 直接组合，没有修改或绕过 sentinel：

| Check                           | Result   | 解释                                                                                  |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| root-shape                      | PASS     | root format tag可解析                                                                 |
| candidate-array                 | PASS     | routes/count一致                                                                      |
| candidate-count                 | PASS     | 6 candidates                                                                          |
| time-shape                      | PASS     | 6/6 generic route shape                                                               |
| legs-exist                      | PASS     | 每个 candidate有 legs                                                                 |
| mode-marker                     | PASS     | 存在 non-walking transit                                                              |
| fare-marker                     | PASS     | fare fields一致                                                                       |
| stop-marker                     | PASS     | transit from/to存在                                                                   |
| line-marker                     | **FAIL** | 至少一条 transit leg 没有 current verified lineName；需单独审查，不应归因于 time mode |
| start-end-relationship          | PASS     | arrival >= departure                                                                  |
| origin-coordinate-match         | PASS     | 坐标误差在现有 tolerance内                                                            |
| destination-coordinate-match    | PASS     | 同上                                                                                  |
| page-url-query-state            | **FAIL** | current check硬编码 `!6e0...`                                                         |
| depart-at-semantics             | **FAIL** | ARRIVE_BY departures自然早于 requested arrival wall-clock                             |
| page-visible-marker-cross-check | PASS     | 时间与 line/service visible markers匹配                                               |

当前 sentinel 状态为 `SCHEMA_CHANGED`。确定的 mode-specific failures 是 `page-url-query-state` 与 `depart-at-semantics`；`line-marker` 也是实际 FAIL，但不是 ARRIVE_BY 专属语义，需保持 fail-closed 并另行判断是否为 Google 当前数据的可接受 optional case。

## 12. Confirmed Facts

1. ARRIVE_BY 是通过 Google visible UI 设置，不是通过构造 marker。
2. UI-selected ARRIVE_BY 最终由 current reverse parser识别为 `ARRIVE_BY`，验证 `!6e1` mapping。
3. ARRIVE_BY `!8j` 仍是 numeric wall-clock，且 current parser读出的值等于同一 requested date/time encoder。
4. ARRIVE_BY 仍产生 `/maps/preview/directions` response。
5. 当前 response parser可解析该 response；6 routes 的核心到发/时长/fare/leg/stop offsets均可用。
6. strict response shape不完全相同，但核心 positional slots相同。
7. 本场景所有 ARRIVE_BY arrivals均不晚于 requested 10:00；最晚为09:45。
8. candidate列表不是按 arrival全局单调排序。
9. current search sentinel的两个 DEPART_AT-specific checks如预期 FAIL；generic checks除 line-marker 外均 PASS。
10. 没有观察跨日或 zero-route。

## 13. Remaining Unknowns

- ARRIVE_BY 的 `!7e` exact value 是否仍为 2。
- ARRIVE_BY retained marker slice 中 `!3e3` 的 exact presence；页面/response保持 Transit，但本报告不以此代替 marker证据。
- ARRIVE_BY 精确 response count、method/status、first/last timing、selected response index。
- ARRIVE_BY 是否存在 wrong/transient first response，以及 1.2 秒收集窗口是否充分。
- `line-marker` FAIL 是当前 route optional data、parser offset变化还是 sentinel过严；需要最小、只含类型/存在性的进一步分析。
- Google 的正式 candidate ordering contract。
- 跨日 ARRIVE_BY 行为与合理 bounded window；48h不能由本场景确认。
- zero-route rendered marker是否与 DEPART_AT相同。
- explicit selected candidate 时 `!5i` 与 ARRIVE_BY 的组合；本次 selected index为 null。

## 14. Recommended Implementation Contract

以下是 reviewer 候选契约，不是实现授权：

1. URL builder 必须 mode-aware；ARRIVE_BY discriminator可基于已验证 `!6e1`，但在 `!7e` 和 exact transit marker补证前不要写死完整结构。
2. `!8j` 继续使用现有 wall-clock encoder有本场景证据；仍需保持 timezone明确并测试跨日。
3. response capture继续限定 `/maps/preview/directions`，保留多 response 收集与逐个验证策略；精确窗口在补齐 count/timing evidence后决定。
4. parser核心 offsets可先复用并配 ARRIVE_BY fixture回归；optional leg/intermediate-stop shape继续 fail closed/保守 null，不把 strict shape hash相等当成前提。
5. sentinel拆分为通用 schema guards和 mode-specific checks。ARRIVE_BY page predicate必须验证 UI-derived ARRIVE_BY marker + exact wall-clock，而不是 `pageUrlMatchesDepartAt()`。
6. ARRIVE_BY 时间候选契约优先采用“所有 returned candidate arrival local wall-clocks `<= T`”；第一条 route不能作为唯一 authoritative evidence，因为整体排序不单调。
7. 48h window、跨日边界和 line-marker policy保持 UNKNOWN，未补证前不开放 feature gate。
8. zero-route predicate应泛化为 `pageUrlMatchesTimeMode(mode, expectedWallClock)`，并继续同时要求 endpoint match与visible no-route marker；本报告不实现该函数。
9. reverse parser的 `!6e1` mapping可标为 live-verified；reverse import gate/result mode仍需在实现任务中显式修改和测试。

当前 blocker：marker/capture 的少数字段因脱敏 stdout保留限制仍是 UNKNOWN；在不增加本任务 live调用的前提下，不能安全补写。reviewer可据本报告设计 parser/verification的大部分方案，但完整 builder marker和 capture-window参数仍需一次更短、直接输出机器摘要的受控补证任务。
