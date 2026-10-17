#!/usr/bin/env node
/* compare.js —— 六版本同状态并排矩阵图（考卷 §4.4：同状态截图对比） */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SHOTS = path.resolve(__dirname, '../shots');

(async () => {
  const browser = await chromium.launch();

  /* —— 矩阵1：六版本首屏 2×3 —— */
  const six = ['v2-ink', 'v2-macaron', 'v1-dock', 'hero', 'green', 'ink-black'];
  const cell = `<img src="file://${SHOTS}/menu-VER.png" style="width:375px;height:812px;object-fit:cover;display:block">`;
  const html1 = `<!DOCTYPE html><html><body style="margin:0;background:#2B2622;display:flex;flex-wrap:wrap;width:766px">
    ${six.map(v => `<div style="position:relative">${cell.replace(/VER/g, v)}<span style="position:absolute;top:8px;left:8px;background:#B33A2B;color:#FBF6EA;font:600 12px sans-serif;padding:3px 8px;border-radius:4px">${v}</span></div>`).join('')}
  </body></html>`;
  fs.writeFileSync('/tmp/matrix1.html', html1);
  let page = await browser.newPage({ viewport: { width: 766, height: 1656 }, deviceScaleFactor: 1 });
  await page.goto('file:///tmp/matrix1.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/matrix-6versions.png`, fullPage: true });

  /* —— 矩阵2：详情页三变体 —— */
  const three = ['v2-ink', 'green', 'ink-black'];
  const html2 = `<!DOCTYPE html><html><body style="margin:0;background:#2B2622;display:flex;width:1129px">
    ${three.map(v => `<div style="position:relative"><img src="file://${SHOTS}/detail-F01-${v}.png" style="width:375px;height:812px;object-fit:cover;display:block"><span style="position:absolute;top:8px;left:8px;background:#B33A2B;color:#FBF6EA;font:600 12px sans-serif;padding:3px 8px;border-radius:4px">${v}</span></div>`).join('')}
  </body></html>`;
  fs.writeFileSync('/tmp/matrix2.html', html2);
  await page.setViewportSize({ width: 1129, height: 812 });
  await page.goto('file:///tmp/matrix2.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/matrix-detail3.png`, fullPage: false });

  await browser.close();
  console.log('并排矩阵完成: matrix-6versions.png + matrix-detail3.png');
})();
