# Backend Domain Blueprint v0.1

**性质：工程蓝图提案。已确认产品规则不变，表名/路径可在P0 ADR中微调。未决事项按阶段闸门处理。**

## 1. 同一核心，多个终端

```text
桌面网页 / 手机网页 / Windows / macOS / iOS / Android
                         │  相同业务契约
                         ▼
                    Web / API
          身份 → 授权 → 用例编排 → 事务
                         │
             平台无关 Domain Core
         时间传播 / 约束 / 邻接 / 冲突 / 解释
                         │
          PostgreSQL + Provider + ObjectStorage
                         ▲
                Worker（独立进程）
           持久任务 / 邮件 / 状态刷新 / 通知事件
```

Domain不得依赖React、Next页面状态、DOM、浏览器、移动SDK、数据库连接或网络。时间、ID、随机源通过参数/端口注入；相同输入与策略版本得到相同结果。

Application负责I/O编排。Provider提供观测/候选，不直接改Trip。Worker调用同一用例，不绕过授权、版本、事务和监控开关。

## 2. 关键对象与责任

| 对象                                           | 作用                                                     | 首轮落点                                                       |
| ---------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| User / Invitation / Session                    | 受控账号、角色、会话失效                                 | P1                                                             |
| UserPreference                                 | 基准货币、语言分别保存                                   | P1必要字段                                                     |
| Trip                                           | 所有者、名称、默认人数、有效日期范围、生命周期           | P2；O-01/O-02规则已确认                                        |
| DayOccurrence / Day projection / DateOwnership | sequence 中的日期卡身份、显示投影、用户内自然日归属约束  | P3A 持久化 DayOccurrence；DateOwnership 继续保持自然日唯一归属 |
| Place                                          | 真实地图地点身份/坐标，不是每次访问                      | P2                                                             |
| Visit                                          | 某次出现；PLACE或FREE_ACTION；来源与执行状态             | P2                                                             |
| TransportEdge / AdoptedRoute                   | 相邻连接、已采用快照、历史失效                           | P2/P4                                                          |
| RouteCandidate / RouteReference                | 尚未采用的查询候选 / 复制来的旧方案参考                  | P4；不直接当现行事实                                           |
| UserTimeIntent / TimeConstraint                | 精确/最早/最晚/最低停留与 lock 元数据                    | P3B1 已实现当前要求基础；P3B2 只读传播这些要求                 |
| ScheduleProjection                             | 从当前版本、事实与用户要求纯计算出的可解释评估与要求窗口 | P3B2 已增加确定性 bounds propagation；计划写入/路线求解后置    |
| Evidence / ProviderSnapshot                    | 观测时间、来源、适用位置、可靠性                         | P3/P4                                                          |
| Preview / OperationReceipt                     | 变更预览与采用回执、幂等与撤销依据                       | P4                                                             |
| Job / NotificationEvent                        | 持久任务与站内通知                                       | P1骨架/P5业务                                                  |
| Expense / Task / Attachment / ShareClaim       | 完整蓝图中保留的数据边界                                 | 分阶段另发，不在P0全建                                         |

## 2.1 Trip 日期范围与 DateOwnership（O-01/O-02 已确认）

本节冻结 P2 产品语义。P2A 已建立 Trip、DateOwnership、Place、ItineraryNode 与业务 API；
P3A 后 Day projection 由持久 DayOccurrence identity 驱动；DateOwnership 仍是独立自然日归属。
P2B 只增加当前相邻 Transport 与 resolved 时间基础。

