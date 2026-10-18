// 41号小样截图 + 自动验收（设计资产工具，不进生产）
// 用法：node docs/design/redesign/小样/capture.mjs [--fps]
//  · 3 倍像素 375 宽截图；两版 Dock 同一状态（41号附加 2）
//  · 自动检查：一屏 ≥ 6 道、触控 ≥ 44px、正文 ≥ 14px、文字对比度 ≥ 4.5、减弱动态下零动画、lite 档零毛玻璃
//  · --fps：低配模拟帧率测试（CPU 限速 6 倍、360 宽、normal 档；41号附加 1）
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });
const url = (file, q = '') => pathToFileURL(join(HERE, file)).href + q;
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN' };

const browser = await chromium.launch();
const ready = async (page) => {
  await page.evaluate(async () => {
    const fam = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    await Promise.all([document.fonts.load(`32px ${fam('--font-brush')}`, document.body.innerText), document.fonts.load(`12px ${fam('--font-latin')}`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')]);
    await document.fonts.ready;
  });
  await page.waitForTimeout(1400); // 首次淡入、渐显播完
};

// ---------- 页面内的检查函数 ----------
const CHECKS = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; }; // 53号：左右滑出屏幕的大画卡也不算
  // 一屏看全几道：菜行完整落在顶部到底部操作区之间
  const bottomBar = [...document.querySelectorAll('.cartbar, .dock')].map((e) => e.getBoundingClientRect().top).sort((a, b) => a - b)[0] ?? innerHeight;
  // 顶部被盖住的部分也扣掉：吸顶的分类条、48号收起后的「今日招牌」横幅卡（只算停在屏幕上半截的）
  const topBar = Math.max(0, ...[...document.querySelectorAll('.cats-wrap, body.collapsed .today')].map((e) => e.getBoundingClientRect().bottom).filter((b) => b < innerHeight / 2));
  const perScreen = [...document.querySelectorAll('.row')].filter((r) => { const b = r.getBoundingClientRect(); return b.top >= topBar && b.bottom <= bottomBar; }).length;
  // 触控 ≥ 44：所有可见按钮
  const small = [...document.querySelectorAll('button')].filter(vis).filter((b) => { const r = b.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; })
    .map((b) => `${b.className || b.tagName} ${Math.round(b.getBoundingClientRect().width)}×${Math.round(b.getBoundingClientRect().height)}`);
  // 正文 ≥ 14：豁免 = 英文装饰标签 .en、数字角标 .badge、印章、招牌小印、Dock 图标下的页签字
  const exempt = (el) => el.closest('.en, .badge, .seal, .sq-seal, .blocks, .sig-chip, .tab, .thumb, .tile, .wm'); // 装饰性：英文标签、角标、印章、区块方块字（旁边有完整中文标题）
  const textEls = [...document.querySelectorAll('body *')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(el) && !exempt(el));
  const tiny = textEls.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 14).map((el) => `${el.className || el.tagName}「${el.textContent.trim().slice(0, 8)}」${getComputedStyle(el).fontSize}`);
  // 对比度：沿祖先把半透明底色一层层叠到页面底色上（不计模糊，按最保守的叠色算）
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const pageBase = parse(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255, 1];
  const layerOf = (s) => {
    const c = parse(s.backgroundColor);
    // 渐变底（如朱砂印、烫金按钮）取渐变里最浅的一个色标，按最不利的情况算
    const g = s.backgroundImage.includes('gradient') ? [...s.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter((x) => x && x[3] > 0.5).sort((a, b) => lum(b) - lum(a))[0] : null;
    return g ?? (c && c[3] > 0 ? c : null);
  };
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      // 47号：朱砂印、算盘珠容器的底色画在 ::before 上（整块盖住按钮），也算一层，叠在元素自己的底色上面
      const pb = getComputedStyle(e, '::before');
      const before = pb.content !== 'none' && pb.position === 'absolute' && e.matches('.btn-round, .qty') ? layerOf(pb) : null;
      if (before) stack.push(before);
      const own = layerOf(getComputedStyle(e));
      if (own) stack.push(own);
      // 47号组件 6：选中页签的浅色药丸是 Dock 里单独一个元素（滑动用），不是页签的祖先，这里手动叠上
      const pill = e.matches('.tab.on') ? e.parentElement.querySelector('.dock-pill') : null;
      if (pill) stack.splice(stack.length - 1, 0, layerOf(getComputedStyle(pill)));
    }
    return stack.reverse().reduce((acc, [r, g, b, a]) => [r * a + acc[0] * (1 - a), g * a + acc[1] * (1 - a), b * a + acc[2] * (1 - a)], pageBase.slice(0, 3));
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // 51号：墨玻璃上的白字 / 淡金字带投影，这里的算法看不到投影，单独用「白底实拍」测（见下面 glassText）；角标、选中页签有自己的实底，照常算
  const allText = [...document.querySelectorAll('body *')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && vis(el) && !el.closest('.wm, .hero-wm, .store-wm, .thumb, .tile, .seal, .sq-seal') && !(el.classList.contains('ink-line') && !el.classList.contains('in')) && !(el.closest('.tray') && !el.closest('.badge, .tab.on'))); // 正在渐显中的句子按渐显完成后的样子算 // 印章是标志，按 WCAG 不计对比度
  const contrast = allText.map((el) => {
    const c = parse(getComputedStyle(el).color);
    const op = [...(function* () { for (let e = el; e; e = e.parentElement) yield Number(getComputedStyle(e).opacity); })()].reduce((a, b) => a * b, 1);
    const bgc = bgOf(el);
    const fg = c ? [0, 1, 2].map((i) => c[i] * c[3] * op + bgc[i] * (1 - c[3] * op)) : [0, 0, 0];
    return { el: `${el.className || el.tagName}「${el.textContent.trim().slice(0, 8)}」`, r: ratio(fg, bgc) };
  });
  const low = contrast.filter((x) => x.r < 4.5).map((x) => `${x.el} ${x.r.toFixed(2)}`);
  // 同屏毛玻璃层数（红线 ≤ 3）：每隔 12px 取一个点，数这个点上叠了几层带背景模糊的东西（算盘珠容器的模糊画在 ::before 上，也算）
  const blurry = (e) => { const s = getComputedStyle(e); const b = (x) => x && x !== 'none'; const p = getComputedStyle(e, '::before'); return b(s.backdropFilter) || b(s.webkitBackdropFilter) || (p.content !== 'none' && (b(p.backdropFilter) || b(p.webkitBackdropFilter))); };
  let glassDepth = 0;
  for (let y = 0; y < innerHeight; y += 12) for (let x = 0; x < innerWidth; x += 12) glassDepth = Math.max(glassDepth, document.elementsFromPoint(x, y).filter(blurry).length);
  // 53号：对比度重测表——按元素类型分别给最低值（字体全站换书法后逐类核对）
  const KINDS = { 菜名: '.row-name .t', 价格: '.row .price', 分组标题: '.grp-head h2', 分类条: '.cat span', 店名: '.store-name', 桌号: '.chip-table', 等待时间: '.wait', 描述: '.row-hook', 选中页签: '.tab.on span', 角标: '.badge', 详情价格: '.d-price', 详情底栏价格: '.dbar .price' };
  const byKind = Object.fromEntries(Object.entries(KINDS).map(([k, sel]) => {
    const rs = allText.map((el, i) => (el.matches(sel) || el.closest(sel) ? contrast[i].r : null)).filter((x) => x !== null);
    return [k, rs.length ? +Math.min(...rs).toFixed(2) : null];
  }).filter(([, v]) => v !== null));
  return { perScreen, small, tiny, minContrast: Math.min(...contrast.map((x) => x.r)).toFixed(2), low, glassDepth, byKind };
};

