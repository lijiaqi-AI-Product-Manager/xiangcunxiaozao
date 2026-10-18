// 54号 交付截图：主程序五页（大画态模式，375 宽）+ 桌面宽一张（水印可见性）+ 问题一至五的状态图
// 数据全在一次性测试库里造：测试会员（测试手机号 + 测试密码）、几张现金单，由老板端接口推进状态
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'docs', 'screenshots', 'p4-redesign');
mkdirSync(OUT, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const API = 'http://localhost:8788';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
if (!process.env.BRAND) process.loadEnvFile(resolve(ROOT, '.env'));
const FONTS = resolve(ROOT, 'brands', process.env.BRAND!, 'fonts');
// 书法 / 衬线裁剪字表：截图的同时检查标题标签层每个字都在里面（第二批新页面也覆盖到）
const HAVE = readFileSync(resolve(FONTS, 'brush-subset.chars.txt'), 'utf8') + readFileSync(resolve(FONTS, 'latin-subset.chars.txt'), 'utf8');
const missing: string[] = [];
const scan = async (page: Page, where: string) => {
  const bad = await page.evaluate((chars) => {
    const set = new Set([...chars, ' ', ' ']);
    const out = new Set<string>();
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!getComputedStyle(el).fontFamily.startsWith('"UI Latin"')) continue;
      for (const n of el.childNodes) if (n.nodeType === 3) for (const ch of n.textContent ?? '') if (!set.has(ch)) out.add(ch);
    }
    return [...out];
  }, HAVE);
  if (bad.length) missing.push(`${where}：${bad.join('')}`);
};
const shot = async (page: Page, name: string, fullPage = false) => { await scan(page, name); await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage }); };

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

let token = '';
const admin = async (request: APIRequestContext, path: string, data?: unknown) => {
  if (!token) token = ((await (await request.post(`${API}/api/admin/login`, { data: { password: 'e2e-test-password' } })).json()) as { token: string }).token;
  const r = data === undefined ? await request.get(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } }) : await request.post(`${API}${path}`, { data, headers: { authorization: `Bearer ${token}` } });
  expect(r.ok(), `${path} ${r.status()}`).toBe(true);
  return r.json() as Promise<Record<string, unknown>>;
};
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === 'running' && !['breath', 'cloud', 'now-pulse'].includes((a as CSSAnimation).animationName ?? '')), null, { timeout: 8000 });
  await page.waitForTimeout(150);
}
async function placeOrder(page: Page, dish: string) {
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await page.getByRole('button', { name: `加购 ${dish}` }).click();
  await page.locator('.cartbar-go').click();
  await page.getByText('现金（到柜台）').click();
  await page.getByRole('button', { name: /提交订单/ }).click();
  await expect(page.locator('.hero-no')).toBeVisible();
  const device = await page.evaluate(() => localStorage.getItem('cart-id'));
  const mine = await (await page.request.get(`${API}/api/order/mine?device=${device}`)).json() as { id: string }[];
  return mine[0]!.id;
}

