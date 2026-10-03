# Google Transit 兼容契约

此服务为 REBUILT_COMPATIBLE_IMPLEMENTATION。当前约束来自未修改的 Travel 适配器，历史参考仅用于定位，不能证明新实现已通过真实验收。

`POST /v1/transit/search` 仅在 development/test 启用，监听 127.0.0.1，以专用 Bearer token 鉴权。输入为 origin/destination（非空 label、有限 latitude/longitude）、真实 YYYY-MM-DD 日期、HH:mm、IANA timezone、DEPART_AT 或 ARRIVE_BY。拒绝歧义或不存在的当地时间，不使用宿主机时区。

成功响应要求 status=OK、provider=GOOGLE_CONSUMER_EXPERIMENTAL、queryVerified=true、requestedQuery 完整一致、UTC fetchedAt、正数 candidateCount 与数组长度一致。queryVerified 只有 UI、页面时间状态、端点、候选语义和可见候选标记都核对后才能产生。

候选必须含唯一 id、非负 sourceIndex、departureTime/arrivalTime（localDateTime、timezone、utc）、非负整数 durationSeconds 和非空 legs。总时长等于绝对到发时刻差。fare 可为 null；存在时 amount 为非负有限数字，currency 为三位大写代码。

分段 mode 为 WALK/BUS/TRAIN/SUBWAY/TRAM/FERRY；from/to 可为 null，存在时含 name 和成对坐标；departureTime/arrivalTime/durationSeconds 可为 null。lineName/serviceName 必须存在，可为 null。不推断未知班次或票价。相邻分段内部边界必须具有相同精确坐标；没有实证的步行端点保持 null，由原适配器用邻接已知站点补齐，不按距离或名称合并站点。

分段时间必须单调、在总行程内，到发时刻齐全时与 durationSeconds 相符。DEPART_AT 检查所有候选 departure >= requested instant；ARRIVE_BY 检查所有 arrival <= requested instant。跨日按 UTC 比较，不对候选顺序作保证。

错误响应为 `{status:"ERROR",requestId,error:{code,message}}`。400 VALIDATION_ERROR、401 UNAUTHORIZED、422 UNSUPPORTED_MODE/UNSUPPORTED_QUERY、429 BUSY、503 PROVIDER_DISABLED/BROWSER_UNAVAILABLE、504 UPSTREAM_TIMEOUT、502 UPSTREAM_BLOCKED/UPSTREAM_ERROR/REQUEST_MISMATCH/SCHEMA_CHANGED、499 REQUEST_CANCELLED、404 NO_ROUTES。NO_ROUTES 需同时核对请求状态、响应端点和页面明确无路线文案。原 Travel 适配器将 NO_ROUTES 映射为无候选，不支持模式映射为不支持查询，其余归为上游不可用；服务保留细分诊断，不改变 Travel 的公共错误契约。

无缓存，无排队，无重试；单并发，单请求匿名非持久 BrowserContext。health 不启动浏览器、不访问 Google、不返回凭证。当前不提供 import、NOW、LAST_TRANSIT。
