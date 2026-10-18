// 33号比稿：三个方向的静态高保真稿生成器（设计资产，不进生产）。
// 数据全部来自品牌配置与菜单数据（同一份数据、同一个状态），不手抄菜名价格。
// 用法：node docs/design/sprint/02-比稿/build.mjs  →  A/ B/ C/ 下生成 list.html、detail.html、tokens.css
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const BRAND_DIR = join(ROOT, 'brands', env.BRAND);
const brand = JSON.parse(readFileSync(join(BRAND_DIR, 'brand.json'), 'utf8'));
const menu = JSON.parse(readFileSync(join(BRAND_DIR, 'menu.json'), 'utf8'));
const baseTokens = JSON.parse(readFileSync(join(BRAND_DIR, 'tokens.json'), 'utf8')).customer;

// ---------- 同一份数据、同一个状态 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const yuan = (sen) => String(sen / 100);
const money = (sen) => `RM&nbsp;${yuan(sen)}`;
const catName = Object.fromEntries(menu.categories.map((c) => [c.key, c.name]));
const groups = brand.categoryOrder
  .map((k) => ({ key: k, name: catName[k] ?? k, dishes: menu.dishes.filter((d) => d.categoryKey === k && d.orderable) }))
  .filter((g) => g.dishes.length);
const DETAIL = menu.dishes.find((d) => d.uid === 'e06'); // 已转正基线里的 S 级样张
const route = (r) => (r ? r.split('（')[0].trim() || null : null); // 30号 A 方案
const TRUST = ['明厨亮灶', '当日现采', '一菜一锅']; // 35号 Q4：只用 08号问答里有的三句
const STATE = { table: '8', waitMin: 16, queue: 1, cart: [{ uid: 'e01', qty: 1 }, { uid: 'e06', qty: 1 }] }; // 示意状态，三方向一致
const cartCount = STATE.cart.reduce((n, l) => n + l.qty, 0);
const cartTotal = STATE.cart.reduce((n, l) => n + l.qty * menu.dishes.find((d) => d.uid === l.uid).priceSen, 0);
const qtyOf = (uid) => STATE.cart.find((l) => l.uid === uid)?.qty ?? 0;
const hours = brand.store?.hours ?? '营业时间待提供';
const C = baseTokens; // 锚：底色、文字、品牌红都取 tokens.json，不另起颜色

// ---------- 三个方向的 token（比稿用，不进生产） ----------
const anchor = {
  '--bg': C['color-bg'], '--surface': C['color-surface'], '--text': C['color-text'], '--text-2': C['color-text-secondary'],
  '--line': C['color-border'], '--paper': C['color-placeholder-bg'],
  '--red': C['color-accent'], '--red-line': C['color-accent'], '--red-10': 'rgba(200,55,45,0.10)', // 一种红，三种浓度
  '--ink': C['color-text'], '--on-red': C['color-accent-contrast'],
  '--font-body': C['font-family-body'], '--font-brush': C['font-family-brush'],
  '--wm-opacity': C['watermark-opacity'], '--wm-size': '179px', // 30/31号：水印 179px 定稿
};
const DIRS = {
  A: {
    name: '紧凑效率', motion: '微反馈（加购徽标弹跳 + 拆开看看错峰）', thumb: 'red',
    tokens: { ...anchor, '--fs-1': '12px', '--fs-2': '14px', '--fs-3': '16px', '--fs-4': '20px', '--fs-5': '28px', '--fs-price': '18px',
      '--sp-1': '4px', '--sp-2': '8px', '--sp-3': '12px', '--sp-4': '16px', '--sp-5': '24px',
      '--r-card': '12px', '--r-btn': '8px', '--r-thumb': '8px', '--shadow': '0 1px 0 rgba(51,51,51,0.04)',
      '--motion-pop': '450ms', '--motion-stagger': '120ms', '--motion-enter': '0ms' },
  },
  B: {
    name: '主次大卡', motion: '仪式感（首次进入淡入一次 + 加购弹跳 + 拆开看看错峰与轻呼吸）', thumb: 'ink',
    tokens: { ...anchor, '--fs-1': '12px', '--fs-2': '14px', '--fs-3': '16px', '--fs-4': '22px', '--fs-5': '32px', '--fs-price': '18px',
      '--sp-1': '4px', '--sp-2': '8px', '--sp-3': '12px', '--sp-4': '16px', '--sp-5': '24px', '--sp-6': '32px',
      '--r-card': '16px', '--r-btn': '24px', '--r-thumb': '12px', '--shadow': '0 4px 20px rgba(51,51,51,0.06)',
      '--motion-pop': '450ms', '--motion-stagger': '120ms', '--motion-enter': '300ms' },
  },
  C: {
    name: '纸本菜谱', motion: '近零动效（只保留拆开看看错峰，09号硬规定）', thumb: 'ink',
    tokens: { ...anchor, '--fs-1': '12px', '--fs-2': '14px', '--fs-3': '15px', '--fs-4': '20px', '--fs-5': '30px', '--fs-price': '16px',
      '--sp-1': '4px', '--sp-2': '8px', '--sp-3': '12px', '--sp-4': '16px', '--sp-5': '24px',
      '--r-card': '0px', '--r-btn': '4px', '--r-thumb': '4px', '--shadow': 'none',
      '--motion-pop': '0ms', '--motion-stagger': '120ms', '--motion-enter': '0ms' },
  },
};
const tokenCss = (t) => `:root{\n${Object.entries(t).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`;