const report = { pages: {}, motion: {}, fps: null };
const shoot = async (file, name, { open = false, scroll = 0, scrollTo = 0 } = {}) => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url(file, '?tier=normal'));
  await ready(page);
  if (scroll) { await page.evaluate(() => document.querySelector('[data-drink]').scrollIntoView({ block: 'start' })); await page.evaluate(() => window.scrollBy(0, -120)); await page.waitForTimeout(2800); } // 滚到饮品区，等氛围色 2.4 秒过渡完
  if (scrollTo) { await page.evaluate((y) => window.scrollTo(0, y), scrollTo); await page.waitForTimeout(700); } // 48号：大画态滑过触发线后收起
  if (open) { await page.click('[data-open-stage]'); await page.waitForTimeout(1400); }
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  if (!open && !scroll) report.pages[name] = await page.evaluate(CHECKS);
  await ctx.close();
};

// 47号：本轮只出淡黄满血版
await shoot('点单-淡黄-Dock并入.html', '点单-淡黄-V1并入');
await shoot('点单-淡黄-现状版.html', '点单-淡黄-V2现状');
await shoot('点单-淡黄-现状版-马卡龙.html', '点单-淡黄-V2马卡龙');
await shoot('点单-淡黄-大画态结构.html', '点单-淡黄-大画态结构');
await shoot('点单-淡黄-大画态结构.html', '点单-淡黄-大画态-收起后', { scrollTo: 560 });
await shoot('点单-淡绿-大画态结构.html', '点单-淡绿-大画态结构');
await shoot('点单-淡绿-大画态结构.html', '点单-淡绿-大画态-收起后', { scrollTo: 560 });
await shoot('点单-淡黄-墨黑-大画态结构.html', '点单-淡黄-墨黑-大画态结构');
await shoot('点单-淡黄-墨黑-大画态结构.html', '点单-淡黄-墨黑-大画态-收起后', { scrollTo: 560 });
await shoot('详情-淡绿.html', '详情-淡绿');
await shoot('详情-淡黄-墨黑结构色.html', '详情-淡黄-墨黑结构色');
await shoot('详情-淡黄.html', '详情-淡黄');
await shoot('详情-淡黄.html', '详情-淡黄-拆开看看', { open: true });
await shoot('点单-淡黄-现状版.html', '点单-淡黄-饮品区氛围色', { scroll: 1 });

