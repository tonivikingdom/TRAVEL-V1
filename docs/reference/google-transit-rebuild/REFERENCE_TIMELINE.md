# 参考时间线与证据边界

## 已有材料，不是已恢复源码

- `reference/HISTORICAL_SIDECAR_README.md`：旧服务的个人/实验边界、HTTP 调用方式、单并发、匿名浏览器和故障处理说明；其时间模式示例属于升级前版本。
- `reference/ARRIVE_BY_DISCOVERY_REPORT.md`：2026-09-20 升级前审计，包含模块职责、调用链、当时解析索引、查询匹配、错误分类、缓存维度和测试清单。它不是 parser 的完整实现。
- `reference/ARRIVE_BY_DISCOVERY_SUMMARY.json`：同一升级前审计的机器可读摘要。
- `reference/ARRIVE_BY_STRUCTURAL_EVIDENCE.md`：2026-09-20 的匿名 Chrome / 可见 UI 结构观察；包括相同起终点和时间下两种模式的比较，以及 UNKNOWN 项。这里只证明当时那个场景，不证明现在网页的兼容性。

上述四个文件来自用户 Library 的现有附件，本包未修改其历史正文。

## 更晚的本地交付记录

用户已上传的历史会话文件 `ChatGPT-确认开发基线-20260930-0005.md` 中，2026-09-20 17:10 的交付报告称：

- ARRIVE_BY V1 direct search 已实现；DEPART_AT 保留。
- sidecar 单测 37/37 通过，typecheck/build 通过。
- 札幌站 → 小樽站、2026-09-22 10:00 Asia/Tokyo 的 ARRIVE_BY 历史测试取得 6 个满足到达条件的候选；DEPART_AT 同场景也做了回归。
- ARRIVE_BY reverse import 仍关闭；NOW 和 LAST_TRANSIT 未开放。
- 未 commit/push，`services/` 仍整体 untracked。宿主工作区 HEAD `63c9317...` 不能作为已归档 sidecar 版本。

这是后续交付报告的摘要，不是这次重新运行的结果。没有恢复对应完整源码，不能据此宣布新服务继承了这些通过状态。

## 任务开始时应核对的仓库材料

仓库：`tonivikingdom/TRAVEL-V1`。
已暂停任务报告基线：`d5350fc051bd4a3ff7b50c1aae5605007e0a3ab2`，分支 `feat/google-consumer-transit-cloud-dev`。
开始时读取实际 HEAD、origin/main 和工作区状态，记录差异，不假定 main 永远不变，也不自动丢弃工作。

重点读取：
- `packages/providers/src/google-consumer-transit-route-provider.ts`
- `packages/providers/test/google-consumer-transit-route-provider.test.ts`
- `packages/providers/src/config.ts` 及测试
- `apps/api/src/main.ts`
- `.env.dev.example`
- `docs/status/GOOGLE_CONSUMER_TRANSIT_INTEGRATION.md`

主项目文档仍保留更早的 ARRIVE_BY 未 live 支持记录；不能用旧文档否定后续本地报告，也不能反过来用报告替代新云端验证。

## 新实现的取证要求

- 历史字段位置只能作为查找线索；当前页面模式、日期时间、返回结构须重新观察和核对。
- normalized sidecar fixture 只能证明 Travel 接口兼容，不是 Google 原始 response fixture。
- 原始网络响应仅在允许的临时内存处理，不提交 Cookie、真实密钥、完整 URL/pb 或原始 payload；脱敏证据、合成测试必须明确标记。
- 不能把 2026-09-22 的历史候选数、票价或时间写成今天 live 的断言；新验证选择实际可查询的日期并记录绝对日期与时区。
