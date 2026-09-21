# P2–P5 Full Product & Engineering Audit V2

## 审计边界

- 仓库：`tonivikingdom/TRAVEL-V1`
- 固定基线：`317a08ed4c9d5ff0fcb455573a012762269eaaf7`
- 审计日期：2026-09-21
- 审计分支：`audit/p2-p5-deep-review-v2`
- 范围：P2A/P2B、P3A/P3B1/P3B2、P4A1/P4B1/P4B2/P4B3、P5A/P5B/P5C、P5D1/P5D2/P5D3、P5E1，以及 Auth/Session、Job/Worker、Notification/Outbox、ObjectStorage。
- P5E2 仅审计设计前置条件；没有实现 P5E2。

本轮只增加审计报告、证据索引、隔离复现材料和带 `[AUDIT ...]` 标识的 characterization tests。没有修改业务实现、数据库 schema、历史 migration 或 Git 历史。

## 总结

基线具备一条相当完整、并且在当前 CI 中持续通过的核心链路：账户与 Magic Link、持久 Job/Worker、Trip/DayOccurrence、三层时间事实、时间意图与只读传播、路线查询/Preview/Adopt/Undo、执行风险、航班事实与后台监控、位置推断与事实 Undo。事务、版本、owner isolation、幂等和历史保留整体设计较严谨。

但“已具备执行能力”不等于“可以默认开启协助”。主要缺口集中在：能力级 opt-in/暂停/停止、位置辅助与自动记录的独立授权、可解释的位置证据、Undo 后旧样本重放、事实来源可信性、arrival/departure 因果一致性、跨域通知聚合、协助结束生命周期，以及真实 Provider 的治理边界。

## Findings 概览

| 分类             |   数量 | 最高严重度 |
| ---------------- | -----: | ---------- |
| DEFECT           |      4 | HIGH       |
| PRINCIPLE_GAP    |      6 | HIGH       |
| PRODUCT_DECISION |      1 | MEDIUM     |
| VERIFICATION_GAP |      2 | HIGH       |
| **合计**         | **13** | **HIGH**   |

没有发现需要立即停止开发或回滚正式数据的 CRITICAL finding。闸门已按 P5E2 后端、跨层验收、原生后台定位、真实 Provider、正式客户端/附件/上线分别列出；不是所有上线条件都阻塞 P5E2 设计，见 [remediation-plan.md](./remediation-plan.md)。

## 文件索引

- [principles.md](./principles.md)：R1–R9 逐条核验。
- [coverage.md](./coverage.md)：模块与跨模块覆盖矩阵。
- [evidence-matrix.md](./evidence-matrix.md)：逐场景调用链、代码、测试、运行证据和限制。
- [findings.md](./findings.md)：13 个保留稳定编号的 finding。
- [verification.md](./verification.md)：本机与正式 CI 验证记录、外部来源。
- [remediation-plan.md](./remediation-plan.md)：修复顺序与分阶段闸门。
- [repro/](./repro/)：隔离复现说明和纯 Domain 演示。

## 重要限制

- 没有探测或复用未知本地数据库；审计新增 PostgreSQL 用例交由 PR 的隔离 CI 数据库运行。本机、固定基线 CI、审计 PR CI 和新增用例在 [verification.md](./verification.md) 分开披露。
- 外部 Provider 的覆盖、许可、留存、推送能力来自 2026-09-21 查询的官方文档。具体合同/付费计划未知，因此本报告把相关问题归为决策或验证缺口，不断言法律违规。
- 本报告没有进行付费 API 调用、订阅变更、真实用户数据访问或 Production/Staging 操作。
