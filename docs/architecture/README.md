# P0 架构基线

本目录把产品基线转换为可执行的工程边界，但不代表 P1～P5 已实现。

- [模块边界与依赖](modules.md)
- [字段与事实来源](information-sources.md)
- [关键责任与事务边界](responsibilities.md)
- [阶段计划、闸门与未决项](roadmap-and-gates.md)

本项目从空白工程开始，不沿用旧仓库的表、接口或 Scenario 实现。当前代码只包含
健康端点、Worker 心跳、PostgreSQL readiness 适配器和一个无 I/O 的领域纯函数示例。
