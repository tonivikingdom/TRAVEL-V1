# MagicPath 桌面首页独立预览

Issue #66 的真实导出快照与独立预览，现已按用户要求增加桌面响应式布局优化。仅用于桌面设计验收，全部旅程、通知和账户文案是 **SYNTHETIC 演示数据**。本预览没有业务 API、数据库或真实登录连接。

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
pnpm verify:layout-evidence
pnpm lint
pnpm typecheck
pnpm build
pnpm preview
```

`dev` 与 `preview` 共用 4178，请一次运行其中一个。构建依赖安装需要网络；页面图片与字体已保存本地，运行时不依赖 Unsplash 或 Google Fonts。

## 保留范围

- 原始 React/TypeScript、生成组件 CSS、内联 SVG 和已有演示交互保留；桌面布局由独立 `src/desktop-layout.css` 覆盖。
- 6 张原地址图片、2 份字体样式、202 份字体文件，共 210 个缓存资源、8,863,523 字节；没有替换图片或缺失资源。
- 导出源码仅有已声明的资源 URL、`theme` 的 `let→const` 修正，以及 `App.tsx` 导入桌面覆盖层。入口标题、预览命令与独立锁文件是运行适配。
- `verify:snapshot` 校验原始 ZIP、资源字节/哈希与全部导出 `src/` 文件；将已声明适配逆向还原后必须匹配原始源码哈希。

原包中的未使用依赖、`use-mobile.ts` 和原有媒体查询按导出结果保留，没有开发或验收手机端。重命名、分享、删除、新建旅程、账户操作仍是设计提示示例。

## 当前桌面布局

覆盖层仅在 CSS 宽度 ≥960px 生效。1920×1080 下主视觉为 440px，在较高窗口中逐步增高并限制为 360–560px；内容最大宽度随窗口适度增加，限制为 1408–1728px。卡片保持 268px 高、大屏最多四列；原有三列断点、导航样式和交互不变。页面背景使用原主题色 `#F8FBFE` 并以 `100dvh` 适配实际视口，内容过长时正常纵向滚动。

## 截图与验收

[响应式布局报告与前后截图](../../docs/status/ISSUE-67-DESKTOP-RESPONSIVE.md)包含三种主要 CSS 视口、缩放对应的实际尺寸、单卡片背景、原生 DPR 和交互验证。`verify:layout-evidence` 检查录制证据、截图哈希/尺寸及其对应的 CSS 指纹，不替代重新运行浏览器；更改覆盖层后应重新捕获证据。

原稿名称标注 1920×1080，但实际 MagicPath 画布组件为 1440×1024。[第一阶段历史报告](../../docs/status/ISSUE-66-MAGICPATH-DESKTOP.md)保留了原样迁移的 356px 主视觉基线。原始 ZIP 和素材快照没有修改；新的桌面优化可以通过移除覆盖层导入恢复基准布局。

桌面第二轮评审：见 [卡片、状态和居中报告](../../docs/status/ISSUE-67-CARD-REVIEW.md)，当前证据运行 pnpm verify:card-evidence。原导出源码保留，960 CSS px 以下继续使用原组件。
