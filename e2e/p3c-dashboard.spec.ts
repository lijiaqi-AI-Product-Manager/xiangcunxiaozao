// P3 第③项：数据看板简版。前面几批测试已经在同一个测试库里下过单、退过款、充过值，
// 这里核对页面上的大数字和服务器现算的结果一致，并截图存进 docs/screenshots/p3-batch3/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Dashboard, formatMoney } from '@pkg/contract';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p3-batch3');
mkdirSync(SHOTS, { recursive: true });
const ADMIN = 'http://localhost:5184';

test('数据看板：今日营收 / 有效订单 / 储值净变动与服务器现算一致；可以翻到前一天', async ({ browser }) => {
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();

  // 以前的写法是「指望前面的用例已经下过单」。单独跑这条、或者换了执行顺序，库里就是空的，
  // 结果红在一个跟看板毫无关系的地方。用例要能自己站起来：先真下一单。
  await test.step('先真下一单（不依赖别的用例）', async () => {
    await phone.goto('http://localhost:5183/?table=4');
    await phone.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
    await expect(phone.locator('.cartbar-go')).toBeVisible({ timeout: 10000 });
    await phone.locator('.cartbar-go').click();
    await phone.getByText('现金（到柜台）').click();
    await phone.getByRole('button', { name: /提交订单/ }).click();
    await expect(phone.locator('.hero-status')).toHaveText('待制作');
  });

  await desk.goto(ADMIN);
  await desk.getByLabel('老板密码').fill('e2e-test-password');
  await desk.getByRole('button', { name: '登录' }).click();
  await desk.locator('.side').getByRole('link', { name: /^数据看板/ }).click();
  await expect(desk.getByRole('region', { name: '实收营收' })).toBeVisible();

  const token = await desk.evaluate(() => localStorage.getItem('admin-token') ?? '');
  const api = Dashboard.parse(await (await desk.request.get(`${ADMIN}/api/admin/dashboard`, { headers: { authorization: `Bearer ${token}` } })).json());
  expect(api.day.orders).toBeGreaterThan(0); // 前面的测试确实下过单
  const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
  expect(flat(await desk.getByRole('region', { name: '实收营收' }).locator('.stat-big').textContent())).toBe(`RM ${formatMoney(api.day.netSen)}`);
  expect(flat(await desk.getByRole('region', { name: '有效订单' }).locator('.stat-big').textContent())).toBe(`${api.day.orders} 单`);
  // 付款方式拆分合计 = 总实收
  expect(api.day.byMethod.reduce((n, m) => n + m.netSen, 0)).toBe(api.day.netSen);
  await desk.screenshot({ path: resolve(SHOTS, '老板-数据看板-今天.png'), fullPage: true });

  await desk.getByRole('button', { name: '‹ 前一天' }).click();
  await expect(desk.getByRole('button', { name: '回到今天' })).toBeVisible();
  // 以前这里断言「昨天一定是 0 单」，理由是「测试库是今天新建的」。
  // 这个前提只在白天成立：全量 e2e 跑过零点时，「昨天」正是刚跑完的那一批，
  // 少说也有好几单，于是这句永远红。翻页对不对，要跟接口返回的**前一天数据**比，
  // 而不是跟一个写死的 0 比。
  // week 是「所选日期往前共 7 天、含当天」，所以前一天 = week 的倒数第二个
  const prev = api.week[api.week.length - 2]!;
  expect(flat(await desk.getByRole('region', { name: '有效订单' }).locator('.stat-big').textContent())).toBe(`${prev.orders} 单`);
  expect(flat(await desk.getByRole('region', { name: '实收营收' }).locator('.stat-big').textContent())).toBe(`RM ${formatMoney(prev.netSen)}`);
  await desk.getByRole('button', { name: '回到今天' }).click();
  await expect(desk.getByRole('button', { name: '后一天 ›' })).toBeDisabled();
});
