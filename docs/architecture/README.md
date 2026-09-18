# P0/P1 架构基线与 P2A Trip Core 边界

本目录把产品基线转换为可执行的工程边界。P0、P1A、P1B1、P1B2 与 P2A 的状态以对应
status 文件为准，不代表 P2B～P5 已实现。

- [模块边界与依赖](modules.md)
- [字段与事实来源](information-sources.md)
- [关键责任与事务边界](responsibilities.md)
- [阶段计划、闸门与未决项](roadmap-and-gates.md)

本项目从空白工程开始，不沿用旧仓库的表、接口或 Scenario 实现。当前代码包含 P0
健康/Worker 基线、P1A 身份、P1B1 持久 Job，以及 P1B2 站内通知与 Dev/Test 私有存储边界；
P2A 增加 Trip、DateOwnership、Place、Place Visit 与 FreeAction；仍没有 Transport、时间传播、
生命周期自动化、正式 Attachment API、真实云 ObjectStorage provider 或正式 UI。
