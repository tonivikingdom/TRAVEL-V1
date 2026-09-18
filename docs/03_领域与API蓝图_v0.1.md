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
| 对象 | 作用 | 首轮落点 |
|---|---|---|
| User / Invitation / Session | 受控账号、角色、会话失效 | P1 |
| UserPreference | 基准货币、语言分别保存 | P1必要字段 |
| Trip | 所有者、名称、默认人数、有效日期范围、生命周期 | P2；O-01/O-02规则已确认 |
| Day / DateOwnership | 日期组织、用户内日期归属约束 | P2；按已确认 O-01/O-02 实现 |
| Place | 真实地图地点身份/坐标，不是每次访问 | P2 |
| Visit | 某次出现；PLACE或FREE_ACTION；来源与执行状态 | P2 |
| TransportEdge / AdoptedRoute | 相邻连接、已采用快照、历史失效 | P2/P4 |
| RouteCandidate / RouteReference | 尚未采用的查询候选 / 复制来的旧方案参考 | P4；不直接当现行事实 |
| UserTimeIntent / TimeConstraint | 固定/最早/最晚/最低停留/预留要求 | P3 |
| ScheduleProjection | 从当前版本与证据计算出的结果 | P3 |
| Evidence / ProviderSnapshot | 观测时间、来源、适用位置、可靠性 | P3/P4 |
| Preview / OperationReceipt | 变更预览与采用回执、幂等与撤销依据 | P4 |
| Job / NotificationEvent | 持久任务与站内通知 | P1骨架/P5业务 |
| Expense / Task / Attachment / ShareClaim | 完整蓝图中保留的数据边界 | 分阶段另发，不在P0全建 |

## 2.1 Trip 日期范围与 DateOwnership（O-01/O-02 已确认）

本节冻结 P2 产品语义。P2A 已建立 Trip、DateOwnership、Place、ItineraryNode 与业务 API；
Day 仍为 projection，不建立独立表。P2B 只增加当前相邻 Transport 与 resolved 时间基础。

- Trip 的有效日期范围只由有效行程内容决定：最早一个有效行程内容自然日至最晚一个有效行程内容自然日。有效内容包括未来的 Visit、FreeAction、Transport 或其他真实行程实体。
- 编辑器通过“添加下一天/前一天”产生的首尾空白日只是临时编辑态，不属于正式范围、不建立 `DateOwnership`、不占用自然日。离开编辑且没有有效内容时自动消失；删除或移动首日/末日最后一个有效内容后，范围向内收缩，连续首尾空白日一并收缩。V1 不提供保留首尾空白日开关。
- 有效范围内部的所有自然日都归属于该 Trip，即使中间没有行程内容；中间空白日不会释放给另一 Trip。一个 Trip 尚无有效内容时可以存在，但不占用任何自然日。
- 新建 Trip 输入的 `start date` 在空 Trip 阶段只是规划/编辑锚点，不得直接创建 `DateOwnership`。实现必须分别表达日期锚点、有效日期范围与日期归属，不能把三者混成一个 `startDate`。
- Trip note、todo、普通备注、Attachment、Expense、NotificationEvent 或用户偏好单独存在时不撑开日期范围；未来若 Task/Expense 附着于有效行程实体，由该实体决定日期范围。跨午夜、跨日期线与跨时区 Day 投影继续受 O-03 约束。
- 同一账号同一自然日最多属于一个 Trip。范围扩展遇到已占用日期时必须返回明确冲突，不重复占用、不静默覆盖、不自动合并；未来再由用户流程选择合并、调整或取消。

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

没有Trip级统一时区；生命周期日期的调度基准不能暗用服务器UTC，参见O-03。对夏令时重复/不存在钟点、跨日期线不确定归属，返回明确歧义，而不是自动纠正成看似有效的时间。

## 5. 一个节点，不复制跨日实体
跨日Visit或Transport是同一实体，在覆盖的Day里投影显示。费用不因重复显示而重复计数。跨日交通由真实出发/到达事实判断，不让用户手动给普通卡贴跨日标签。

不要只比较终点本地日期是否“大于”起点本地日期来推时长；跨时区航班可能本地到达钟点看起来更早。首轮先完成同一时区跨午夜与UTC时长测试；跨日期线Day投影待O-03。

## 6. 行程状态与监控状态分开
Trip生命周期提案：PLANNED、IN_PROGRESS、AWAITING_OUTCOME、FINISHED、NOT_TAKEN。FINISHED另带finishReason NORMAL/INCOMPLETE，不把不完整伪装成未去。

- 到起始日期进入IN_PROGRESS是运行假设，不自动生成Actual事实。
- NOT_TAKEN只能由用户确认；无数据不等于没旅行。
- 无法确认整趟是否发生，计划周期后AWAITING_OUTCOME并停止任务。
- 已有实际执行但尾段未知，可异常收尾；有争议按O-07不自动归类。