- Trip 的有效日期范围只由有效行程内容决定：最早一个有效行程内容自然日至最晚一个有效行程内容自然日。有效内容包括未来的 Visit、FreeAction、Transport 或其他真实行程实体。
- 编辑器通过“添加下一天/前一天”产生的首尾空白日只是临时编辑态，不属于正式范围、不建立 `DateOwnership`、不占用自然日。离开编辑且没有有效内容时自动消失；删除或移动首日/末日最后一个有效内容后，范围向内收缩，连续首尾空白日一并收缩。V1 不提供保留首尾空白日开关。
- 有效范围内部的所有自然日都归属于该 Trip，即使中间没有行程内容；中间空白日不会释放给另一 Trip。一个 Trip 尚无有效内容时可以存在，但不占用任何自然日。
- 新建 Trip 输入的 `start date` 在空 Trip 阶段只是规划/编辑锚点，不得直接创建 `DateOwnership`。实现必须分别表达日期锚点、有效日期范围与日期归属，不能把三者混成一个 `startDate`。
- Trip note、todo、普通备注、Attachment、Expense、NotificationEvent 或用户偏好单独存在时不撑开日期范围；未来若 Task/Expense 附着于有效行程实体，由该实体决定日期范围。跨午夜、跨日期线与跨时区 Day 投影继续受 O-03 约束。
- 同一账号同一自然日最多属于一个 Trip。范围扩展遇到已占用日期时必须返回明确冲突，不重复占用、不静默覆盖、不自动合并；未来再由用户流程选择合并、调整或取消。

## 2.2 O-03 timeline 与日期卡（产品规则已确认，仅规格）

- 真实行程顺序由独立 timeline sequence 决定；已有明确 instant 时，真实时间先后按 instant 判断。
  `localDate` / `localTime` 只负责当地显示，不能作为整趟 Trip 的最终排序键。
- 跨国际日期线可使日期卡按 sequence 出现 `1月9日 → 1月10日 → 1月9日`，同一个
  `localDate` 可以出现任意多张独立日期卡。P3A 正式采用持久 `DayOccurrence`，以 UUID 标识日期卡，
  以 Trip-scoped sequence 排序。
- 新增/编辑内容必须定位到具体 DayOccurrence，不能只用 `localDate` 决定目标卡。日期卡顺序来自
  timeline/sequence，不能按日期数字重排或把同日期卡合并。
- `DateOwnership` 仍是用户自然日到 Trip 的唯一归属；同一 Trip 有多张同日期卡时仍只有一份
  日期归属，另一 Trip 不能占用该自然日。
- P3A 已将 P2B 的 `localDate + position` 升级为 `DayOccurrence.sequence + node.position`，并用
  migration 无损回填旧数据。跨日 Transport 多卡投影与 DST command/UI 仍未实现。
- DST 回拨日的重复当地时间若只有手工 local clock 输入，必须让用户选择前一个或后一个
  occurrence，不得默认；DST 跳时导致不存在的当地时间必须明确拒绝，不得自动平移。
- Provider/固定服务等可靠结构化数据已有明确 instant 或 UTC offset 时直接使用，不询问用户。
  信息不足以唯一确定 instant 时保持歧义，不猜测。

## 3. 数据归属与权限

所有私有资源必须通过owner和所属Trip检查权限。owner从服务端会话取得，不信任客户端传来的ownerId。管理员仅能开通/禁用/撤销账号会话，不继承读取他人Trip、附件、位置、费用的权限。[S07]

首版一趟Trip一个owner；预留`authorize(actor, action, resource)`集中入口。不要提前建复杂协作表、共享定位或多人账本。

同一Place可有多个Visit；来源为USER_PLANNED / ROUTE_GENERATED / EXECUTION_ADDED，但三者可表现为普通地点卡。FREE_ACTION没有假Place/假坐标。

## 4. 时间不能仅有startTime/endTime两列

至少区分：

- 输入意图：用户想要的目标时间/停留要求，包含比较运算EQ/NOT_AFTER/NOT_BEFORE/AT_LEAST与是否🔒。
- 已采用的计划结果：路线和独立计划值支持的排程快照。
- 当前预测：基于最新证据的预计结果，可失效。
- 实际记录：已确认发生的事实，自动排程不能回写过去。

P2B 的 resolved `TimeValue` 权威字段为明确 `instant`、`timeZone`（IANA）、`layer`、
`pointKind`、`sourceKind`、`sourceRef` 与 `observedAt`。`localDateTime` 由 instant + timeZone
输出时派生，不持久化第二份时间真相；持续时长用真实时间点之差计算，不使用服务器默认时区。
用户目标、约束、最低停留与 lock 属于后续 `UserTimeIntent / TimeConstraint`，不能塞入 TimeValue。

