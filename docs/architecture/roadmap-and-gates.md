# 阶段计划、闸门与未决项

| 阶段 | 计划交付                                            | 当前状态                                                                                                           | 进入条件 / 关联未决项                                                                |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| P0   | 蓝图、workspace、API/Worker 健康、Compose、CI       | 已合并 main；main CI Run `35294938746` 通过                                                                        | 已完成                                                                               |
| P1A  | 邀请、Magic Link、可撤销多设备 Session、集中授权    | 已 Squash Merge；main CI Run `35309420185` 通过                                                                    | 已完成；真实邮件 provider 仍未配置                                                   |
| P1B1 | 持久 Job、Worker 执行框架、Magic Link 异步邮件      | 已 Squash Merge；main CI Run `35322043421` 通过                                                                    | 已完成；真实邮件 provider 仍未配置                                                   |
| P1B2 | NotificationEvent、ObjectStorage 边界               | 已 Squash Merge；main commit `ddd6b83b5c0c903f8291969aba6fee7a0f47a953`；main CI Run `35332091867` 通过            | 只含站内通知基础与私有本地测试存储，不进入 P2                                        |
| P2A  | Trip/DateOwnership/Place/Visit/FreeAction、版本     | 已 Squash Merge；main commit `59e82dae31c49457fafb53351b5fe0d48e8330c8`；main CI Run `35342774635` 通过            | 已完成；O-03/O-07 不阻塞当前基础自然日能力                                           |
| P2B  | Transport、失效历史、resolved 三层时间基础          | 已 Squash Merge；main commit `50866c4aa4ec122e4522920dcf2e53b551de7dfb`；main CI Run `35353581612` 通过            | 已完成；O-03/O-07 不阻塞已交付的基础边界                                             |
| P3A  | DayOccurrence identity、sequence 与节点日期卡归属   | 已 Squash Merge；main commit `330f9f2d469f5ff1eda7a98d45457f9c21c7265f`；main CI Run `35409984734` 通过            | 已完成 foundation；solver、跨日 Transport 投影与 DST 输入 UI 仍后置                  |
| P3B1 | UserTimeIntent、最低停留、lock 与只读约束评估       | 已 Squash Merge；main commit `d4fb0f59b9bd0775bc0f35e801acde262cec0d8d`；main CI Run `35415523541` 通过            | 已完成当前状态评估基础；不自动改时间或推荐                                           |
| P3B2 | 确定性时间上下界传播、来源与客观冲突                | 已 Squash Merge；main commit `0c5fcbdfe09b049c5fbbf77abe20ec296ded4383`；main CI Run `35418153790` 通过            | 已完成只读传播；不写 PLANNED、不查询 Provider、不生成推荐                            |
| P3B+ | 完整路线求解、候选与推荐衔接                        | 未授权、未实现                                                                                                     | P3B2 只产出要求窗口；P4 路线候选、Preview/Adopt 与 RecommendationPolicy 仍须单独授权 |
| P4A1 | Provider-neutral Route Query、候选归一化与二次校验  | 已通过 PR #12 Squash Merge；main commit `4a50beb711e2c56679b9b846ca6a4d9ff56403cb`；main CI Run `35420894762` 通过 | 仅 SYNTHETIC 测试适配器；真实/付费 Provider 未接入                                   |
| P4B1 | 服务端 Candidate Snapshot 与持久 Preview foundation | 已通过 PR #13 Squash Merge；main commit `9ec780d010257f0c98dba58928a68920bfa4308c`；main CI Run `35423819550` 通过 | immutable snapshot/preview foundation 已完成；真实/付费 Provider 仍未接入            |
| P4B2 | Adopt、事务/幂等、正式节点与交通写入                | 已通过 PR #14 Squash Merge；main commit `66ffaed90acaa08798dd3afe6ff62c13d80cb667`；main CI Run `35430697966` 通过 | Preview v2、AdoptedRoute、跨日投影、OperationReceipt 与 outbox 已完成                |
| P4B3 | Route Adopt 单步 Undo                               | 已通过 PR #15 Squash Merge；main `d00c053f7bafdc0c6cbf8b2e03fe7682fe08cc4c`；CI `35434086597` 通过                 | 已完成短时单步前向补偿；不包含 Undo stack 或 Redo                                    |
| P5A  | Dev/Test Debug Web 薄测试台                         | 已通过 PR #16 合并；main `cbf9fe2a727011e4708585ef259c3324c05b4362`；CI `35435976817` 通过                         | 只串联真实 API；非正式客户端，不包含 RecommendationPolicy、监控、Push 或离线编辑     |
| P5B  | Development/Test 内部验收与环境闸门                 | 已授权，在 `feature/p5b-internal-acceptance` 实施                                                                  | ≤5 synthetic 用户跨层验收；不是性能容量认证、Staging 许可或 Production readiness     |
| P5C+ | 后续执行/提醒/正式客户端能力                        | 未授权、未实现                                                                                                     | 根据内部验收结果另行决定；O-09 上线配置仍 Deferred                                   |

