# Issue #66：MagicPath 桌面首页原样迁移

模型建议：GPT-6.1 Sol / High；备选 GPT-6 Astra / High。本阶段主要是真实导出、资源完整性和浏览器核验；若遇到复杂导出结构或难以解释的视觉差异，再升级推理强度。建议不会切换当前会话配置。

## 阶段与来源

- 第一阶段：保存快照并建立独立桌面预览，停止于 Draft PR 和用户验收。
- 分支：`feat/issue-66-magicpath-desktop-preview`。
- main 基线：`4f6b31a262acdf9ac634f0ad58eab437ca79d4cb`。
- Issue：[UI Design Migration #66](https://github.com/tonivikingdom/TRAVEL-V1/issues/66)。
- MagicPath：[源项目](https://www.magicpath.ai/files/460289538988863488)，[v13 发布预览](https://designs.magicpath.ai/v1/vibrantly-dusk-6071)。
- 导出：2026-10-13 14:31:49（Asia/Shanghai），网页 Code → Download codebase。API 插件只读请求返回额度不足（50/50），随后正常网页导出成功，无需再次登录或购买升级。
- 最新组件：桌面首页 · 默认状态，`v13 · latest`；组件 `460296927121121280`，修订 `460575445763645440`。

## 交付与运行

原始 ZIP、逐文件 SHA-256、来源、版本与资源清单位于 [design-snapshots](../../design-snapshots/magicpath/2026-10-13-v13/README.md)。ZIP 未改动；SHA-256 为 `9f836b476c29df4eae579b6a4ab9c660352d7b8317893f8226ecf35c21ee56ba`。

在仓库根目录执行：

```powershell
cd ui-previews/magicpath-desktop
pnpm install --frozen-lockfile
pnpm dev
```

预览地址：<http://127.0.0.1:4178/>。当前交付也运行了 `pnpm build` 和 `pnpm preview`，供直接查看编译结果。完整说明见 [预览 README](../../ui-previews/magicpath-desktop/README.md)。

新增独立 `ui-previews/` 目录、独立 workspace/锁文件和专用 CI。没有修改 `apps/`、`packages/`、数据库、业务 API、既有登录或移动客户端。根 ESLint 只新增对全新预览目录的排除：原导出使用 ESLint 9/旧解析器，根 ESLint 10 若混用会报 `scopeManager.addGlobals is not a function`；新预览由独立流水线执行原导出依赖的 lint/typecheck/完整性校验/build，既有业务检查规则继续保留。

## 截图对照

两张截图均在同一浏览器、显式 1920×1080 捕获区域、默认状态、页面顶部完成。文件尺寸实际校验为 1920×1080。JPEG 解码后本次逐像素比较 RGB 平均绝对差为 `[0, 0, 0]`，结果见 [screenshot-comparison.json](assets/issue-66-magicpath/screenshot-comparison.json)。这是本次截图结果，不承诺所有浏览器和字体环境逐像素相同。

MagicPath v13 原版：

![MagicPath v13 原版 1920×1080](assets/issue-66-magicpath/magicpath-v13-1920x1080.jpg)

本地原样迁移：

![本地预览 1920×1080](assets/issue-66-magicpath/local-v13-1920x1080.jpg)

[头像菜单截图](assets/issue-66-magicpath/local-account-menu.jpg)、[1440×900 桌面](assets/issue-66-magicpath/local-1440x900.jpg)、[1024×900 桌面](assets/issue-66-magicpath/local-1024x900.jpg)已保存。[桌面缩放证据](assets/issue-66-magicpath/desktop-resize.json)确认 1440 宽度保留四列，1024 宽度按原 CSS 切换三列，无横向溢出。

## 实际验证

| 检查                 | 结果与证据                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 导出依赖安装         | `pnpm import` 从原始 yarn.lock 转换；`pnpm install --frozen-lockfile` 成功，Node 24.19.0、pnpm 11.25.0                                            |
| 原包/源码/资源完整性 | `pnpm verify:snapshot` 通过：ZIP、210 个缓存资源、全部 10 个导出源码文件                                                                          |
| 预览静态检查         | `pnpm lint`、`pnpm typecheck` 通过                                                                                                                |
| 根仓库 lint          | `node node_modules/eslint/bin/eslint.js .` 通过；新预览由独立检查覆盖                                                                             |
| 预览编译             | `pnpm build` 通过（TypeScript 5.7.3、Vite 6.2.0）                                                                                                 |
| 浏览器运行           | `pnpm preview` 在 loopback 4178 启动，首页、原图和字体实际加载                                                                                    |
| 原有交互             | 全部/出行中/待出行/已结束分别展示 4/1/2/1 张旅程；搜索瑞士有匹配结果；通知、头像与旅程操作菜单可打开；Escape 可关闭；新建旅程显示原稿下一阶段提示 |
| 浏览器错误           | 验证期间读取 error/warn 日志为空                                                                                                                  |
| 桌面视口             | 1920×1080、1440×900、1024×900；没有手机端开发或验收                                                                                               |

交互过程的实际 DOM 快照见 [interaction-evidence.json](assets/issue-66-magicpath/interaction-evidence.json)；浏览器几何采样见 [layout-1920x1080.json](assets/issue-66-magicpath/layout-1920x1080.json)，采样会包含各查看器当前滚动条状态，截图以显式捕获区域为准。

验证路径：浏览器打开页面 → 本地静态脚本与资源 → 导出组件本地 React 状态 → 原有演示结果展示。没有业务服务请求或真实数据源。React 检查确认现有状态/hooks、事件清理、按钮标签和键盘 Escape 行为可运行；没有为性能或风格重构生成组件。

原模板首次 lint 仅发现 `App.tsx` 的 `theme` 从未重新赋值，已改为 `const` 后通过。首次根 lint 暴露上述解析器冲突，已将独立预览交由专用检查，未弱化业务目录检查。全业务集成和数据库测试不属于此次源码迁移验证，不宣称已经重跑通过；PR 的既有 CI 结果以 GitHub 实际状态为准。

## 资源与保留差异

- 6 张图片与 2 份字体 CSS、202 份字体二进制全部按原 URL 保存，共 8,863,523 字节；没有替换图片，缺失资源清单为空。原内联 SVG 全部保留。
- 源码变化仅为本地资源 URL、模板 `let→const`；入口标题与中文 `lang`、运行命令、独立 pnpm/CI 是宿主适配。完整原包始终保留。
- 原稿名称标注 1920×1080，实际画布是 1440×1024；按响应式真实源码预览，而不是缩放重绘。
- 原设计主视觉 356px；页面内容高度约 1156.5px，页脚在 1080 首屏下方，保持原样。
- 原通知文本包含北海道，与旅程卡片的日本行程文案存在演示内容差异；保留原稿文案。
- 原依赖及未用的 `use-mobile.ts`、原 CSS 媒体查询仍保留，不代表开发或验收手机端。
- 所有旅程、通知和账户内容是 **SYNTHETIC 设计演示**，新建/重命名/分享/删除/账户操作保留原提示，不等于业务实现。

## 停止点

仅提交 Draft PR，等待用户确认原样迁移效果。没有合并 main，也没有实施 440px 主视觉、进一步视觉调整、业务接入或手机端。
