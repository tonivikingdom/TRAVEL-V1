# PR #67：桌面响应式布局与截图验收

模型建议：GPT-6.1 Sol / High；备选 GPT-6 Astra / High。任务以小范围桌面 CSS 和实际浏览器证据为主；出现难以解释的缩放或截图差异时再提高推理强度。建议不切换当前会话配置。

## 结果与范围

本次基于 [Draft PR #67](https://github.com/tonivikingdom/TRAVEL-V1/pull/67)，在 `feat/issue-66-magicpath-desktop-preview` 分支继续优化。对照基线为 `115516d28fad59ffa2a155914fcdbaf3a554fc58`，最终交付 SHA 以 PR 当前 HEAD 为准。

较高桌面窗口或筛选为单张旅程时，原主体最小高度固定 1080px，页面下方会露出白色背景。现在主体、宿主容器和浏览器页面统一为原有 `#F8FBFE`，最小高度跟随实际视口；主视觉在 1920×1080 为 440px，内容宽度适度增加，卡片高度、样式和交互保留。

只新增独立桌面 CSS 覆盖层和一条导入，生成组件 TSX/CSS、原始 ZIP、素材、手机媒体查询不变。覆盖层仅在 CSS 宽度 ≥960px 生效；没有业务 API、数据库、登录或手机端改动，也没有修改或合并 main。导航布局仍为原来的 Logo、搜索、通知与头像，弹出菜单随新的内容边缘对齐。

## 布局规则

| 项目                 | 修改前                 | 修改后                                           |
| -------------------- | ---------------------- | ------------------------------------------------ |
| 主视觉               | 固定 356px             | `clamp(360px, 20dvh + 224px, 560px)`，带 vh 回退 |
| 页面最小高度         | 固定 1080px            | `100dvh`，带 100vh 回退；内容可继续增高          |
| 主内容与导航最大宽度 | 1408px                 | `clamp(1408px, 80vw, 1728px)`，两者保持对齐      |
| 卡片高度、封面高度   | 268px、151px           | 保留原值                                         |
| 卡片列数             | 四列；原小桌面三列断点 | 保留，最多四列，没有第五列                       |
| 页面滚动             | 固定高度基线留下空白   | 正常纵向滚动，不压缩卡片或强制两行入屏           |
| 背景                 | 主体浅蓝灰，外层白色   | html/body/root/主体均为原浅蓝灰                  |

## 三种主要 CSS 视口

以下数值来自实际浏览器 DOM 测量，非图片推算。每种视口均检查“全部”和“已结束”两种状态；“已结束”保留原有新建卡片，旅程卡片本身只有 1 张。

| CSS 视口  | 主视觉前→后 | 内容宽度前→后 | 默认主体高度（后） | 已结束主体高度前→后 | 列数/卡片高 |
| --------- | ----------- | ------------- | ------------------ | ------------------- | ----------- |
| 1920×1080 | 356→440px   | 1408→1536px   | 1240.5px，可滚动   | 1080→1080px         | 4 / 268px   |
| 2560×1440 | 356→512px   | 1408→1728px   | 1440px             | 1080→1440px         | 4 / 268px   |
| 3840×2160 | 356→560px   | 1408→1728px   | 2160px             | 1080→2160px         | 4 / 268px   |

1920×1080 默认状态确实发生纵向滚动，实测到底部约 160.67px，末张卡片与页脚可以完整访问。第二行卡片没有被压扁以塞进第一屏。

## 缩放与较短桌面窗口

浏览器用 CSS 像素布局；物理显示面积、系统缩放、浏览器缩放和窗口边框共同影响实际可用视口。本次没有改动用户系统缩放设置。

- 本机 Chrome 实际观测：`innerWidth=2560`、`innerHeight=1279`、`devicePixelRatio=1.5`，前后在同一窗口记录，包含默认和单张旅程状态。修改后主视觉约 479.86px，已结束主体约 1279.33px，背景覆盖实际视口。DPR 单独记录，不把它直接等同于某个系统设置。
- 125%、150%、200% 场景通过浏览器直接使用相应的等效 CSS 视口验证。下表的显示面积映射是内容区除以缩放比例的估算，不包含浏览器边框/工具栏；指定截图对应的 CSS 尺寸均已实测，不是缩放图片。
- 3840×2160 内容区在 150% 下对应 2560×1440 CSS 视口，在 200% 下对应 1920×1080 CSS 视口，这两种已被主要矩阵覆盖。

| 估算场景 / CSS 视口                 | 主视觉（后） | 列数          | 卡片高 | 背景与水平溢出     |
| ----------------------------------- | ------------ | ------------- | ------ | ------------------ |
| 1920×1080 / 125% → 1536×864         | 396.79px     | 4             | 268px  | 满铺，无水平溢出   |
| 2560×1440 / 150% → 1707×960（取整） | 416px        | 4             | 268px  | 满铺，无水平溢出   |
| 1920×1080 / 150% → 1280×720         | 368px        | 4             | 268px  | 满铺，无水平溢出   |
| 1920×1080 / 200% → 960×540          | 360px，下限  | 3，沿用原断点 | 268px  | 满铺，正常纵向滚动 |
| 短窗口 1920×600                     | 360px，下限  | 4             | 268px  | 满铺，正常纵向滚动 |

所有场景均检查两种筛选状态。较短窗口仍可滚动到全部内容；这不是手机端开发或验收。

## 实际截图与前后对照

32 张指定 CSS 视口截图均为实际浏览器直接输出，其文件尺寸逐一核验为对应 CSS 视口；每次捕获前确认 `scrollY=0`。另外保存 4 张本机原生窗口图、头像菜单图和完整页面图，共 38 张。原生窗口/完整页面图保留截图接口返回的原始像素范围，和其记录的 CSS 视口分别标明，不将它们冒充指定尺寸截图。图片没有后期拉伸、拼接或重绘。

1920×1080，默认状态，修改前：

![1920 默认 修改前](assets/issue-67-desktop-layout/before/1920x1080-all.jpg)

1920×1080，默认状态，修改后：

![1920 默认 修改后](assets/issue-67-desktop-layout/after/1920x1080-all.jpg)

3840×2160，已结束，修改前：

![3840 已结束 修改前](assets/issue-67-desktop-layout/before/3840x2160-ended.jpg)

3840×2160，已结束，修改后：

![3840 已结束 修改后](assets/issue-67-desktop-layout/after/3840x2160-ended.jpg)

后两张图底部的实际 JPEG 像素由 `[255,255,255]` 变为约 `[247,251,254]`，与原浅蓝灰主题色一致；JPEG 允许少量编码误差。2560×1440 的单张旅程状态也完成相同检查。

| CSS 视口  | 修改前：默认 / 已结束                                                                                                                                           | 修改后：默认 / 已结束                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1920×1080 | [默认](assets/issue-67-desktop-layout/before/1920x1080-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/1920x1080-ended.jpg)                           | [默认](assets/issue-67-desktop-layout/after/1920x1080-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/1920x1080-ended.jpg)                           |
| 2560×1440 | [默认](assets/issue-67-desktop-layout/before/2560x1440-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/2560x1440-ended.jpg)                           | [默认](assets/issue-67-desktop-layout/after/2560x1440-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/2560x1440-ended.jpg)                           |
| 3840×2160 | [默认](assets/issue-67-desktop-layout/before/3840x2160-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/3840x2160-ended.jpg)                           | [默认](assets/issue-67-desktop-layout/after/3840x2160-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/3840x2160-ended.jpg)                           |
| 1536×864  | [默认](assets/issue-67-desktop-layout/before/scale-125-1536x864-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/scale-125-1536x864-ended.jpg)         | [默认](assets/issue-67-desktop-layout/after/scale-125-1536x864-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/scale-125-1536x864-ended.jpg)         |
| 1707×960  | [默认](assets/issue-67-desktop-layout/before/scale-150-1707x960-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/scale-150-1707x960-ended.jpg)         | [默认](assets/issue-67-desktop-layout/after/scale-150-1707x960-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/scale-150-1707x960-ended.jpg)         |
| 1280×720  | [默认](assets/issue-67-desktop-layout/before/scale-150-1280x720-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/scale-150-1280x720-ended.jpg)         | [默认](assets/issue-67-desktop-layout/after/scale-150-1280x720-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/scale-150-1280x720-ended.jpg)         |
| 960×540   | [默认](assets/issue-67-desktop-layout/before/scale-200-960x540-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/scale-200-960x540-ended.jpg)           | [默认](assets/issue-67-desktop-layout/after/scale-200-960x540-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/scale-200-960x540-ended.jpg)           |
| 1920×600  | [默认](assets/issue-67-desktop-layout/before/short-desktop-1920x600-all.jpg) / [已结束](assets/issue-67-desktop-layout/before/short-desktop-1920x600-ended.jpg) | [默认](assets/issue-67-desktop-layout/after/short-desktop-1920x600-all.jpg) / [已结束](assets/issue-67-desktop-layout/after/short-desktop-1920x600-ended.jpg) |

补充：[本机原生修改前默认](assets/issue-67-desktop-layout/before/native-system-all.jpg)、[修改后默认](assets/issue-67-desktop-layout/after/native-system-all.jpg)、[本机原生修改前已结束](assets/issue-67-desktop-layout/before/native-system-ended.jpg)、[修改后已结束](assets/issue-67-desktop-layout/after/native-system-ended.jpg)、[头像菜单](assets/issue-67-desktop-layout/after/1920x1080-account.jpg)、[完整页面](assets/issue-67-desktop-layout/after/1920x1080-all-full.jpg)。

## 验证与证据

| 检查                                        | 实际结果                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm verify:snapshot`                      | 原始 ZIP、210 个资源、全部 10 个原导出源码文件校验通过；只逆向移除已声明宿主适配和桌面 CSS 导入 |
| `pnpm verify:layout-evidence`               | 8 个 CSS 视口 × 2 状态、38 张图片、卡片高度/列数/背景/菜单对齐/交互/滚动检查通过                |
| `pnpm lint`、`pnpm typecheck`、`pnpm build` | 通过                                                                                            |
| 实际浏览器                                  | 内嵌 Chromium 的明确 CSS 尺寸捕获；本机 Chrome 的真实 DPR/窗口捕获                              |
| 筛选                                        | 出行中/待出行/已结束/全部分别为 1/2/1/4 张旅程卡片                                              |
| 搜索                                        | 瑞士有单个匹配结果，无匹配文案可显示，输入和关闭行为保留                                        |
| 菜单与提示                                  | 通知、头像、卡片操作菜单、Escape、新建旅程演示提示保留                                          |
| 菜单对齐                                    | 三种大屏下头像菜单右边缘和导航一致；通知菜单沿用 61px 相对偏移                                  |
| 浏览器日志                                  | 验证期间 error/warn 为空                                                                        |

逐项原始数据：[修改前布局](assets/issue-67-desktop-layout/before/layouts.json)、[修改后布局](assets/issue-67-desktop-layout/after/layouts.json)、[本机窗口/DPR](assets/issue-67-desktop-layout/native-system.json)、[菜单](assets/issue-67-desktop-layout/panels.json)、[交互与滚动](assets/issue-67-desktop-layout/interactions.json)、[截图尺寸/哈希/底部像素](assets/issue-67-desktop-layout/screenshots.json)。

证据校验脚本检查当前覆盖层的文本 SHA-256 与捕获记录匹配；调整 CSS 后必须更新浏览器证据。它校验已经录制的实际结果，不宣称在 GitHub 上重新操作了这个预览浏览器。GitHub 专用预览 CI 执行快照、证据、lint、类型与编译检查，原仓库业务 CI 单独运行，其最终结果见 PR 当前检查。

## 运行与停止点

```powershell
cd ui-previews/magicpath-desktop
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:4178/>。本次验证使用了编译后的 `pnpm preview`，对照图来自基线提交的隔离静态预览，不涉及业务服务。

仅更新 Draft PR #67，等待用户审阅桌面效果。保留原始快照作为回退基准，没有合并 main，也没有开展业务接入或手机端工作。
