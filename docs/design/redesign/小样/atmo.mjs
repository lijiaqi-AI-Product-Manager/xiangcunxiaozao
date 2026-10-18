// 43号任务 A「活的氛围层」验收（设计资产工具，不进生产）
// 用法：node docs/design/redesign/小样/atmo.mjs [--video]
//  · A1 纸的呼吸：基准帧 vs 峰值帧逐像素色差 ΔE00、每秒最大变化量
//  · A2 分区色温：同一滚动位置，湘菜态 vs 饮品态色差
//  · A3 聚光呼吸：光心亮度波动 ±%
//  · 只动合成层属性：页面上所有动画 / 过渡涉及的属性清单；主线程卡死 2.5 秒时呼吸是否照走
//  · --video：录 3 段 30 秒左右的屏幕录像（shots/录像-*.webm）
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const sharp = createRequire(join(ROOT, 'package.json'))('sharp');
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });
const url = (file, q = '') => pathToFileURL(join(HERE, file)).href + q;
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'zh-CN' };
const ORDER = '点单-淡黄-现状版.html';
const DETAIL = '详情-淡黄.html';
const HERO = '点单-淡黄-大画态结构.html';

// ---------- 色差（CIEDE2000）----------
const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lab = (r, g, b) => {
  const [R, G, B] = [r, g, b].map(lin);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const X = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), Y = f(R * 0.2126 + G * 0.7152 + B * 0.0722), Z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};
const rad = Math.PI / 180;
const de00 = ([L1, a1, b1], [L2, a2, b2]) => {
  const Cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G), C1 = Math.hypot(a1p, b1), C2 = Math.hypot(a2p, b2);
  const hh = (x, y) => (Math.atan2(y, x) / rad + 360) % 360;
  const h1 = hh(a1p, b1), h2 = hh(a2p, b2);
  let dh = h2 - h1; if (Math.abs(dh) > 180) dh -= Math.sign(dh) * 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2, Cmp = (C1 + C2) / 2;
  let hm = (h1 + h2) / 2; if (Math.abs(h1 - h2) > 180) hm += 180;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cmp, SH = 1 + 0.015 * Cmp * T;
  const RT = -2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt(((L2 - L1) / SL) ** 2 + ((C2 - C1) / SC) ** 2 + (dH / SH) ** 2 + RT * ((C2 - C1) / SC) * (dH / SH));
};
const raw = async (buf) => { const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; };
// 两张图逐像素比（每 3 像素取一个），返回平均 / 95 分位 / 最大色差 + 平均色
const diff = async (a, b, box) => {
  const [A, B] = [await raw(a), await raw(b)];
  const { x0 = 0, y0 = 0, x1 = A.w, y1 = A.h } = box ?? {};
  const ds = [];
  const avg = [[0, 0, 0], [0, 0, 0]];
  for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) {
    const i = (y * A.w + x) * 3;
    ds.push(de00(lab(A.data[i], A.data[i + 1], A.data[i + 2]), lab(B.data[i], B.data[i + 1], B.data[i + 2])));
    for (let k = 0; k < 3; k++) { avg[0][k] += A.data[i + k]; avg[1][k] += B.data[i + k]; }
  }
  ds.sort((p, q) => p - q);
  const n = ds.length;
  const hue = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return 0; let h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn); return Math.round(((h * 60 + 360) % 360) * 10) / 10; };
  const [ca, cb] = avg.map((c) => c.map((v) => Math.round(v / n)));
  return { meanDE: +(ds.reduce((s, v) => s + v, 0) / n).toFixed(2), p95DE: +ds[Math.floor(n * 0.95)].toFixed(2), maxDE: +ds[n - 1].toFixed(2), avgColor: [ca, cb], hue: [hue(ca), hue(cb)], avgDE: +de00(lab(...ca), lab(...cb)).toFixed(2) };
};
const relLum = async (buf, cx, cy, r) => {
  const A = await raw(buf);
  let s = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    const i = (y * A.w + x) * 3;
    s += 0.2126 * lin(A.data[i]) + 0.7152 * lin(A.data[i + 1]) + 0.0722 * lin(A.data[i + 2]); n++;
  }
  return s / n;
};

