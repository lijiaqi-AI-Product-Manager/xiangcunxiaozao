// P3 第④项：书法字体自托管 + 上传侧图片压缩（≤300KB）
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { expect, test } from '@playwright/test';

import { autoConfirm } from './helpers.ts';
const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p3-batch4');
mkdirSync(SHOTS, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
const LIMIT = 300 * 1024;

test('书法字体从自己的服务器加载，不再请求谷歌字体；书法字真正渲染出来', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true })).newPage();
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.goto(`${CUSTOMER}/?table=8#dish/e06`);
  await expect(page.locator('.detail-name')).toHaveText('湘味油泼牛肉');
  await page.evaluate(() => document.fonts.ready);
  expect(requested.filter((u) => /googleapis|gstatic/.test(u))).toEqual([]);
  const font = requested.find((u) => u.includes('/brand-font/'));
  expect(font).toBeTruthy();
  const res = await page.request.get(font!);
  expect(res.headers()['content-type']).toBe('font/woff2');
  expect((await res.body()).length).toBeLessThan(200 * 1024); // 裁剪后的小字体
  expect(await page.evaluate(() => [...document.fonts].some((f) => f.status === 'loaded'))).toBe(true);
});

test('老板上传一张约 2MB 的大图：浏览器先压到 300KB 以内再上传，并告诉老板压了多少', async ({ browser }) => {
  // 一张「像照片」的 2400×2400 JPG（渐变 + 颗粒），约 2MB
  const size = 2400;
  const raw = Buffer.alloc(size * size * 3);
  let s = 0x9e3779b9;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 3;
    const base = [200 * x / size + 30, 160 * y / size + 50, 120 + 80 * Math.sin((x + y) / 90)];
    for (let c = 0; c < 3; c++) raw[i + c] = Math.max(0, Math.min(255, base[c]! + (rnd() - 0.5) * 40));
  }
  const big = await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  expect(big.length).toBeGreaterThan(1024 * 1024);

  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  autoConfirm(desk); // 老板端的确认是自定义弹窗，不是原生 dialog
  await desk.goto(ADMIN);
  await desk.getByLabel('老板密码').fill('e2e-test-password');
  await desk.getByRole('button', { name: '登录' }).click();
  await desk.locator('.side').getByRole('link', { name: /^菜品管理/ }).click();
  await desk.getByLabel('搜索菜品').fill('咸鸭蛋'); // 上传测试专用的 fixture 菜（31号 ④）
  await desk.getByLabel('上传 下饭咸鸭蛋 图片').setInputFiles({ name: 'big-photo.jpg', mimeType: 'image/jpeg', buffer: big });
  const note = desk.getByRole('status').filter({ hasText: '图片已压缩' });
  await expect(note).toBeVisible({ timeout: 20_000 });
  // 压缩后的图能正常解码显示（不是坏图）：等缩略图真正画出来再截图
  const thumb = desk.locator('.dish-table tbody tr', { hasText: '下饭咸鸭蛋' }).locator('img');
  await thumb.scrollIntoViewIfNeeded();
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await desk.screenshot({ path: resolve(SHOTS, '老板-上传大图自动压缩.png') });

  // 服务器上存的那张图 ≤ 300KB
  const src = await thumb.getAttribute('src');
  expect(src).toMatch(/^\/media\//);
  const stored = await desk.request.get(`${ADMIN}${src}`);
  expect((await stored.body()).length).toBeLessThanOrEqual(LIMIT);

  // 收尾：删掉测试图，fixture 菜回到占位
  await desk.getByRole('button', { name: '删除 下饭咸鸭蛋 图片' }).click();
  await expect(desk.getByRole('button', { name: '删除 下饭咸鸭蛋 图片' })).toHaveCount(0);
});
