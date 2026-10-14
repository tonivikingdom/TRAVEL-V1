# MagicPath 原始导出快照

- 项目：[旅途计划 · 桌面首页｜头像菜单](https://www.magicpath.ai/files/460289538988863488)
- 组件：旅途计划｜桌面首页 · 默认状态（1920×1080）
- 最新版本：`v13 · latest`；组件 `460296927121121280`，修订 `460575445763645440`
- 导出时间：2026-10-13 14:31:49（Asia/Shanghai）
- 取得方式：已授权网页 Code → Download codebase。插件只读请求返回 `EXTERNAL_AGENT_API_QUOTA_EXCEEDED`（50/50），随后使用正常网页导出，没有绕过权限或购买升级。
- 原始 ZIP：`magicpath-project.zip`，82,642 字节，SHA-256 `9f836b476c29df4eae579b6a4ab9c660352d7b8317893f8226ecf35c21ee56ba`。ZIP 从网页下载后未修改。
- 完整文件、来源、日期、版本与基线信息：`source-manifest.json`。
- 资源来源 URL、文件路径、字节数、SHA-256：`assets-manifest.json`。Google Fonts 原始 CSS 响应保存在本目录，资源文件保存在预览 `public/assets/`。

ZIP 包含 22 个文件，涵盖 React/TypeScript、生成组件 CSS、全局 CSS、配置与原始 `yarn.lock`。它没有图片/字体二进制；这些按源码中的精确原始 URL 获取并保存，没有重绘或替代资源。Logo、图标、新建卡片山形是原始内联 SVG，仍保留在 TSX。

## 可追溯性

在 `ui-previews/magicpath-desktop` 执行 `pnpm verify:snapshot`，会校验 ZIP 与所有资源，并将全部 10 个导出源码文件中声明的本地资源 URL、`theme` 声明适配还原后，检查原始文本 SHA-256。

`source-manifest.json` 同时包含逐文件原始字节哈希和规范化文本哈希；后者只统一 CRLF/LF，避免系统换行差异被误判为设计修改。原始包是恢复基准；不要更新它来掩盖未来视觉调整。下一阶段修改应保留此快照并另记增量。

资源目录和本快照的 `.gitattributes` 禁止 Git 改写缓存字体 CSS 的换行，保证 Windows 与 Linux 检出后的资源字节哈希一致。

## 资源清单

| 资源 | 原来源 | 保存方式 |
| --- | --- | --- |
| 山湖与木船主视觉 | Unsplash `photo-1476514525535-07fb3b4ae5f1?w=2200&q=90` | 原地址二进制缓存 |
| 头像 | Unsplash `photo-1470770841072-f978cf4d019e?w=130&q=70` | 原地址二进制缓存 |
| 日本卡片 | Unsplash `photo-1493976040374-85c8e12f0c0e?w=1000&q=85` | 原地址二进制缓存 |
| 瑞士卡片 | Unsplash `photo-1501785888041-af3ef285b470?w=1000&q=85` | 原地址二进制缓存 |
| 冰岛卡片 | Unsplash `photo-1476610182048-b716b8518aae?w=1000&q=85` | 原地址二进制缓存 |
| 意大利卡片 | Unsplash `photo-1499856871958-5b9627545d1a?w=1000&q=85` | 原地址二进制缓存 |
| Noto Sans SC 400/500/600/700 | 导出代码中的两条 Google Fonts 样式地址 | 原 CSS 响应 + 202 个字体文件 |
| Logo、图标与山形 | 导出的 React 内联 SVG | 原 TSX 保留 |

缺失清单为空。原设计 CSS 还列出系统回退字体（PingFang SC、Microsoft YaHei、Noto Sans CJK SC、Arial）及 Inter；Inter 未在原包中单独引入，保留原回退行为，没有补装或替代字体。清单记录来源与完整性，不扩大第三方素材许可。