P3B1 已将该边界落地为独立 `UserTimeIntent`：POINT_TIME 支持 ARRIVAL/DEPARTURE 的 EXACT、
NOT_BEFORE、NOT_AFTER，MIN_DWELL 保存正数秒数；同一 Node 的同一要求槽位只有一个当前值。
`locked` 只表达用户不希望自动放宽，不保证现实可满足。`POST /trips/:id/schedule/evaluate`
基于指定 `basisVersion` 只读计算 `ScheduleProjection`，不会写回 PLANNED、TemporalValue 或 Trip。
当前值按 ACTUAL、ESTIMATED、PLANNED 事实层选择；已采用 fixedService Transport 的 PLANNED
时刻作为显式锚点参与判断，但不复制到 Node 时间表。用户要求彼此矛盾时返回 CONFLICT，缺证据
返回 UNKNOWN。P3B2 在同一只读 endpoint 上增加 arrival/departure 的 earliest/latest requirement
window：UserTimeIntent、ACTUAL 与 fixedService Transport PLANNED 是硬约束；普通 PLANNED/ESTIMATED
不是硬约束。明确 MIN_DWELL 支持 forward/backward 单调收紧，lower > upper 返回带 provenance 的
客观冲突。传播结果不写回时间事实，不跨未知 Transport 猜时长，也不包含 Provider、计划修改或推荐。

没有 Trip 级统一时区；生命周期日期的调度基准不能暗用服务器 UTC，参见 O-03。跨日期线与
DST 产品规则已确认；sequence/DayOccurrence 与 migration 在 P3A 落地，输入 command/UI 仍待实现。
重复当地时间由用户明确选前/后 occurrence，不存在时间明确拒绝；可靠数据已有 instant/offset
时直接使用，信息不足时返回明确歧义，不自动纠正成看似有效的时间。

## 5. 一个实体，按 sequence 投影到日期卡

跨日 Visit 或 Transport 是同一业务实体，在它真实经过的日期卡中投影显示；重复显示不复制
数据库实体，也不重复费用、时间、延误/取消状态或备注。修改或删除一次，所有投影同步变化。

连续 Transport 跨越多个自然日时，被它完整覆盖的中间日期仍需投影日期卡，可概念性称为
“交通占用日”。该日期进入 Trip 正式范围并由 `DateOwnership` 覆盖，但不能再加入 Place、
FreeAction 或其他普通行程内容。本轮不锁死数据库 enum 或关系设计。

Transport 与日期卡的显示关系依赖实际 timeline/sequence，不能只按 `localDate` 匹配；如果
同一日期在 timeline 中重复出现，Transport 只出现在它实际经过的那些 DayOccurrence。

跨时区但 localDate 不变、当地钟点回拨时，不因回拨本身创建第二张同日期卡；同一卡允许显示
较大的钟点后跟较小钟点，并在发生变化的 Transport 上解释“时区切换/当地时间回拨”。只有真正
发生跨时区变化的 Transport 卡显示出发/到达时区，后续普通卡不重复显示时区缩写。

不要比较终点本地日期或钟点大小来计算时长；跨时区航班可能当地到达钟点更早，真实持续时长
使用 instants。跨日期线导致 localDate 回拨时保留真实日期，并按 sequence 生成新的日期回拨卡，
不得为视觉递增篡改日期。

## 6. 行程状态与监控状态分开

用户可见 Trip 生命周期保持简单：PLANNED、IN_PROGRESS、FINISHED、NOT_TAKEN。

- 到起始日期进入 IN_PROGRESS 是运行假设，不自动生成 Actual 事实。
- 计划日期结束后自然进入 FINISHED；即使没有打开 App、没有定位、没有 Actual 或尾段未知，
  也不要求用户证明旅行发生，不进入待确认或“记录不完整待处理”。
- Actual、定位与 App 使用证据有多少保存多少，缺少部分保持 unknown；它们用于提醒、风险、调整
  与历史回看，不是生命周期结束门槛。
- NOT_TAKEN 只能由用户主动明确表示“没去”；无数据不等于没旅行，系统不得自动判断未执行。
- 不弹“是否去过”、不要求补全实际记录。底层如需技术状态，不得变成用户必须处理的任务。

