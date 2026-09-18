# P0 架构基线与 P1A 身份边界

本目录把产品基线转换为可执行的工程边界。P0 和 P1A 的状态以对应 status 文件为准，
不代表 P1B 或 P2～P5 已实现。

- [模块边界与依赖](modules.md)
- [字段与事实来源](information-sources.md)
- [关键责任与事务边界](responsibilities.md)
- [阶段计划、闸门与未决项](roadmap-and-gates.md)

本项目从空白工程开始，不沿用旧仓库的表、接口或 Scenario 实现。当前代码包含 P0
健康/Worker 基线，以及 P1A 邀请、Magic Link、集中授权和可撤销多设备 Session；没有
Trip、持久 Job、ObjectStorage、Provider 或正式 UI。