O-09 保持 Deferred。O-11 的产品规则已确认，但正式回顾/分享 UI 与匿名访问仍未实现。协作、公众注册、
原生客户端/Push、天气、预算、OCR、多人分摊、完整订单、完整审计和异地灾备均不在首轮批量开发范围。

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
- O-00 已解决。P1B2 已 Squash Merge 到 main，main CI Run `35332091867` 的 `verify` 与
  `Compose verification` 均已通过，远程 `feature/p1b2-notifications-storage` 已删除。
- O-01/O-02 当时由用户正式确认并先行落档；这解除了 G2/P2 对日期范围与 DateOwnership
  规则的阻塞，但不等于自动授权 P2 代码实现。O-03/O-07 在当时尚未确认，后续产品规则状态见
  PR #8 记录。
- PR #5 已 Squash Merge；O-01/O-02 文档基线 main commit 为
  `4759846ed1fd2d1511e4a9cbc2529119b48640f1`，main CI Run `35335051632` 的
  `verify` 与 `Compose verification` 均为 success；远程 `feature/p2-prep-day-ownership`
  已删除。P2A 已获单独授权并在 `feature/p2a-trip-core` 实施。
- PR #6 已 Squash Merge；P2A 正式 main commit 为
  `59e82dae31c49457fafb53351b5fe0d48e8330c8`，main CI Run `35342774635` 的
  `verify` 与 `Compose verification` 均为 success；远程 `feature/p2a-trip-core` 已删除。
  P2B 随后获单独授权，只实施相邻交通、历史与 resolved 三层时间基础。
- PR #7 已 Squash Merge；P2B 正式 main commit 为
  `50866c4aa4ec122e4522920dcf2e53b551de7dfb`，main CI Run `35353581612` 的
  `verify` 与 `Compose verification` 均为 success；远程 `feature/p2b-transport-temporal`
  已删除。P2B 本身没有实现 O-03/O-07 高级能力。
- PR #8 已 Squash Merge；规格基线 main commit 为
  `be573533e025acc3730f44ad3dc7d4499ed55d1b`，main CI Run `35366718778` 的 `verify` 与
  `Compose verification` 均为 success。该 PR 在 `feature/p3-prep-o03-timeline-days` 仅落档
  产品规则：O-03（含 DST）至 O-08、
  O-10 与 O-11 均在产品规则层面 RESOLVED；O-09 保持 Deferred。无业务代码、migration、P3
  solver、RecommendationPolicy、P4 Provider、实时监控、故障客户端、图片备份或回顾/分享实现。
  P3A 的 DayOccurrence/sequence foundation 已通过 PR #9 合并到 main，main CI Run `35409984734` 通过。
  P3B1 已通过 PR #10 Squash Merge 到 main，main CI Run `35415523541` 通过。P3B2 已通过 PR #11
  Squash Merge 到 main `0c5fcbdfe09b049c5fbbf77abe20ec296ded4383`，main CI Run `35418153790`
  通过。P4A1 已通过 PR #12 Squash Merge 到 main `4a50beb711e2c56679b9b846ca6a4d9ff56403cb`，
  main CI Run `35420894762` 通过。P4B1 已通过 PR #13 合并到 main
  `9ec780d010257f0c98dba58928a68920bfa4308c`，main CI Run `35423819550` 通过。P4B2 已通过
  PR #14 合并到 main `66ffaed90acaa08798dd3afe6ff62c13d80cb667`，main CI Run `35430697966`
  通过。P4B3 随后获得单独授权，只实现最近一次 Route Adopt 的短时安全补偿；真实 Provider、推荐、
  多级 Undo/Redo 与 Production 仍未授权。

## P1A → P1B 邮件安全闸门

- P1A 的 Magic Link 邮件只建立客户端 landing URL 契约：token 放在 URL fragment，
  consume API 只接受 POST body；没有用 GET 直接创建 Session。
- P1B1 将公开 request endpoint 改为对所有通过格式和节流检查的请求执行同一事务入队；
  账号/邀请资格检查与邮件 I/O 移到 Worker，解决同步 provider 的响应时间枚举边界。
- 真实邮件 provider 仍未配置，Production 仍未授权；即使异步架构验证通过，也不得宣称
  公网正式邮件登录已完成。

## O-09 上线配置（Deferred）

- P1B2 使用 `OBJECT_MAX_FILE_BYTES`、`OBJECT_MAX_USER_TOTAL_BYTES` 和
  `OBJECT_ALLOWED_MEDIA_TYPES` 作为服务端边界。
- Development/Test 允许明确的 SYNTHETIC 工程默认值；这些数值不是永久产品承诺。
- Staging/Production 必须显式配置限额与 allowlist，且在真实 ObjectStorage provider 获得
  授权并实现前，上传能力保持 `OBJECT_STORAGE_PROVIDER_UNCONFIGURED`。
- 正式 Attachment/upload API 或 Staging/Production ObjectStorage 启用前，必须实现 stale
  PENDING reservation 的 expiry/reconciliation，并处理 provider 侧 orphan temporary/object；
  否则进程崩溃后的预留可能永久占用 quota。该项是上线硬闸门。
- O-09 的附件最终大小/数量/总存储额、邮件 Provider、外部部署参数与 Session 最终时长继续后置；
  不在 PR #8 决定。正式值仍待对应上线阶段确认，不解除 Production 闸门。