// ---------- 共用零件 ----------
// 书法字体用品牌目录里自托管的裁剪字体（P3 第④项之后不再走谷歌字体）；稿子在 A/ B/ C/ 子目录里，按相对路径引用
const FONT = brand.brushFont
  ? `<style>@font-face{font-family:"${esc(brand.brushFont.family)}";src:url("../../../../../brands/${env.BRAND}/${brand.brushFont.file}") format("woff2");font-display:block}</style>`
  : (brand.fontStylesheets ?? []).map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('');
const BASE = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--bg)}
body{color:var(--text);font-family:var(--font-body);font-size:var(--fs-3);line-height:1.5;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;border:0;background:none}
.app{position:relative;z-index:1;max-width:375px;margin:0 auto;min-height:100vh}
.wm{position:fixed;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:flex-end;overflow:hidden;z-index:0}
.wm span{writing-mode:vertical-rl;font-family:var(--font-brush);font-size:var(--wm-size);line-height:1;color:var(--text);opacity:var(--wm-opacity)}
.seal{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:50%;color:var(--red);font-family:var(--font-brush);transform:rotate(-8deg);border:2px solid var(--red);box-shadow:inset 0 0 0 1.5px var(--surface),inset 0 0 0 3px var(--red);line-height:1}
.brush{font-family:var(--font-brush);font-weight:400}
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:5;max-width:375px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);background:var(--surface);border-top:1px solid var(--line)}
.tabbar a{height:56px;display:flex;align-items:center;justify-content:center;color:var(--text-2);text-decoration:none;font-size:var(--fs-3)}
.tabbar a.on{color:var(--ink);font-weight:700}
.thumb{flex:none;display:flex;align-items:center;justify-content:center;background:var(--paper);font-family:var(--font-brush);line-height:1;color:var(--thumb-color)}
.big-ph{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:var(--paper);overflow:hidden}
.big-ph .n{font-family:var(--font-brush);color:var(--text);line-height:1.15;text-align:center;text-wrap:balance}
.big-ph .c{font-size:var(--fs-1);color:var(--text-2)}
.big-ph .seal{position:absolute;right:10px;bottom:10px;opacity:.85}
.price{color:var(--red);font-weight:700;font-size:var(--fs-price);white-space:nowrap}
.unit{color:var(--text-2);font-weight:400;font-size:var(--fs-1)}
.add{width:32px;height:32px;border-radius:50%;background:var(--red);color:var(--on-red);font-size:22px;line-height:32px;text-align:center;flex:none}
.add.line{background:none;border:1.5px solid var(--red-line);color:var(--red);line-height:29px}
.qty{display:flex;align-items:center;gap:6px}.qty .m{width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:var(--surface);font-size:20px;line-height:30px;text-align:center}.qty b{min-width:16px;text-align:center}
.cartbar{position:fixed;left:0;right:0;bottom:56px;z-index:4;max-width:375px;margin:0 auto;display:flex;gap:8px;padding:8px 12px;background:var(--bg)}
.add.q{position:relative}.add.q em{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:var(--ink);color:var(--surface);font-size:11px;line-height:18px;font-style:normal;font-weight:700}
.cart-sum{flex:1;display:flex;align-items:center;gap:12px;height:48px;padding:0 16px;border-radius:var(--r-btn);background:var(--ink);color:var(--surface);font-weight:700}
.badge{min-width:24px;height:24px;padding:0 6px;border-radius:12px;background:var(--red);color:var(--on-red);font-size:var(--fs-2);display:inline-flex;align-items:center;justify-content:center}
.cart-go{height:48px;padding:0 20px;border-radius:var(--r-btn);background:var(--red);color:var(--on-red);font-weight:700}
.trust{font-size:var(--fs-1);color:var(--text-2);letter-spacing:1px}
.trust i{font-style:normal;color:var(--red);margin:0 6px}
.clip1{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
const page = (dir, title, css, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${FONT}<style>${tokenCss(DIRS[dir].tokens)}:root{--thumb-color:var(--${THUMB === 'ink' ? 'ink' : 'red'})}${BASE}${css}</style></head>
<body><div class="wm" aria-hidden="true"><span>${esc(brand.watermark)}</span></div><div class="app">${body}</div></body></html>`;
let THUMB = 'red';
const seal = (size) => `<span class="seal" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.56)}px">${esc(brand.seal)}</span>`;
const tabbar = `<nav class="tabbar"><a class="on">点单</a><a>取餐</a><a>会员</a><a>我的</a></nav>`;
const cartbar = `<div class="cartbar"><div class="cart-sum"><span class="badge">${cartCount}</span><span>${money(cartTotal)}</span></div><button class="cart-go">去结算</button></div>`;
const firstChar = (d) => esc([...d.name][0]);
const trustLine = () => `<p class="trust">${TRUST.map(esc).join('<i>·</i>')}</p>`;
const bigPh = (d, w, h, nameSize, sealSize = 22) =>
  `<div class="big-ph" style="width:${w};height:${h}"><span class="n" style="font-size:${nameSize}px">${esc(d.name)}</span><span class="c">成品图上线中</span>${seal(sealSize)}</div>`;