监控用户开关与当前运行状态也分开：`userEnabled` + OFF/IDLE/RUNNING/LIMITED。用户关掉后不因第二天或重新打开界面自动恢复；系统自然停止不改变userEnabled。

设备证据必须有deviceId、capturedAt、accuracy、source、receivedAt；晚到数据不能覆盖较新证据。位置输入只认用户授权客户端/主动填写，不通过服务器猜测。

## 6.1 受保护安排（O-04 产品规则已确认）

- 不解析备注、附件、待办或自然语言去猜预约/购票事实；“已经订了”等文字本身不建立保护。
- 受保护来源只有可靠结构化事实（如已采用固定班次、结构化确认的预约/门票时间）或用户主动
  明确标记“已预订 / 时间固定”。
- V1 只需轻量结构化确认，不要求订单号、截图、付款凭证、OCR 或完整订单模块。
- 普通计划相对可调整；保护安排发生冲突时优先尝试保住，但保护不等于绝对禁止修改。无法满足时
  展示冲突并让用户决定，不能伪造“已解决”。
- Provider/Booking 将来如何取得结构化确认属于 P4 或外部服务实现，不再是核心产品规则阻塞。

## 6.2 推荐策略边界（O-05 产品规则已确认）

- 没有全局体验最低时长；只有用户对具体活动明确设置的最低时长才是硬约束。
- 先排除违反事实、受保护安排和用户硬约束的候选，再按保护固定内容、最小改动以及成本、体验、
  时间、风险和影响范围进行有解释的比较。不存在永久“最便宜优先”“最快优先”或全局固定权重。
- 偏好可以影响可行候选排序，但不能替代事实或约束。默认 1 个主推荐和最多 2 个可靠备选；不凑数，
  无可靠候选时明确返回没有可确认方案。
- 本节只冻结契约；RecommendationPolicy、评分/比较执行和 UI 尚未实现。

## 6.3 外部预约调整（O-06 产品规则已确认）

- 系统负责发现冲突、建议外部预约的新时刻并提醒用户自行处理；用户点击“已调整”后，application
  可将其作为用户确认继续规划。
- V1 不要求 API 回执、订单号、截图、付款证明或 OCR，也不建立复杂的外部预约状态机。
- 该状态必须明确标为用户确认，不能表达为商家官方确认、有位或 Provider 已核验。用户后来发现
  调整失败时，可再次调整或选择其他方案。
- 真实外部 Provider 属于可选增强，尚未实现，不再是 P3/P4 核心产品逻辑阻塞。

## 6.4 实时监控与提醒（O-08 产品规则已确认）

- `userEnabled` 与 OFF/IDLE/RUNNING/LIMITED 分离。用户关闭实时监控后，位置、动态 ETA、动态最晚
  出发、实时风险和延误联动停止；固定提醒是独立能力，除非单独关闭否则继续。
- 定位权限丢失使监控进入 LIMITED，不等于用户关闭；`userEnabled` 保持 true，固定提醒继续，权限
  恢复后可自动恢复位置相关能力。
- App 挂起、离线或后台中断后必须重新同步当前位置、交通状态和当前时间。旧位置不可冒充实时位置，
  中间过程保持 unknown，不推断停留或到达。
- 同一个稳定风险事件默认只主动提醒一次。再次提醒只允许发生在严重等级升级、新重要事实出现，或
  用户 snooze 到期且风险仍存在时；分钟级 ETA 小幅变化不构成新事件。
- 用户选择“知道了，继续按这个计划”只接受当前风险等级；同等级静默，升级后仍可提醒。没有全局
  “减少 X 分钟就提醒”阈值。
- 实时计算可提前静默运行，只在需要用户行动的窗口打扰。过期固定提醒不补发旧指令；恢复后只
  基于当前事实生成仍有意义的提醒。
- 目的相同的固定/动态提醒去重；同时出现时优先明确时窗与严重后果，通知正文采用“关键提醒 +
  待办数量汇总”，不删除低优先级待办。
- 本机通知、服务端 Worker 与未来 Push 只是投递 capability，不承诺任何平台下 100% 到达。

