# Provider 环境配置与真实验收

只在 Cloud Environment 中填四项，禁止把真实值写入 Git、文件、日志、PR 或聊天：

| 类型                   | 环境变量                     |
| ---------------------- | ---------------------------- |
| Network/secret         | GOOGLE_SERVER_API_KEY        |
| Network/secret         | BAIDU_SERVER_API_KEY         |
| Browser build variable | VITE_GOOGLE_MAPS_BROWSER_KEY |
| Browser build variable | VITE_BAIDU_MAPS_BROWSER_KEY  |

Google Server 需启用 Places API (New)、Routes API；Browser 需 Maps JavaScript API。
Baidu Server 需要地点、步行、当前驾车、公交、骑行与未来驾车的账号权限；Browser 需要 JavaScript API、JS 坐标转换。
Server key 只能用于服务器，Browser key 会进入 browser SDK 请求，需设置域名与 API 限制。

修改后必须 **Save → Publish/Republish → 创建新的 Cloud task → 明确选择已发布的 TRAVEL-V1 environment**。
旧任务不会自动得到新版环境。本仓库不会修改 Cloud Environment 自身。
`.env.provider.example` 是空值参考，不能填入真实凭据；`.env*` 真实值文件仍被忽略。

Network allowlist 需包含 `places.googleapis.com`、`routes.googleapis.com`、`maps.googleapis.com`、`maps.gstatic.com`、`api.map.baidu.com`，以及实际 SDK 使用的百度静态资源域名（当前候选 `maponline0.bdimg.com` 至 `maponline3.bdimg.com`，需浏览器验收确认）。
官方契约研究另需 `developers.google.com`、`lbsyun.baidu.com`。网络域名是环境网络策略，不是新增凭据。
2026-10-06 当前任务访问这两个官方文档域名被 proxy CONNECT 403 拒绝；不能据此宣称契约已核实。

```sh
pnpm provider:doctor
pnpm provider:doctor --live
```

默认模式只读取配置，不访问网络。四把 key 只显示 SET/UNSET。
`--live` 明确授权有费用风险的外部请求；每个已实现能力最多一次、无重试、8 秒超时、禁止重定向，不写 response 或请求文件。
当前最多 6 次 fetch 尝试：Google Places/WALKING/DRIVING，Baidu Place/WALKING/当前 DRIVING。
计数是实际发起的 fetch 次数；网络失败也计数，无法证明 Provider 已收到请求。
Doctor 绕过应用 approval gates 仅用于独立诊断，不改变任何 gate。HTTP/契约成功仅显示 LIVE_CHECK_PASS，不代表 production 许可。
Google 错误按结构化 ErrorInfo reason 分类；百度错误按状态码分类，未知码保守为 PROVIDER_ERROR。
网络策略拒绝/连接失败归为 NETWORK_BLOCKED；无响应时无法进一步证明是策略拒绝还是连接故障。

当前状态 **PARTIAL**：百度 TRANSIT、CYCLING、FUTURE DRIVING 及 Browser 新 JSAPI/官方坐标转换未核实，因此 doctor 明确 BLOCKED 且不发请求。
ARRIVE_BY 保持 UNSUPPORTED；未来驾车不调用当前驾车替代。填 key 本身不能关闭这些契约阻塞。
Baidu Mini Map 尚未注入坐标能力，继续局部降级，不把服务器 AK 注入 Web。

应用生产 gates 默认 false，只有独立完成 entitlement/storage/attribution/coordinate 审查后才能由用户设置，doctor 不代为批准。
浏览器 SDK 验收需在实际浏览器内完成；CLI 不会把 browser key 当 server key 发送请求。

最短操作：

1. 填四把 Key。
2. Save 并 Publish/Republish environment。
3. 新建任务，选择已发布 TRAVEL-V1 environment。
4. `pnpm provider:doctor`。
5. `pnpm provider:doctor --live`。

百度契约 BLOCKED 项需在可访问官方文档的新任务中继续施工，不能把上述五步解释为全部能力已完成。
