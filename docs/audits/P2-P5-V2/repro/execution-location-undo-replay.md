# Repro: location fact Undo 后重放旧样本

状态：baseline 静态确认；需要 `TEST_DATABASE_URL` 或 API+PostgreSQL 环境完成动态复现。

## 前置

1. 创建 owner、Trip、一个有坐标的 PLACE_VISIT node。
2. 获取 owner bearer session。
3. 记录 Trip version `V`。

## 步骤

1. POST `/trips/:tripId/execution/location`，样本 S 在 node 半径内，`observedAt=T`。
2. 断言 response 为 `CONFIRMED_ARRIVAL`，获得 `eventId=E`；数据库存在 node ARRIVAL ACTUAL，Trip version 为 `V+1`。
3. POST `/trips/:tripId/execution/events/E/undo`，使用当前 version 和唯一 idempotency key。
4. 断言 ACTUAL 删除、E 标记 `undoneAt`，Trip version 为 `V+2`。
5. 重新 POST **完全相同**的位置样本 S（同 coordinates、accuracy、`observedAt=T`）。

## Baseline 预期（用于确认缺陷）

- Step 3 的 `undoEvent()` 删除 `ExecutionLocationState`。
- Step 5 无 `lastObservedAt` watermark，domain 再次返回 `CONFIRMED_ARRIVAL`。
- `createFactEvent()` 只查询 `undoneAt=null`，因此创建新的 event/ACTUAL。

## 修复后的断言

- Step 5 必须 `NO_CHANGE` 或明确 stale/replayed observation，不创建新 event/ACTUAL。
- Trip version 保持 `V+2`。
- airport trigger claim 不新增。
- 更旧样本同样被拒绝；合法更新样本按新的证据策略处理。

不要在日志或文档中写 bearer credential、精确私人位置或 Magic Link token。
