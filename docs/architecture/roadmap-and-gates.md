# 阶段计划、闸门与未决项

| 阶段 | 计划交付                                           | 当前状态                                    | 进入条件 / 关联未决项                                 |
| ---- | -------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| P0   | 蓝图、workspace、API/Worker 健康、Compose、CI      | 已合并 main；main CI Run `35294938746` 通过 | 已完成                                                |
| P1A  | 邀请、Magic Link、可撤销多设备 Session、集中授权   | 已授权；本分支实现并等待 CI / Draft PR 验证 | O-09 的邮件与 TTL 采用配置；真实邮件仍未配置          |
| P1B  | 持久 Job、NotificationEvent、ObjectStorage 边界    | 未授权、未实现                              | P1A 验收后另行授权；不得由 P1A 自动进入               |
| P2   | Trip/Day/Visit/Transport、版本、基础生命周期       | 未授权、未实现                              | 集中确认 O-01 与 O-02；O-07 阻塞自动收尾              |
| P3   | 双向传播、来源解释、约束与冲突                     | 未授权、未实现                              | fixture 语义一致；O-03 高级时区不明时返回 UNSUPPORTED |
| P4   | Provider 探针、候选、Preview/Adopt、事务/幂等/撤销 | 未授权、未实现                              | Provider 字段验证；O-04/O-05/O-06 限制自动判断        |
| P5   | 薄测试台、站内通知、已确认流程 E2E                 | 未授权、未实现                              | 鉴权/隔离/HTTPS/邮件闸门；O-08/O-10 需测试配置        |

O-11 只影响正式回顾/分享 UI，本轮后置。协作、公众注册、原生客户端/Push、天气、
预算、OCR、多人分摊、完整订单、完整审计和异地灾备均不在首轮批量开发范围。

## O-00 当前事实

- 目标远程：`https://github.com/tonivikingdom/TRAVEL-V1.git`
- 已获一次性 bootstrap 授权；main 初始化提交为
  `74ad1cf3e4c6985482e5ce655b88388a0d2b5196`，只包含 `README.md` 与 `.gitignore`。
- PR #1 已 Squash Merge，main 正式 P0 基线为
  `93741a4c8641a1225632eaee381b6f706678245b`。
- main CI Run `35294938746` 的 `verify` 与 `Compose verification` 均已通过；远程
  `feature/p0-foundation` 已删除。
- O-00 已解决。P1A 已获单独授权；P1B 与 P2 之后仍受阶段闸门约束。

## P1A → P1B 邮件安全闸门

- P1A 的 Magic Link 邮件只建立客户端 landing URL 契约：token 放在 URL fragment，
  consume API 只接受 POST body；没有用 GET 直接创建 Session。
- 当前 `requestMagicLink` 仅对合法账号调用 `MailSender`，未知账号不调用；若未来接入
  真实同步邮件 provider，公开 request endpoint 可能暴露响应时间差。
- P1A 不使用固定 sleep 或随机延迟伪装修复。进入 P1B 前，必须引入持久 Job / outbox，
  将真实邮件发送异步化，并完成真实邮件服务配置与独立安全验证；此前不得宣称公网正式可用。
