# P5A Debug Web 手工验收

## 启动

复制并填写 Development 环境变量后分别启动：

```text
Terminal A: pnpm dev:api
Terminal B: pnpm dev:worker
Terminal C: pnpm dev:debug-web
```

打开 `http://127.0.0.1:5173`。页面必须持续显示“开发测试台 / 仅用于 Dev/Test / 不是正式产品界面”。
Development 的 `AUTH_MAGIC_LINK_LANDING_URL` 应为
`http://127.0.0.1:5173/login/magic`。

## 主流程

1. 输入测试邮箱并请求 Magic Link，从 Dev/Test capture mail 打开链接。
2. 确认 URL fragment 中的 token 被立即清除，页面通过 `/me` 显示当前用户。
3. 创建 Trip，设置 planningAnchorDate 与人数。
4. 在明确选择的 DayOccurrence 中添加两个 Place Visit；确认时间轴按 occurrence sequence，而非 localDate 排序。
5. 对终点设置 ARRIVAL `NOT_AFTER`，点击“重新评估时间约束”，检查 ruleId、sourceRefs 与 explanation。
6. 对相邻 Place 执行 Route Query；确认 SYNTHETIC provider 显示醒目警告及 queryTimeCondition。
7. 选择 Candidate，生成 Preview，检查 corridor、替换项、generated/reused/removed node、投影与时间来源。
8. 仅在 `adoptable=true` 时采用路线；记录 resulting version、adoptedRouteId 和 undoExpiresAt。
9. 刷新 Trip，确认正式 Transport source 为 `ADOPTED_ROUTE`，并查看 Transport History。
10. 点击“撤销刚才的路线采用”；确认 Trip version 再增加、结构恢复、Undo receipt 显示且不能再次 Undo。

## VERSION_CONFLICT（两个 tab）

1. 两个 tab 同时登录并打开同一个 Trip。
2. Tab A 执行任意 Trip mutation。
3. Tab B 使用旧 version 执行 mutation。
4. B 必须显示 `VERSION_CONFLICT` 和“已停止本次操作”，不得自动覆盖或重放。
5. 点击“刷新 Trip”；确认旧 Candidate/Preview 已清除，再重新确认操作。

## Offline / unavailable

1. 正常打开 Trip。
2. 停止 API。
3. 页面必须进入“服务暂时不可用”，隐藏旧 Trip，不允许继续正式写入，也不显示“已同步”。
4. 恢复 API。
5. 点击重新检查或等待健康检查；页面应依次通过 `/health/ready`、`/me`、选中 Trip 重新同步。
6. 只有同步成功后恢复操作。

## Provider failure

将 Route Provider 配置为 unavailable 后执行 Route Query。页面只在 Route 区域显示交通查询不可用，
Trip 与已有正式计划仍可查看编辑；`NO_MATCHING_CANDIDATE` 必须显示为“当前条件下没有找到匹配候选”，
不能与 Provider 故障混淆。
