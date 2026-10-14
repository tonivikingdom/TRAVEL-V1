# PR #67 桌面首页第二轮评审

模型建议：GPT‑6.1 Sol / High，备选 GPT‑6 Astra / High；用于明确的局部 UI 修改与浏览器验收。当前模型配置未切换。升级条件为交互或布局问题需要跨组件分析。

日期：2026-10-14。分支：`feat/issue-66-magicpath-desktop-preview`。本轮起点：`5ad5fc9`。仅独立预览，不改业务、不开发手机端、不合并 main。

用户确认出行中绿色、待出行蓝色、已结束灰色；费用为整趟总费用。

- “我的旅程”与筛选按钮作为整体水平居中，中心与主内容区域一致。未改变主视觉文案、顶部导航或卡片网格的位置。
- 筛选按钮与卡片标签沿用同一状态配色。筛选选中态为对应实色，未选中态为浅色底；文字和图标保留，颜色不是唯一识别手段。
- 卡片标签字号由 11px 增至 14px，标签由 90×30px 调整到 104×34px。
- 卡片信息分为标题、日期、地点与天数、总费用与人数四行；卡片仍为 268px 高，封面仍为 151px。
- 没有费用与人数的真实数据，使用 null，显示“总费用待填写／人数待填写”；原有旅程均为 SYNTHETIC 预览数据，没有编造价格或人数，也没有接入业务接口。

实现为单独桌面组件和 CSS。原始导出组件、CSS、ZIP 与素材不改。960px 以下继续渲染原组件，桌面查询监听在组件卸载时清理；跨断点切换会重置临时预览筛选状态，不涉及持久数据。新增副本是当前设计评审的桌面演进版本，后续正式业务接入需独立授权。

## 实际浏览器验收

CSS 视口 1920×1080、2560×1440、3840×2160、1280×720、960×540，各检查“全部”和“已结束”。五种视口筛选栏中心误差均小于 0.001px，卡片高度均 268px，没有横向溢出，主体背景适配视口；960px 保留三列，其余四列。费用／人数行在卡片底部以内，无裁切。

筛选卡片计数为 1／2／1／4；搜索瑞士得到一条结果；头像、通知、卡片菜单及 Escape 关闭通过。800px 窄屏确认渲染原组件，未显示新增桌面信息行。浏览器 error／warn 日志为空。

本轮截图直接保存浏览器原生返回的像素，未重绘或调整尺寸。CSS 视口来自 DOM 测量；截图文件的像素尺寸不冒充精确 CSS 视口尺寸。完整测量、交互记录、源码与截图 SHA-256 见 [证据目录](assets/issue-67-card-review/manifest.json)。

| CSS 视口  | 全部                                                  | 已结束                                                  |
| --------- | ----------------------------------------------------- | ------------------------------------------------------- |
| 1920×1080 | [截图](assets/issue-67-card-review/1920x1080-all.jpg) | [截图](assets/issue-67-card-review/1920x1080-ended.jpg) |
| 2560×1440 | [截图](assets/issue-67-card-review/2560x1440-all.jpg) | [截图](assets/issue-67-card-review/2560x1440-ended.jpg) |
| 3840×2160 | [截图](assets/issue-67-card-review/3840x2160-all.jpg) | [截图](assets/issue-67-card-review/3840x2160-ended.jpg) |
| 1280×720  | [截图](assets/issue-67-card-review/1280x720-all.jpg)  | [截图](assets/issue-67-card-review/1280x720-ended.jpg)  |
| 960×540   | [截图](assets/issue-67-card-review/960x540-all.jpg)   | [截图](assets/issue-67-card-review/960x540-ended.jpg)   |

修改前见 [第一轮响应式布局报告](ISSUE-67-DESKTOP-RESPONSIVE.md)，其 38 张截图与记录属于 5ad5fc9 历史验收。本轮 `verify:card-evidence` 绑定当前渲染源码和截图；原 `verify:layout-evidence` 保留验证上一轮归档证据，不将旧截图当成本轮效果。

![当前全部状态](assets/issue-67-card-review/1920x1080-all.jpg)

![当前已结束状态](assets/issue-67-card-review/1920x1080-ended.jpg)

## 验证与运行

本地 `verify:snapshot`、`verify:layout-evidence`、`verify:card-evidence`、lint、typecheck、build 均通过。证据校验检查已记录的浏览器结果与文件哈希，CI 不重新启动浏览器。当前提交的 GitHub 检查以 PR #67 为准，不能继承上一提交的成功状态。

在 `ui-previews/magicpath-desktop` 执行 `pnpm preview`，访问 `http://127.0.0.1:4178/`。请使用桌面浏览器宽度至少 960 CSS px 查看本轮修改；窄侧栏显示保留的原组件。

停止点：本轮三个首页问题完成，费用／人数保持待填写。无正式业务接入、main 合并或下一阶段开发。
