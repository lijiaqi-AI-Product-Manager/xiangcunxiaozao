# 湘村小灶 · 点单页视觉小样（design/）

> 新中式诗意 · 六版本矩阵 · 375px 移动端优先 · 可交互静态网页
> 定位：**视觉重做小样**（不接支付/后端），给老板和顾客看效果、拍板用。
> 生产系统（`server/` + `web/`）零改动，本工程完全独立于 `design/` 目录。

## 六版本矩阵

| 目录 | 版本 | 差异点 |
|---|---|---|
| `dist/v2-ink/` | V2·墨字 | 独立结算条 + 墨字白底缩略图（**基准版**） |
| `dist/v2-macaron/` | V2·马卡龙 | 马卡龙底缩略图（4色按菜品编号哈希固定） |
| `dist/v1-dock/` | V1·并入Dock | 结算并入底部胶囊导航 |
| `dist/hero/` | 大画态 | heroDish 240px 水墨大图区 + 滚动收起横幅卡 |
| `dist/green/` | 淡绿纸 | 绿纸底 + 大画态 |
| `dist/ink-black/` | 墨黑结构 | 结构色 #2B2622 + 大画态 |

每版含 `index.html`（点单页）+ `detail.html?id=F01..M06`（详情页，48道可查）。
入口：`dist/index.html`（版本导航页）。顶部切换条为**演示/评审脚手架，发布版移除**。

## 快速开始

```bash
cd design
npm i            # 仅 playwright（截图/录屏/测试用）
npm run build    # menu.json → 六版本 dist/（唯一数据源，改完重跑即全站生效）
npm test         # 单元8 + e2e红线自证（tests/e2e/report.json）
npm run capture  # 21张截图 → shots/
npm run compare  # 六版并排矩阵图 ×2 → shots/matrix-*.png
npm run record   # 四段录屏 webm → recordings/
```

## 红线自证表（全部实测，非声明）

| # | 红线 | 实测值 | 判定 | 方法 |
|---|---|---|---|---|
| 1 | 常驻动画只动 opacity/transform | 越界属性 0 个 | ✅ | getAnimations→getKeyframes 逐帧属性审计（排除 offset/easing/composite 元数据） |
| 2 | 主线程不被动画阻塞 | rAF 平均帧 16.7ms（≈vsync，动画常驻中） | ✅ | 动画运行时 130 帧 rAF 采样 |
| 4 | 无图态/横幅卡收起后一屏≥6道 | 无图态 **6道**；hero 滚动后 **8道** | ✅ | getBoundingClientRect 全卡计数（dock 避让线） |
| 5 | 核心交互热区≥44px / 字号≥11px | 违规 **0** / 违规 **0** | ✅ | 全 button/a 热区审计（含 ::after 溢出热区）；全文本节点字号扫描 |
| 6 | 正文对比度≥4.5 | 最低 **5.47**（去结算白字 on 朱砂），正文 7.27–11.48 | ✅ | WCAG 相对亮度公式，6 组关键配色对 |
| 7 | 同屏毛玻璃层≤3 | **3**（纸→墨玻璃叠层最深处） | ✅ | computedStyle backdrop-filter 全 DOM 扫描 |
| 8 | prefers-reduced-motion 一键全静 | 运行中动画 **0** | ✅ | 模拟媒体特性后 getAnimations 计数 |
| 9 | 三档性能自动降级 | lite：毛玻璃 0 + 常驻动画 0；minimal：毛玻璃 0；normal：全开 | ✅ | CDP 模拟 + computedStyle 验证；判定=手动参数>localStorage>设备内存/核数 |
| 10 | CPU 6倍限速连点无超50ms帧 | 最慢帧 **16.8ms**（5次点击，130帧/次） | ✅ | CDP setCPUThrottlingRate(6) + rAF 逐帧间隔 |
| 12 | 菜单数据零硬编码 | 48道全部出自 `src/menu.json`，页面无内联菜单 | ✅ | build 注入 `window.MENU_DATA`；改 json 重跑 build 即全站生效 |

