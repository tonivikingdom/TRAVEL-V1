# Real Provider Bootstrap — PARTIAL

推荐模型：GPT-6.1 Sol / High；备选 GPT-6 Astra / High。Provider 契约疑难提高推理强度；实际运行配置未知。

Base: `7ed43747c9da17bc8eec6bd71374ea7321aab147`（已 fetch origin/main）。
Branch: `feat/real-provider-bootstrap`。

完成：空凭据模板、只读配置 doctor、显式 live doctor、无重试/单能力单请求/脱敏分类与计数、Google snapping bounded binding、百度 inverse approximation bounded binding、测试和环境说明。
保留 RegionalRouter、Japan Consumer Transit sidecar、approval gates、ARRIVE_BY 与未来百度驾车拒绝。

BLOCKED：百度公交/骑行/未来驾车、官方 Browser 坐标转换注入、新 JSAPI 迁移。官方文档网络请求被 proxy CONNECT 403 拒绝；未猜测 endpoint、参数、transit legs、future departure 或 arrival contract。当前任务四项凭据未配置，未执行真实 Provider 请求。
这些阻塞只暂停相应能力，完成其他工程修改。用户填四把 key 后可验收已有 6 项服务器能力；仍需浏览器 SDK 验收和官方契约后续施工。

Google RouteLeg 文档描述 endpoint 可因道路位置不同于 supplied waypoint，参考 https://developers.google.com/maps/documentation/routes/reference/rest/v2/Route#RouteLeg 。本次无法在线重新核实，因此状态仍 PARTIAL。
100m 是项目保守的 snapping 上限，不是 Provider 承诺；超过阈值/非法/缺失坐标 fail closed。归一化候选保留用户授权端点，使 downstream exact identity guard 不需要放宽。
百度 BD09LL → WGS84 数学 inverse 是 approximate/non-authoritative。50m 是项目误差预算，不是官方精度或官方 round-trip；真实验收需要多样本对照已知 WGS84/官方正向转换，记录误差并验证预算。不能凭 synthetic 通过批准 coordinate gate。

API/contract/schema delta：无公共 API、schema 或业务 travel mode 变更；新增 repo CLI；Provider boundary 增加显式距离绑定策略。
Migration delta: 0。现存 migration 数量见交付验证记录。
未部署 production，不合并 PR。

## 验证证据

- ESLint 全仓通过。
- Provider package、Web package、doctor 独立 TypeScript 检查通过（doctor 使用 `/tmp` 独立配置避免其他脚本的 Prisma 依赖）。
- Web production build 通过；server-key exclusion 构建级测试通过。
- 初轮相关 6 文件 / 81 tests 通过；新增配置模板与百度 unsupported mode 回归后，doctor + binding 2 文件 / 15 tests 通过。
- 全量 Vitest：84 文件通过、990 tests 通过；1 个 persistence suite 因生成 Prisma client 缺失无法加载，整体退出失败，未 skip。
- pnpm install 下载依赖成功，但 postinstall Prisma generate 因 `binaries.prisma.sh` 403 失败；完整仓库 typecheck/build 和 PostgreSQL integration 未完成，不代表全仓检查通过。
- `pnpm --config.verify-deps-before-run=false provider:doctor` 在当前环境通过，四把 key 全 UNSET，request count 0。临时缓存使用 `/tmp`；pnpm 依赖自动校验会重试被阻塞的 postinstall。
- 没有执行 `--live` 真实验收；mocks 的 fetch 次数不等于真实 Provider 请求。
- 现存 migration count 26；本次新增 0。

## 修改文件

`.env.provider.example`、`package.json`、`packages/providers/src/baidu-coordinates.ts`、`packages/providers/src/regional-route-adapters.ts`、`packages/providers/src/route-endpoint-binding.ts`、`packages/providers/test/route-endpoint-binding.test.ts`、`scripts/provider-doctor/{cli,config,runner,doctor.test}.ts`、`docs/provider-environment-setup.md`、本状态文件。

## GitHub 交付

实现提交 `335ec57` 已成功 push 到 `origin/feat/real-provider-bootstrap`。
Draft PR **BLOCKED**：执行 `gh pr create --draft`，GitHub GraphQL 返回 `Forbidden`；当前 CLI 认证检查也失败。未创建 PR，不宣称已完成 PR 或 CI；无合并、无部署。
分支比较页：https://github.com/tonivikingdom/TRAVEL-V1/compare/main...feat/real-provider-bootstrap 。
PR 正文已准备于当前任务临时文件 `/tmp/travel-provider-pr.md`，权限恢复后可用 `gh pr create --repo tonivikingdom/TRAVEL-V1 --base main --head feat/real-provider-bootstrap --draft --title "feat(providers): safe acceptance bootstrap (PARTIAL)" --body-file /tmp/travel-provider-pr.md`。
最终 SHA 由交付回复和远程分支记录确认（本报告不会自引用自身 commit SHA）。
