# Google Transit 云端兼容服务

本服务是 **REBUILT_COMPATIBLE_IMPLEMENTATION**，依据现有 Travel 契约和历史材料新写，非原源码恢复或原样迁移。仅供个人 development/test 低频实验；使用匿名 Google Maps Consumer 页面，不调用付费 Routes API。交付证据及未验证项见 [状态报告](../../docs/status/GOOGLE_CONSUMER_TRANSIT_CLOUD_REBUILD.md)。

## 启动

需要仓库锁定的 Node 24、pnpm 11、Linux Chromium 和现有 workspace 依赖。此次云端环境已有 `/usr/bin/chromium`；其他 Debian 环境可以由环境维护者安装 `chromium`。`playwright-core` 不下载浏览器，不包含个人 Chrome 配置或 Cookie。

```bash
pnpm install --frozen-lockfile
pnpm --filter @travel/google-consumer-transit token
```

token 命令在服务目录生成权限 0600 的未跟踪 `.env`，默认关闭服务，不打印 token，不覆盖现有文件。[模板](.env.dev.example) 列出配置。确认个人开发使用范围和网络访问后，在该私有文件中设置 `ENABLE_GOOGLE_CONSUMER_TRANSIT=true`，然后：

```bash
pnpm --filter @travel/google-consumer-transit dev
```

入口读取可选 `.env` 和进程环境，监听 `127.0.0.1:8787`。只有 development/test 可启动，其他地址和非单并发配置直接拒绝。构建后可用 `pnpm --filter @travel/google-consumer-transit start`。

云端使用环境提供的 HTTP(S) proxy 和 `CODEX_PROXY_CERT` 时，仅信任该证书的公钥，不关闭全局 TLS 验证，不改变网络策略；会话证书与代理值不进入仓库。无代理的普通环境使用系统证书。

## Travel 接入

API 和服务应在同一主机／网络命名空间运行。服务在宿主机时，应直接在宿主机启动 API；现有 Compose API 容器自己的回环地址不能访问宿主机服务。本批未添加容器桥接地址例外，也未改动生产 Compose。

在 API 的私有环境中配置：

```dotenv
APP_ENV=development
ROUTE_PROVIDER=google_consumer_experimental
GOOGLE_CONSUMER_TRANSIT_BASE_URL=http://127.0.0.1:8787
GOOGLE_CONSUMER_TRANSIT_TOKEN=与服务专用token相同的私有值
GOOGLE_CONSUMER_TRANSIT_TIMEOUT_MS=60000
```

适配器原有 30000ms 默认值及 1000–120000ms 配置范围未改。60 秒是这个启动示例的选择，覆盖服务默认 45 秒截止时间。还需按仓库原说明配置隔离 PostgreSQL、认证和私有对象存储，再运行 `pnpm dev:api`；不需要前端。

## 接口与保护

`GET /health` 无鉴权，只报告启用、忙碌、版本和两种模式，不启动浏览器、不访问 Google。`POST /v1/transit/search` 使用专用 Bearer token；输入输出详见 [兼容契约](CONTRACT.md)。

DEPART_AT 和 ARRIVE_BY 均通过可见 UI 选择，不生成私有 `pb` 请求或手工注入模式 URL。每次新建非持久 BrowserContext，指定 IANA 时区，复用服务自有浏览器进程；操作结束、断开或超时后关闭上下文。第二个请求立即返回 BUSY，不排队。没有缓存、自动重试或后台查询。

捕获页面自行产生的 directions 响应，多份响应分别解析核对。成功必须同时匹配 UI、页面时间状态、响应端点、时区、绝对候选时刻及可见路线标记。`fetchedAt` 来自选中响应的实际捕获时刻。原始 URL、响应、header、Cookie、凭证不记录或保存。

未知步行时刻、步行坐标及可选线路名保持 null；总时长含等待时间，不把等待错误加到车程上。解析异常、请求不匹配、网络故障不能返回空路线。遇到 CAPTCHA、登录门槛或明确封禁，返回 UPSTREAM_BLOCKED 并结束操作；调用者必须停止追加 live 尝试。

## 测试

```bash
pnpm --filter @travel/google-consumer-transit test
pnpm --filter @travel/google-consumer-transit typecheck
pnpm --filter @travel/google-consumer-transit build
```

所有单测 fixture 明示 SYNTHETIC。测试不连接 Google；包括真实 loopback HTTP 契约测试，但其数据仍是合成数据。

低频真实验证需明确日期与个人开发范围确认：

```bash
GOOGLE_TRANSIT_LIVE_ACK=personal-development \
GOOGLE_TRANSIT_LIVE_DATE=2026-10-05 \
pnpm --filter @travel/google-consumer-transit test:live
```

示例日期属于本次验收；后续需要重新选择实际可查询的日期。最多四个串行目标查询，间隔 15 秒；遇到受限即停止。摘要只写入 gitignored `artifacts/google-consumer-transit/`。

完整 Travel 验收必须先 `pnpm build`，使用已应用原有 24 个 migrations 的独立 PostgreSQL 数据库，名字以 `_google_live_test` 结尾且位于回环地址。传入私有 `TEST_DATABASE_URL`，再明确授权隔离测试 Adopt/Undo：

```bash
GOOGLE_TRANSIT_LIVE_ACK=personal-development \
GOOGLE_TRANSIT_LIVE_ADOPT_ACK=isolated-test-adopt-and-undo \
GOOGLE_TRANSIT_LIVE_DATE=2026-10-05 \
pnpm --filter @travel/google-consumer-transit test:travel-live
```

该脚本使用真实 HTTP 连接 Travel API 与 sidecar，生成隔离测试账户和行程，分别运行两种模式、Snapshot、Preview、显式 Adopt、Undo；不发送邮件、不 reset 数据库。账户／行程标为 SYNTHETIC，候选来自实时 Google 查询。它保留测试记录供复核，测试数据库由操作者在验收后单独关闭。

## 限制与关闭

当前日期控制仅支持页面可见日历中的日期；其他月份明确返回 UNSUPPORTED_QUERY，不构造未经验证的私有状态。日期年、模式和绝对当地时间还会通过页面状态核对。跨日与 DST 保护已做合成回归，跨日真实路线尚未验收。

不包含 import、NOW／立即出发、LAST_TRANSIT／末班车、生产可用性保证。Google 页面或私有结构变化会失败关闭。验证码、封禁、真实无路线和真实结构变化本批未实际遇到，相应负例只有自动测试证据。

设置 `ENABLE_GOOGLE_CONSUMER_TRANSIT=false` 即停止后续查询；停止新服务进程会关闭其浏览器。API 改回 `ROUTE_PROVIDER=unconfigured` 并按正常方式重启即可回退，不改行程或 schema；生产限制始终保留。原电脑服务不受影响。
