#!/usr/bin/env node
/* ============================================================
   capture.js —— 全量截图（375×812，全部强制 normal 档）
   场景：六版首屏 / 滚动横幅卡 / 加购态 / 详情页 / 档位对比
   ============================================================ */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const DIST = path.resolve(__dirname, '../dist');
const SHOTS = path.resolve(__dirname, '../shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VERS = ['v2-ink', 'v2-macaron', 'v1-dock', 'hero', 'green', 'ink-black'];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const go = async (url) => {
    const errs = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900); // 字体+首帧稳定
    return errs;
  };

  /* —— ① 六版点单页首屏 —— */
  for (const v of VERS) {
    const errs = await go(`file://${DIST}/${v}/index.html?perf=normal`);
    if (errs.length) console.error(`[ERR] ${v}:`, errs);
    await page.screenshot({ path: `${SHOTS}/menu-${v}.png` });
    console.log(`✓ menu-${v}.png`);
  }

  /* —— ② 大画态：滚动后横幅卡（hero 版） —— */
  await go(`file://${DIST}/hero/index.html?perf=normal`);
  await page.evaluate(() => window.scrollTo(0, 340));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/banner-card-hero.png` });
  console.log('✓ banner-card-hero.png');

  /* —— ③ 加购态：算盘珠 + 结算条（v2-ink） —— */
  await go(`file://${DIST}/v2-ink/index.html?perf=normal`);
  await page.click('.dish-card[data-id="E01"] .stamp-add');
  await page.waitForTimeout(250);
  await page.click('.dish-card[data-id="E01"] .qty-plus');
  await page.click('.dish-card[data-id="F01"] .stamp-add');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/cart-v2-ink.png` });
  console.log('✓ cart-v2-ink.png');

  /* —— ④ 加购态：Dock 版（v1-dock） —— */
  await go(`file://${DIST}/v1-dock/index.html?perf=normal`);
  await page.click('.dish-card[data-id="E01"] .stamp-add');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/cart-v1-dock.png` });
  console.log('✓ cart-v1-dock.png');

  /* —— ⑤ 详情页（主版 v2-ink + 变体 green / ink-black） —— */
  for (const v of ['v2-ink', 'green', 'ink-black']) {
    await go(`file://${DIST}/${v}/detail.html?id=F01&perf=normal`);
    await page.screenshot({ path: `${SHOTS}/detail-F01-${v}.png` });
    await page.evaluate(() => window.scrollTo(0, 620));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/detail-F01-${v}-mid.png` });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight - 900));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/detail-F01-${v}-bottom.png` });
    console.log(`✓ detail-F01-${v} ×3`);
  }

  /* —— ⑥ 性能档位对比（v2-ink：normal / minimal / lite） —— */
  for (const p of ['normal', 'minimal', 'lite']) {
    await go(`file://${DIST}/v2-ink/index.html?perf=${p}`);
    await page.screenshot({ path: `${SHOTS}/perf-${p}.png` });
    console.log(`✓ perf-${p}.png`);
  }

  await browser.close();
  console.log('截图全部完成 →', SHOTS);
})();