## 6.5 故障与人工查询出口（O-10 产品规则已确认）

- 外部 Provider 独立降级：铁路、航班或地图故障只让相应实时/路线能力变为 unavailable/unknown，
  Trip、地点、备注与固定计划继续可用，且不得声称未经确认的实时事实。
- Provider 故障时提供与 API 独立的人工查询出口，例如航空公司/机场/运营商官网、Google Maps 或
  Apple Maps。外部跳转不把网页内容自动导入系统；没有结构化数据就不能冒充系统事实。
- 核心 TRAVEL 后端不可用时显示服务暂时不可用，不把旧缓存伪装成可靠当前行程；V1 不实现完整
  离线模式。
- 核心故障的托底是带生成时间的静态行程图片备份，可保存到相册或分享；它不可编辑，且后续修改
  不会同步。旅行前一天或第一次进入“即将开始”时只提醒一次保存，不每天重复。

## 6.6 历史回顾与分享（O-11 产品规则已确认）

- 回顾默认相信用户最终保留的历史行程，不要求定位、Actual、App 打开记录或额外证明。只有用户
  明确跳过/取消/删除/修正为未发生，或系统有可靠未执行事实时才排除。
- 回顾主线是地点、FreeAction/特别体验及真实最终顺序；普通交通不展示。交通本身是旅行体验时
  可以作为体验内容进入回顾，但不是底层 TransportEdge 日志。
- 历史行程仍可编辑，回顾从该源数据重新生成，不建立第二套回顾事实数据库。旧图片和分享快照
  不随历史编辑自动更新。
- 分享默认只含轻量回顾内容，不含交通细节、待办、风险、订单、费用、私人备注或附件。静态分享
  链接默认长期有效、匿名可看，由用户主动停止；新旧版本独立。
- 复制时才要求登录，并从快照生成新的计划中 Trip：用户选择新日期、人数和名称；地点/顺序与当地
  时间作为参考平移，原 Actual 不成为新用户事实，私人数据与历史执行事实不复制。
- 跨时区/日期线回顾按 timeline sequence / DayOccurrence 显示，允许当地日期回拨，不为视觉连续
  重排，也不强制插入航班卡。
- 本节是产品规则，不代表回顾 UI、分享、匿名访问或复制功能已经实现。

## 7. Query / Preview / Adopt的事务规则

**Query**：传起终点、最早出发/最晚到达、日期时区、已有方案参考；返回候选与来源/有效期。不得写当前Trip。
P4A1 已实现其中的 provider-neutral 基础：只查询当前相邻 PLACE_VISIT，复用 P3B2 hard requirement
window，并允许一次性的 DEPART_AT/ARRIVE_BY hint。hint 不持久化且不能放宽 hard window；没有时间依据时
返回 `ROUTE_QUERY_TIME_REQUIRED`。Provider 结果由 Application 再次校验，越界候选不会作为可行路线
返回。当前只有明确标记的 SYNTHETIC 开发/测试 adapter，尚无真实 Provider。

P4B1 在 accepted candidate 后建立服务器拥有的短期 `RouteCandidateSnapshot`：Provider 调用结束后用
短事务重新锁定 Trip，并复核版本和 adjacency；只保存 normalized payload、provider provenance、query
condition、candidateHash 和 expiry，不保存第三方 raw response。Query 响应返回
`candidateSnapshotId` 与 `snapshotExpiresAt`，未来 Preview/Adopt 不信任客户端回传的 candidate JSON。

**Preview**：`POST /trips/:id/previews` 只接收 `basisVersion + candidateSnapshotId`，重新校验 owner、版本、
expiry、hash、adjacency、domain 与 P3B2 hard window，并以明确 policyVersion 持久化 immutable 变更预览。
Preview 可重新读取；过期时 `adoptable=false`。它只描述 CREATE/REPLACE、transfer points 和 proposed
segments，不创建 Place/Node/Transport，不复制时间到 Node，不修改正式 Trip 或版本。

**Adopt**：服务端重新校验权限、Trip版本、预览过期和Provider适用性；有效则一次事务落地节点、交通、来源与相关结果，并产生outbox事件。

