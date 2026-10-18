// 41号两页小样生成器（设计资产，不进生产）：从品牌配置和菜单数据生成点单页、详情页静态高保真稿。
// 用法：node docs/design/redesign/小样/build.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BRAND_DIR = join(ROOT, 'brands', env.BRAND);
// Windows 上偶尔有别的程序（预览服务器、杀毒）短暂占着文件，写入会报 UNKNOWN / EBUSY——稍等重试几次
const write = (path, text) => {
  for (let i = 0; ; i++) {
    try { return writeFileSync(path, text); } catch (e) {
      if (i >= 5 || !['UNKNOWN', 'EBUSY', 'EPERM'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
};
const brand =JSON.parse(readFileSync(join(BRAND_DIR, 'brand.json'), 'utf8'));
const menu = JSON.parse(readFileSync(join(BRAND_DIR, 'menu.json'), 'utf8'));
const EN = brand.englishLabels; // 41号终版
const FONT_BASE = `../../../../brands/${env.BRAND}/`; // 从本目录引用品牌目录里的自托管字体

// ---------------- 两套底色 token（41号附加 3：分开交付，最终只留一版，另一版留档） ----------------
const shared = {
  '--ink': '#2B2622', '--ink-2': '#5F564C', '--line': 'rgba(43,38,34,.08)', '--line-strong': 'rgba(43,38,34,.16)',
  // 42号④：印泥红 #C8372D 做价格、描边；实心按钮降饱和走酒红调（不要「拼多多红」）
  '--red': '#C8372D', '--red-10': 'rgba(200,55,45,.10)', '--on-red': '#FFFFFF', '--glow-red': '0 6px 16px rgba(130,30,24,.30)',
  '--red-solid': 'linear-gradient(180deg,#A93026,#8C2620)',
  '--struct': '#1F3D2E', '--on-struct': '#FFFFFF', '--gold': '#B08A4E',
  '--glass': 'rgba(255,255,255,.72)', '--glass-solid': 'rgba(255,255,255,.94)', '--pill': 'rgba(255,255,255,.92)',
  '--shadow': '0 4px 20px rgba(43,38,34,.04), 0 2px 8px rgba(43,38,34,.03)',
  '--dark': 'rgba(30,26,22,.88)', '--dark-solid': '#2A2420', '--dark-glow': 'inset 0 0 0 1px rgba(255,255,255,.08), 0 8px 24px rgba(31,61,46,.25)',
  // 49号⑥：墨玻璃调透以后，未选中页签字提到 .9，浅色底上仍过 4.5
  '--on-dark': '#FBF5E9', '--on-dark-2': 'rgba(251,245,233,.9)', '--dock-pill': 'rgba(255,255,255,.14)',
  '--ripple': 'rgba(200,55,45,.16)', '--yinni-1': 'rgba(200,55,45,.55)', '--yinni-2': 'rgba(240,170,90,.35)', '--scrim': 'rgba(43,38,34,.28)',
  // 42号②：氛围是页面主角之一——墨晕 55%、纸纹 10%，第一眼要看得见
  '--ink-opacity': '.55', '--grain-opacity': '.10', '--bloom-opacity': '.32',
  // 47号 G2：云斑——一团模糊的云影（缩放 + 位移 + 透明度）从大图上飘过，不再整块变亮变暗
  '--cloud': 'rgba(70,52,34,.22)', '--cloud-edge': 'rgba(70,52,34,.08)',
  // 47号 G1：菜卡环境光（湘菜区暖橙侧逆光 / 饮品区青绿冷光），和分区色温同一个开关
  '--card-light-warm': 'rgba(255,164,92,.20)', '--card-light-cool': 'rgba(96,186,166,.18)',
  // 47号组件 1「朱砂印」：朱砂 135° 渐变（浅朱 → 深朱）+ 红系投影 + 顶部内高光 + 1px 白描边
  '--zhu-solid': 'linear-gradient(135deg,#C4432F,#9A2A1E)', '--zhu-shadow': '0 4px 8px rgba(139,0,0,.25)', '--zhu-shadow-press': '0 1px 3px rgba(139,0,0,.32)',
  // 47号组件 2「算盘珠」：一体化浅色容器，减号深灰、加号朱砂
  '--abacus': 'rgba(255,255,255,.9)', '--abacus-minus': '#333333',
  // 47号组件 3「墨玻璃托盘」：半透明墨 + 顶部 1px 微光线；去结算 = 深红 → 暗红底 + 淡金字（烫金）
  // 51号墨玻璃配方（磨砂材质，不是遮罩）：底 = 135° 渐变，左上薄亮、右下厚暗（光从左上来）；Dock 只放图标，墨色再透一档
  '--tray': 'linear-gradient(135deg,rgba(58,52,46,.68) 0%,rgba(34,30,26,.60) 55%,rgba(24,21,18,.52) 100%)',
  '--tray-dock': 'linear-gradient(135deg,rgba(58,52,46,.60) 0%,rgba(34,30,26,.52) 55%,rgba(24,21,18,.45) 100%)',
  // 左上角静态环境光斑（漫反射，永不动），60% 处衰减完
  '--tray-spot': 'radial-gradient(120% 160% at 0% 0%,rgba(255,246,230,.10) 0%,rgba(255,246,230,0) 60%)',
  // 边缘折射光不均匀：顶边亮、左边弱、底边极弱、右边无 + 悬浮投影
  '--tray-edges': 'inset 0 1px 0 rgba(255,255,255,.34),inset 1px 0 0 rgba(255,255,255,.12),inset 0 -1px 0 rgba(255,255,255,.05),0 8px 28px -6px rgba(20,16,12,.35)',
  // 51号规格 6：6 倍降速连点加购掉帧 → 托盘保 18px、Dock 降到 14px（饱和度不动）
  '--tray-filter': 'blur(18px) saturate(160%) brightness(1.06)', '--tray-filter-dock': 'blur(14px) brightness(1.06)',
  '--tray-solid': '#2B2622',
  '--card-bg': 'rgba(255,255,255,.8)', // 51号：列表卡片不模糊，白色略加一点保持透出的墨晕不抢字
  // 白字、淡金字的双层投影：底透下去、字立得住（替代加深底色）
  '--glass-text-shadow': '0 1px 2px rgba(0,0,0,.5),0 0 8px rgba(0,0,0,.28)',
  // Dock 墨色更透一档，12px 页签字用规格投影只有 3.6–4.0；字改纯白、投影晕加深一点，白底最坏情况也过 4.5
  '--glass-text-shadow-dock': '0 1px 2px rgba(0,0,0,.7),0 0 5px rgba(0,0,0,.85)', // 53号：页签字放大到 14px 后投影覆盖再变薄，晕收紧加浓（白底最坏情况最低 4.54） // 53号：页签换书法后字框更高、投影覆盖变薄，晕再加深一点
  // 水滴落进购物车：落点一团柔光扩散（替代 49号的斜向扫光）
  '--land-glow': 'radial-gradient(circle,rgba(255,240,214,.95) 0%,rgba(255,240,214,.4) 40%,rgba(255,240,214,0) 70%)',
  '--gilt-btn': 'linear-gradient(180deg,#8E2A20,#661C16)', '--gilt-text': '#F1D9A6', '--gilt-badge-text': '#661C16',
  // 47号组件 5/6 Dock：离底悬浮的大面积弥散阴影；选中 = 浅色药丸 + 品牌色微立体图标
  '--dock-shadow': '0 16px 36px rgba(43,38,34,.24), 0 3px 10px rgba(43,38,34,.12)', '--dock-pill-on': 'rgba(255,255,255,.9)',
  // 47号组件 4「谷雨式」分类条：半透明纸色 + 金棕细线 + 朱红圆点
  // 48号抛光②：分类条底色饱和度 -5%、亮度 -3%（rgba(246,234,205) → rgba(243,229,195)）
  '--cats-bg': 'rgba(243,229,195,.5)', '--gold-line': '#8C6A3F',
  // 48号抛光①：算盘珠容器 120° 柔散射高光（包浆感）
  '--abacus-sheen': 'linear-gradient(120deg,rgba(255,255,255,.75) 0%,rgba(255,255,255,.18) 38%,rgba(255,255,255,0) 60%,rgba(214,196,160,.14) 100%)',
  // 47号任务 C-B「马卡龙」首字底色：有色的白，不是色块（38号第三层漏斗）
  '--mac-1': '#FFF9E1', '--mac-2': '#F0F7E8', '--mac-3': '#FFF3E6', '--mac-4': '#F5EDE0',
  // 47号任务 D 图标微立体：品牌色（选中页签）/ 墨色（功能位）两组深浅渐变 + 同色系投影
  // 53号 T：底部导航选中态改朱砂（字 + 微立体图标）
  '--ico-on-1': '#D2563F', '--ico-on-2': '#9A2A1E', '--ico-on-drop': 'rgba(110,24,16,.4)',
  // 53号 T3：书法没有粗体，菜名 / 分组标题用加深一档的墨色替代字重；价格单独一个变量，贴线就加深到 #B02A21
  '--ink-deep': '#221E1B', '--price': '#B02A21', // 原 #C8372D 在纸白卡上 4.66 贴线，按 53号 T3 加深
  '--ico-ink-1': '#71675D', '--ico-ink-2': '#2B2622', '--ico-ink-drop': 'rgba(30,26,22,.35)',
  '--font-body': '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
  '--font-brush': `"XC Latin", "${brand.brushFont.family}", "STKaiti", "KaiTi", serif`,
  // 53号（高斯）：详情正文（详细介绍、源流、工序、食材说明）用楷体；手机上没有自带楷体时退到宋体，不会掉到黑体
  '--font-kai': '"LXGW WenKai", "STKaiti", "KaiTi", "Kaiti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif',
  '--font-latin': `"${brand.latinFont.family}", Georgia, "Times New Roman", serif`,
};
const BASES = {
  // 42号④：原来的淡黄被评「过期牛奶」——黄味加足、往暖纸（宣纸）色走
  淡黄: {
    '--bg-1': '#EFDDB2', '--bg-2': '#F6EACD', '--bg-3': '#FBF4E3', '--seal-gap': '#F6EACD',
    '--alt-1': '#E3EDCB', '--alt-2': '#EFF4DE', // 饮品区氛围色：过渡到淡绿
    '--light': 'rgba(255,176,86,.55)', '--light-alt': 'rgba(170,212,112,.50)',
    '--paper': '#EEDDBB', '--paper-2': '#F4E8CF', '--spot': '#FFF6E2',
    // 43号 A1：纸的呼吸——暖黄 → 米橙 → 暖黄。47号 §七加一档：只看背景峰值平均色差 ΔE00 ≈ 3（上限）
    '--breath-warm': 'linear-gradient(180deg,rgba(240,160,96,.16),rgba(240,160,96,.13) 45%,rgba(240,160,96,.09))',
    '--breath-cool': 'linear-gradient(180deg,rgba(110,184,168,.16),rgba(110,184,168,.13) 45%,rgba(110,184,168,.09))',
  },
  淡绿: {
    '--bg-1': '#D9E6BD', '--bg-2': '#E8F0D3', '--bg-3': '#F5F8EA', '--seal-gap': '#E8F0D3',
    '--alt-1': '#D6EBDF', '--alt-2': '#EAF5EE', // 淡绿底时饮品区过渡到更清凉的薄荷
    '--light': 'rgba(214,206,110,.50)', '--light-alt': 'rgba(130,200,178,.45)',
    '--paper': '#DFE9C6', '--paper-2': '#EBF1DA', '--spot': '#FAFCEE',
    '--cats-bg': 'rgba(222,231,199,.5)', // 淡绿底的分类条用同一套降饱和、降亮度后的绿纸色
    '--breath-warm': 'linear-gradient(180deg,rgba(222,196,104,.16),rgba(222,196,104,.13) 45%,rgba(222,196,104,.09))',
    '--breath-cool': 'linear-gradient(180deg,rgba(110,184,168,.16),rgba(110,184,168,.13) 45%,rgba(110,184,168,.09))',
  },
};
const tokenCss = (name) => `/* 41号小样 · ${name}底 token（设计资产，不进生产）。结构色备选：html[data-struct=ink] 用墨黑 */\n:root{\n${Object.entries({ ...shared, ...BASES[name] }).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\nhtml[data-struct=ink]{--struct:#2B2622}\n`;
for (const name of Object.keys(BASES)) write(join(HERE, `tokens-${name}.css`), tokenCss(name));

// ---------------- 程序化墨晕（40号 Q3-B）：构建时画一次，存成 SVG，页面里当静态背景，不逐帧计算 ----------------
// 43号 A2：墨色分两套——湘菜区偏暖（赭石），饮品区偏青绿；山形同一份（种子固定），只换墨色
const INK = { warm: '#4E321F', cool: '#1D3B36' };
function inkWash(color) {
  let s = 20261017;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const W = 750, H = 420;
  const ridge = (base, amp, seg) => {
    const waves = Array.from({ length: 4 }, (_, k) => ({ a: amp / (k + 1.3), f: (0.004 + rnd() * 0.004) * (k + 1), p: rnd() * 6.3 }));
    const pts = [];
    for (let x = -20; x <= W + 20; x += seg) pts.push([x, base + waves.reduce((y, w) => y + w.a * Math.sin(x * w.f + w.p), 0) + (rnd() - 0.5) * amp * 0.12]);
    return `M-20 ${H} ` + pts.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ` L${W + 20} ${H} Z`;
  };
  // 42号②：远山更高、层次更多，靠近的一层更浓——要第一眼看得见「纸上晕染」
  const layers = [
    { d: ridge(110, 70, 14), op: 0.30 },
    { d: ridge(170, 85, 12), op: 0.50 },
    { d: ridge(240, 75, 10), op: 0.75 },
    { d: ridge(305, 50, 9), op: 1 },
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMin slice">
<defs>
<filter id="bleed" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.03" numOctaves="3" seed="7"/><feDisplacementMap in="SourceGraphic" scale="22"/><feGaussianBlur stdDeviation="2.2"/></filter>
<linearGradient id="ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".9"/><stop offset=".55" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>
<linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".85"/></linearGradient>
</defs>
<g filter="url(#bleed)">${layers.map((l) => `<path d="${l.d}" fill="url(#ink)" opacity="${l.op}"/>`).join('')}</g>
<rect y="${H * 0.55}" width="${W}" height="${H * 0.45}" fill="url(#mist)"/>
</svg>`;
}
for (const [k, c] of Object.entries(INK)) write(join(HERE, `ink-wash-${k}.svg`), inkWash(c));

// 纸纹（42号②：全页叠纸纹噪点 8–12%）：一块 240 的小图平铺，构建时生成
// 49号①：宣纸肌理（纵横交错的细长纤维，极浅），铺在大画态进店屏上；和纸纹噪点一起叠
write(join(HERE, 'xuan-fiber.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><filter id="f"><feTurbulence type="turbulence" baseFrequency=".006 .14" numOctaves="2" seed="9" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .36  0 0 0 0 .29  0 0 0 0 .2  0 0 0 2.4 -1.25"/></filter><filter id="h"><feTurbulence type="turbulence" baseFrequency=".12 .008" numOctaves="2" seed="4" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .36  0 0 0 0 .29  0 0 0 0 .2  0 0 0 2.2 -1.25"/></filter><rect width="320" height="320" filter="url(#f)"/><rect width="320" height="320" filter="url(#h)" opacity=".6"/></svg>`);
write(join(HERE, 'paper-grain.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 .17  0 0 0 0 .15  0 0 0 0 .13  0 0 0 1.6 -.55"/></filter><rect width="240" height="240" filter="url(#g)"/></svg>`);

// 页面中下部的墨晕团（不只是顶部一条山）：几团晕开的墨，随页面一起滚动
// 47号 §七：饮品区墨团浓度 +1 档（青绿墨团色标 × 1.4），湘菜区不变
const BLOOM_STRENGTH = { warm: 1, cool: 1.4 };
for (const [k, c] of Object.entries(INK)) write(join(HERE, `ink-bloom-${k}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 900" preserveAspectRatio="xMidYMid slice"><defs>
<filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="4" seed="11"/><feDisplacementMap in="SourceGraphic" scale="60"/><feGaussianBlur stdDeviation="14"/></filter>
<radialGradient id="r"><stop offset="0" stop-color="${c}" stop-opacity="${(0.55 * BLOOM_STRENGTH[k]).toFixed(2)}"/><stop offset=".6" stop-color="${c}" stop-opacity="${(0.18 * BLOOM_STRENGTH[k]).toFixed(2)}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>
<g filter="url(#b)"><ellipse cx="-10" cy="300" rx="150" ry="110" fill="url(#r)"/><ellipse cx="420" cy="560" rx="170" ry="120" fill="url(#r)"/><ellipse cx="30" cy="820" rx="140" ry="90" fill="url(#r)"/></g></svg>`);

// 一缕干笔墨痕（42号③：无图菜占位的「一缕墨晕笔触」）
const brushStroke = (stretch) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"${stretch ? ' preserveAspectRatio="none"' : ''}><defs><filter id="d" x="-10%" y="-30%" width="120%" height="160%"><feTurbulence type="fractalNoise" baseFrequency="0.9 0.06" numOctaves="2" seed="5"/><feDisplacementMap in="SourceGraphic" scale="9"/></filter>
<linearGradient id="k" x1="0" x2="1"><stop offset="0" stop-color="#2B2622" stop-opacity=".0"/><stop offset=".18" stop-color="#2B2622" stop-opacity=".75"/><stop offset=".7" stop-color="#2B2622" stop-opacity=".5"/><stop offset="1" stop-color="#2B2622" stop-opacity="0"/></linearGradient></defs>
<path filter="url(#d)" d="M8 78 C 50 40, 110 30, 192 50 C 150 56, 90 70, 30 96 Z" fill="url(#k)"/></svg>`;
write(join(HERE, 'brush-stroke.svg'), brushStroke(false));
// 53号：详情标题下的「一笔浓墨」要横着拉长，同一笔画不锁比例
write(join(HERE, 'brush-stroke-wide.svg'), brushStroke(true));

// 42号①：图料位 + 47号 E1：images.json = { heroDish: 菜品内部 ID 或 null, images: { 菜品内部 ID: 图片相对路径 } }
// 生产数据不写 heroDish = 点单页顶部维持无图态；有图的菜用真图，没写的走水墨意境占位
const CONF = existsSync(join(HERE, 'images.json')) ? JSON.parse(readFileSync(join(HERE, 'images.json'), 'utf8').replace(/^﻿/, '')) : {}; // 用记事本改过的文件开头会多一个 BOM
const IMAGES = CONF.images ?? {};

// ---------------- 同一份数据、同一个状态（41号附加 2：两版 Dock 同状态截图） ----------------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const yuan = (sen) => String(sen / 100);
const catName = Object.fromEntries(menu.categories.map((c) => [c.key, c.name]));
const groups = brand.categoryOrder
  .map((k) => ({ key: k, name: catName[k] ?? k, en: EN.categories[k] ?? '', dishes: menu.dishes.filter((d) => d.categoryKey === k && d.orderable) }))
  .filter((g) => g.dishes.length);
const DRINKS = new Set(['s', 'l', 'm', 'xl', 'can']); // 分类氛围色：饮品区
const SIGNATURE = new Set(['e', 'v']); // 店长推荐、镇店硬菜：金棕书签条
const CART = { e01: 1, e06: 1 };
const cartCount = Object.values(CART).reduce((a, b) => a + b, 0);
const cartTotal = Object.entries(CART).reduce((n, [uid, q]) => n + q * menu.dishes.find((d) => d.uid === uid).priceSen, 0);
const STATE = { table: '8', waitMin: 16 };
const TRUST = ['明厨亮灶', '当日现采', '一菜一锅']; // 35号 Q4

// ---------------- 图标（代码画，面性，不出图）：47号任务 D 微立体 = 同色系渐变填充 + 顶部 40% 白高光弧 + 底部同色投影 ----------------
// 每个图标两层：.f 本体（未选中 = 灰阶平铺；选中 / 功能位 = 渐变）、.hl 同形高光（只露顶部 40%）
const ico = (vb, parts, cls = '') => `<svg viewBox="0 0 ${vb} ${vb}" class="ico${cls ? ` ${cls}` : ''}" aria-hidden="true">${parts.f ? `<path class="f" d="${parts.f}"/>` : ''}${parts.s ? `<path class="s" d="${parts.s}"/>` : ''}${parts.f ? `<path class="hl" d="${parts.f}"/>` : ''}</svg>`;
const P = {
  order: { f: 'M3 11h18a9 9 0 0 1-18 0Z', s: 'M8 4c1 1 1 2 0 3m4-3c1 1 1 2 0 3m4-3c1 1 1 2 0 3' },
  pickup: { f: 'M12 3a6 6 0 0 0-6 6v3.5L4.2 16h15.6L18 12.5V9a6 6 0 0 0-6-6Zm-2.2 15a2.2 2.2 0 0 0 4.4 0Z' },
  member: { f: 'M3 7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v1H3Zm0 4h18v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Zm3 4v2h5v-2Z' },
  me: { f: 'M12 3.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4ZM3.8 20.5c.8-4 4.2-6.5 8.2-6.5s7.4 2.5 8.2 6.5Z' },
};
const I = {
  back: ico(16, { f: 'M10.5 2 4.5 8l6 6 1.4-1.4L7.3 8l4.6-4.6Z' }, 'ico-ink'),
  arrow: ico(12, { f: 'M6 9 1.5 4.5l1-1L6 7l3.5-3.5 1 1Z' }, 'ico-ink'),
};
// 渐变色标走 token（style 里用 CSS 变量），一页只放一份
const ICON_DEFS = `<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
<linearGradient id="g-on" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--ico-on-1)"/><stop offset="1" style="stop-color:var(--ico-on-2)"/></linearGradient>
<linearGradient id="g-ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--ico-ink-1)"/><stop offset="1" style="stop-color:var(--ico-ink-2)"/></linearGradient>
<linearGradient id="g-hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".4"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs></svg>`;
// 53号（高斯）：圆形店标印章写「湘」（品牌配置 logoSeal），方形小印仍是「灶」
const LOGO_SEAL = brand.logoSeal ?? brand.seal;
const seal = (size) => `<span class="seal" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.56)}px">${esc(LOGO_SEAL)}</span>`;
// 47号组件 5/6：Dock 里只有一个药丸，切换时滑过去（transform），不是每个页签各画一个
const tabs = (labels) => `<span class="dock-pill" aria-hidden="true"></span>` + [['order', '点单'], ['pickup', '取餐'], ['member', '会员'], ['me', '我的']]
  .map(([k, t], i) => `<button class="tab press${i === 0 ? ' on' : ''}" aria-label="${t}"${i === 0 ? ' aria-current="page"' : ''}>${ico(24, P[k])}${labels ? `<span>${t}</span>` : ''}</button>`).join('');

function head(title, base, struct, extra = '') {
  // 档位在画面出来之前就定好（不闪）：?tier= 可强制，测试和截图用
  const lf = brand.latinFont;
  return `<!doctype html><html lang="zh-CN"${struct === 'ink' ? ' data-struct="ink"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<style>@font-face{font-family:"${brand.brushFont.family}";src:url("${FONT_BASE}${brand.brushFont.file}") format("woff2");font-display:swap}@font-face{font-family:"${lf.family}";src:url("${FONT_BASE}${lf.file}") format("woff2");${lf.weightRange ? `font-weight:${lf.weightRange.join(' ')};` : ''}font-display:swap}
/* 53号（高斯）：标题标签层的数字、英文不用书法——同一个字体名下，ASCII 和几个符号走衬线体，汉字走书法 */
@font-face{font-family:"XC Latin";src:url("${FONT_BASE}${lf.file}") format("woff2");${lf.weightRange ? `font-weight:${lf.weightRange.join(' ')};` : ''}unicode-range:U+0020-007E,U+00B7,U+2019,U+2212;font-display:swap}
${brand.bodyFont ? `@font-face{font-family:"${brand.bodyFont.family}";src:url("${FONT_BASE}${brand.bodyFont.file}") format("woff2");font-display:swap}` : ''}</style>
<link rel="stylesheet" href="tokens-${base}.css"><link rel="stylesheet" href="mock.css">
<script>(function(){var r=document.documentElement,q=new URLSearchParams(location.search).get('tier');
function d(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return'static';var m=navigator.deviceMemory,c=navigator.hardwareConcurrency,s=navigator.connection&&navigator.connection.saveData;
if(s||(m&&m<=2)||(c&&c<=4))return'lite';if((m&&m<=4)||(c&&c<=6))return'minimal';return'normal'}
r.dataset.tier=q||d();r.dataset.forced=q?'1':''})()</script>${extra}
<style>.ink .warm{background-image:url("ink-wash-warm.svg")}.ink .cool{background-image:url("ink-wash-cool.svg")}.grain{background-image:url("paper-grain.svg")}.bloom .warm{background-image:url("ink-bloom-warm.svg")}.bloom .cool{background-image:url("ink-bloom-cool.svg")}.thumb.ph::before,.hero-img.ph::before{background-image:url("brush-stroke.svg")}.lockup-stroke{background-image:url("brush-stroke-wide.svg")}.hero-paper{background-image:url("xuan-fiber.svg"),url("paper-grain.svg")}</style></head>`;
}
// 背景层：纸底 →（饮品区淡绿）→ 呼吸层 → 光源（47号起不再漂移）→ 墨晕（暖 / 青两套交叉淡化）→ 纸纹；墨晕团随页面滚动
const bg = `${ICON_DEFS}<div class="bg" aria-hidden="true"><div class="bg-alt"></div><div class="breath"><i class="warm"></i><i class="cool"></i></div><div class="light"></div><div class="light alt"></div><div class="ink"><i class="warm"></i><i class="cool"></i></div><div class="grain"></div></div><div class="bloom" aria-hidden="true"><i class="warm"></i><i class="cool"></i></div><div class="wm" aria-hidden="true"><span>${esc(brand.watermark)}</span></div>`;
// 47号组件 1「朱砂印」加号、组件 2「算盘珠」：加减号都是衬线字形（Cinzel）
const addBtn = (d) => `<button class="btn-round add press" aria-label="加购 ${esc(d.name)}"><span class="g" aria-hidden="true">+</span></button>`;
const minusBtn = (name, hidden = false) => `<button class="btn-round minus press" aria-label="减少 ${esc(name)}"${hidden ? ' hidden' : ''}><span class="g" aria-hidden="true">−</span></button>`;
// 49号⑤：算盘珠容器、减号、数字一开始就在（没加购时隐藏），第一次加购只是显示出来、容器淡入——不再临时长出新图层（消 67ms 那一帧）
const qtyHtml = (d) => {
  const q = CART[d.uid] ?? 0;
  return `<div class="qty${q ? ' on' : ''}" data-qty="${q}"><span class="abacus" aria-hidden="true"></span>${minusBtn(d.name, !q)}<b${q ? '' : ' hidden'}>${q}</b>${addBtn(d)}</div>`;
};

// 方形印章：分组字标、详情大图、风味之路统一用方印（42号④；圆形印章只做店标）
const sqSeal = (size) => `<span class="sq-seal" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.62)}px" aria-hidden="true">${esc(brand.seal)}</span>`;
// 43号 C2 / 47号：首字跳过修饰词——名字以「招 金 糖 特 湘 脆」开头时，跳过开头两个字的修饰词（招牌、金秋、糖醋、湘西、湘味、特色、脆皮）
const MODIFIER_HEADS = new Set([...'招金糖特湘脆']);
const stripModifier = (name) => { const c = [...name]; return MODIFIER_HEADS.has(c[0]) && c.length > 3 ? c.slice(2) : c; };
// 48号裁定：同一分组里首字撞了，取（去掉修饰词后的）第三个字；第三个字也撞了就往后找没用过的字
const THUMB_CHAR = new Map();
for (const g of groups) {
  const used = new Set();
  for (const d of g.dishes) {
    const c = stripModifier(d.name);
    let ch = c[0];
    if (used.has(ch)) ch = [c[2], ...c.slice(3), ...c].find((x) => x && !used.has(x)) ?? c[0];
    used.add(ch);
    THUMB_CHAR.set(d.uid, ch);
  }
}
const firstChar = (d) => THUMB_CHAR.get(d.uid) ?? stripModifier(d.name)[0];
// 47号 C-B：马卡龙底色按菜品 ID 固定一色（同一道菜永远同色）
const macOf = (uid) => ([...uid].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) % 4) + 1;
// 缩略图：有放行的成品图用真图；没有的走「水墨意境占位」。C-A = 墨字 + 淡墨痕（现状）；C-B = 马卡龙底 + 微立体
const thumb = (d, mode) => IMAGES[d.uid]
  ? `<div class="thumb img" aria-hidden="true"><img src="${esc(IMAGES[d.uid])}" alt="" loading="lazy"></div>`
  : mode === 'mac'
    ? `<div class="thumb mac" style="--mac:var(--mac-${macOf(d.uid)})" aria-hidden="true"><span>${esc(firstChar(d))}</span><i class="mini-seal"></i></div>`
    : `<div class="thumb ph" aria-hidden="true"><span>${esc(firstChar(d))}</span><i class="mini-seal"></i></div>`;
// 大图：有图 = 真图 + 径向聚光；没图 = 水墨意境占位（大号书法菜名 + 墨痕 + 方印）。47号 G2 云斑叠在大图与内容之间
const heroImg = (d, { cloud = true, seal: withSeal = true } = {}) => IMAGES[d.uid]
  ? `<div class="hero-img img" role="img" aria-label="${esc(d.name)}"><img src="${esc(IMAGES[d.uid])}" alt="">${cloud ? '<i class="cloud"></i>' : ''}</div>`
  : `<div class="hero-img ph" role="img" aria-label="${esc(d.name)}">${cloud ? '<i class="cloud"></i>' : ''}<span class="n">${esc(d.name)}</span>${withSeal ? sqSeal(34) : ''}</div>`;
const D = menu.dishes.find((d) => d.uid === 'e06'); // 已转正基线里的 S 级样张

// 47号 E1 点单页顶部双模态：无图态 = 墨晕 + 书法店名（现状）；大画态 = 全幅大图 + 径向聚光 + 左下竖排 SIGNATURE + 价格锚（绿茶门面公式）
// 53号（高斯）：水印 A（大画卡内）、B（门店框右下）同时成立——门店框里总是带着 B
const storeRow = `<span class="store-wm" aria-hidden="true">${esc(brand.watermark)}</span><div class="store-row">${seal(40)}<span class="store-name">${esc(brand.shortName)}</span><span class="chip-table">桌 ${STATE.table}</span>
<span class="wait">当前等待约<b>${STATE.waitMin} 分钟</b></span></div>
<p class="trust">${TRUST.map(esc).join('<i class="dot-seal"></i>')}</p>`;
// 48号：大画态按 C 方案——进店是 240px 大图；滑过 240px 触发线，顶部换成 110px「今日招牌」横幅卡（图 + 菜名 + 价格 + 直达），
// 横幅卡从上方滑入、分类条跟着让位，都只用 transform；滑回顶部再收回去。这样大图只占门面一屏，往下翻仍是一屏 6 道
const HERO_LINE = 240;
// 53号（高斯）：大画态可以放多张——老板在老板端挑当日招牌（以后还有特价、小广告），左右滑动切换，后面露出叠着的卡（堆叠态）。
// images.json 的 heroDishes = 菜品 ID 列表；只写一张就是单张。直达：有详情页的去详情，其余跳到列表里那道菜
const hrefOf = (d, detail) => (d.uid === D.uid ? detail : `#dish-${d.uid}`);
const storeHeader = (heroUids, detail) => {
  const hs = (heroUids ?? []).map((u) => menu.dishes.find((d) => d.uid === u)).filter(Boolean);
  const h = hs[0];
  if (!h) return `<header class="store glass reveal has-wm">${storeRow}</header>`;
  // 49号④：横幅卡没图时按菜单头版式——金棕书签条 + 大号书法菜名 + 价格锚，不再借列表同款首字缩略；有图时左边放真图
  const img = IMAGES[h.uid];
  const today = img
    ? `<aside class="today glass" aria-label="今日招牌" inert><span class="today-img"><img src="${esc(img)}" alt=""></span><span class="today-txt"><span class="today-label">今日招牌<span class="en">${esc(EN.sections.signature ?? '')}</span></span>
<span class="today-name">${esc(h.name)}</span><span class="price">RM ${yuan(h.priceSen)}</span></span><a class="go gilt press today-go" href="${esc(detail)}">直达</a></aside>`
    : `<aside class="today glass noimg" aria-label="今日招牌" inert><i class="today-mark" aria-hidden="true"></i><span class="today-txt"><span class="today-label">今日招牌<span class="en">${esc(EN.sections.signature ?? '')}</span></span>
<span class="today-name">${esc(h.name)}</span></span><span class="today-anchor"><b>RM ${yuan(h.priceSen)}</b><a class="go gilt press today-go" href="${esc(detail)}">直达</a></span></aside>`;
  const slides = hs.map((d, i) => `<article class="hero-slide" data-name="${esc(d.name)}" data-price="RM ${yuan(d.priceSen)}" data-href="${esc(hrefOf(d, detail))}" aria-roledescription="slide" aria-label="${i + 1} / ${hs.length}：${esc(d.name)}">
${heroImg(d, { cloud: false, seal: false })}<i class="hero-spot" aria-hidden="true"></i><i class="hero-paper" aria-hidden="true"></i><span class="hero-wm" aria-hidden="true">${esc(brand.watermark)}</span>
<span class="en sig-v" aria-hidden="true">${esc(EN.sections.signature ?? '')}</span>
<p class="price-anchor glass"><span class="pa-name">${esc(d.name)}</span><b>RM ${yuan(d.priceSen)}</b></p></article>`).join('');
  const dots = hs.length > 1 ? `<div class="hero-dots" aria-hidden="true">${hs.map((_, i) => `<i${i ? '' : ' class="on"'}></i>`).join('')}</div>` : '';
  return `<div class="hero-stack${hs.length > 1 ? ' deck' : ''} reveal"><header class="store-hero" aria-roledescription="carousel" aria-label="今日招牌">
<div class="hero-track" tabindex="0">${slides}</div>
<div class="store glass has-wm">${storeRow}</div>${dots}</header></div>
<i class="hero-line" style="top:${HERO_LINE}px" aria-hidden="true"></i><i class="today-scrim" aria-hidden="true"></i>
${today.replace(`href="${esc(detail)}"`, `href="${esc(hrefOf(h, detail))}"`)}`;
};

// ---------------- 点单页 ----------------
// 53号：heroUids = 大画态的几张卡（images.json 的 heroDishes；旧字段 heroDish 也认）；水印 B 在门店框里常驻，A 在大画卡里
const HERO_CONF = CONF.heroDishes ?? (CONF.heroDish ? [CONF.heroDish] : null);
function orderPage(base, variant, { struct = 'green', thumbs = 'ink', heroUids = HERO_CONF, detail = `详情-${base}.html` } = {}) {
  const rows = (g) => g.dishes.map((d) => `<article class="row${SIGNATURE.has(g.key) ? ' sig' : ''}" id="dish-${d.uid}" data-uid="${d.uid}" data-price="${d.priceSen}">
${thumb(d, thumbs)}
<div class="row-body"><p class="row-name"><span class="t">${d.uid === D.uid ? `<a class="row-link" href="${esc(detail)}">${esc(d.name)}</a>` : esc(d.name)}</span></p>
${d.hook ? `<p class="row-hook">${esc(d.hook)}</p>` : ''}<p class="price">RM ${yuan(d.priceSen)}${d.unit ? `<small> /${esc(d.unit)}</small>` : ''}</p></div>
${qtyHtml(d)}</article>`).join('');
  // 47号组件 3：去结算条 = 墨玻璃托盘 + 烫金按钮（两端微尖）；V1 并入 Dock、V2 独立条，两个都改
  const dock = variant === 'v1'
    ? `<nav class="dock tray v1" aria-label="主导航">${tabs(false)}<button class="dock-go gilt press" aria-label="去结算"><span class="badge" data-count>${cartCount}</span><span class="stack"><b>去结算</b><span data-total>RM ${yuan(cartTotal)}</span></span></button></nav>`
    : `<div class="cartbar tray"><span class="badge" data-count>${cartCount}</span><span class="sum" data-total>RM ${yuan(cartTotal)}</span><button class="go gilt press">去结算</button></div><nav class="dock tray" aria-label="主导航">${tabs(true)}</nav>`;
  return `${head(`小样 · 点单页 · ${base} · ${variant === 'v1' ? 'Dock 并入' : '现状版'}${thumbs === 'mac' ? ' · 马卡龙首字' : ''}${heroUids ? ' · 大画态' : ''}`, base, struct)}
<body data-seal="${esc(LOGO_SEAL)}">${bg}<div class="app">
${storeHeader(heroUids, detail)}
<div class="cats-wrap"><nav class="cats" aria-label="菜品分类"><button class="cat on" aria-current="true"><span>全部</span></button>${groups.map((g) => `<button class="cat"><span>${esc(g.name)}</span></button>`).join('')}</nav>
<button class="cats-more" aria-label="全部分类"><span class="ring-arrow">${I.arrow}</span></button></div>
${groups.map((g) => `<section class="grp reveal"${DRINKS.has(g.key) ? ' data-drink="1"' : ''} aria-label="${esc(g.name)}">
<div class="grp-head"><h2>${esc(g.name)}</h2>${sqSeal(16)}<span class="en">${esc(g.en)}</span><i class="rule" aria-hidden="true"></i><span class="count">${g.dishes.length} 道</span></div>
<div class="card glass">${rows(g)}</div></section>`).join('')}
</div>${dock}<script src="mock.js"></script></body></html>`;
}

// ---------------- 详情页 ----------------
const route = D.flavorRoute ? D.flavorRoute.split('（')[0].trim() : null; // 30号 A 方案
const inkLines = (text) => text.split(/(?<=[，。！？；：])/).map((t) => `<span class="ink-line">${esc(t)}</span>`).join('');
// 47号 B1：区块标题双层（绿茶画册式）——中文大字 / 英文宽体衬线全大写独立一行 / 细金线横贯
const secHead = (zh, en) => `<div class="sec-head"><h2>${esc(zh)}</h2><p class="en">${esc(en)}</p><i class="rule" aria-hidden="true"></i></div>`;
function detailPage(base, struct = 'green', back = `点单-${base}-现状版.html`) {
  const n = D.ingredients.length;
  return `${head(`小样 · 详情页 · ${base}${struct === 'ink' ? ' · 墨黑结构色' : ''}`, base, struct)}
<body data-seal="${esc(LOGO_SEAL)}">${bg}<div class="app">
<div class="hero">${heroImg(D, { seal: false })}
<div class="top-btns"><a class="circle-btn glass press" href="${esc(back)}" aria-label="返回菜单">${I.back}</a><span class="code-chip glass">${esc(catName[D.categoryKey])} · ${esc(D.code)}</span></div>
<div class="xbtn-wrap"><button class="xbtn press" data-open-stage>拆开看看<small>${n} 样食材</small></button><span class="en">${esc(EN.sections.takeApart)}</span></div></div>
<div class="sheet">
<div class="title-lockup"><span class="en lockup-en" aria-hidden="true">${esc(EN.categories[D.categoryKey] ?? '')}</span><div class="lockup-main"><h1 class="d-title">${esc(D.name)}</h1><i class="lockup-stroke" aria-hidden="true"></i>${sqSeal(30)}</div></div>
<p class="d-price">RM ${yuan(D.priceSen)}</p><p class="d-hook">${esc(D.hook)}</p>
<section class="sec">${secHead('详细介绍', EN.sections.intro)}<p>${inkLines(D.intro)}</p></section>
<section class="sec paper">${secHead('源流', EN.sections.origin)}<p>${inkLines(D.origin)}</p></section>
<section class="sec">${secHead('工序', EN.sections.steps)}<ol class="steps">${D.steps.map((s, i) => `<li class="step"><b>${String(i + 1).padStart(2, '0')}</b><span>${esc(s)}</span></li>`).join('')}</ol></section>
${route ? `<section class="sec">${secHead('风味之路', EN.sections.flavorRoute)}<div class="route"><span class="route-v glass">${esc(route)}</span>${sqSeal(30)}</div></section>` : ''}
<div style="height:40px"></div></div></div>
<div class="dbar glass" data-uid="${D.uid}" data-price="${D.priceSen}"><span class="price">RM ${yuan(D.priceSen)}</span>${qtyHtml(D)}<button class="go gilt press">去结算 · <span data-count>${cartCount}</span></button></div>
<nav class="dock tray" aria-label="主导航">${tabs(true)}</nav>
<div class="scrim" data-close-stage></div>
<section class="stage glass" aria-label="拆开看看" aria-hidden="true" inert><div class="stage-head"><h3>拆开看看</h3><span class="en">${esc(EN.sections.takeApart)} · ${n}</span>
<button class="pill-btn glass press" data-close-stage>合拢${I.arrow}</button></div>
${D.ingredients.map((g, i) => `<div class="layer" style="--i:${i};--r:${n - 1 - i}"><span class="tile">${esc(g.name)}</span><div><b>${esc(g.name)}</b><p>${inkLines(g.note)}</p></div></div>`).join('')}
</section><script src="mock.js"></script></body></html>`;
}

// 淡黄满血版为主；48号：淡绿底、墨黑结构色两个变体带大画态一起出（大画先借水墨占位，军师的图到了改 images.json）
const HERO_DEMO = [D.uid, 'e01', 'v01']; // 演示用的三张当日招牌（都是菜单里现有的菜和价格，不编特价）
const HERO_LG = '点单-淡绿-大画态结构.html', HERO_INK = '点单-淡黄-墨黑-大画态结构.html', DT_INK = '详情-淡黄-墨黑结构色.html';
const pages = [
  ['点单-淡黄-现状版.html', orderPage('淡黄', 'v2')],
  ['点单-淡黄-Dock并入.html', orderPage('淡黄', 'v1')],
  ['点单-淡黄-现状版-马卡龙.html', orderPage('淡黄', 'v2', { thumbs: 'mac' })],
  ['点单-淡黄-大画态结构.html', orderPage('淡黄', 'v2', { heroUids: HERO_DEMO })], // 结构演示：三张招牌叠成一摞（借水墨占位当大画），图到了改 images.json 的 heroDishes
  ['详情-淡黄.html', detailPage('淡黄')],
  [HERO_LG, orderPage('淡绿', 'v2', { heroUids: HERO_DEMO })],
  ['详情-淡绿.html', detailPage('淡绿', 'green', HERO_LG)],
  [HERO_INK, orderPage('淡黄', 'v2', { struct: 'ink', heroUids: HERO_DEMO, detail: DT_INK })],
  [DT_INK, detailPage('淡黄', 'ink', HERO_INK)],
];
for (const [file, html] of pages) write(join(HERE, file), html);
console.log(`生成 ${pages.length} 页 + 2 份 token + 墨晕；${groups.length} 个分类、${groups.reduce((n, g) => n + g.dishes.length, 0)} 道菜；详情样张 ${D.code} ${D.name}`);

