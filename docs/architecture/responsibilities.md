# 关键责任与事务边界

## 账号与 Session（P1A）

- Invitation 控制可注册邮箱；Magic Link 短期、单次、只保存摘要，并在事务中条件消费。
- Session 由服务端过期和撤销；多设备各有独立 Session，账号禁用使现有会话全部失效。
- actor/owner 来自已验证 Session，不接受客户端传入 ownerId。
- 管理员只能做账号管理；不因此获得读取他人 Trip、附件、位置或费用的权限。
- `authorize(actor, action, resource)` 是集中授权入口；管理员没有私人资源通配规则。
- Session 验证与 credential 的 HTTP 携带方式分离。P1A 测试 API 使用 opaque bearer；
  未来 Cookie / 原生安全存储属于 transport adapter。
- Magic Link request 的节流状态保存在 PostgreSQL；已知和未知邮箱返回相同通用响应。
- Development/Test 邮件只进入 SYNTHETIC 捕获器；真实 staging provider 尚未配置。

P1A 已实现上述数据表、迁移和最小端点；不包含任何 Trip 私有资源实现。

## Job 与 Worker（P1B1，已授权）

- Job 持久化到 PostgreSQL，至少包含 runAt、status、attempts、leaseUntil、
  uniqueKey 和 payloadRef。
- Worker 通过租约/行锁领取，任务幂等、有限重试、退避、超时、失败可见并支持撤销。
- Magic Link 的节流状态、DeliveryRequest 与 Job 在同一事务写入；外部邮件副作用为
  at-least-once，不宣称 exactly-once。
- Worker 调用 application 用例，不绕过资源归属、Trip 版本或监控开关。
- `Job.payloadRef` 只引用类型化业务记录；不保存任意 JSON、原始登录 token 或完整链接。
- Worker 从 DeliveryRequest ID、持久 tokenGeneration 和 Git 外 `MAGIC_LINK_TOKEN_KEY` 派生
  可重试的原始 token，PostgreSQL 仍只保存 SHA-256 digest。TTL 内重试保持 generation；过期
  重试在行锁事务内轮换 generation 与 digest，旧链接不会复活。
- Staging/Production 要求至少 32-byte、由密码学安全随机源生成且以 canonical base64url 或
  hex 编码的 key。程序只验证格式与解码长度，不宣称能证明随机熵。

P1B1 在 P0 健康心跳之上增加 JobRunner；WorkerRuntime 只负责进程生命周期，Runner 负责
poll/claim/lease/timeout/retry，Handler 只处理 `MAGIC_LINK_EMAIL`。P1B2 的
NotificationEvent / ObjectStorage 已获单独授权并在独立功能分支实施。

## Trip 日期范围与 DateOwnership（P2A）

- O-01/O-02 已确认；P2A 建立 Trip、DateOwnership、Place 与 ItineraryNode migration/API。
- 有效日期范围由最早至最晚有效行程内容自然日决定；范围内所有自然日（含中间空白日）归属该 Trip。空 Trip 不占用自然日，创建时的 `start date` 只是规划/编辑锚点。
- 首尾空白日仅可作为临时编辑态；没有有效内容就离开编辑时自动消失，首尾最后一个有效内容被移除后范围向内收缩。临时首尾日不创建 `DateOwnership`，V1 不提供保留开关。
- 有效行程内容包括未来的 Visit、FreeAction、Transport 或其他真实行程实体；note、todo、普通备注、Attachment、Expense、NotificationEvent 与偏好单独存在时不撑开范围。跨午夜/跨时区投影遵守 O-03；P3A 已落地 sequence/DayOccurrence foundation，跨日 Transport 投影仍待实现。
- 同一账号同一自然日最多属于一个 Trip。冲突必须明确返回，不能重复归属、静默覆盖或自动合并；日期锚点、有效范围与 `DateOwnership` 必须是可区分的概念。
- `DateOwnership(ownerUserId, localDate)` 是跨 Trip 唯一自然日归属事实；`DayOccurrence` 是 Trip
  内可重复 localDate 的日期卡身份和排序事实，两者职责不同，不能互相替代。