// 详情页整页长图（窗口拉到整页高度再截，固定栏落在底部；水印先定在手机屏的大小）
for (const base of ['淡黄']) {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url(`详情-${base}.html`, '?tier=normal'));
  await ready(page);
  await page.evaluate(async () => {
    const wm = document.querySelector('.wm span'); wm.style.fontSize = getComputedStyle(wm).fontSize;
    for (let y = 0; y < document.body.scrollHeight; y += 300) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } // 触发墨迹渐显
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(800);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 375, height: h });
  await page.screenshot({ path: join(SHOTS, `详情-${base}-整页.png`) });
  await ctx.close();
}

// ---------- 减弱动态 / lite 档 ----------
{
  const ctx = await browser.newContext({ ...PHONE, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(url('点单-淡黄-现状版.html'));
  await ready(page);
  await page.click('.row .add');
  await page.waitForTimeout(50);
  const order = await page.evaluate(() => ({ tier: document.documentElement.dataset.tier, running: document.getAnimations().length }));
  await page.goto(url('详情-淡黄.html'));
  await ready(page);
  await page.click('[data-open-stage]');
  await page.waitForTimeout(50);
  const detail = await page.evaluate(() => ({ running: document.getAnimations().length, stageOpen: document.querySelector('.stage').classList.contains('open') }));
  report.motion.reduced = { order, detail };
  await ctx.close();
}
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url('点单-淡黄-现状版.html', '?tier=lite'));
  await ready(page);
  report.motion.lite = await page.evaluate(() => ({
    blurred: [...document.querySelectorAll('.glass, .glass-dark')].filter((e) => { const s = getComputedStyle(e); return (s.backdropFilter && s.backdropFilter !== 'none') || (s.webkitBackdropFilter && s.webkitBackdropFilter !== 'none'); }).length,
    ambientLoop: document.querySelector('.light').getAnimations().length + document.querySelector('.breath').getAnimations().length, // 光源漂移 + 43号纸的呼吸
  }));
  await page.screenshot({ path: join(SHOTS, '点单-淡黄-lite档.png') });
  await ctx.close();
}

