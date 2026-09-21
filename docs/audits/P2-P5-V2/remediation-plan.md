# Remediation Plan

本计划区分已确认产品原则、合理工程设计和仍需用户决定的少量细节。P5E2 指地面公共交通执行能力，不等于正式客户端或上线授权。

## 可独立优先修复

### 1. F-03 observation watermark/tombstone

不等待完整 AssistanceCapability：

- freshness/tombstone 不随事实 Undo 删除；
- 同 observation 与更旧 observation 稳定 no-op；
- 是否允许更新 observation 开启新推断周期需显式规则；
- 覆盖 Undo/observe owner-lock concurrency、Trip version、event/ACTUAL、airport trigger。

### 2. F-11 公共时间事实来源可信边界

- public client 只能声明用户来源；
- provider/adopted/derived source 只由受信 application adapter 写入；
- debug 输入如保留，必须是 development/test guard，不得仅靠 UI 文案；
- owner isolation 继续保留，但不能代替 writer provenance authorization。

### 3. F-13 执行事实因果不变量

- 明确 ARRIVAL→DEPARTURE 的最小偏序；
- Undo ARRIVAL 遇到 dependent DEPARTURE 应 conflict 或显式补偿，不可留下 orphan departure；
- frontier 遇到前序 open node + 后序 completed node 应输出可解释 conflict/unknown，不静默跳过。

## P5E2 设计/后端实现前

允许先做不依赖后台定位/主动监控的地面执行 domain/API 设计，但必须：

1. 记录 F-01/F-02/F-10 的**公共根因**：缺少最小 capability lifecycle/root authority。
2. 不默认建立 user/trip/binding/node 四层全量配置矩阵；先从实际需要的 flight monitoring、location assistance、auto-record scope 设计最小模型。
3. 固定已经确认的原则：逐项 opt-in、位置辅助与记录分权、pause/stop 不静默恢复、旅行结束停止普通协助、允许已批准短尾、不按服务器午夜截断。
4. 只把默认值、scope precedence、结束信号和 late job 处理作为待用户决定细节。

## P5E2 跨层验收前

- 修 F-03、F-11、F-13。
- 增加 F-09 synthetic API+PostgreSQL+Worker acceptance：Location→ACTUAL→Risk→airport trigger→Flight refresh/notification，含 retry/no duplicate。
- 处理 F-12：内部 Risk/Flight 事实可分开，但用户主动提醒需要明确 aggregation/suppression authority。
- 设备 A/B stale event、pause、Undo、Preview 必须纳入验收。

## 原生后台定位接入前

- 完成 F-02 capability scopes 与服务端 enforcement。
- 完成 F-04 evidence/reliability contract 和重复地点、重叠半径、pass-through、FreeAction/中途开始等轨迹验证。
- 明确 OS 权限/采样由客户端提供，但服务端不得把“收到 sample”视作 auto-record consent。

## 真实 Provider 使用前

- F-05 provider/account matrix：字段、TTL、attribution、删除、费用、覆盖、entitlement；公开资料不能替代账户证据。
- F-06 按已确认的 Push/Webhook 优先、Polling 补充、Query 按需落实现实能力；逐 provider 设计签名/认证，不假设统一回调机制。
- 不新增订阅、不付费、不删除现有 provider 数据，除非获得单独授权。

## 正式客户端、附件、Staging/Production 前

- 正式客户端前：F-01/F-02/F-03/F-04/F-10/F-11/F-12/F-13 与跨层验收完成；F-08 文案修正。
- Attachment/真实 storage 前：F-07 stale PENDING reconciliation 与 orphan cleanup。
- Staging/Production 前：真实 Mail/Route/ObjectStorage、HTTPS/ingress、隐私/备份、provider governance 分别过闸；P5E2 通过不等于这些授权。

## 推荐交付顺序

1. 独立修 F-03、F-11、F-13。
2. 最小 capability ADR（F-01/F-02/F-10），不做过度层级化。
3. 服务端 capability guards 与 late-job no-op。
4. F-04 evidence contract/轨迹验证。
5. F-09/F-12 跨层 acceptance 与提醒策略。
6. P5E2 地面执行能力，再另行决定正式客户端。
7. Provider governance、Storage cleanup 和上线闸门。

任何步骤若需要改变已确认产品原则、把 Notification 当作 Push 成功、以 mock 代替 PostgreSQL/Worker、或把公开网页当作账号 entitlement，都必须停止并单独报告。
