# Real Provider 安全验收环境

推荐模型：GPT-6.1 Sol / XHigh；备选 GPT-6 Astra。复杂坐标、授权或官方契约争议升级复核；实际运行模型配置未确认。

## 用户最短步骤

1. 在 Cloud Environment 安全设置中填四项，**不要发到对话或写入文件**：

   | 用途                   | 环境变量                       | 对应能力                                                                                  |
   | ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
   | Network/secret，服务端 | `GOOGLE_SERVER_API_KEY`        | Places API (New)、Routes API；HTTPS 目标 `places.googleapis.com`、`routes.googleapis.com` |
   | Network/secret，服务端 | `BAIDU_SERVER_API_KEY`         | 地点、步行、驾车、公交、骑行；HTTPS 目标 `api.map.baidu.com`                              |
   | Browser build variable | `VITE_GOOGLE_MAPS_BROWSER_KEY` | Maps JavaScript API，独立的域名受限 Browser key                                           |
   | Browser build variable | `VITE_BAIDU_MAPS_BROWSER_KEY`  | 百度 JSAPI 4.0、官方 JS 坐标转换，独立的 Browser AK                                       |

2. **Save，再 Publish/Republish environment**。草稿保存、运行实例与发布版本不是同一件事。
3. **创建新的 Cloud task，明确选择已发布的 TRAVEL-V1 environment**。本变更合并前，任务使用 `feat/real-provider-bootstrap-cloud` 分支；不能假定 main 已合并。按仓库正常安装、迁移、构建步骤准备该分支。
4. 在 `/workspace/TRAVEL-V1` 运行 `pnpm provider:doctor`。
5. 核对配置结果后，显式运行 `pnpm provider:doctor --live`。验收任务使用 `APP_ENV=development` 或 `test`；production/staging 被此工具拒绝。