const plus = (d, cls = '') => qtyOf(d.uid) ? `<span class="qty"><span class="m">−</span><b>${qtyOf(d.uid)}</b><span class="add ${cls}">+</span></span>` : `<span class="add ${cls}">+</span>`;
const unit = (d) => (d.unit ? `<span class="unit"> /${esc(d.unit)}</span>` : '');

// ---------- A 紧凑效率 ----------
const A = {
  list: () => page('A', 'A 紧凑效率 · 点单', `
.head{position:sticky;top:0;z-index:3;background:var(--bg)}
.store{display:flex;align-items:center;gap:var(--sp-2);height:52px;padding:0 var(--sp-4)}
.store .nm{font-size:var(--fs-4);font-weight:700}
.store .meta{margin-left:auto;font-size:var(--fs-2);color:var(--text-2);text-align:right;line-height:1.3}
.store .meta b{color:var(--red);font-size:var(--fs-3)}
.cats{display:flex;gap:var(--sp-5);padding:0 56px 0 var(--sp-4);height:40px;align-items:stretch;overflow:hidden;position:relative;border-bottom:1px solid var(--line)}
.cats span{display:flex;align-items:center;white-space:nowrap;color:var(--text-2);font-size:var(--fs-3);border-bottom:3px solid transparent}
.cats span.on{color:var(--ink);font-weight:700;border-bottom-color:var(--red)}
.cats .more{position:absolute;right:0;top:0;bottom:0;width:48px;background:var(--bg);display:flex;align-items:center;justify-content:center;color:var(--text-2);font-size:var(--fs-1)}
.head .trust{padding:4px var(--sp-4);border-bottom:1px solid var(--line)}
.grp{padding:var(--sp-3) var(--sp-3) 0}
.grp h2{font-size:var(--fs-2);color:var(--text-2);font-weight:400;padding:0 var(--sp-1) var(--sp-2)}
.grp h2 b{color:var(--ink);font-weight:700;margin-right:var(--sp-2)}
.box{background:var(--surface);border-radius:var(--r-card)}
.row{display:flex;gap:var(--sp-3);align-items:center;padding:10px var(--sp-3);border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row .thumb{width:64px;height:64px;border-radius:var(--r-thumb);font-size:32px}
.row .body{flex:1;min-width:0}
.row .nm{font-weight:700;font-size:var(--fs-3);display:flex;gap:var(--sp-2);align-items:baseline}
.row .nm small{font-weight:400;font-size:var(--fs-1);color:var(--text-2)}
.row .hook{font-size:var(--fs-1);color:var(--text-2);margin-top:2px}
.row .price{display:block;margin-top:2px;line-height:1.3}
.cats{-webkit-mask-image:linear-gradient(to right,black calc(100% - 96px),transparent calc(100% - 48px));mask-image:linear-gradient(to right,black calc(100% - 96px),transparent calc(100% - 48px))}
`, `
<header class="head">
  <div class="store">${seal(32)}<span class="nm">${esc(brand.shortName)}</span><span class="meta">桌 ${STATE.table} · 等待约 <b>${STATE.waitMin}</b> 分钟<br>前面 ${STATE.queue} 单</span></div>
  <div class="cats"><span class="on">全部</span>${groups.map((g) => `<span>${esc(g.name)}</span>`).join('')}<span class="more">▼</span></div>
  ${trustLine()}
</header>
${groups.map((g) => `<section class="grp"><h2><b>${esc(g.name)}</b>${g.dishes.length} 道</h2><div class="box">${g.dishes.map((d) => `
  <article class="row"><span class="thumb">${firstChar(d)}</span><div class="body">
    <p class="nm"><span class="clip1">${esc(d.name)}</span>${d.code ? `<small>${esc(d.code)}</small>` : ''}</p>
    ${d.hook ? `<p class="hook clip1">${esc(d.hook)}</p>` : ''}
    <span class="price">${money(d.priceSen)}${unit(d)}</span>
  </div>${plus(d)}</article>`).join('')}</div></section>`).join('')}
<div style="height:140px"></div>${cartbar}${tabbar}`),
  detail: () => page('A', 'A 紧凑效率 · 详情', `
.top{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 var(--sp-4);font-size:var(--fs-2);color:var(--text-2)}
.stage{position:relative;margin:0 var(--sp-4)}
.stage .big-ph{border-radius:var(--r-card)}
.xbtn{position:absolute;left:50%;bottom:var(--sp-4);transform:translateX(-50%);height:40px;padding:0 var(--sp-5);border-radius:20px;background:var(--red);color:var(--on-red);font-weight:700;letter-spacing:2px;box-shadow:0 4px 12px rgba(200,55,45,0.3);white-space:nowrap}
.xbtn small{font-weight:400;letter-spacing:0;opacity:.85;margin-left:var(--sp-2);font-size:var(--fs-1)}
.ttl{padding:var(--sp-4) var(--sp-4) 0}
.ttl h1{font-family:var(--font-brush);font-weight:400;font-size:var(--fs-5);line-height:1.2}
.ttl .line{display:flex;align-items:baseline;gap:var(--sp-2);margin-top:var(--sp-1)}
.ttl .line .price{font-size:24px}
.ttl .chip{margin-left:auto;font-size:var(--fs-1);color:var(--red);background:var(--red-10);padding:2px 8px;border-radius:10px}
.ttl .hook{margin-top:var(--sp-2);font-size:var(--fs-2)}
.sec{margin:var(--sp-3) var(--sp-4) 0;padding:var(--sp-3) var(--sp-4);background:var(--surface);border-radius:var(--r-card)}
.sec h2{font-size:var(--fs-3);font-weight:700;margin-bottom:var(--sp-1)}
.sec p{font-size:var(--fs-2);line-height:1.7}
.sec.paper{background:var(--paper)}
.steps{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:var(--sp-2);text-align:center;font-size:var(--fs-1);line-height:1.5}
.steps i{display:flex;width:28px;height:28px;margin:0 auto var(--sp-1);border-radius:50%;background:var(--red);color:var(--on-red);font-style:normal;font-weight:700;align-items:center;justify-content:center;font-size:var(--fs-2)}
.tag{display:inline-block;padding:2px 12px;border-radius:14px;border:1px solid var(--red-line);color:var(--red);font-size:var(--fs-2)}
.dbar{position:fixed;left:0;right:0;bottom:56px;z-index:4;max-width:375px;margin:0 auto;display:flex;gap:8px;padding:8px 12px;background:var(--bg)}
.dbar .main{flex:1;display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 8px 0 16px;border-radius:var(--r-btn);background:var(--surface);border:1px solid var(--line)}
`, detailBody('A'))
};