const browser = await chromium.launch();
const ready = async (page) => {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(1400);
};
// 把某个动画停在第 t 毫秒（其余常驻动画停在 0，免得光源漂移混进来）
const freeze = (page, name, t) => page.evaluate(([name, t]) => {
  document.getAnimations().forEach((a) => { a.pause(); a.currentTime = a.animationName === name ? t : 0; });
}, [name, t]);
const HIDE_APP = '.app,.dock,.cartbar,.dbar,.wm{visibility:hidden!important}';
const report = {};

// ---------- A1 纸的呼吸 ----------
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url(ORDER, '?tier=normal'));
  await ready(page);
  // 呼吸曲线：每 0.25 秒读一次呼吸层透明度，算每秒最大变化
  const curve = await page.evaluate(() => {
    const a = document.querySelector('.breath').getAnimations()[0];
    const out = [];
    a.pause();
    for (let t = 0; t <= 10000; t += 250) { a.currentTime = t; out.push(Number(getComputedStyle(document.querySelector('.breath')).opacity)); }
    return { duration: a.effect.getTiming().duration, direction: a.effect.getTiming().direction, out };
  });
  const maxRate = Math.max(...curve.out.slice(1).map((v, i) => Math.abs(v - curve.out[i]) * 4)); // 透明度 / 秒
  const shots = {};
  for (const [k, t] of [['base', 0], ['peak', 10000]]) {
    await freeze(page, 'breath', t);
    await page.waitForTimeout(150);
    shots[k] = await page.screenshot();
    await page.addStyleTag({ content: HIDE_APP });
    shots[`${k}Bg`] = await page.screenshot();
    await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent.includes('visibility:hidden!important') && s.remove()));
  }
  const full = await diff(shots.base, shots.peak);
  const bgOnly = await diff(shots.baseBg, shots.peakBg);
  report.A1 = {
    cycle: `${(curve.duration * 2) / 1000} 秒一轮（${curve.duration / 1000} 秒变暖 + ${curve.duration / 1000} 秒回来）`,
    bgOnly, withContent: full,
    maxPerSecondDE: +(bgOnly.p95DE * maxRate).toFixed(2),
    note: 'bgOnly = 只看背景（菜卡隐藏）；withContent = 实际画面',
  };
  for (const [k, b] of Object.entries(shots)) writeFileSync(join(SHOTS, `氛围-A1-${k}.png`), b);
  await ctx.close();
}

// ---------- A2 分区色温（同一滚动位置，强制切换开关比较） ----------
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url(ORDER, '?tier=normal'));
  await ready(page);
  await page.evaluate(() => { document.querySelector('[data-drink]').scrollIntoView({ block: 'start' }); window.scrollBy(0, -120); });
  await page.waitForTimeout(3000);
  const autoOn = await page.evaluate(() => document.body.classList.contains('drinks'));
  await freeze(page, 'breath', 0);
  const grab = async (on) => {
    await page.evaluate((on) => {
      document.querySelectorAll('.bg *, .bloom *').forEach((e) => { e.style.transition = 'none'; });
      document.body.classList.toggle('drinks', on);
    }, on);
    await page.waitForTimeout(200);
    const shot = await page.screenshot();
    await page.addStyleTag({ content: HIDE_APP });
    const bgShot = await page.screenshot();
    await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent.includes('visibility:hidden!important') && s.remove()));
    return { shot, bgShot };
  };
  const warm = await grab(false);
  const cool = await grab(true);
  // 只换墨色（底色已经是饮品区淡绿，第二轮就有）：看本轮新增的墨色变化有多大
  await page.addStyleTag({ content: '/*force-warm*/.ink .warm,.bloom .warm,.breath .warm{opacity:1!important}.ink .cool,.bloom .cool,.breath .cool{opacity:0!important}' });
  const coolBgWarmInk = await grab(true);
  await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent.startsWith('/*force-warm*/') && s.remove()));
  report.A2 = { autoSwitchedOnDrinks: autoOn, transition: '2.4 秒', bgOnly: await diff(warm.bgShot, cool.bgShot), withContent: await diff(warm.shot, cool.shot), inkOnlyBg: await diff(coolBgWarmInk.bgShot, cool.bgShot) };
  writeFileSync(join(SHOTS, '氛围-A2-湘菜态.png'), warm.shot);
  writeFileSync(join(SHOTS, '氛围-A2-饮品态.png'), cool.shot);
  writeFileSync(join(SHOTS, '氛围-A2-湘菜态-背景.png'), warm.bgShot);
  writeFileSync(join(SHOTS, '氛围-A2-饮品态-背景.png'), cool.bgShot);
  // 顶部远山那一屏（墨晕最浓的地方）也比一次
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.evaluate(() => { const ink = document.querySelector('.ink'); ink.style.transform = 'none'; });
  const topWarm = await grab(false);
  const topCool = await grab(true);
  report.A2.topRidgeBgOnly = await diff(topWarm.bgShot, topCool.bgShot, { x0: 0, y0: 0, x1: 375, y1: 460 });
  writeFileSync(join(SHOTS, '氛围-A2-顶部-湘菜态-背景.png'), topWarm.bgShot);
  writeFileSync(join(SHOTS, '氛围-A2-顶部-饮品态-背景.png'), topCool.bgShot);
  await ctx.close();
}