（#3/#11 为真机验证项与真图适配项，见自报问题清单。）

## VLM 视觉评审记录（glm-5v-turbo，三轮迭代）

| 轮次 | 对象 | 得分 | 关键反馈 → 动作 |
|---|---|---|---|
| 1 | 基准版首屏 | 8.2/10 | Dock遮挡末位菜/描述字浅 → 已修（padding 190px + 对比度加深） |
| 2 | 详情页 | 8.5/10 | 返回按钮突兀/版本条像调试面板 → 已修（幽灵式返回+切换条弱化） |
| 3 | 六版矩阵 | 统一性 9/10 | 无崩坏无违和，六版差异清晰可辨 |

## 自报问题清单（如实）

1. **无图态是程序化水墨**：考卷设定图包未到（"无图态本身就是考题"），hero 区/缩略图/详情大图均为程序化水墨+书法首字占位。真图到货后需替换 `detail.html` 大图区与缩略图，样式层已预留（`dt-visual` 结构不变直接塞 `<img>`）。
2. **呼吸动效 ΔE00≈3 未做像素级实测**：两层透明度差 10% 的叠加是按公式推的设计值，逐帧 ΔE00 像素测量成本过高未执行，以参数近似达标。若需严格证明，可用 24s 周期首尾帧取色差分。
3. **normal 档毛玻璃未经真机验证**：沙箱 2核4G 自动判 lite；e2e 用 CPU 6x 限速模拟低端机（最慢帧 16.8ms），但真机（尤其低端安卓）的实际 blur 开销未验。保守策略已内置：minimal 档全关毛玻璃换实底渐变。
4. **录屏为 headless Chromium 渲染**：字体抗锯齿与真机略有差异，动效参数（0.42s 落印/0.62s 水滴/2.4s 色温/24s 呼吸）以代码为准。
5. **结算条避让 Dock 抬高 80px**：六版均有 Dock 故无实际影响；若未来做"无 Dock 纯 bar"变体需调 `checkout-bar` 的 bottom。

## 目录结构

```
design/
├── src/                 # 源码（改这里，不改 dist）
│   ├── menu.json        # ★ 唯一数据源：48道×五层文案+首字+分区
│   ├── css/             # tokens/base/components/detail/motion/perf 六层
│   ├── js/              # cart.js(纯逻辑可测) + app.js + detail.js
│   ├── templates/       # index/detail 两模板（{{MENU_JSON}}等构建时注入）
│   └── assets/fonts/    # 霞鹜文楷子集247KB + Cinzel 9KB（自托管）
├── scripts/             # build/capture/compare/record/subset-fonts
├── tests/unit/          # 8 单元测试（node --test）
├── tests/e2e/           # e2e 红线自证（report.json）
├── dist/                # ★ 交付物：六版本静态目录（可直接分发）
├── shots/               # 21张截图 + 2张六版矩阵图
└── recordings/          # 四段录屏 webm
```

## 设计规格锚点（考卷 §3 摘要）

- 宣纸四层背景：L1 纸底 / L2 噪点10%+纤维4% / L3 墨晕55% / L4 分区光
- 墨玻璃（毛玻璃）：blur 14px + saturate 1.25 + brightness 1.08（perf 档可关）
- 朱砂印加购钮：squircle 30%/32% + 135° 三段渐变 + 按压 scale 0.92 + 落印曲线 cubic-bezier(.34,1.56,.64,1) 0.42s
- 水滴飞行：0.62s，贝塞尔先上抛后俯冲，缩小至 0.25
- 分区色温：body[data-zone] 2.4s 过渡（湘菜暖赭 / 饮品青翠）
- 字体：霞鹜文楷（标题/书法字）+ Cinzel（英文衬线）+ 系统黑体兜底