function detailBody(dir) {
  const d = DETAIL;
  const r = route(d.flavorRoute);
  const steps = d.steps.map((s, i) => `<div><i>${i + 1}</i>${esc(s)}</div>`).join('');
  if (dir === 'A') return `
<div class="top"><span>‹ 返回菜单</span><span>${esc(d.code)}</span></div>
<div class="stage">${bigPh(d, '100%', '258px', 30)}<button class="xbtn">拆开看看<small>${d.ingredients.length} 样食材</small></button></div>
<div class="ttl"><h1>${esc(d.name)}</h1><div class="line"><span class="price">${money(d.priceSen)}</span><span class="chip">${esc(catName[d.categoryKey])}</span></div><p class="hook">${esc(d.hook)}</p></div>
<section class="sec"><h2>详细介绍</h2><p>${esc(d.intro)}</p></section>
<section class="sec paper"><h2>源流</h2><p>${esc(d.origin)}</p></section>
<section class="sec"><h2>工序三步</h2><div class="steps">${steps}</div></section>
${r ? `<section class="sec"><h2>风味之路</h2><span class="tag">${esc(r)}</span></section>` : ''}
<div style="height:140px"></div>
<div class="dbar"><div class="main"><span class="price">${money(d.priceSen)}</span>${plus(d)}</div><button class="cart-go">去结算 · ${cartCount}</button></div>${tabbar}`;
  if (dir === 'B') return `
<div class="hero">${bigPh(d, '100%', '375px', 36, 26)}<span class="back">‹</span></div>
<div class="ttl"><p class="cat">${esc(catName[d.categoryKey])} · ${esc(d.code)}</p><h1>${esc(d.name)}</h1><p class="hook">${esc(d.hook)}</p>
  <div class="line"><span class="price">${money(d.priceSen)}</span><button class="xbtn">拆开看看 · ${d.ingredients.length} 样食材</button></div></div>
<section class="sec"><h2>详细介绍</h2><p>${esc(d.intro)}</p></section>
<section class="sec"><h2>源流</h2><p>${esc(d.origin)}</p></section>
<section class="sec"><h2>工序三步</h2><div class="steps">${steps}</div></section>
${r ? `<section class="sec"><h2>风味之路</h2><p class="route">${esc(r)}</p></section>` : ''}
<div style="height:140px"></div>
<div class="dbar"><span class="price">${money(d.priceSen)}</span>${plus(d)}<button class="cart-go">去结算 · ${cartCount}</button></div>${tabbar}`;
  return `
<div class="top"><span>‹ 返回菜单</span><span>${esc(catName[d.categoryKey])} · ${esc(d.code)}</span></div>
<div class="frame">${bigPh(d, '100%', '240px', 30)}</div>
<div class="ttl"><h1>${esc(d.name)}</h1><p class="price">${money(d.priceSen)}</p><p class="hook">${esc(d.hook)}</p>
  <button class="xbtn">拆开看看（${d.ingredients.length} 样食材）</button></div>
<section class="sec"><h2><i></i>详细介绍</h2><p>${esc(d.intro)}</p></section>
<section class="sec"><h2><i></i>源流</h2><p>${esc(d.origin)}</p></section>
<section class="sec"><h2><i></i>工序</h2><ol class="steps">${d.steps.map((s, i) => `<li><i>${i + 1}</i><span>${esc(s)}</span></li>`).join('')}</ol></section>
${r ? `<section class="sec"><h2><i></i>风味之路</h2><span class="stamp">${esc(r)}</span></section>` : ''}
<div style="height:140px"></div>
<div class="dbar"><span class="price">${money(d.priceSen)}</span>${plus(d, 'line')}<button class="cart-go">去结算 · ${cartCount}</button></div>${tabbar}`;
}