// ---------- G2 云斑（47号：一团云影从大图上飘过，不是整块变亮变暗） ----------
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url(DETAIL, '?tier=normal'));
  await ready(page);
  const timing = await page.evaluate(() => document.querySelector('.cloud').getAnimations()[0].effect.getTiming().duration);
  await page.addStyleTag({ content: '.top-btns,.xbtn-wrap,.hero-en{visibility:hidden!important}' });
  const frames = [];
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const t = Math.min(timing * f, timing - 1);
    await freeze(page, 'breath', 0);
    await page.evaluate((t) => { const a = document.querySelector('.cloud').getAnimations()[0]; a.pause(); a.currentTime = t; }, t);
    await page.waitForTimeout(120);
    const pos = await page.evaluate(() => { const r = document.querySelector('.cloud').getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), opacity: +getComputedStyle(document.querySelector('.cloud')).opacity }; });
    frames.push({ t: +(t / 1000).toFixed(2), ...pos, shot: await page.screenshot({ clip: { x: 0, y: 0, width: 375, height: 440 } }) });
  }
  // 云影中心点的亮度：和没有云的第 0 帧同一位置比，看压暗多少；顺便看画面中心以外是否不受影响
  const base = frames[0].shot;
  const g2 = [];
  for (const f of frames) {
    const cx = Math.max(41, Math.min(334, f.cx)), cy = Math.max(41, Math.min(399, f.cy));
    const [l0, l1] = [await relLum(base, cx, cy, 40), await relLum(f.shot, cx, cy, 40)];
    g2.push({ t: f.t, cloudCenter: [f.cx, f.cy], opacity: f.opacity, darkenAtCloud: `${(((l0 - l1) / l0) * 100).toFixed(1)}%` });
  }
  const far = await relLum(base, 30, 420, 12) - await relLum(frames[2].shot, 30, 420, 12);
  report.G2 = { cycle: `${timing / 1000} 秒一周期（左 → 右飘过，放大缩小，渐隐渐现）`, frames: g2, travelPx: frames[4].cx - frames[0].cx, cornerUnaffected: Math.abs(far) < 0.005 };
  frames.forEach((f, i) => writeFileSync(join(SHOTS, `氛围-G2-${i}.png`), f.shot));
  await ctx.close();
}