监控用户开关与当前运行状态也分开：`userEnabled` + OFF/IDLE/RUNNING/LIMITED。用户关掉后不因第二天或重新打开界面自动恢复；系统自然停止不改变userEnabled。

设备证据必须有deviceId、capturedAt、accuracy、source、receivedAt；晚到数据不能覆盖较新证据。位置输入只认用户授权客户端/主动填写，不通过服务器猜测。

## 7. Query / Preview / Adopt的事务规则
**Query**：传起終点、最早出发/最晚到达、日期时区、已有方案参考；返回候选与来源/有效期。不得写当前Trip。

**Preview**：以baseTripVersion、用户动作、provider snapshot和policyVersion计算变更。可保存临时候选，但不得修改正式节点/交通/通知。

**Adopt**：服务端重新校验权限、Trip版本、预览过期和Provider适用性；有效则一次事务落地节点、交通、来源与相关结果，并产生outbox事件。

必须有requestId/idempotencyKey；同一请求重试不能重复插入Visit、费用、任务或通知。相同key不同payload要拒绝。两设备同时采用同一baseVersion最多一个成功；另一个明确VERSION_CONFLICT。[S09]

一次采用失败不能只写了一半路线。外部API调用不要包在长数据库事务中：先取候选，事务提交时核验版本/快照有效性；必要时返回PREVIEW_STALE。

## 8. 撤销不是把世界倒回过去
单步、短时撤销恢复上一用户操作及其内部连带数据；不得回滚后续真实航班更新、实际位置或已发生事实。

若自上次操作后Trip版本已被其他设备修改，撤销返回UNDO_CONFLICT，不覆盖新改动。撤销成功后按最新可靠证据重新计算风险，不能恢复一个已经失真的“正常”状态。

Trip永久删除与不可逆合并不享有普通Undo；须用其已确认强提示流程。

## 9. API契约目录（蓝图，不要求P0全部实现）
| 范围 | 示例接口 | 必要边界 |
|---|---|---|
| 健康 | GET /health/live, /health/ready | 不含敏感配置 |
| 登录 | POST /auth/magic-link/request, /auth/magic-link/consume | 邀请、单次、过期、限流 |
| 会话 | POST /auth/logout, GET /me | server端撤销 |
| 管理 | POST /admin/invitations, POST /admin/users/{id}/disable, /revoke-sessions | 管理员不读取Trip |
| 行程 | POST /trips, GET /trips/{id}, PATCH /trips/{id} | owner验证、baseVersion |
| 节点 | POST /trips/{id}/commands | 类型化业务command，不接收随意数据库patch |
| 计算 | POST /trips/{id}/schedule/evaluate | 可解释、无正式写入 |
| 路线 | POST /trips/{id}/routes/query | 候选≠采用 |
| 预览 | POST /trips/{id}/previews | baseVersion+输入快照 |
| 采用 | POST /trips/{id}/previews/{pid}/adopt | 幂等+事务+版本 |
| 撤销 | POST /trips/{id}/operations/{oid}/undo | 仅最近一次且不覆盖新事实 |
| 通知 | GET /notifications, POST /notifications/{id}/dismiss | 归属隔离、抑制同一事件 |
| 附件 | POST /attachments/upload-intent, /complete, GET /attachments/{id}/download | 私有访问、类型/配额校验 |

命名可在P0调整，语义不可暗改。DTO不能暴露ORM内部表，也不能叫desktop-card/mobile-card。

## 10. 统一错误与解释结果
错误建议包含`code`、面向用户的中文`message`、`requestId`、`retryable`、必要的非敏感详情。示例：
UNAUTHENTICATED / FORBIDDEN / VERSION_CONFLICT / PREVIEW_STALE / DATE_OWNED / PROVIDER_UNAVAILABLE / NO_MATCHING_CANDIDATE / LOCATION_UNKNOWN / CONSTRAINT_CONFLICT / AMBIGUOUS_TIME_INPUT / UNSUPPORTED_SCENARIO。

`NO_MATCHING_CANDIDATE`与`PROVIDER_UNAVAILABLE`分开；都不能自动变成“今天没车”。数据错误不能以空数组悄悄隐藏。

每个时间结果/冲突至少带sourceRefs、规则ID、输入值、计算式的简短解释和policyVersion，不记录模型隐藏思维过程。示例：“20:21固定发车−40分钟最低预留=19:41到站目标”。

## 11. 测试与真实数据严格分开
Fixture数据明示SYNTHETIC，禁用于真实交通展示、Provider回退或production。Provider contract sample如含个人信息须脱敏且核对使用条款；测试日志不保存完整票据或令牌。

至少在正式UI前做一次真实接口字段与覆盖探针：到达/出发含义、时区、班次、站内步行、价格范围、停运、日期支持。探针失败记录缺口，不能用夹具“证明”接入完成。