// ---------- 51号墨玻璃：玻璃上文字的对比度（含投影）+ 结构五判 ----------
// 做法：把页面背景换成纯白（玻璃后面最亮的情况），只留托盘和 Dock；拍两张——一张文字隐藏（只剩玻璃底 + 投影），一张正常。
// 取每段文字所在区域里「玻璃底 + 投影」的平均颜色，和文字颜色算对比度：这就是字实际落在上面的底
{
  const sharp = (await import('node:module')).createRequire(join(ROOT, 'package.json'))('sharp');
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const results = {};
  for (const [file, name] of [['点单-淡黄-现状版.html', 'V2 托盘 + Dock'], ['点单-淡黄-Dock并入.html', 'V1 并入 Dock'], ['详情-淡黄.html', '详情页 Dock']]) {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(url(file, '?tier=normal'));
    await ready(page);
    await page.addStyleTag({ content: 'html,body{background:#fff!important}.bg,.bloom,.wm,.app,.dbar{visibility:hidden!important}' });
    const boxes = await page.evaluate(() => [...document.querySelectorAll('.tray *')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !el.closest('.badge') && el.getBoundingClientRect().width > 0).map((el) => {
      const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect();
      const c = getComputedStyle(el).color.match(/[\d.]+/g).map(Number);
      return { label: el.textContent.trim().slice(0, 8), x: b.x, y: b.y, w: b.width, h: b.height, color: c, shadow: getComputedStyle(el).textShadow !== 'none' };
    }));
    await page.addStyleTag({ content: '.tray *{color:transparent!important}' });
    await page.waitForTimeout(100);
    const shot = await page.screenshot();
    const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const s = info.width / 375;
    results[name] = boxes.map((b) => {
      let acc = [0, 0, 0], n = 0;
      for (let y = Math.round(b.y * s); y < Math.round((b.y + b.h) * s); y++) for (let x = Math.round(b.x * s); x < Math.round((b.x + b.w) * s); x++) { const i = (y * info.width + x) * 3; acc = acc.map((v, k) => v + data[i + k]); n++; }
      const bg = acc.map((v) => v / n);
      const [r, g, bl, a = 1] = b.color;
      const fg = [r, g, bl].map((v, k) => v * a + bg[k] * (1 - a));
      const [hi, lo] = [L(fg), L(bg)].sort((p, q) => q - p);
      return { text: b.label, shadow: b.shadow, ratio: +((hi + 0.05) / (lo + 0.05)).toFixed(2) };
    });
    await ctx.close();
  }
  report.glassText = results;
  report.glassTextMin = Math.min(...Object.values(results).flat().map((r) => r.ratio));

  // 结构五判（截图验不了玻璃感，只验结构在不在）
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url('点单-淡黄-现状版.html', '?tier=normal'));
  await ready(page);
  report.glassStructure = await page.evaluate(() => {
    const pick = (sel) => { const e = document.querySelector(sel); const s = getComputedStyle(e); const b = getComputedStyle(e, '::before');
      return { background135: s.backgroundImage.includes('135deg'), staticSpot: s.backgroundImage.startsWith('radial-gradient'), filter: s.backdropFilter || s.webkitBackdropFilter,
        unevenEdges: (s.boxShadow.match(/inset/g) || []).length, noise: b.backgroundImage.includes('feTurbulence') && b.mixBlendMode === 'overlay' }; };
    const moving = document.getAnimations().filter((a) => { const t = a.effect?.target; return t && t.closest && t.closest('.tray') && a.effect.getTiming().iterations === Infinity; }).length;
    return { cartbar: pick('.cartbar'), dock: pick('.dock'), movingHighlightsOnGlass: moving, cardsBlur: [...document.querySelectorAll('.card')].filter((c) => getComputedStyle(c).backdropFilter !== 'none').length };
  });
  await ctx.close();
}