// ---------- G1 菜卡环境光（湘菜暖 / 饮品冷；不许把卡片染色） ----------
{
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url(ORDER, '?tier=normal'));
  await ready(page);
  await freeze(page, 'breath', 0);
  const box = await page.evaluate(() => { const r = document.querySelector('.card').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: 160 }; });
  const shotCard = () => page.screenshot({ clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  // 同一个分区底色下，只开 / 关菜卡环境光，比加光前后
  const setState = (drinks, lights) => page.evaluate(([drinks, lights]) => {
    let st = document.getElementById('g1');
    if (!st) { st = document.createElement('style'); st.id = 'g1'; document.head.appendChild(st); }
    st.textContent = `.card::before,.card::after,.bg *,.bloom *{transition:none!important}${lights ? '' : '.card::before,.card::after{opacity:0!important}'}`;
    document.body.classList.toggle('drinks', drinks);
  }, [drinks, lights]);
  const shots = {};
  for (const [k, drinks, lights] of [['none', false, false], ['warm', false, true], ['noneCool', true, false], ['cool', true, true]]) { await setState(drinks, lights); await page.waitForTimeout(150); shots[k] = await shotCard(); }
  // 卡片左上角（光最浓处）vs 卡片中间偏右（光已经淡出）——光只在边上，不把整张卡染色
  const corner = { x0: 0, y0: 0, x1: 60, y1: 40 }, middle = { x0: Math.round(box.w * 0.45), y0: 90, x1: Math.round(box.w * 0.8), y1: 150 };
  report.G1 = {
    warmCorner: (await diff(shots.none, shots.warm, corner)).meanDE, warmMiddle: (await diff(shots.none, shots.warm, middle)).meanDE,
    coolCorner: (await diff(shots.noneCool, shots.cool, corner)).meanDE, coolMiddle: (await diff(shots.noneCool, shots.cool, middle)).meanDE,
    note: 'ΔE00：同一分区底色下加光前后的色差。角落 = 卡片左上 60×40；中间 = 卡片中部偏右（离顶 90px 以下）',
  };
  delete shots.noneCool;
  for (const [k, b] of Object.entries(shots)) writeFileSync(join(SHOTS, `氛围-G1-${k}.png`), b);
  await ctx.close();
}

// ---------- 只动合成层属性 + 档位降级 ----------
{
  const props = new Set();
  const collect = (page) => page.evaluate(() => document.getAnimations().flatMap((a) => (a.transitionProperty ? [a.transitionProperty] : a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p)))))).then((l) => l.forEach((p) => props.add(p)));
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(url(ORDER, '?tier=normal'));
  await collect(page);
  await ready(page);
  await collect(page);
  await page.click('.row .add');
  await collect(page);
  await page.evaluate(() => { document.querySelector('[data-drink]').scrollIntoView({ block: 'start' }); });
  await page.waitForTimeout(600);
  await collect(page);
  await page.goto(url(DETAIL, '?tier=normal'));
  await ready(page);
  await collect(page);
  await page.click('[data-open-stage]');
  await page.waitForTimeout(100);
  await collect(page);
  report.animatedProperties = [...props].sort();
  report.compositorOnly = [...props].every((p) => ['opacity', 'transform', 'visibility'].includes(p));

  await ctx.close();

  // 浏览器自己的记录：每个常驻动画是否交给了合成线程（Chrome 性能记录里的 Animation 事件，compositeFailed = 0 才算）
  const composited = {};
  for (const file of [ORDER, DETAIL, HERO]) {
    const c = await browser.newContext(PHONE);
    const p = await c.newPage();
    await browser.startTracing(p, { categories: ['blink.animations', 'devtools.timeline', 'disabled-by-default-devtools.timeline'] });
    await p.goto(url(file, '?tier=normal'));
    await p.waitForTimeout(2500);
    if (file === ORDER) {
      // 47号新增的动效都走一遍：按住朱砂印（印章按下 + 投影收紧）、点加号（落印 + 水滴飞向购物车）、切页签（药丸滑动）、滑到饮品区（色温 + 菜卡环境光）
      const add = p.locator('.row .add').nth(1);
      await add.hover(); await p.mouse.down(); await p.waitForTimeout(150); await p.mouse.up();
      await p.waitForTimeout(1100);
      await p.locator('.dock .tab').nth(1).click();
      await p.waitForTimeout(400);
      await p.evaluate(() => document.querySelector('[data-drink]').scrollIntoView({ block: 'start' }));
      await p.waitForTimeout(800);
    }
    if (file === DETAIL) { // 拆开看看舞台升起、合拢
      await p.click('[data-open-stage]'); await p.waitForTimeout(1300);
      await p.click('.stage [data-close-stage]'); await p.waitForTimeout(800);
    }
    if (file === HERO) { // 48号：滑过 240px 收起成横幅卡，再滑回顶部展开
      await p.evaluate(() => window.scrollTo(0, 560)); await p.waitForTimeout(700);
      await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(700);
    }
    const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents.filter((e) => e.name === 'Animation');
    const names = new Map();
    for (const e of events) {
      const d = e.args?.data ?? {};
      if (d.displayName !== undefined) names.set(e.id2?.local ?? e.id, `${d.displayName} @ ${d.nodeName.replace(/^\w+ class='([^']*)'.*/, '.$1')}`);
    }
    const ok = new Set(), bad = new Set();
    for (const e of events) {
      const d = e.args?.data ?? {};
      if (d.compositeFailed === undefined) continue;
      const n = names.get(e.id2?.local ?? e.id) ?? '?';
      if (d.compositeFailed === 0) ok.add(n); else bad.add(`${n}（原因码 ${d.compositeFailed}${d.unsupportedProperties?.length ? `：${d.unsupportedProperties.join(',')}` : ''}）`);
    }
    composited[file] = { 合成线程: [...ok].sort(), 主线程: [...bad].sort() };
    await c.close();
  }
  report.compositorTrace = composited;

  const tiers = {};
  for (const [name, opts, q] of [['lite', {}, '?tier=lite'], ['minimal', {}, '?tier=minimal'], ['reduced', { reducedMotion: 'reduce' }, '']]) {
    const c = await browser.newContext({ ...PHONE, ...opts });
    const p = await c.newPage();
    await p.goto(url(ORDER, q));
    await ready(p);
    const order = await p.evaluate(() => ({ tier: document.documentElement.dataset.tier, breathRunning: document.querySelector('.breath').getAnimations().length, breathOpacity: getComputedStyle(document.querySelector('.breath')).opacity }));
    await p.goto(url(DETAIL, q));
    await ready(p);
    const detail = await p.evaluate(() => ({ cloudRunning: document.querySelector('.cloud').getAnimations().length, cloudOpacity: getComputedStyle(document.querySelector('.cloud')).opacity }));
    tiers[name] = { ...order, ...detail };
    await c.close();
  }
  report.tiers = tiers;
}

