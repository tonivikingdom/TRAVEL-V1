# P2A Trip Core / DateOwnership / Visit / FreeAction

- 当前状态：已通过 PR #6 Squash Merge 进入 main
- 基线 main：`4759846ed1fd2d1511e4a9cbc2529119b48640f1`
- 正式 main commit：`59e82dae31c49457fafb53351b5fe0d48e8330c8`
- main CI：Run `35342774635`，`verify` 与 `Compose verification` 均为 success
- 原分支：`feature/p2a-trip-core`（远程已删除）
- 推荐模型 / 强度：GPT-5.6 Sol / Extra High
- 备选：GPT-5.6 Luna / Max
- 实际使用模型与强度：未知（客户端实际配置无法从仓库证据确认）
- P2B 已获单独授权并在 `feature/p2b-transport-temporal` 实施；P3、正式 UI、Provider 与
  Production 均未授权

## 数据与事务

- 新增 `Trip`、`DateOwnership`、`Place`、`ItineraryNode` 正式 migration。
- 空 Trip 只保存 `planningAnchorDate`；有效范围为 null/null、ownership 为 0、`days=[]`。
- `DateOwnership(ownerUserId, localDate)` 是唯一日期事实；范围内部空白日仍持久归属。
- Day 不建表，由连续 ownership 与节点投影。
- 结构 mutation 使用 owner advisory transaction lock、Trip 行锁与 `baseTripVersion`；成功只将
  version 增加 1，失败全部回滚。
- Place 与 Visit occurrence 分离；FreeAction 不创建假地点；Replace Place 清空旧 note。

## HTTP API

- `POST /trips`
- `GET /trips`
- `GET /trips/:id`
- `PATCH /trips/:id`
- `POST /trips/:id/commands`
- 命令：`ADD_PLACE_VISIT`、`ADD_FREE_ACTION`、`DELETE_NODE`、
  `MOVE_NODE_WITHIN_DAY`、`REPLACE_PLACE`

owner 只来自 Session actor。普通用户与 ADMIN 均不能读取或修改其他 owner 的 Trip/Place；
跨 owner 和不存在的私有 ID 对外统一 `NOT_FOUND`。

## 验证状态

- 本机 `prisma:validate` 与 `typecheck` 已通过。
- 本机 unit tests：12 files / 60 tests，通过。
- P2A PostgreSQL integration 已新增；本机没有 Docker、psql 或 5432 PostgreSQL，因此本机未运行。
- PR CI Run `35340532326` 与 main CI Run `35342774635` 均通过 PostgreSQL 17、migration
  deploy、build 与 Compose 回归。

## 停止点

O-03 与 O-07 仍未解决。P2A 本身不支持跨午夜/跨时区高级 Day 投影、自动生命周期、
Transport、时间传播、跨日移动、Trip merge/copy/share、Undo、Provider 或正式 UI；Transport
与 resolved 三层时间基础只在后续单独授权的 P2B 分支实施。
