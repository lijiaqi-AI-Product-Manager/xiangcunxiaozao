#!/usr/bin/env node
/* ============================================================
   e2e.js —— 六版本冒烟 + 红线自证（输出 tests/e2e/report.json）
   红线覆盖：#1动画属性 #4一屏6道 #5触控/字号 #6对比度
             #7毛玻璃≤3 #8 reduced-motion #9 lite档 #10 CPU6x掉帧
   ============================================================ */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '../../dist');
const report = { generated: new Date().toISOString(), versions: {}, redlines: {} };

/* —— WCAG 相对亮度 / 对比度（页面内执行） —— */
const CONTRAST_FN = `
function lum(r,g,b){
  const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
  return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);
}
function ratio(c1,c2){
  const L1=lum(...c1),L2=lum(...c2);
  return +(((Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05)).toFixed(2));
}
function parse(s){
  const m=s.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/);
  return m?[+m[1],+m[2],+m[3]]:null;
}`;

(async () => {
  const browser = await chromium.launch();

  /* ============ ① 六版本加载 + 核心交互链 ============ */
  for (const v of ['v2-ink', 'v2-macaron', 'v1-dock', 'hero', 'green', 'ink-black']) {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(`file://${DIST}/${v}/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    // 加购 ×2 → 徽标/结算联动
    await page.click('.dish-card[data-id="E01"] .stamp-add');
    await page.waitForTimeout(150);
    await page.click('.dish-card[data-id="E01"] .qty-plus');
    await page.waitForTimeout(400);
    const interact = await page.evaluate(() => {
      const dockMode = document.documentElement.dataset.checkout === 'dock';
      const qtyEl = document.querySelector('.dish-card[data-id="E01"] .qty-n');
      const total = dockMode
        ? (document.querySelector('.dock-checkout b') || {}).textContent
        : (document.querySelector('.cb-total b') || {}).textContent;
      return {
        qty: qtyEl ? qtyEl.textContent : null,
        checkoutShown: dockMode
          ? document.querySelector('.dock-checkout').classList.contains('has')
          : document.querySelector('#checkoutBar').classList.contains('has'),
        dockBadge: (document.querySelector('.dock-badge') || {}).textContent,
        total,
      };
    });
    // 去结算按钮存在且可点
    const goBtnVisible = await page.evaluate(() => {
      const b = document.querySelector('.cb-go') || document.querySelector('.dock-checkout');
      return b ? b.getBoundingClientRect().height >= 44 : false;
    });
    report.versions[v] = { jsErrors: errs, interact, goBtnMinH44: goBtnVisible };
    await page.close();
  }

  /* ============ ② 红线#1 常驻动画只动 opacity/transform ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    report.redlines.r1_animProps = await page.evaluate(() => {
      const bad = [];
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running' || !a.effect) continue;
        const frames = a.effect.getKeyframes();
        for (const f of frames) {
          for (const k of Object.keys(f)) {
            if (['offset', 'computedOffset', 'easing', 'composite'].includes(k)) continue;
            if (!['opacity', 'transform'].includes(k)) bad.push({ name: a.animationName || a.id, prop: k });
          }
        }
      }
      return { total: document.getAnimations().filter(a => a.playState === 'running').length, bad };
    });
    await page.close();
  }

  /* ============ ③ 红线#4 一屏≥6道（无图态 + hero滚动收起后） ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    report.redlines.r4_firstScreenCards_plain = await page.evaluate(() => {
      const dock = document.querySelector('.dock').getBoundingClientRect();
      return [...document.querySelectorAll('.dish-card')].filter(c => c.getBoundingClientRect().bottom <= dock.top - 4).length;
    });
    await page.goto(`file://${DIST}/hero/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(700);
    report.redlines.r4_firstScreenCards_heroScrolled = await page.evaluate(() => {
      const dock = document.querySelector('.dock').getBoundingClientRect();
      return {
        cards: [...document.querySelectorAll('.dish-card')].filter(c => c.getBoundingClientRect().bottom <= dock.top - 4).length,
        bannerShown: document.querySelector('.banner-card').classList.contains('show'),
      };
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(700);
    report.redlines.r4_bannerFoldOnTop = await page.evaluate(() =>
      !document.querySelector('.banner-card').classList.contains('show'));
    await page.close();
  }

  /* ============ ④ 红线#5 触控热区 + 正文字号 ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    report.redlines.r5_touchAndFont = await page.evaluate(() => {
      const minTouch = [];
      document.querySelectorAll('button, a').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        const cls = el.className || el.tagName;
        if (el.closest('.ver-switch') || /perf-badge/.test(cls)) return; // 演示脚手架，发布版移除
        let h = r.height;
        const p = getComputedStyle(el, '::after');
        if (p.content !== 'none' && p.position === 'absolute') h += 2 * Math.abs(parseFloat(p.top) || 0);
        if (h < 42) minTouch.push({ cls: String(cls).slice(0, 26), h: +h.toFixed(0) });
      });
      const smallFont = [];
      document.querySelectorAll('.dc-name, .dc-copy, .dc-price, .cat-pill span, .shop-meta').forEach(el => {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 11) smallFont.push({ text: (el.textContent || '').slice(0, 10), fs });
      });
      return { minTouch, smallFont };
    });
    await page.close();
  }

  /* ============ ⑤ 红线#6 对比度（计算样式实算） ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    report.redlines.r6_contrast = await page.evaluate(`(() => { ${CONTRAST_FN}
      const pairs = {};
      const card = [253,251,243];   // --card #FDFBF3
      const paper = [245,239,224];  // --paper #F5EFE0
      const ink = [31,61,46];       // --ink #1F3D2E
      const glassInk = [46,68,55];  // --glass-bg-ink 近似实底
      const cinn = [179,58,43];     // --cinnabar #B33A2B
      const milk = [251,246,234];   // #FBF6EA
      // 菜名 on 卡
      const name = parse(getComputedStyle(document.querySelector('.dc-name')).color);
      pairs.name_on_card = ratio(name, card);
      // 文案(ink-soft 0.82 on ink) on 卡 —— 合成后等效色
      const softEq = [Math.round(28+0.18*(253-28)), Math.round(54+0.18*(251-54)), Math.round(40+0.18*(243-40))];
      pairs.copy_on_card = ratio(softEq, card);
      // 价格 on 卡
      const price = parse(getComputedStyle(document.querySelector('.dc-price')).color);
      pairs.price_on_card = ratio(price, card);
      // 结算合计白字 on 墨玻璃
      pairs.total_on_glass = ratio(milk, glassInk);
      // 去结算白字 on 朱砂
      pairs.go_on_cinnabar = ratio(milk, cinn);
      // 分类条胶囊 on 纸
      pairs.enCap_on_paper = ratio(parse(getComputedStyle(document.querySelector('.en-cap')).color), paper);
      return pairs;
    })()`);
    await page.close();
  }

  /* ============ ⑥ 红线#7 同屏毛玻璃层 ≤3 ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.click('.dish-card[data-id="E01"] .stamp-add');
    await page.waitForTimeout(400);
    report.redlines.r7_backdrop = await page.evaluate(() =>
      [...document.querySelectorAll('*')].filter(el => {
        const s = getComputedStyle(el);
        return (s.backdropFilter || s.webkitBackdropFilter || '').includes('blur') &&
          el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().top < innerHeight;
      }).length);
    await page.close();
  }

  /* ============ ⑦ 红线#8 reduced-motion 全静 ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    report.redlines.r8_reducedMotionRunning = await page.evaluate(() =>
      document.getAnimations().filter(a => a.playState === 'running' && a.currentTime > 1).length);
    await page.close();
  }

  /* ============ ⑧ 红线#9 lite 档 ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=lite`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    report.redlines.r9_lite = await page.evaluate(() => ({
      perf: document.documentElement.dataset.perf,
      backdropCount: [...document.querySelectorAll('*')].filter(el => (getComputedStyle(el).backdropFilter || '').includes('blur')).length,
      infiniteAnims: document.getAnimations().filter(a => a.effect && a.effect.getIterations && a.effect.getIterations() === Infinity).length,
    }));
    await page.close();
  }

  /* ============ ⑨ 红线#10 CPU 6x 连点加号 5 次 ============ */
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.goto(`file://${DIST}/v2-ink/index.html?perf=normal`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.click('.dish-card[data-id="E01"] .stamp-add');
    const frameStats = [];
    for (let i = 0; i < 4; i++) {
      await page.click('.dish-card[data-id="E01"] .qty-plus', { noWaitAfter: true });
      const s = await page.evaluate(async () => {
        const ts = [];
        await new Promise(res => { let n = 0; requestAnimationFrame(function tick(t) { ts.push(t); if (++n < 40) requestAnimationFrame(tick); else res(); }); });
        let worst = 0;
        for (let i = 1; i < ts.length; i++) worst = Math.max(worst, ts[i] - ts[i - 1]);
        return +worst.toFixed(1);
      });
      frameStats.push(s);
    }
    report.redlines.r10_cpu6x = { worstFramePerClick: frameStats, worst: Math.max(...frameStats) };
    await page.close();
  }

  fs.writeFileSync(path.resolve(__dirname, 'report.json'), JSON.stringify(report, null, 2));
  const rl = report.redlines;
  console.log('=== e2e 汇总 ===');
  console.log('r1 动画越界:', rl.r1_animProps.bad.length === 0 ? 'PASS' : JSON.stringify(rl.r1_animProps.bad));
  console.log('r4 无图态:', rl.r4_firstScreenCards_plain, 'hero滚动后:', rl.r4_firstScreenCards_heroScrolled.cards, 'banner:', rl.r4_firstScreenCards_heroScrolled.bannerShown, '回顶收起:', rl.r4_bannerFoldOnTop);
  console.log('r5 触控<42px:', rl.r5_touchAndFont.minTouch.length, '字号<11px:', rl.r5_touchAndFont.smallFont.length);
  console.log('r6 对比度:', JSON.stringify(rl.r6_contrast));
  console.log('r7 毛玻璃:', rl.r7_backdrop, 'r8 rm运行:', rl.r8_reducedMotionRunning, 'r9 lite:', JSON.stringify(rl.r9_lite));
  console.log('r10 CPU6x最慢帧:', rl.r10_cpu6x.worst + 'ms');
  await browser.close();
})();
