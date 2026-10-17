#!/usr/bin/env node
/* ============================================================
   build.js —— 六版本构建
   menu.json（唯一数据源）→ dist/{六版本}/index.html + detail.html
   红线 #12：菜单数据零硬编码，改 menu.json 重跑 build 即全站生效
   ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + '/..';
const SRC = ROOT + '/src';
const DIST = ROOT + '/dist';
const menu = JSON.parse(fs.readFileSync(SRC + '/menu.json', 'utf8'));

const hero = menu.dishes.find(d => d.id === menu.brand.hero_dish);

/* —— 六版本矩阵（考卷 §4.4）—— */
const VERSIONS = [
  { dir: 'v2-ink',     label: 'V2·墨字',    checkout: 'bar',  thumb: 'ink',     paper: 'yellow', ink: 'green', hero: false },
  { dir: 'v2-macaron', label: 'V2·马卡龙',  checkout: 'bar',  thumb: 'macaron', paper: 'yellow', ink: 'green', hero: false },
  { dir: 'v1-dock',    label: 'V1·并入Dock', checkout: 'dock', thumb: 'ink',   paper: 'yellow', ink: 'green', hero: false },
  { dir: 'hero',       label: '大画态',      checkout: 'bar',  thumb: 'ink',     paper: 'yellow', ink: 'green', hero: true },
  { dir: 'green',      label: '淡绿纸',      checkout: 'bar',  thumb: 'ink',     paper: 'green',  ink: 'green', hero: true },
  { dir: 'ink-black',  label: '墨黑结构',    checkout: 'bar',  thumb: 'ink',     paper: 'yellow', ink: 'black', hero: true },
];

/* —— CSS / JS 拼接 —— */
const cssOrder = ['tokens.css', 'base.css', 'components.css', 'detail.css', 'motion.css', 'perf.css'];
function concatCss() {
  let css = cssOrder.map(f => fs.readFileSync(SRC + '/css/' + f, 'utf8')).join('\n');
  const fontCss = SRC + '/assets/fonts/fonts.css';
  if (fs.existsSync(fontCss)) css += '\n' + fs.readFileSync(fontCss, 'utf8');
  return css;
}
function concatJs(files) {
  return files.map(f => fs.readFileSync(SRC + '/js/' + f, 'utf8')).join('\n;\n');
}

/* —— 版本切换条（仅演示）—— */
function versionsNav(curDir) {
  const links = VERSIONS.map(v =>
    `<a href="../${v.dir}/index.html"${v.dir === curDir ? ' class="on"' : ''}>${v.label}</a>`
  ).join('');
  const perf = `<button id="perfBadge" class="perf-badge" type="button">perf</button>`;
  return links + perf;
}

/* —— 模板填充 —— */
function fillTemplate(tpl, v) {
  const attrs = [
    `data-version="${v.dir}"`,
    `data-checkout="${v.checkout}"`,
    `data-thumb="${v.thumb}"`,
    `data-paper="${v.paper}"`,
    `data-ink="${v.ink}"`,
    `data-hero="${v.hero ? 'on' : 'off'}"`,
  ].join(' ');
  return tpl
    .replace('{{DATA_ATTRS}}', attrs)
    .replace('{{VERSIONS_NAV}}', versionsNav(v.dir))
    .replace('{{MENU_JSON}}', JSON.stringify(menu))
    .replace(/\{\{HERO_ID\}\}/g, hero.id)
    .replace(/\{\{HERO_NAME\}\}/g, hero.name)
    .replace(/\{\{HERO_PRICE\}\}/g, hero.price % 1 ? hero.price.toFixed(1) : hero.price)
    .replace(/\{\{BRAND_ADDR\}\}/g, menu.brand.addr)
    .replace(/\{\{BRAND_HOURS\}\}/g, menu.brand.hours)
    .replace(/\{\{BRAND_TAGLINE\}\}/g, menu.brand.tagline);
}