// ---------- 53号 T2：标题标签层必须用书法画，缺字（会退到楷体 / 衬线）即判失败 ----------
{
  const { readFileSync } = await import('node:fs');
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  const brandJson = JSON.parse(readFileSync(join(ROOT, 'brands', env.BRAND, 'brand.json'), 'utf8'));
  const have = readFileSync(join(ROOT, 'brands', env.BRAND, brandJson.brushFont.file.replace(/\.woff2$/, '.chars.txt')), 'utf8');
  const haveLatin = readFileSync(join(ROOT, 'brands', env.BRAND, brandJson.latinFont.file.replace(/\.woff2$/, '.chars.txt')), 'utf8'); // 53号：数字、英文走衬线体
  const SEL = '.store-name, .chip-table, .wait, .cat span, .grp-head h2, .row-name .t, .price, .tab span, .gilt, .sum, .d-price, .xbtn, .pill-btn, .today-label, .today-name, .today-anchor b, .price-anchor .pa-name, .price-anchor b';
  const brushCheck = {};
  for (const file of ['点单-淡黄-现状版.html', '点单-淡黄-Dock并入.html', '点单-淡黄-大画态结构.html', '详情-淡黄.html']) {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(url(file, '?tier=normal'));
    await ready(page);
    brushCheck[file] = await page.evaluate(([sel, have, haveLatin, family]) => {
      const set = new Set([...have]);
      const latin = new Set([...haveLatin]);
      const isLatin = (ch) => /[ -~·’−]/.test(ch);
      // 只看元素自己的文字（不含子元素里另有字体的部分，比如英文标签、按钮里的小字）
      const own = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') + [...el.children].filter((c) => getComputedStyle(c).fontFamily === getComputedStyle(el).fontFamily).map((c) => c.textContent).join('');
      const els = [...document.querySelectorAll(sel)];
      const bad = [];
      for (const el of els) {
        const fam = getComputedStyle(el).fontFamily;
        if (!fam.startsWith(`"XC Latin", "${family}"`)) bad.push(`${el.className}：字体是 ${fam.slice(0, 30)}`); // 衬线（数字英文）+ 书法（汉字）
        const miss = [...own(el)].filter((ch) => ch.trim() && !(isLatin(ch) ? latin.has(ch) : set.has(ch)));
        if (miss.length) bad.push(`${el.className}「${el.textContent.trim().slice(0, 8)}」缺字 ${[...new Set(miss)].join('')}`);
      }
      return { checked: els.length, fallback: bad };
    }, [SEL, have, haveLatin, brandJson.brushFont.family]);
    await ctx.close();
  }
  report.brushCheck = brushCheck;

  // 53号：同屏真毛玻璃 ≤ 3 层（假玻璃不算）——数屏幕上看得见的、真开了背景模糊的元素
  const realGlass = {};
  for (const [file, scrollTo] of [['点单-淡黄-现状版.html', 0], ['点单-淡黄-Dock并入.html', 0], ['点单-淡黄-大画态结构.html', 0], ['点单-淡黄-大画态结构.html', 560], ['详情-淡黄.html', 0]]) {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    await page.goto(url(file, '?tier=normal'));
    await ready(page);
    if (scrollTo) { await page.evaluate((y) => window.scrollTo(0, y), scrollTo); await page.waitForTimeout(700); }
    realGlass[`${file}${scrollTo ? ' 收起后' : ''}`] = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => {
      const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
      const on = (v) => v && v !== 'none';
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && Number(s.opacity) > 0 && (on(s.backdropFilter) || on(s.webkitBackdropFilter));
    }).map((e) => e.className.split(' ')[0]));
    await ctx.close();
  }
  report.realGlass = realGlass;
}

// ---------- 低配模拟帧率（41号附加 1） ----------
if (process.argv.includes('--fps')) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const measure = (fn) => page.evaluate(async (src) => {
    const run = new Function(`return (${src})`)();
    const stamps = [];
    let on = true;
    const tick = (t) => { stamps.push(t); if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await run();
    on = false;
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    const secs = (stamps.at(-1) - stamps[0]) / 1000;
    return { fps: Math.round(gaps.length / secs), worstFrameMs: Math.round(Math.max(...gaps)), longFrames: gaps.filter((g) => g > 50).length };
  }, fn.toString());
  await page.goto(url('点单-淡黄-现状版.html', '?tier=normal'));
  await ready(page);
  const scroll = await measure(async () => { for (let i = 0; i < 60; i++) { window.scrollBy(0, 40); await new Promise((r) => requestAnimationFrame(r)); } await new Promise((r) => setTimeout(r, 400)); });
  const addBurst = await measure(async () => { const btns = [...document.querySelectorAll('.row .add')].slice(0, 5); for (const b of btns) { b.click(); await new Promise((r) => setTimeout(r, 180)); } await new Promise((r) => setTimeout(r, 600)); });
  await page.goto(url('详情-淡黄.html', '?tier=normal'));
  await ready(page);
  const stage = await measure(async () => { document.querySelector('[data-open-stage]').click(); await new Promise((r) => setTimeout(r, 1300)); });
  const detailScroll = await measure(async () => { for (let i = 0; i < 50; i++) { window.scrollBy(0, 40); await new Promise((r) => requestAnimationFrame(r)); } await new Promise((r) => setTimeout(r, 300)); });
  report.fps = { setup: 'CPU 限速 6 倍、360×780、2 倍像素、normal 档（毛玻璃、纸的呼吸、云斑、菜卡环境光、视差、落印、水滴角标全开）', scroll, addBurst, stage, detailScroll };
  await ctx.close();
}

await browser.close();
for (let i = 0; ; i++) { try { writeFileSync(join(SHOTS, 'checks.json'), JSON.stringify(report, null, 2)); break; } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 200)); } } // Windows 偶尔短暂锁文件，重试
console.log(JSON.stringify(report, null, 2));
