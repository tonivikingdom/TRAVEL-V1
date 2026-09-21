# 审计覆盖清单

详细的 requirement/scenario ID、调用链、固定基线文件/函数/行范围、测试名称/断言、运行方式和限制见 [evidence-matrix.md](./evidence-matrix.md)。本页只做范围完整性和结果索引，不再用“integration/main CI 已覆盖”替代具体证据。

## 模块覆盖

| 模块                | 关键场景 ID                                                  | 结论                                          | 关联 finding/限制                    |
| ------------------- | ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------ |
| P2A                 | P2A-01：空 Trip、日期范围、重复 localDate、ownership/并发    | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| P2B                 | P2B-01：adjacency、history、三层事实、FACT protection        | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| P3A                 | P3A-01：occurrence identity/sequence、日期回拨               | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| P3B1                | P3B1-01：intent 与事实分离、evaluate 只读                    | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| P3B2                | P3B2-01：hard basis、双向传播、conflict/provenance           | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| P4A1                | P4A1-01：provider-neutral query、P3 window、post-filter      | `BASELINE_TESTS_PASSED`                       | 真实 Provider governance F-05/F-06   |
| P4B1                | P4B1-01：immutable snapshot/Preview、owner/version/expiry    | `BASELINE_TESTS_PASSED`                       | retention F-05                       |
| P4B2                | P4B2-01：Adopt transaction、receipt/outbox、failure rollback | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| P4B3                | P4B3-01：Undo compensation、ACTUAL/new fact guard、并发      | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| P5A                 | P5A-01：Debug client、outage/version/error state             | `BASELINE_TESTS_PASSED`                       | 文案 F-08；source trust F-11         |
| P5B                 | P5B-01：5-user synthetic/auth/outage/worker/adopt/undo       | `BASELINE_TESTS_PASSED`                       | 不含后来的 P5E1 全链，F-09           |
| P5C                 | P5C-01：ranking/lookback/dwell adjustment/undo/buffers       | `BASELINE_TESTS_PASSED`                       | 重点结论已明确，无新缺陷             |
| P5D1                | P5D1-01：risk lifecycle、ack/snooze、fixed/actual anchors    | `BASELINE_TESTS_PASSED`                       | capability F-01；跨域通知 F-12       |
| P5D2                | P5D2-01：snapshot ordering/fact mapping/ACTUAL protection    | `BASELINE_TESTS_PASSED`                       | governance F-05/F-06                 |
| P5D3                | P5D3-01：monitor decision marker、aggregation、next job      | `BASELINE_TESTS_PASSED`                       | opt-in/stop F-01/F-10；跨域通知 F-12 |
| P5E1                | P5E1-01：location decision/fact/Undo/risk/airport trigger    | `BASELINE_TESTS_PASSED` + `DEFECT_REPRODUCED` | F-02/F-03/F-04/F-09/F-13             |
| Auth/Session        | PUB-01：邀请、Magic Link、session revoke、non-disclosure     | `BASELINE_TESTS_PASSED`                       | 无新增 finding                       |
| Job/Worker          | PUB-01：claim/lease/retry/restart/shutdown                   | `BASELINE_TESTS_PASSED`                       | capability lifecycle F-01/F-10       |
| Notification/Outbox | PUB-01：owner list/dismiss/dedupe/outbox                     | `BASELINE_TESTS_PASSED`                       | 两通知域 F-12；Push 未实现           |
| ObjectStorage       | PUB-01：owner lookup、quota、provider failure/restart        | `BASELINE_TESTS_PASSED`                       | stale PENDING F-07                   |

## 跨模块 A–H 状态

| ID                                                   | 状态                              | 摘要                                                                            |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| A 最低停留→Query→Preview→Adopt→Undo                  | `BASELINE_TESTS_PASSED`           | 要求与路线可原子调整并由 Undo 恢复；idempotent replay 有断言。                  |
| B 取消中间地点→旧目标/候选/风险/task 收口            | `PARTIAL`                         | transport/history/version 成立；旧 execution risk/task lifecycle 没有统一实现。 |
| C Flight update→risk/notify/job→关闭辅助→late result | `PARTIAL`                         | snapshot/monitor 幂等成立；关闭辅助不存在，Risk/Flight 可能双通知。             |
| D Location→fact→risk→flight→notification→纠正        | `DEFECT_REPRODUCED + UNVERIFIED`  | 单模块段有证据；完整 Worker 链缺失；Undo 后 observation 可复活。                |
| E 无重要后果 vs 用户保护安排                         | `PARTIAL`                         | objective anchor、user intent、risk state 分离；主动提醒跨域聚合缺失。          |
| F 断网/重启/DB 中断恢复                              | `BASELINE_TESTS_PASSED + PARTIAL` | P5B/Job/route/flight 有证据；P5E1→Flight 全链未纳入。                           |
| G 多设备 stale mutation/event/Preview                | `PARTIAL/DEFECT_REPRODUCED`       | version/Preview/route Undo 保护成立；pause 不存在；旧 location event 可复活。   |
| H 结束、跨夜与短尾                                   | `NOT_IMPLEMENTED/UNVERIFIED`      | instant/sequence 不依赖 server localDate；统一 end/cleanup authority 不存在。   |

## 明确没有被证明的事项

- `UNVERIFIED`：重复车站/酒店重叠、乘车经过但未下车、完整跨夜结束/短尾、P5E1 API+Worker+Flight 全链。
- `NOT_IMPLEMENTED`：Push、正式后台定位客户端、capability pause/stop/cleanup、正式 Desktop/Mobile、RecommendationPolicy 之外的自动改计划、Production deployment。
- `NOT AUTHORIZED`：Staging/Production、真实付费 Provider 调用、供应商订阅/数据删除。
- P5E2 仅表示后续地面公共交通执行能力；不等于正式客户端开发或上线授权。
