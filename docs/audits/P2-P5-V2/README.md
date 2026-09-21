# P2–P5 Full Product & Engineering Audit V2

## 审计边界

- 仓库：`tonivikingdom/TRAVEL-V1`
- 固定基线：`317a08ed4c9d5ff0fcb455573a012762269eaaf7`
- 审计日期：2026-09-21
- 审计分支：`audit/p2-p5-deep-review-v2`
- 范围：P2A/P2B、P3A/P3B1/P3B2、P4A1/P4B1/P4B2/P4B3、P5A/P5B/P5C、P5D1/P5D2/P5D3、P5E1，以及 Auth/Session、Job/Worker、Notification/Outbox、ObjectStorage。
- P5E2 仅审计设计前置条件；没有实现 P5E2。

本目录只包含审计报告、证据索引和隔离复现材料。没有修改业务代码、数据库 schema、migration 或 Git 历史。

## 总结

基线具备一条相当完整、并且在当前 CI 中持续通过的核心链路：账户与 Magic Link、持久 Job/Worker、Trip/DayOccurrence、三层时间事实、时间意图与只读传播、路线查询/Preview/Adopt/Undo、执行风险、航班事实与后台监控、位置推断与事实 Undo。事务、版本、owner isolation、幂等和历史保留整体设计较严谨。

但“已具备执行能力”不等于“可以在 P5E2 客户端中默认开启协助”。九条新产品规则揭示的主要缺口集中在：能力级 opt-in/暂停/停止、位置收集与自动记录的独立授权、自动推断证据强度、Undo 后旧位置样本重放、协助生命周期，以及真实 Provider 的留存/归因/采集方式决策。

## Findings 概览

| 分类             |   数量 | 最高严重度 |
| ---------------- | -----: | ---------- |
| DEFECT           |      2 | HIGH       |
| PRINCIPLE_GAP    |      4 | HIGH       |
| PRODUCT_DECISION |      2 | HIGH       |
| VERIFICATION_GAP |      2 | HIGH       |
| **合计**         | **10** | **HIGH**   |

没有发现需要立即停止开发或回滚正式数据的 CRITICAL finding。`P5E2` 开始实现前有 5 个 must-fix/must-decide 项，见 [remediation-plan.md](./remediation-plan.md)。

## 文件索引

- [principles.md](./principles.md)：R1–R9 逐条核验。
- [coverage.md](./coverage.md)：模块与跨模块覆盖矩阵。
- [findings.md](./findings.md)：10 个可定位、可复现、可分派的 finding。
- [verification.md](./verification.md)：本机与正式 CI 验证记录、外部来源。
- [remediation-plan.md](./remediation-plan.md)：修复顺序、P5E2 前置闸门。
- [repro/](./repro/)：隔离复现说明和纯 Domain 演示。

## 重要限制

- 本机没有 Docker CLI，且没有配置 `TEST_DATABASE_URL`；本地 PostgreSQL integration、Compose verification 与 P5B acceptance 未能重跑。它们在同一基线的正式 main CI Run `35554823250` 中通过。两种证据在报告中分开标记，未将 CI 结果伪装成本机结果。
- 外部 Provider 的覆盖、许可、留存、推送能力来自 2026-09-21 查询的官方文档。具体合同/付费计划未知，因此本报告把相关问题归为决策或验证缺口，不断言法律违规。
- 本报告没有进行付费 API 调用、订阅变更、真实用户数据访问或 Production/Staging 操作。