必须有requestId/idempotencyKey；同一请求重试不能重复插入Visit、费用、任务或通知。相同key不同payload要拒绝。两设备同时采用同一baseVersion最多一个成功；另一个明确VERSION_CONFLICT。[S09]

一次采用失败不能只写了一半路线。外部API调用不要包在长数据库事务中：先取候选，事务提交时核验版本/快照有效性；必要时返回PREVIEW_STALE。

## 8. 撤销不是把世界倒回过去

单步、短时撤销恢复上一用户操作及其内部连带数据；不得回滚后续真实航班更新、实际位置或已发生事实。

若自上次操作后Trip版本已被其他设备修改，撤销返回UNDO_CONFLICT，不覆盖新改动。撤销成功后按最新可靠证据重新计算风险，不能恢复一个已经失真的“正常”状态。

Trip永久删除与不可逆合并不享有普通Undo；须用其已确认强提示流程。

## 9. API契约目录（蓝图，不要求P0全部实现）

| 范围 | 示例接口                                                                   | 必要边界                                 |
| ---- | -------------------------------------------------------------------------- | ---------------------------------------- |
| 健康 | GET /health/live, /health/ready                                            | 不含敏感配置                             |
| 登录 | POST /auth/magic-link/request, /auth/magic-link/consume                    | 邀请、单次、过期、限流                   |
| 会话 | POST /auth/logout, GET /me                                                 | server端撤销                             |
| 管理 | POST /admin/invitations, POST /admin/users/{id}/disable, /revoke-sessions  | 管理员不读取Trip                         |
| 行程 | POST /trips, GET /trips/{id}, PATCH /trips/{id}                            | owner验证、baseVersion                   |
| 节点 | POST /trips/{id}/commands                                                  | 类型化业务command，不接收随意数据库patch |
| 计算 | POST /trips/{id}/schedule/evaluate                                         | 可解释、无正式写入                       |
| 路线 | POST /trips/{id}/routes/query                                              | 候选≠采用                                |
| 预览 | POST /trips/{id}/previews                                                  | baseVersion+输入快照                     |
| 采用 | POST /trips/{id}/previews/{pid}/adopt                                      | 幂等+事务+版本                           |
| 撤销 | POST /trips/{id}/operations/{oid}/undo                                     | 仅最近一次且不覆盖新事实                 |
| 通知 | GET /notifications, POST /notifications/{id}/dismiss                       | 归属隔离、抑制同一事件                   |
| 附件 | POST /attachments/upload-intent, /complete, GET /attachments/{id}/download | 私有访问、类型/配额校验                  |

命名可在P0调整，语义不可暗改。DTO不能暴露ORM内部表，也不能叫desktop-card/mobile-card。

## 10. 统一错误与解释结果

错误建议包含`code`、面向用户的中文`message`、`requestId`、`retryable`、必要的非敏感详情。示例：
UNAUTHENTICATED / FORBIDDEN / VERSION_CONFLICT / PREVIEW_STALE / DATE_OWNED / PROVIDER_UNAVAILABLE / NO_MATCHING_CANDIDATE / LOCATION_UNKNOWN / CONSTRAINT_CONFLICT / AMBIGUOUS_TIME_INPUT / UNSUPPORTED_SCENARIO。

`NO_MATCHING_CANDIDATE`与`PROVIDER_UNAVAILABLE`分开；都不能自动变成“今天没车”。数据错误不能以空数组悄悄隐藏。

每个时间结果/冲突至少带sourceRefs、规则ID、输入值、计算式的简短解释和policyVersion，不记录模型隐藏思维过程。示例：“20:21固定发车−40分钟最低预留=19:41到站目标”。

## 11. 测试与真实数据严格分开

Fixture数据明示SYNTHETIC，禁用于真实交通展示、Provider回退或production。Provider contract sample如含个人信息须脱敏且核对使用条款；测试日志不保存完整票据或令牌。

至少在正式UI前做一次真实接口字段与覆盖探针：到达/出发含义、时区、班次、站内步行、价格范围、停运、日期支持。探针失败记录缺口，不能用夹具“证明”接入完成。