test('五页 + 桌面 + 状态图', async ({ browser, request }) => {
  test.setTimeout(240_000);
  await admin(request, '/api/admin/today', { dishes: ['e06', 'e01', 'v01'] });
  const page = await (await browser.newContext(PHONE)).newPage();

  // ---------- 点单页 ----------
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(page.locator('.deck-card')).toHaveCount(3);
  await settle(page);
  await shot(page, '01-点单-进店空态');
  await page.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
  await page.getByRole('button', { name: '加购 招牌剁椒鱼' }).click();
  await settle(page);
  await shot(page, '02-点单-首菜后托盘');
  await page.evaluate(() => window.scrollTo(0, 760));
  await settle(page);
  await shot(page, '03-点单-收起态横幅卡');
  await page.getByRole('button', { name: '全部分类' }).click();
  await settle(page);
  await shot(page, '04-点单-展开全部分类');
  await page.getByRole('button', { name: '全部分类' }).click();
  await page.getByRole('button', { name: '查看购物车' }).click();
  await settle(page);
  await shot(page, '05-点单-购物车');
  await page.getByRole('button', { name: '清空' }).click();
  await expect(page.locator('.cartbar')).toHaveCount(0);

  // ---------- 详情页：标题组三变体 + 拆开看看 ----------
  for (const v of ['1', '2', '3']) {
    await page.goto(`${CUSTOMER}/?table=8&tier=normal&lockup=${v}#dish/e06`);
    await expect(page.locator('.detail-name')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 300));
    await settle(page);
    await shot(page, `06-详情-标题组变体${v}`);
  }
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#dish/e06`);
  await settle(page);
  await shot(page, '07-详情-首屏');
  await page.getByRole('button', { name: /拆开看看/ }).click();
  await settle(page);
  await shot(page, '08-详情-拆开看看');

  // ---------- 结算 ----------
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await page.getByRole('button', { name: '加购 农家一碗香' }).click();
  await page.locator('.cartbar-go').click();
  await page.getByRole('button', { name: '微辣' }).click();
  await page.getByText('现金（到柜台）').click();
  await settle(page);
  await shot(page, '09-结算', true);
  await page.getByRole('button', { name: /提交订单/ }).click();

  // ---------- 取餐：待制作 → 制作中 → 请取餐；另一单取消 ----------
  await expect(page.locator('.hero-status')).toHaveText('待制作');
  await settle(page);
  await shot(page, '10-取餐-待制作');
  const device = await page.evaluate(() => localStorage.getItem('cart-id'));
  const [latest] = await (await page.request.get(`${API}/api/order/mine?device=${device}`)).json() as { id: string }[];
  await admin(request, `/api/admin/orders/${latest!.id}/status`, { to: 'cooking' });
  await page.reload();
  await expect(page.locator('.hero-status')).toHaveText('制作中');
  await settle(page);
  await shot(page, '11-取餐-制作中');
  await admin(request, `/api/admin/orders/${latest!.id}/status`, { to: 'done' });
  await page.reload();
  await expect(page.locator('.hero-status')).toHaveText('已完成');
  await settle(page);
  await shot(page, '12-取餐-请取餐', true);
  const other = await placeOrder(page, '凉拌黄瓜');
  await admin(request, `/api/admin/orders/${other}/status`, { to: 'cancelled', reason: '客人临时离开' });
  await page.reload();
  await expect(page.locator('.hero-status')).toHaveText('已取消');
  await settle(page);
  await shot(page, '13-取餐-已取消整卡变灰', true);

  // ---------- 会员：登录前 / 登录后 ----------
  const m = await admin(request, '/api/admin/members', { phone: '0100000123', pin: '2468' }) as { id: string; memberNo: string };
  await admin(request, `/api/admin/members/${m.id}/recharge`, { amountSen: 20000, note: '测试充值', requestId: 'shots-recharge-0001' });
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#member`);
  await settle(page);
  await shot(page, '14-会员-登录前');
  const f = page.getByRole('form', { name: '会员登录' });
  await f.getByLabel('会员号').fill(m.memberNo);
  await f.getByLabel('4 位密码').fill('2468');
  await f.getByRole('button', { name: '登录会员' }).click();
  await expect(page.locator('.balance')).toBeVisible();
  await settle(page);
  await shot(page, '15-会员-会员卡', true);

  // ---------- 我的 ----------
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#me`);
  await expect(page.getByRole('heading', { name: `会员 ${m.memberNo}` })).toBeVisible();
  await settle(page);
  await shot(page, '16-我的');
  await shot(page, '16b-我的-整页', true);

  // ---------- 桌面宽：水印可见 ----------
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await desk.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(desk.locator('.deck-card')).toHaveCount(3);
  await settle(desk);
  await desk.screenshot({ path: resolve(OUT, '17-桌面-点单.png') });
  await admin(request, '/api/admin/today', { dishes: [] });
  expect(missing, '书法字体回退').toEqual([]);
});
