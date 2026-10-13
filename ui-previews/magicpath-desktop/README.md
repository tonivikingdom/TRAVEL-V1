# MagicPath 桌面首页独立预览

Issue #66 第一阶段：真实导出、资源快照、原样迁移。仅用于桌面设计验收，全部旅程、通知和账户文案是 **SYNTHETIC 演示数据**。本预览没有业务 API、数据库或真实登录连接。

来源：MagicPath「旅途计划 · 桌面首页｜头像菜单」中的「旅途计划｜桌面首页 · 默认状态（1920×1080）」，2026-10-13 导出 **v13 · latest**。原始 ZIP 与完整清单见 [design-snapshots](../../design-snapshots/magicpath/2026-10-13-v13/README.md)。

## 运行

使用 Node.js 24、pnpm 11。在仓库根目录执行：

```powershell
cd ui-previews/magicpath-desktop
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:4178/>。这里有独立 `pnpm-workspace.yaml` 和锁文件，不需要在业务仓库安装依赖、配置 `.env` 或启动业务服务。端口占用会明确失败，不会静默换端口。

构建后的预览：

```powershell
pnpm verify:snapshot
pnpm lint
pnpm typecheck
pnpm build
pnpm preview
```

`dev` 与 `preview` 共用 4178，请一次运行其中一个。构建依赖安装需要网络；页面图片与字体已保存本地，运行时不依赖 Unsplash 或 Google Fonts。

## 保留范围

- 原始 React/TypeScript、CSS、内联 SVG 和已有演示交互。主视觉 356px、两行卡片、四种状态筛选均保留。
- 6 张原地址图片、2 份字体样式、202 份字体文件，共 210 个缓存资源、8,863,523 字节；没有替换图片或缺失资源。
- 预览源码只替换资源地址，并将导出模板的 `App.tsx` 中 `let theme` 改为 `const theme`，修正原有 lint 错误。入口标题、预览命令与独立锁文件是运行适配。
- `verify:snapshot` 校验原始 ZIP、资源字节/哈希与全部导出 `src/` 文件；将已声明适配逆向还原后必须匹配原始源码哈希。

原包中的未使用依赖、`use-mobile.ts` 和原有媒体查询按导出结果保留，没有开发或验收手机端。重命名、分享、删除、新建旅程、账户操作仍是设计提示示例。

## 截图与验收

[阶段报告](../../docs/status/ISSUE-66-MAGICPATH-DESKTOP.md)包含截图、验证结果和停止点。基准 1920×1080，另检查 1440×900 与 1024×900 桌面窗口；没有改变原设计的窄屏规则。

原稿名称标注 1920×1080，但实际 MagicPath 画布组件为 1440×1024；预览按真实响应式源码在 1920×1080 捕获。原稿页面内容高度约 1156.5px，因此第二行卡片接近首屏底部，页脚需滚动才能看到，此行为原样保留。