// ---------- B 主次大卡 ----------
const featured = groups[0].dishes.slice(0, 6);
const B = {
  list: () => page('B', 'B 主次大卡 · 点单', `
.store{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-3) var(--sp-4) var(--sp-1)}
.store .nm{font-size:var(--fs-4);font-weight:700;line-height:1.2}
.store .trust{margin-top:2px}
.store .wait{margin-left:auto;text-align:center;line-height:1.1;font-size:var(--fs-1);color:var(--text-2)}
.store .wait b{display:block;color:var(--red);font-size:var(--fs-4)}
.cats{position:sticky;top:0;z-index:3;background:var(--bg);display:flex;gap:var(--sp-2);padding:var(--sp-2) var(--sp-4);overflow:hidden;-webkit-mask-image:linear-gradient(to right,black calc(100% - 64px),transparent);mask-image:linear-gradient(to right,black calc(100% - 64px),transparent)}
.cats span{flex:none;height:32px;padding:0 var(--sp-3);border-radius:16px;display:flex;align-items:center;font-size:var(--fs-2);color:var(--text-2);background:var(--surface)}
.cats span.on{background:var(--ink);color:var(--surface);font-weight:700}
.feat h2,.grp h2{font-size:var(--fs-3);font-weight:700;padding:var(--sp-2) var(--sp-4) var(--sp-2)}
.grp.cont{border-top:1px solid var(--line);margin:var(--sp-3) var(--sp-4) 0;padding-top:var(--sp-1)}
.grp.cont .row{padding-left:0;padding-right:0}
.strip{display:flex;gap:var(--sp-3);padding:0 var(--sp-4);overflow:hidden}
.fcard{flex:none;width:148px;background:var(--surface);border-radius:var(--r-card);box-shadow:var(--shadow);overflow:hidden}
.fcard .body{padding:var(--sp-2) var(--sp-3) var(--sp-3)}
.fcard .nm{font-weight:700;font-size:var(--fs-2)}
.fcard .foot{display:flex;align-items:center;justify-content:space-between;margin-top:var(--sp-1)}
.row{display:flex;gap:var(--sp-3);align-items:center;padding:6px var(--sp-4)}
.row .thumb{width:64px;height:64px;border-radius:var(--r-thumb);font-size:32px}
.row .body{flex:1;min-width:0}
.row .nm{font-weight:700}
.row .hook{font-size:var(--fs-1);color:var(--text-2)}
.row .foot{display:flex;align-items:center;justify-content:space-between;margin-top:2px}
`, `
<header class="store">${seal(40)}<div><p class="nm">${esc(brand.shortName)}</p>${trustLine()}</div><p class="wait"><b>${STATE.waitMin}</b>分钟 · 桌 ${STATE.table}</p></header>
<div class="cats"><span class="on">全部</span>${groups.map((g) => `<span>${esc(g.name)}</span>`).join('')}</div>
<section class="feat"><h2>${esc(groups[0].name)} · 主推</h2><div class="strip">${featured.map((d) => `
  <article class="fcard">${bigPh(d, '148px', '100px', 18, 16)}<div class="body"><p class="nm clip1">${esc(d.name)}</p><div class="foot"><span class="price">${money(d.priceSen)}</span>${qtyOf(d.uid) ? `<span class="add q">+<em>${qtyOf(d.uid)}</em></span>` : '<span class="add">+</span>'}</div></div></article>`).join('')}</div></section>
${groups.map((g, gi) => {
    const list = gi === 0 ? g.dishes.slice(featured.length) : g.dishes;
    return list.length ? `<section class="grp${gi === 0 ? ' cont' : ''}">${gi === 0 ? '' : `<h2>${esc(g.name)}</h2>`}${list.map((d) => `
  <article class="row"><span class="thumb">${firstChar(d)}</span><div class="body"><p class="nm clip1">${esc(d.name)}</p>${d.hook ? `<p class="hook clip1">${esc(d.hook)}</p>` : ''}
  <div class="foot"><span class="price">${money(d.priceSen)}${unit(d)}</span>${plus(d)}</div></div></article>`).join('')}</section>` : '';
  }).join('')}
<div style="height:140px"></div>${cartbar}${tabbar}`),
  detail: () => page('B', 'B 主次大卡 · 详情', `
.hero{position:relative}
.hero .big-ph .seal{bottom:40px}
.hero .back{position:absolute;left:var(--sp-4);top:var(--sp-4);width:36px;height:36px;border-radius:50%;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:var(--shadow)}
.ttl{position:relative;margin:-24px 0 0;padding:var(--sp-5) var(--sp-4) var(--sp-4);background:var(--bg);border-radius:var(--r-card) var(--r-card) 0 0}
.ttl .cat{font-size:var(--fs-1);color:var(--text-2);letter-spacing:1px}
.ttl h1{font-family:var(--font-brush);font-weight:400;font-size:var(--fs-5);line-height:1.2;margin-top:var(--sp-1)}
.ttl .hook{margin-top:var(--sp-2);color:var(--text-2);font-size:var(--fs-2)}
.ttl .line{display:flex;align-items:center;justify-content:space-between;margin-top:var(--sp-4)}
.ttl .line .price{font-size:var(--fs-4)}
.xbtn{height:40px;padding:0 var(--sp-4);border-radius:var(--r-btn);border:1.5px solid var(--red-line);color:var(--red);font-weight:700;font-size:var(--fs-2)}
.sec{padding:var(--sp-5) var(--sp-4) 0}
.sec h2{font-size:var(--fs-3);font-weight:700;margin-bottom:var(--sp-2)}
.sec p{font-size:var(--fs-2);line-height:1.8;color:var(--text)}
.steps{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:var(--sp-3);font-size:var(--fs-1);line-height:1.5}
.steps div{background:var(--surface);border-radius:var(--r-thumb);padding:var(--sp-3) var(--sp-2);text-align:center}
.steps i{display:block;font-style:normal;font-weight:700;color:var(--red);font-size:var(--fs-4);line-height:1;margin-bottom:var(--sp-1)}
.route{font-weight:700}
.dbar{position:fixed;left:0;right:0;bottom:56px;z-index:4;max-width:375px;margin:0 auto;display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-2) var(--sp-4);background:var(--surface);border-top:1px solid var(--line)}
.dbar .price{font-size:var(--fs-4);margin-right:auto}
`, detailBody('B'))
};

