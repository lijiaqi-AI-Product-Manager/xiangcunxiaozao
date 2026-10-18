// P3 第③项：数据看板简版。前面几批测试已经在同一个测试库里下过单、退过款、充过值，
// 这里核对页面上的大数字和服务器现算的结果一致，并截图存进 docs/screenshots/p3-batch3/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Dashboard, formatPrice } from '@pkg/contract';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p3-batch3');
mkdirSync(SHOTS, { recursive: true });
const ADMIN = 'http://localhost:5184';

test('数据看板：今日营收 / 有效订单 / 储值净变动与服务器现算一致；可以翻到前一天', async ({ browser }) => {
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await desk.goto(ADMIN);
  await desk.getByLabel('老板密码').fill('e2e-test-password');
  await desk.getByRole('button', { name: '登录' }).click();
  await desk.locator('.side').getByRole('link', { name: /^数据看板/ }).click();
  await expect(desk.getByRole('region', { name: '实收营收' })).toBeVisible();

  const token = await desk.evaluate(() => localStorage.getItem('admin-token') ?? '');
  const api = Dashboard.parse(await (await desk.request.get(`${ADMIN}/api/admin/dashboard`, { headers: { authorization: `Bearer ${token}` } })).json());
  expect(api.day.orders).toBeGreaterThan(0); // 前面的测试确实下过单
  const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
  expect(flat(await desk.getByRole('region', { name: '实收营收' }).locator('.stat-big').textContent())).toBe(`RM ${formatPrice(api.day.netSen)}`);
  expect(flat(await desk.getByRole('region', { name: '有效订单' }).locator('.stat-big').textContent())).toBe(`${api.day.orders} 单`);
  // 付款方式拆分合计 = 总实收
  expect(api.day.byMethod.reduce((n, m) => n + m.netSen, 0)).toBe(api.day.netSen);
  await desk.screenshot({ path: resolve(SHOTS, '老板-数据看板-今天.png'), fullPage: true });

  await desk.getByRole('button', { name: '‹ 前一天' }).click();
  await expect(desk.getByRole('button', { name: '回到今天' })).toBeVisible();
  await expect(desk.getByRole('region', { name: '有效订单' }).locator('.stat-big')).toHaveText(/^0\s*单$/); // 测试库是今天新建的
  await desk.getByRole('button', { name: '回到今天' }).click();
  await expect(desk.getByRole('button', { name: '后一天 ›' })).toBeDisabled();
});
