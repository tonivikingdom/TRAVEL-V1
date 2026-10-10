# 正式 Web 交互清单

基线 `4f6b31a262acdf9ac634f0ad58eab437ca79d4cb`，分支 `feat/p7a-web-ux-round1`。只覆盖 `apps/web` 已实现入口；测试数据均为 SYNTHETIC。以下是代码审查清单，运行结果另记录于 P7A-WEB-UX-ROUND1.md。

| 页面或弹层         | 旧入口与主操作                 | 关闭与状态                              | 代码                                                    | 首稿目标                                 |
| ------------------ | ------------------------------ | --------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| 登录               | 受邀邮箱→发送链接              | 空值、发送中、防枚举、网络错误          | main.ts login/act/start                                 | 字段内提示、保留邮箱                     |
| 登录恢复           | 详情内邮箱、完整链接           | 原账户核验、草稿保留                    | main.ts showRecovery/recoverDraft; authoring.ts recover | 共用验证与状态                           |
| 旅行列表           | 整卡 button→旅行               | 空列表、读取中、读取失败                | main.ts listTrips/render                                | 无嵌套按钮的卡片结构                     |
| 新建旅行           | 列表新建→右侧详情              | dirty/busy/幂等核验                     | authoring.ts openCreate/submit                          | 居中 modal、日期、人数步进、取消         |
| 全部日程           | 日期卡、地点、交通             | 日期唯一归属、待定、无网                | main.ts render/editorDays                               | 保留事实与时间三项                       |
| 添加安排           | 选择类型→替换详情              | owner/版本/日期目标                     | authoring.ts openAdd/chooseKind                         | 同容器切换地点与自由行动                 |
| 地点搜索           | query、语言、候选、保存 select | 延迟/取消、坐标、选择 token             | place-search.ts                                         | 搜索/已保存切换、单一选中摘要            |
| 自由行动           | 标题→添加                      | 空白、超长、结果未知                    | authoring.ts submit                                     | 字段提示与局部反馈                       |
| 调整日期顺序       | 地点的调整按钮                 | 日期变更重核对、位置保护                | authoring.ts openMove/recover                           | 同弹层表单                               |
| 地点详情           | 地点卡→地址、时间、备注        | dirty 关闭、延迟保存、恢复              | main.ts openPlace/command                               | 时间与备注分组、局部保存状态             |
| 时间与停留         | 展开时间要求                   | 删除要求、DST、时区、空数字             | main.ts time-edit/dwell-edit                            | 统一日期时间、原语义不变                 |
| 当前交通           | 连接卡→当前方案                | 导航不写入、局部地图降级                | main.ts openRoute/savedTransport                        | 摘要→更换路线                            |
| 搜索条件与候选     | 主动搜索路线                   | 模式、时间、版本、无结果、Provider 故障 | main.ts route-search/showCandidates                     | 分阶段、返回保留条件与滚动               |
| 路线预览           | 候选→预览→使用                 | TTL、阻断、重要同意、幂等               | preview-presentation.ts; main.ts showPreview            | 重点前置，一般详情折叠                   |
| 采用和撤销         | 使用路线、轻反馈撤销           | 事务、owner、事实、窗口保护             | main.ts finishAdoption/undo                             | 保留既有保护                             |
| 今天与下一步       | 顶部切换                       | 可靠执行/unknown、严重影响              | in-trip.ts; main.ts renderToday                         | 名称、时间、影响可达                     |
| 航班               | 今天及资料                     | 计划/预计/实际、能力不可用              | main.ts todayFlights; essentials.ts                     | 标签明确、来源可展开                     |
| 影响与调整         | 查看影响→主动搜索              | 权威状态、起点、版本                    | impact.ts; alternatives.ts                              | 原引擎不变、明确信息层级                 |
| 地图               | 地点、交通、外部导航           | SDK/loading/位置未知、草稿              | mini-map.ts; map-adapter.ts                             | 局部降级、异步安全确认                   |
| 在线资料与静态备份 | 顶部资料、生成/下载/查看       | owner、版本、请求未知、静态隔离         | main.ts renderMaterials; essentials.ts                  | 私人备份、时间与不更新提示、技术信息折叠 |
| 全站草稿与异常     | 表单编辑/离开/重新读取         | 断网、会话撤销、原账户、未知结果        | drawer.ts; main.ts act/showRecovery; authoring.ts       | 应用内确认、保留 beforeunload            |

## 卡片能力核对

| 能力       | 结论                         | 接口证据与最小依赖                                                                                                          |
| ---------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 进入旅行   | 可直接复用                   | GET /trips/:id，现有 owner 校验                                                                                             |
| 新建旅行   | 可直接复用                   | POST /trips，已有幂等 authoring 保护                                                                                        |
| 重命名整趟 | DEPENDENCY / NOT IMPLEMENTED | app.ts、TripCommandInput、TripAuthoringCommandInput 无对应命令；需 owner、baseTripVersion、幂等键、name 校验及返回 TripView |
| 删除整趟   | DEPENDENCY / NOT IMPLEMENTED | 无 DELETE /trips/:id；需明确关联行程/附件/Job/备份删除范围、事实与并发保护、成功后才移除卡片；不提供伪撤销                  |
| 公开分享   | DEPENDENCY / NOT IMPLEMENTED | 现有 backup 是私人资料；需独立内容白名单、匿名访问/停止语义、真实生成与权限测试                                             |

缺能力项只在明确标注 SYNTHETIC、无真实请求的独立 UI 评审夹具中展示交互设计。正式列表不提供可点击却无实际作用的操作。此轮不新增对应后端。