Doctor 启动命令使用 Node 24 `--use-env-proxy`，尊重 `HTTPS_PROXY` / `HTTP_PROXY` 与 `NO_PROXY`。Network Secret 占位值原样进入请求，经环境规定的 HTTPS CONNECT 代理发送；不要解析占位值或提取真实 Key。保留环境 `NODE_EXTRA_CA_CERTS` 和 TLS 证书验证，不使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`。通过本地 SYNTHETIC CONNECT 代理测试占位值传递、可信 CA、未可信证书拒绝和 NO_PROXY；这不等于真实 Provider 授权或代理端 Secret 替换验收。

四项只通过进程环境读取。示例 [.env.provider.example](../.env.provider.example) 仅描述空配置形状，不应复制后填真实值。`.env*` 的非 example 文件仍被 Git 忽略；本工具不加载凭据文件、不创建真实凭据文件、不输出值、长度、前后缀或摘要。浏览器 Key 本身会用于浏览器 SDK，需按网站来源限制；两个 Server key 永远不进入 Web HTML/JS/source map。更换 Browser build variables 后需重建 Web 或重启 Vite；发布旧构建不能让新 Key 生效。

## 网络与验收结果

服务端需要 `places.googleapis.com`、`routes.googleapis.com`、`api.map.baidu.com`；浏览器需要 `maps.googleapis.com`、`api.map.baidu.com` 及 SDK 资源域 `*.gstatic.com`、`*.bdimg.com`、`*.bdstatic.com`。网络设置是平台配置，由环境设置管理；仓库代码不修改 Cloud Environment。doctor 默认只列出所需 host，**不探测网络，也不声称白名单已放行**。浏览器后续资源域须结合实际部署请求审核，不能把一次脚本加载成功当作完整网络验收。

默认 doctor 输出四项 `SET/UNSET`、已有非 secret gate 的 `TRUE/FALSE/INVALID`、能力与 wiring，以及零请求计数。`SET` 表示存在绑定，不证明账户可用；代理占位变量应通过对应 HTTPS 目标验证。缺 Key 的默认检查正常退出，允许先配置。

`--live` 串行进行九项**服务端**检查：Google Places/WALKING/DRIVING，Baidu Place/WALKING/当前 DRIVING/同城 TRANSIT/CYCLING/FUTURE DRIVING。每项最多 dispatch 一次 fetch；无 retry、无 redirect、无自动 fallback，超时 8 秒。未来驾车指定运行时刻之后 24 小时的 UNIX `departure_time`，不是当前路况请求。计数报告包括 dispatch 尝试；网络拦截时请求可能尚未到达 Provider，不能声称 Provider 已收到。全部四项未提供时真实请求数为 0。

结果只含固定状态标签、HTTP 数字状态与计数，不含 URL、响应正文或 Provider 的错误消息。失败分为 `SECRET_UNSET`、`NETWORK_BLOCKED`、`API_NOT_ENABLED`、`BILLING_OR_ENTITLEMENT`、`AUTH_REJECTED`、`CONTRACT_MISMATCH`、`PROVIDER_ERROR`。分类依据结构化错误代码；模糊权限失败不被当成已通过 entitlement。失败退出 1。`NO_MATCHING_CANDIDATE` 明确区分于故障。

`LIVE_CONTRACT_PASS` 仅表示一次响应通过当前解析和绑定，不证明条款、账单、高级权限、存储、attribution 或 production approval。**全部 gate 保持原值**，默认 false；doctor 不打开正常应用的 Provider slot。通过验收后，各项 gate 必须按实际账户、许可证、保留策略和坐标准确性逐项人工审核。模板列出全部实际 gate，含 `BAIDU_FUTURE_DRIVING_APPROVED`；没有高级权限审核不能在普通应用中启用未来驾车。`ROUTE_PROVIDER=regional` 是正常应用的显式 runtime 选择，不是 doctor 的先决条件。

doctor 的 Node 模式不加载 Browser SDK，不创建真实地图截图。Google/Baidu Mini Map 会报告 wiring 和 `BROWSER_ACCEPTANCE_REQUIRED`；**不能把 server doctor 的 PASS 当作实际 Browser map 验收**。真实浏览器 Pin、pan、zoom、转换回调、SDK 失败降级和域名限制仍需在审核启用后的页面单独验收。Maps entitlement/storage/attribution/coordinates gate 不会因 Key 存在或 HTTP 200 自动通过。

## 路线与坐标边界

- Mainland China 继续由 RegionalRouter 选择 Baidu；Japan TRANSIT 继续使用原 Google Consumer Transit sidecar；Japan/Global ordinary Google 策略不变，没有跨区域 fallback。
- Baidu 使用 `direction/v2/walking`、`driving`、`riding`、`transit`。CYCLING 使用普通自行车 `riding_type=0`，作为正式查询/存储/展示模式，不添加 UI 推荐。TRANSIT 当前只接受返回明确相同 `city_id` 的同城方案，保留**聚合预计耗时**，不编造 BUS/RAIL 分段、车次、站点、固定发车时间或监控能力。官方接口描述支持跨城，但当前跨城接入/实测为 **PARTIAL/UNSUPPORTED**，需独立验收。公交接口时间精度为分钟；指定出发必须对齐分钟，NOW 则向后对齐下一分钟并保留该查询时间，不向前截断。
- Future driving 使用 v2 `departure_time`，仅接受当前之后至 7 天内的时间，并要求高级权限审核 gate；过期/超范围/未审批返回 UNSUPPORTED，不退回当前路况。所有未来指定时间，包括数秒后的出发，都不能由当前路况替代；v2 UNIX 时间精度为秒，非整秒的未来驾车输入明确 UNSUPPORTED。返回 duration 只作为 Provider 估算，不是车辆 ACTUAL。
- ARRIVE_BY 保持 **UNSUPPORTED**。官方描述了 `expect_arrival_time` / `suggest_departure_time` 高级契约，但尚未通过实际账户验收；本实现不倒推、不把当前 duration 当建议出发事实。
- Google 官方 RouteLeg 允许起终点 snap 到道路，但距离本身不证明道路/地点身份。Google 100 米、Baidu 30 米只保留为外层排除边界；没有可靠接驳证据时，返回端点必须与输入在现有 Place 六位小数精度上等价。不同端点坍缩、倒置、歧义、平行道路位移及超阈值一律 fail closed。候选保留返回的 normalized 坐标，不再以用户输入覆盖；`legs[].providerRef` 使用 `endpoint-evidence:v1:` 的应用自有 opaque provenance，白名单记录 raw/normalized 坐标、坐标系和偏移，不是 Provider 车次 ID，不含 URL/Key/原始响应。Domain 可信端点保护不变。不虚构接驳时间/距离；普通 snapping 或 Baidu 近似逆变换的精度差异可能导致合法路线拒绝，这是当前契约下的保守限制。
- Baidu TRANSIT 的 HTTP 200 / numeric `status=1002` / `result=null` 表示不支持该跨域查询，映射 `UNSUPPORTED_QUERY`，Doctor 为 `UNSUPPORTED`。其他 mode、未知代码、HTTP 故障不随之改为 unsupported；1001 仍为无候选。
- Internal canonical 仍为 WGS84。Baidu 请求明确 `coord_type=wgs84`，响应明确 `ret_coordtype=bd09ll`。服务端 BD09→GCJ02→WGS84 的数值逆变换是 **approximate / non-authoritative**，绝非“官方 round-trip”；六位小数及 fixture 回归不证明真实地理误差。30 米绑定只约束错点风险，不能自动批准坐标 gate。
- Browser display 使用官方 JSAPI 4.0 `BMap.Convertor.translate`、`COORDINATES_WGS84`→`COORDINATES_BD09`。只在 callback status=0、点数/坐标及逐点偏移 sanity 校验通过后 mount；超时/缺模块/错误结果局部降级。取消只忽略迟到结果，SDK 没有公开取消网络请求接口。没有复制反向近似算法到 Web。

## 可复核的官方来源

官网页面在当前环境返回网络 403；技术契约通过 Provider 官方 GitHub 仓库核对，不用第三方博客推断。

- [Google 官方 RouteLeg proto](https://github.com/googleapis/googleapis/blob/e63fb893d2fd6767bc9ca4116401f2d1e9202db3/google/maps/routing/v2/route.proto)：`start_location` / `end_location` 明确允许不同于输入、绑定到道路；没有给出米数上限。
- [Baidu 官方 Web API 文档](https://github.com/baidu-maps/webapi-skills/tree/67d85191b91755b447088ee8c492a3fb54d99e8b/skills/baidu-map-webapi/references)：driving/walking/cycling/transit、`capabilities/future_driving_route.md`、`suggested_departure_time.md`、通用错误代码。原官方页面为 `lbs.baidu.com/faq/api` 对应 webservice-direction 文档。
- [Baidu 官方 JSAPI 4 文档](https://github.com/baidu-maps/jsapi-skills/tree/1a1f500d52704694d43484ce50eede9e4dede1e9/skills/bmap-jsapi-v4/references)：`project-setup.md` 指定 `v=4.0` 和 `BMap`；`geolocation-and-convertor.md` 指定异步转换、坐标常量、无公开取消能力。新版不再默认加载旧 `type=webgl&v=1.0` / `BMapGL`。

测试先使用明示 SYNTHETIC 的 mocks/fixtures、真实隔离 PostgreSQL 和临时生产 Web build；不需要任何真实 Key。实际账号/高级权限、真实误差、真实 Browser SDK/底图和 production approval 仍需单独确认。没有 Production 部署。
