# 阶段计划、闸门与未决项

| 阶段 | 计划交付                                           | 当前状态                                        | 进入条件 / 关联未决项                                 |
| ---- | -------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| P0   | 蓝图、workspace、API/Worker 健康、Compose、CI      | 已合并 main；main CI Run `35294938746` 通过     | 已完成                                                |
| P1A  | 邀请、Magic Link、可撤销多设备 Session、集中授权   | 已 Squash Merge；main CI Run `35309420185` 通过 | 已完成；真实邮件 provider 仍未配置                    |
| P1B1 | 持久 Job、Worker 执行框架、Magic Link 异步邮件     | 已 Squash Merge；main CI Run `35322043421` 通过 | 已完成；真实邮件 provider 仍未配置                    |
| P1B2 | NotificationEvent、ObjectStorage 边界              | 实现完成；Draft PR #4 等待最终验收/合并         | 只含站内通知基础与私有本地测试存储，不进入 P2         |
| P2   | Trip/Day/Visit/Transport、版本、基础生命周期       | 未授权、未实现                                  | 集中确认 O-01 与 O-02；O-07 阻塞自动收尾              |
| P3   | 双向传播、来源解释、约束与冲突                     | 未授权、未实现                                  | fixture 语义一致；O-03 高级时区不明时返回 UNSUPPORTED |
| P4   | Provider 探针、候选、Preview/Adopt、事务/幂等/撤销 | 未授权、未实现                                  | Provider 字段验证；O-04/O-05/O-06 限制自动判断        |
| P5   | 薄测试台、站内通知、已确认流程 E2E                 | 未授权、未实现                                  | 鉴权/隔离/HTTPS/邮件闸门；O-08/O-10 需测试配置        |

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
- PR #2 已 Squash Merge；P1A main commit 为
  `17591cfc2bf8eb4bdd753c321a7572fd10bf8322`，main CI Run `35309420185`
  的 `verify` 与 `Compose verification` 均为 success。
- PR #3 已 Squash Merge；P1B1 main commit 为
  `200e26ad85d6b41533d87fb8841729cfd5a2a688`，main CI Run `35322043421`
  的 `verify` 与 `Compose verification` 均为 success；远程
  `feature/p1b1-jobs-mail` 已删除。
- O-00 已解决。P1B2 已获单独授权；P2 及之后仍受阶段闸门约束。

## P1A → P1B 邮件安全闸门

- P1A 的 Magic Link 邮件只建立客户端 landing URL 契约：token 放在 URL fragment，
  consume API 只接受 POST body；没有用 GET 直接创建 Session。
- P1B1 将公开 request endpoint 改为对所有通过格式和节流检查的请求执行同一事务入队；
  账号/邀请资格检查与邮件 I/O 移到 Worker，解决同步 provider 的响应时间枚举边界。
- 真实邮件 provider 仍未配置，Production 仍未授权；即使异步架构验证通过，也不得宣称
  公网正式邮件登录已完成。

## O-09 对象存储限额

- P1B2 使用 `OBJECT_MAX_FILE_BYTES`、`OBJECT_MAX_USER_TOTAL_BYTES` 和
  `OBJECT_ALLOWED_MEDIA_TYPES` 作为服务端边界。
- Development/Test 允许明确的 SYNTHETIC 工程默认值；这些数值不是永久产品承诺。
- Staging/Production 必须显式配置限额与 allowlist，且在真实 ObjectStorage provider 获得
  授权并实现前，上传能力保持 `OBJECT_STORAGE_PROVIDER_UNCONFIGURED`。
- 正式 Attachment/upload API 或 Staging/Production ObjectStorage 启用前，必须实现 stale
  PENDING reservation 的 expiry/reconciliation，并处理 provider 侧 orphan temporary/object；
  否则进程崩溃后的预留可能永久占用 quota。该项是上线硬闸门。
- O-09 的正式产品数值仍待上线阶段确认，不解除 P2 或 Production 闸门。