- 结构 mutation 先取得 owner-scoped advisory transaction lock，再锁定并校验 Trip version；
  节点写入、range/ownership reconciliation 与 version+1 原子完成。
- P2A 交付时只支持同日排序；P3A 已增加明确 occurrence 的跨卡移动 foundation。时间传播、跨日
  Transport 投影与生命周期仍后置。

## 相邻 Transport 与 resolved 时间（P2B）

- `TransportEdge` 只代表当前 timeline 中相邻 PLACE_VISIT 间已确认的手工交通；缺少交通由
  connection projection 的 `MISSING` 表达，不创建空行、默认步行或其他假交通。
- 结构命令完成后只归档不再属于当前 adjacency 的边。删除 Node、Replace Place、用户替换与
  清除使用明确原因；新 adjacency 不继承旧交通。
- FreeAction 没有固定位置，不允许 TransportEdge。Place→FreeAction / FreeAction→FreeAction
  为 `NOT_APPLICABLE`；FreeAction→Place 为 `RUNTIME_ORIGIN_REQUIRED`。
- 节点写入、Transport 历史快照、current edge 删除、DateOwnership reconciliation 与单次
  Trip version 增量共享一个 owner-scoped transaction。
- `TemporalValue` 是已经解析的绝对时间结果，按 Node/Transport、ARRIVAL/DEPARTURE 与
  PLANNED/ESTIMATED/ACTUAL 分离；权威值为 `instant + IANA timeZone`，不保存 local datetime
  副本，也不承载用户约束。
- Transport 归档时将相关时间值复制到强类型历史表；三层时间不会因 current edge 删除而丢失。
- P2B 不公开任意时间写 HTTP API，不实现传播、反推、Provider、Preview/Adopt、风险或生命周期。

## Timeline 与 DayOccurrence（P3A foundation）

- Domain 的真实先后关系必须使用独立 timeline sequence；有明确 instant 时按 instant 判断时间先后。
  `localDate` / `localTime` 是当地显示信息，不能承担整趟 Trip 的排序职责。
- `DayOccurrence(id, tripId, localDate, sequence)` 是持久日期卡身份；同一 Trip 的 sequence 唯一，
  `localDate` 不唯一。节点通过 `(dayOccurrenceId, tripId)` 强 FK 归属日期卡，整趟正式顺序为
  `DayOccurrence.sequence + ItineraryNode.position`。
- Trip read model 为每张卡返回 `dayOccurrenceId/localDate/sequence/nodes`。新增内容使用明确的
  EXISTING/NEW 日期卡目标，移动使用目标 dayOccurrenceId；不按重复 localDate 猜卡。
- `DateOwnership` 继续负责用户自然日到 Trip 的唯一归属。同一 Trip 的重复日期卡共享一份自然日
  归属；另一 Trip 仍不能占用该日期。
- 连续跨日 Transport 始终是单一实体，只在真实经过的 DayOccurrence 中重复投影。完全被 Transport
  覆盖的中间自然日进入范围和 ownership，但拒绝普通 Place/FreeAction 内容。
- 跨日期线导致 localDate 回拨时保留真实日期并按 sequence 生成新卡；跨时区但 localDate 不变、
  仅钟点回拨时仍在同一卡继续，由 Transport 显示时区切换。
- 执行阶段的当前当地时区来源优先级为可靠设备定位、设备时区、行程地点时区上下文；服务端默认
  时区不得参与。位置/时区上下文不能生成 Visit 完成、具体地点到达或 ACTUAL 事实。
- 可靠结构化数据已有 instant/offset 时直接确定 DST occurrence；只有手工 local clock 且重复时，
  application 必须要求用户选前/后 occurrence，不得默认。不存在的当地时间明确拒绝，不平移。
- P3A 已将 current Transport adjacency 与失效判断切换到 occurrence sequence，并保持结构、历史、
  ownership 与 Trip version 同事务。跨日 Transport 多卡投影、交通占用日、DST command/UI、solver
  与时间传播仍未实现。

## 受保护安排（O-04 产品规则已确认，仅规格）

- 保护来源只接受可靠结构化事实（例如已采用固定班次、结构化确认的预约/门票时间）或用户主动
  明确标记“已预订 / 时间固定”。