// ---------- 对比图（给军师看：基准 / 峰值并排，并排的数字是实测色差） ----------
{
  const pairs = [
    ['A1 纸的呼吸', '氛围-A1-baseBg.png', '基准（暖黄）', '氛围-A1-peakBg.png', '峰值（米橙）', `只看背景 · 平均色差 ΔE00 ${report.A1.bgOnly.meanDE}（≈1 人眼刚分得出）`],
    ['A1 纸的呼吸（实际画面）', '氛围-A1-base.png', '基准', '氛围-A1-peak.png', '峰值', `实际画面 · 平均色差 ${report.A1.withContent.meanDE}`],
    ['A2 分区色温', '氛围-A2-湘菜态-背景.png', '湘菜区（赭石墨）', '氛围-A2-饮品态-背景.png', '饮品区（青绿墨）', `只看背景 · 平均色差 ${report.A2.bgOnly.meanDE}`],
    ['A2 分区色温（顶部远山）', '氛围-A2-顶部-湘菜态-背景.png', '赭石墨', '氛围-A2-顶部-饮品态-背景.png', '青绿墨', `远山一带 · 平均色差 ${report.A2.topRidgeBgOnly.meanDE}`],
  ].map(([t, a, la, b, lb, note]) => [t, note, [[a, la], [b, lb]]]);
  pairs.push(['G1 菜卡环境光', `加光前后色差：暖光角落 ${report.G1.warmCorner} / 卡片中间 ${report.G1.warmMiddle}；冷光角落 ${report.G1.coolCorner} / 中间 ${report.G1.coolMiddle}（光只在顶边和左边）`,
    [['氛围-G1-none.png', '不加光'], ['氛围-G1-warm.png', '湘菜区暖橙侧逆光'], ['氛围-G1-cool.png', '饮品区青绿冷光']]]);
  pairs.push(['G2 云斑', `一团云影 ${report.G2.cycle}；云影下方压暗 ${report.G2.frames.map((f) => f.darkenAtCloud).join(' → ')}，横向飘过 ${report.G2.travelPx}px`,
    report.G2.frames.map((f, i) => [`氛围-G2-${i}.png`, `${f.t} 秒`])]);
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#fff;font:15px/1.5 "Microsoft YaHei",sans-serif;color:#2B2622}
section{margin-bottom:28px}h2{font-size:18px;margin:0 0 4px}p{margin:0 0 10px;color:#5F564C}.row{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;flex:1;min-width:0}figcaption{text-align:center;margin-top:4px}img{width:100%;display:block;border-radius:12px;box-shadow:0 0 0 1px #0002}</style>
${pairs.map(([t, note, imgs]) => `<section><h2>${t}</h2><p>${note}</p><div class="row">${imgs.map(([src, cap]) => `<figure><img src="${src}"><figcaption>${cap}</figcaption></figure>`).join('')}</div></section>`).join('')}`;
  writeFileSync(join(SHOTS, '_atmo-sheet.html'), html);
  const ctx = await browser.newContext({ viewport: { width: 760, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(SHOTS, '_atmo-sheet.html')).href);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, '对比-47号-氛围与场景光.png'), fullPage: true });
  await ctx.close();
  rmSync(join(SHOTS, '_atmo-sheet.html'));
}

// ---------- 屏幕录像 ----------
if (process.argv.includes('--video')) {
  const VID = join(SHOTS, '_video');
  const clips = [
    ['录像-A1-点单页静置30秒', ORDER, async (page) => { await page.waitForTimeout(30000); }],
    ['录像-A2-湘菜滚到饮品', ORDER, async (page) => {
      await page.waitForTimeout(2500);
      const target = await page.evaluate(() => document.querySelector('[data-drink]').getBoundingClientRect().top + scrollY - 120);
      for (let y = 0; y < target; y += 14) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(16); }
      await page.waitForTimeout(6000);
      for (let y = target; y > 0; y -= 14) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(16); }
      await page.waitForTimeout(6000);
    }],
    ['录像-G2-云斑飘过', DETAIL, async (page) => { await page.waitForTimeout(24000); }],
    // 48号大画态 C 方案：进店大图 → 慢慢往下滑，过 240px 收成「今日招牌」横幅卡 → 停一下 → 滑回顶部展开
    ['录像-大画态收起展开', HERO, async (page) => {
      await page.waitForTimeout(2500);
      for (let y = 0; y <= 620; y += 10) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(16); }
      await page.waitForTimeout(3000);
      for (let y = 620; y >= 0; y -= 10) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(16); }
      await page.waitForTimeout(2500);
    }],
    // 高斯手机三看之二、之三：朱砂印按下去像不像盖章、水滴 +1 飞向购物车那一下。先原速 3 次，再 0.25 倍慢放 2 次
    ['录像-朱砂印与水滴角标', ORDER, async (page) => {
      await page.waitForTimeout(1500);
      const press = async (i) => { const b = page.locator('.row .add').nth(i); await b.hover(); await page.mouse.down(); await page.waitForTimeout(160); await page.mouse.up(); await page.waitForTimeout(1300); };
      for (const i of [1, 2, 3]) await press(i);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Animation.enable');
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.25 });
      await page.addStyleTag({ content: '.add,.add::after{transition-duration:1.2s!important}' }); // 按压回弹的过渡也一起放慢（CSS 过渡不受上面的倍速影响时兜底）
      for (const i of [4, 5]) { const b = page.locator('.row .add').nth(i); await b.hover(); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up(); await page.waitForTimeout(4200); }
    }],
  ];
  for (const [name, file, act] of clips) {
    rmSync(VID, { recursive: true, force: true });
    const ctx = await browser.newContext({ ...PHONE, deviceScaleFactor: 2, recordVideo: { dir: VID, size: { width: 750, height: 1624 } } });
    const page = await ctx.newPage();
    await page.goto(url(file, '?tier=normal'));
    await act(page);
    await ctx.close();
    const [f] = readdirSync(VID);
    renameSync(join(VID, f), join(SHOTS, `${name}.webm`));
  }
  rmSync(VID, { recursive: true, force: true });
}

await browser.close();
for (let i = 0; ; i++) { try { writeFileSync(join(SHOTS, 'atmo.json'), JSON.stringify(report, null, 2)); break; } catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 200)); } } // Windows 偶尔短暂锁文件，重试
console.log(JSON.stringify(report, null, 2));
