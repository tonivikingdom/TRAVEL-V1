# P2B TransportEdge / 邻接失效历史 / 三层时间基础

- 当前状态：`feature/p2b-transport-temporal` 实现完成，等待 Draft PR 与 CI
- 基线 main：`59e82dae31c49457fafb53351b5fe0d48e8330c8`
- 基线 main CI：Run `35342774635`，`verify` 与 `Compose verification` 均为 success
- 推荐模型 / 强度：GPT-5.6 Sol / Extra High
- 备选：GPT-5.6 Luna / Max，仅用于范围明确的小修
- 实际使用模型与强度：未知（客户端实际配置无法从仓库证据确认）
- P3、P4、正式 UI、Provider 与 Production 均未授权

## 数据与事务

- `TransportEdge` 只保存当前相邻 PLACE_VISIT 的手工交通；数据库限制不同端点、同 Trip 端点、
  adjacency 唯一及每个节点最多一个 current incoming/outgoing。
- `TransportEdgeHistory` 保存已失效边的强类型不可变快照和明确失效原因，端点 ID 不依赖仍存在
  的 Node FK。
- 节点结构命令在同一个 owner lock + Trip row lock 事务中精确比较新 adjacency，只归档真正
  变化的边；结构、History、DateOwnership 与 version+1 原子提交。
- `connections[]` 投影区分 `ACTIVE`、`MISSING`、`NOT_APPLICABLE` 与
  `RUNTIME_ORIGIN_REQUIRED`，不创建假 Transport。
- `TemporalValue` 以强 FK 归属于 Node 或 current TransportEdge，数据库 CHECK 保证恰好一个
  subject；三层与到达/出发分别唯一。
- Transport 失效时，其时间值复制到 `TransportEdgeHistoryTimeValue` 后再删除 current edge。

## 命令与读取边界

- 新增 `SET_MANUAL_TRANSPORT` 与 `CLEAR_TRANSPORT` 类型化 Trip command。
- SET 只接受当前相邻的两个 PLACE_VISIT；已有边先以 `USER_REPLACED` 入历史。
- CLEAR 以 `USER_CLEARED` 入历史；重复清除返回 `NOT_FOUND`，不递增版本。
- 默认 TripView 返回 `connections[]`；History 先保留 owner-only application/repository 读取边界，
  本阶段不新增 HTTP history endpoint。
- resolved TimeValue 只有可信 application/repository 写边界，不开放任意客户端 HTTP 写 API。

## 时间边界

- 权威数据为 explicit instant (`timestamptz`) + IANA `timeZone`，不持久化 localDateTime 副本。
- `PLANNED`、`ESTIMATED`、`ACTUAL` 分层唯一且互不覆盖。
- 只接受带 `Z` 或 UTC offset 的明确 instant；本阶段不猜 DST ambiguous/nonexistent local time。
- TimeValue 不承载 UserTimeIntent、约束、lock、传播或反推。

## 验证状态

- 本机 `pnpm install --frozen-lockfile`、`prisma:validate`、`format:check`、`lint`、`typecheck`
  与 `build` 已通过。
- 本机 unit tests：12 files / 63 tests，全部通过。
- 本机 `pnpm test:integration` 已执行，但因没有 `TEST_DATABASE_URL` 在连接前明确停止；未把它
  记录为通过。
- 本机没有 Docker、psql、`TEST_DATABASE_URL` 或 5432 PostgreSQL；PostgreSQL integration 与
  Compose 由 GitHub CI 的隔离 PostgreSQL 17 环境验证，不把 CI 与本机部署混为一谈。

## 停止点

O-03 与 O-07 仍未解决。P2B 不实现 Provider、路线查询、Preview/Adopt、时间传播/反推、
UserTimeIntent、风险、自动生命周期、跨日移动、Trip merge/copy/share、Undo 或正式 UI；P3/P4
均未进入。