- application 不解析备注、附件、待办或自然语言猜预约状态；这些内容不能自行升级为保护事实。
- 首版结构化确认保持轻量，不要求订单号、截图、付款凭证、OCR 或完整订单模型。
- solver 将保护作为优先保留约束；无法同时满足时返回冲突和影响，由用户决定，不伪造可行结果，
  也不把“保护”解释为永远禁止修改。
- Provider/Booking 如何产生可靠结构化确认属于后续 adapter/use case，不再是产品规则未决项。

## 推荐策略（O-05 产品规则已确认，仅规格）

- domain/application 不定义跨场景全局体验最低值；只有用户对具体活动明确设置的最低时长才是
  硬约束。
- RecommendationPolicy 将先过滤违反事实、受保护安排和用户硬约束的候选，再以保护固定内容与
  最小改动为基线，比较成本、体验、时间、风险和影响范围，并输出解释。
- 偏好只能影响可行候选之间的排序，不能覆盖事实和硬约束；禁止全局固定权重、永久最便宜/最快
  优先级或为凑数生成候选。
- application 契约为 1 个主推荐和最多 2 个可靠备选；无可靠解时明确返回没有可确认方案。
- RecommendationPolicy 与相关 UI 尚未实现，本节不授权 P3/P4 代码。

## 外部预约调整（O-06 产品规则已确认，仅规格）

- application 可以建议新的外部预约时刻，但用户负责在产品外联系并完成调整。
- 用户点击“已调整”是继续规划所需的用户确认；V1 不要求 API 回执、订单号、截图、付款证明或
  OCR，也不建立复杂的外部预约状态机。
- contracts/projection 必须保留确认来源，表述为用户确认，不得伪装为商家官方确认、有位或
  Provider 已核验。失败后允许用户再次调整。
- 真实 Provider 是 adapter 增强能力，尚未实现，也不是 P3/P4 核心产品逻辑前置条件。

## Trip 自然结束（O-07 产品规则已确认，仅规格）

- 用户可见生命周期为计划中、进行中、已结束、未执行。计划日期结束后自然进入已结束，不依赖
  Actual、定位、App 使用记录或用户确认。
- Actual 与执行证据按实际取得量保存，缺失保持 unknown；它们服务于提醒、风险、调整与历史回看，
  不承担“证明旅行发生”的职责。
- application 不创建“是否去过”“等待结果”或“记录不完整待处理”的用户任务。底层技术状态如有
  必要，不得成为用户必须处理的流程。
- `NOT_TAKEN` 只能由用户主动明确表示没去；缺定位、未打开 App、无 Actual 或无执行数据都不能
  自动触发。
- 生命周期自动迁移尚未实现，本次不修改 P2A/P2B 业务代码。

## 实时监控与提醒（O-08 产品规则已确认，仅规格）

- application 将用户开关与 OFF/IDLE/RUNNING/LIMITED 分开；定位权限丢失进入 LIMITED，不改
  `userEnabled`。恢复时重新同步，旧位置和中断过程不能伪造成当前事实。
- 风险事件以 stable key、severity、basisVersion 和用户接受/snooze 状态去重。同一等级默认只主动
  提醒一次；严重等级升级、新重要事实或 snooze 到期且风险仍在才允许再次提醒。
- 固定提醒与动态监控是独立 capability。关闭实时监控不删除固定提醒；当前进度 unknown 不阻止
  固定提醒，但动态推断保持 unknown。过期固定提醒不补发旧指令。
- presentation/notification adapter 负责相同目的去重、关键事项优先及“关键提醒 + N 个待办”摘要；
  低优先级待办仍保留。任何投递 adapter 都不能承诺 100% 到达。
- O-08 尚未实现；P1B2 `NotificationEvent` 基础不等于实时监控、客户端通知或 Push 已完成。

## Provider 与核心故障边界（O-10 产品规则已确认，仅规格）

- Provider adapter 各自独立降级；单一铁路、航班或地图故障只让对应实时/路线结果 unavailable 或
  unknown，不阻塞 Trip 核心读取，也不生成未经确认的实时事实。
- presentation 可提供官网/Google Maps/Apple Maps 等人工查询链接，但外部页面内容不会绕过
  Provider contract 自动写为系统事实。
