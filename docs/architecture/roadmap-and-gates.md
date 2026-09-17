# 阶段计划、闸门与未决项

| 阶段 | 计划交付                                                   | 当前状态                                    | 进入条件 / 关联未决项                                 |
| ---- | ---------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| P0   | 蓝图、workspace、API/Worker 健康、Compose、CI              | 修正与补验已完成；CI Run `35217118090` 通过 | O-00 bootstrap 已解决；等待 Draft PR 验收，不解锁 P1  |
| P1   | 邀请、Magic Link、可撤销 Session、隔离、持久 Job、存储契约 | 未授权、未实现                              | P0 PR 验收；O-09 的限额/邮件/会话值按配置落地         |
| P2   | Trip/Day/Visit/Transport、版本、基础生命周期               | 未授权、未实现                              | 集中确认 O-01 与 O-02；O-07 阻塞自动收尾              |
| P3   | 双向传播、来源解释、约束与冲突                             | 未授权、未实现                              | fixture 语义一致；O-03 高级时区不明时返回 UNSUPPORTED |
| P4   | Provider 探针、候选、Preview/Adopt、事务/幂等/撤销         | 未授权、未实现                              | Provider 字段验证；O-04/O-05/O-06 限制自动判断        |
| P5   | 薄测试台、站内通知、已确认流程 E2E                         | 未授权、未实现                              | 鉴权/隔离/HTTPS/邮件闸门；O-08/O-10 需测试配置        |

O-11 只影响正式回顾/分享 UI，本轮后置。协作、公众注册、原生客户端/Push、天气、
预算、OCR、多人分摊、完整订单、完整审计和异地灾备均不在首轮批量开发范围。

## O-00 当前事实

- 目标远程：`https://github.com/tonivikingdom/TRAVEL-V1.git`
- 已获一次性 bootstrap 授权；main 初始化提交为
  `74ad1cf3e4c6985482e5ce655b88388a0d2b5196`，只包含 `README.md` 与 `.gitignore`。
- 当前 `feature/p0-foundation` 远程 HEAD 为
  `92b2d02e9a4d7d9d8d340eaf913b0ccf9cc3119f`，与本地一致；PR #1 为 Draft，目标为
  `feature/p0-foundation → main`。
- GitHub CI Run `35217118090` 的 `verify` 与 `Compose verification` 均已通过；本机
  未安装 Docker/Compose，因此本机容器验证仍未运行。
- O-00 已解决，但 P1 仍需用户确认 P0 PR 后单独授权；本次不合并、不自动合并、不进入 P1。
