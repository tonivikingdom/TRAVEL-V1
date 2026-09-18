# ADR-0007：DayOccurrence identity 与 sequence 时间线

## 状态

Accepted for P3A foundation。

## 背景

P2A/P2B 使用 `ItineraryNode.localDate + position` 排列整趟时间线。这无法表达跨国际日期线后的日期
回拨，也无法区分同一 Trip 中多次出现的同一个 localDate。O-03 已确认：真实先后关系使用独立
sequence，localDate 只承担当地日期语义。

## 决策

- 持久化 `DayOccurrence(id, tripId, localDate, sequence, timestamps)`；同一 Trip 的 sequence 唯一，
  localDate 不唯一。
- `ItineraryNode` 保存 `dayOccurrenceId + tripId + position`；复合外键保证 Node 与 occurrence 属于
  同一 Trip。删除旧 `ItineraryNode.localDate` 真相副本。
- Trip timeline 的唯一正式排序为 `DayOccurrence.sequence + ItineraryNode.position`。Transport
  adjacency、connection projection 与精确失效均使用此顺序。
- API 日期卡返回稳定 `dayOccurrenceId`。新增内容明确选择 EXISTING 日期卡或以 localDate + sequence
  创建 NEW 日期卡；移动节点明确携带目标 dayOccurrenceId。服务端不按重复日期猜卡。
- `DateOwnership` 仍以 `(ownerUserId, localDate)` 唯一；重复 occurrence 共享同一自然日归属。有效
  范围按保留 occurrence 的自然日期最小/最大值计算。
- 首尾没有有效节点的 occurrence 在同一 Trip mutation 事务中收缩；中间空白 occurrence 保留；
  Trip 变空时 occurrence、ownership 与 effective range 全部清空。
- 旧数据 migration 按原 effective range 为每个自然日建一张 occurrence（含中间空白日），sequence
  按旧日期升序回填，再以旧 localDate + position 绑定 Node，保持 P2B 顺序无损。

## 结果与边界

- 日期回拨和重复日期卡已有稳定结构底座，Transport 不再被 localDate 重新排序。
- ADD/MOVE command 与 node/day read model 存在刻意的 breaking change；旧 localDate-only 命令不再
  接受。
- 本 ADR 不实现跨日 Transport 多卡投影、交通占用日、DST 歧义输入、UserTimeIntent、
  TimeConstraint、solver、双向传播、Provider、生命周期或 UI。