/* —— 主流程 —— */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const indexTpl = fs.readFileSync(SRC + '/templates/index.template.html', 'utf8');
const detailTpl = fs.readFileSync(SRC + '/templates/detail.template.html', 'utf8');
const css = concatCss();
/* 拼接顺序：cart.js → bridge → app/detail.js（bridge 必须先于 IIFE 执行） */
const cartJs = fs.readFileSync(SRC + '/js/cart.js', 'utf8');
/* 浏览器桥接：cart.js 顶层函数声明 → 挂 xcz 前缀到 window（须在 app.js 之前执行） */
const bridge2 = `
;try{ if (typeof window!=='undefined'){ const m={createCart,changeQty,totalQty,totalPrice,fmtRM,macaronIndex,decidePerf}; for(const k in m){ if(!window['xcz'+k[0].toUpperCase()+k.slice(1)]) window['xcz'+k[0].toUpperCase()+k.slice(1)]=m[k]; } } }catch(e){}
`;
/* 主流程继续 */

for (const v of VERSIONS) {
  const dir = path.join(DIST, v.dir);
  fs.mkdirSync(dir + '/assets', { recursive: true });
  fs.writeFileSync(dir + '/index.html', fillTemplate(indexTpl, v));
  fs.writeFileSync(dir + '/detail.html', fillTemplate(detailTpl, v));
  fs.writeFileSync(dir + '/assets/style.css', css);
  const appJs = cartJs + '\n' + bridge2 + '\n' + fs.readFileSync(SRC + '/js/app.js', 'utf8');
  const detailJs = cartJs + '\n' + bridge2 + '\n' + fs.readFileSync(SRC + '/js/detail.js', 'utf8');
  fs.writeFileSync(dir + '/assets/app.js', appJs);
  fs.writeFileSync(dir + '/assets/app-detail.js', detailJs);
  /* 字体（若已子集化） */
  const fontsDir = SRC + '/assets/fonts';
  if (fs.existsSync(fontsDir + '/fonts.css')) {
    fs.mkdirSync(dir + '/assets/fonts', { recursive: true });
    for (const f of fs.readdirSync(fontsDir)) {
      if (f.endsWith('.woff2') || f === 'fonts.css') fs.copyFileSync(fontsDir + '/' + f, dir + '/assets/fonts/' + f);
    }
  }
}

/* dist 入口导航 */
fs.writeFileSync(path.join(DIST, 'index.html'), `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>湘村小灶 · 视觉小样 · 六版本</title>
<style>
body{font-family:'Kaiti SC','STKaiti',KaiTi,serif;background:#F5EFE0;color:#1F3D2E;max-width:480px;margin:0 auto;padding:32px 20px}
h1{font-size:26px}p{color:rgba(31,61,46,.72);font-size:13px;line-height:1.7}
ol{padding-left:1.2em;line-height:2.2;font-size:16px}
a{color:#1F3D2E;text-decoration:none;border-bottom:1px solid rgba(140,106,63,.45)}
small{display:block;margin-top:28px;color:rgba(31,61,46,.5);font-size:11px;letter-spacing:.15em}
</style></head><body>
<h1>湘村小灶 · 点单页视觉小样</h1>
<p>新中式诗意 · 六版本矩阵 · 375px 移动端优先 · 可交互静态小样（不接支付/后端）</p>
<ol>
<li><a href="v2-ink/index.html">V2·墨字 —— 独立结算条 + 墨字白底缩略图（基准版）</a></li>
<li><a href="v2-macaron/index.html">V2·马卡龙 —— 马卡龙底缩略图</a></li>
<li><a href="v1-dock/index.html">V1·并入Dock —— 结算并入底部胶囊</a></li>
<li><a href="hero/index.html">大画态 —— heroDish 240px + 滚动收起横幅卡</a></li>
<li><a href="green/index.html">淡绿纸 —— 绿纸底 + 大画态 + 详情页变体</a></li>
<li><a href="ink-black/index.html">墨黑结构 —— #2B2622 + 大画态 + 详情页变体</a></li>
</ol>
<small>XIANGCUN BISTRO · DESIGN MOCKUP · 2026-10</small>
</body></html>`);

/* —— 字符集收集（供字体子集）—— */
const charset = new Set();
const scan = s => { for (const ch of s) if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) charset.add(ch); };
scan(JSON.stringify(menu));
scan(indexTpl); scan(detailTpl);
scan('演示版本切换条性能档位今日售罄头牌去看看合计去结算菜单招牌购物车已加件湘灶价返回风味之路拆开看看这道菜的来历灶上三步加入减少增加去找');
fs.writeFileSync(ROOT + '/scripts/charset.txt', [...charset].join(''));
console.log('构建完成：六版本 × (index + detail) | 字符集 ' + charset.size + ' 字');