// ---------- C 纸本菜谱 ----------
const C_ = {
  list: () => page('C', 'C 纸本菜谱 · 点单', `
.head{display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-3) var(--sp-4) var(--sp-2);border-bottom:1px solid var(--line)}
.head .nm{font-size:var(--fs-4);font-weight:700}
.head .meta{margin-left:auto;font-size:var(--fs-1);color:var(--text-2);text-align:right;line-height:1.4}
.head .meta b{color:var(--red);font-size:var(--fs-3)}
.sub{padding:6px var(--sp-4);border-bottom:1px dashed var(--line)}
.wrap{display:flex}
.rail{flex:none;width:76px;position:sticky;top:0;align-self:flex-start;border-right:1px solid var(--line);min-height:calc(100vh - 100px)}
.rail span{display:block;padding:var(--sp-3) var(--sp-2);font-size:var(--fs-2);color:var(--text-2);text-align:center;line-height:1.3;border-left:3px solid transparent;text-wrap:balance}
.rail span.on{background:var(--surface);color:var(--ink);font-weight:700;border-left-color:var(--red)}
.list{flex:1;min-width:0;padding:0 var(--sp-3)}
.list h2{display:flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-2);font-weight:700;padding:var(--sp-3) 0 var(--sp-1)}
.list h2 i{width:8px;height:8px;background:var(--red);transform:rotate(45deg)}
.list h2 small{font-weight:400;color:var(--text-2);font-size:var(--fs-1)}
.row{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px dashed var(--line)}
.row .thumb{width:56px;height:56px;border-radius:var(--r-thumb);font-size:28px}
.row .body{flex:1;min-width:0}
.row .nm{font-weight:700;font-size:var(--fs-3)}
.row .hook{font-size:var(--fs-1);color:var(--text-2)}
.row .foot{display:flex;align-items:center;justify-content:space-between;margin-top:2px}
.row .add{width:28px;height:28px;line-height:25px;font-size:20px}
`, `
<header class="head">${seal(32)}<span class="nm">${esc(brand.shortName)}</span><span class="meta">桌 ${STATE.table} · ${esc(hours)}<br>等待约 <b>${STATE.waitMin}</b> 分钟</span></header>
<div class="sub">${trustLine()}</div>
<div class="wrap"><nav class="rail"><span class="on">全部</span>${groups.map((g) => `<span>${esc(g.name)}</span>`).join('')}</nav>
<div class="list">${groups.map((g) => `<h2><i></i>${esc(g.name)}<small>${g.dishes.length} 道</small></h2>${g.dishes.map((d) => `
  <article class="row"><span class="thumb">${firstChar(d)}</span><div class="body"><p class="nm clip1">${esc(d.name)}</p>${d.hook ? `<p class="hook clip1">${esc(d.hook)}</p>` : ''}
  <div class="foot"><span class="price">${money(d.priceSen)}${unit(d)}</span>${plus(d, 'line')}</div></div></article>`).join('')}`).join('')}</div></div>
<div style="height:140px"></div>${cartbar}${tabbar}`),
  detail: () => page('C', 'C 纸本菜谱 · 详情', `
.top{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 var(--sp-4);font-size:var(--fs-2);color:var(--text-2);border-bottom:1px solid var(--line)}
.frame{margin:var(--sp-4);padding:6px;border:1px solid var(--line);outline:1px solid var(--line);outline-offset:3px}
.ttl{text-align:center;padding:0 var(--sp-4)}
.ttl h1{font-family:var(--font-brush);font-weight:400;font-size:var(--fs-5);line-height:1.2}
.ttl .price{font-size:22px;margin-top:var(--sp-1)}
.ttl .hook{margin-top:var(--sp-2);font-size:var(--fs-2);color:var(--text-2)}
.xbtn{margin-top:var(--sp-3);height:40px;padding:0 var(--sp-5);border-radius:var(--r-btn);background:var(--red-10);color:var(--red);font-weight:700;font-size:var(--fs-2)}
.sec{margin:var(--sp-4) var(--sp-4) 0;padding-top:var(--sp-4);border-top:1px dashed var(--line)}
.sec h2{display:flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-3);font-weight:700;margin-bottom:var(--sp-2)}
.sec h2 i{width:8px;height:8px;background:var(--red);transform:rotate(45deg)}
.sec p{font-size:var(--fs-2);line-height:1.8}
.steps{list-style:none;display:flex;flex-direction:column;gap:var(--sp-2)}
.steps li{display:flex;gap:var(--sp-3);align-items:center;font-size:var(--fs-2)}
.steps i{flex:none;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--red-line);color:var(--red);font-style:normal;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:var(--fs-1)}
.stamp{display:inline-block;padding:4px 12px;border:1.5px solid var(--red-line);color:var(--red);font-size:var(--fs-2);transform:rotate(-2deg)}
.dbar{position:fixed;left:0;right:0;bottom:56px;z-index:4;max-width:375px;margin:0 auto;display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-2) var(--sp-4);background:var(--bg);border-top:1px solid var(--line)}
.dbar .price{font-size:var(--fs-4);margin-right:auto}
`, detailBody('C'))
};

// ---------- 输出 ----------
const out = { A, B, C: C_ };
for (const [k, v] of Object.entries(out)) {
  const dir = join(HERE, k);
  mkdirSync(dir, { recursive: true });
  THUMB = DIRS[k].thumb;
  writeFileSync(join(dir, 'tokens.css'), `/* 方向 ${k}「${DIRS[k].name}」比稿 token（不进生产）。锚：底色/文字/品牌红取自 tokens.json；动效档位：${DIRS[k].motion} */\n${tokenCss(DIRS[k].tokens)}`);
  writeFileSync(join(dir, 'list.html'), v.list());
  writeFileSync(join(dir, 'detail.html'), v.detail());
}
// 缩略图首字占位：墨色 / 品牌红两组对比（35号 Q3），用 A 的列表做
THUMB = 'ink';
writeFileSync(join(HERE, 'A', 'list-ink.html'), A.list());
console.log(`生成完成：A/B/C × 列表+详情；${groups.length} 个分类、${groups.reduce((n, g) => n + g.dishes.length, 0)} 道顾客可见菜；详情样张 ${DETAIL.code} ${DETAIL.name}`);