- 核心 API 不可用时客户端进入明确不可用态，不把缓存当当前可靠行程；V1 不承担完整离线编辑。
- 静态行程图片备份属于导出/应急参考边界：带生成时间、不自动同步、不可离线编辑，旅行前只提醒
  一次。相关客户端与导出能力尚未实现。

## 历史回顾、分享与复制（O-11 产品规则已确认，仅规格）

- 历史 Trip 是源数据，回顾是 projection，不建立第二套事实数据库。没有 Actual 不自动排除最终
  保留内容；只有明确跳过/取消/删除/修正或可靠未执行事实才排除。
- 回顾按 timeline sequence / DayOccurrence 投影地点、FreeAction/特别体验；普通 TransportEdge
  不进入主线，体验型交通以体验内容呈现。跨日期线不按 localDate 重排。
- 静态图片/分享快照不随历史编辑变化；每次生成是独立版本。匿名可读分享默认长期有效，由 owner
  主动停止。默认不暴露交通细节、待办、风险、订单、费用、私人备注或附件。
- copy use case 才要求登录，并创建新的计划中 Trip；日期、人数、名称由接收者确认，地点/顺序和
  当地时间仅作规划参考，原 Actual、私有数据和历史执行事实不复制。
- O-11 规则不代表回顾 UI、匿名分享权限、快照存储或复制事务已经实现。

## 站内通知（P1B2）

- `NotificationEvent` 是用户私有、不可由客户端任意创建的持久事件；可信 application / worker
  用例以明确 owner 和 `(ownerUserId, dedupeKey)` 幂等边界创建。
- `GET /notifications` 只列出当前 Session actor 的通知，按 `createdAt + id` 稳定倒序分页；
  已 dismiss 的事件保留并返回 `dismissedAt`，不物理删除证据。
- `POST /notifications/:id/dismiss` 只能操作 actor 自己的记录并保持幂等。ADMIN 身份不获得
  其他用户通知的读取或修改权。
- P1B2 不生成风险业务语义、不实现 Push、偏好或正式通知 UI。

## 私有对象存储（P1B2）

- `packages/storage` 定义流式 `put/open/delete/stat/exists` port；application 只依赖 port，
  不接触文件系统路径或未来 S3 SDK。
- `StoredObject` 只保存 owner、服务端随机 key、状态、展示元数据、真实 byte size 和 SHA-256；
  PostgreSQL 不保存二进制内容，P2 前也不创建虚假 Trip 关联。
- owner 来自已验证 actor；ADMIN 无跨用户通配权。只有 `READY` 可读，`DELETED` 不可恢复为
  可读状态。
- Development/Test 的本地适配器限定私有 root、UUID key、临时文件、实际大小/hash 校验与
  atomic rename，并拒绝 traversal、绝对路径和 symlink。Staging/Production provider 未配置。
- 单文件、用户总量和 MIME allowlist 均为环境配置；用户总量预留在 PostgreSQL 事务中按 owner
  advisory lock 串行化，避免并发明显超卖。O-09 正式产品数值仍未决定。

## Trip 版本（P2 起）

- P2A 已实现每次正式 Trip 写入递增一次服务端版本。
- 多设备写操作携带 baseTripVersion；旧版本返回 VERSION_CONFLICT。
- Query 与 Preview 不递增正式 Trip 版本。
- 已执行事实和后来的可靠证据不会被排程重算或 Undo 覆盖。

## Query / Preview / Adopt（P4）

| 操作    | 正式 Trip 写入 | 必须校验                                            |
| ------- | -------------- | --------------------------------------------------- |
| Query   | 否             | 权限、输入语义、Provider 状态；返回来源和有效期     |
| Preview | 否             | 权限、baseTripVersion、输入/Provider/策略快照       |
| Adopt   | 是，单一事务   | 权限、当前版本、预览有效期、Provider 适用性、幂等键 |

Adopt 一次事务写入节点、交通、来源、版本和 outbox。同一幂等键不同 payload 必须
拒绝；两台设备基于同一版本时最多一个成功。外部 API 调用不放进长数据库事务。

Undo 是受约束的新操作：它不倒退外部世界，不覆盖 Adopt 后的新事实或其他设备修改。
