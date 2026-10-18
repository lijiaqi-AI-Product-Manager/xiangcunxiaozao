// P2 第四批验收：今日售罄 → 储值 + 现金合付 → 按菜品行部分退款（储值先退、其余待柜台退还）→ 两态截图
// 截图存进 docs/screenshots/p2-batch4/ 和 docs/screenshots/two-state/{finished,skeleton}/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p2-batch4');
const TWO = resolve(ROOT, 'docs', 'screenshots', 'two-state');
for (const d of [SHOTS, resolve(TWO, 'finished'), resolve(TWO, 'skeleton')]) mkdirSync(d, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage });

test('第四批：售罄、合付、部分退款', async ({ browser }) => {
  test.setTimeout(240_000);
  const phone = await (await browser.newContext(PHONE)).newPage();
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  desk.on('dialog', (d) => void d.accept());
  const nav = (name: string) => desk.locator('.side').getByRole('link', { name: new RegExp(`^${name}`) });

  await test.step('老板把农家一碗香设为「今日售罄」；顾客端照常显示、置灰、不能加购', async () => {
    await desk.goto(ADMIN);
    await desk.getByLabel('老板密码').fill('e2e-test-password');
    await desk.getByRole('button', { name: '登录' }).click();
    await nav('菜品管理').click();
    const seg = desk.getByRole('group', { name: '农家一碗香 状态' });
    await seg.getByRole('button', { name: '今日售罄' }).click();
    await expect(seg.getByRole('button', { name: '今日售罄' })).toHaveAttribute('aria-pressed', 'true');
    await desk.getByLabel('搜索菜品').fill('农家');
    await shot(desk, '01-老板-三态切换');
    await desk.getByLabel('搜索菜品').fill('');
    await phone.goto(`${CUSTOMER}/?table=5`);
    await phone.getByRole('tab', { name: '家常小炒' }).click();
    const dish = phone.getByRole('article', { name: '农家一碗香，今日售罄' });
    await expect(dish).toBeVisible();
    await expect(dish.getByRole('button')).toHaveCount(0); // 没有加购按钮
    await dish.scrollIntoViewIfNeeded();
    await shot(phone, '02-顾客-今日售罄');
  });

  await test.step('会员余额 RM 90，点 RM 130：储值先付 90，剩下 40 现金', async () => {
    await phone.goto(`${CUSTOMER}/#member`);
    const f = phone.getByRole('form', { name: '会员登录' });
    await f.getByLabel('会员号').fill('100001');
    await f.getByLabel('4 位密码').fill('2468');
    await f.getByRole('button', { name: '登录会员' }).click();
    await expect(phone.locator('.balance')).toHaveText('RM 90');
    await phone.goto(`${CUSTOMER}/?table=5#order`);
    await phone.getByRole('button', { name: '加购 招牌跳跳蛙' }).click(); // 52（第三批改过价）
    await phone.getByRole('tab', { name: '镇店硬菜' }).click();
    await phone.getByRole('button', { name: '加购 脆皮爆汁烤鱼' }).click(); // 78
    await phone.locator('.cartbar-go').click();
    await phone.getByText('先用储值余额付 RM 90').click();
    await phone.getByText('现金（到柜台）').click();
    await expect(phone.getByRole('status')).toHaveText('本单：储值 RM 90 + 现金（到柜台） RM 40');
    await phone.getByRole('status').scrollIntoViewIfNeeded();
    await shot(phone, '03-顾客-储值加现金合付');
    await phone.getByRole('button', { name: /提交订单/ }).click();
    await expect(phone.getByText('储值 RM 90 + 现金（到柜台） RM 40')).toBeVisible();
    await shot(phone, '04-顾客-合付取餐页');
  });

  await test.step('老板按菜品行退款：先退跳跳蛙（全退回储值），再退烤鱼（储值剩 38 + 柜台退 40）', async () => {
    await nav('实时订单').click();
    const t = desk.locator('.ticket', { hasText: '储值 RM 90 + 现金（到柜台） RM 40' });
    await t.getByRole('button', { name: '退款' }).click();
    await t.getByRole('button', { name: '多退一份 招牌跳跳蛙' }).click();
    await t.getByRole('button', { name: '上错菜' }).click();
    await expect(t.getByRole('status')).toHaveText('退款 RM 52：原路退回储值 RM 52');
    await shot(desk, '05-老板-按行退款');
    await t.getByRole('button', { name: '确认退款' }).click();
    await expect(t.locator('.refund-badge')).toHaveText('部分退款');
    // 同一行不能再退（只点了 1 份）
    await t.getByRole('button', { name: '退款' }).click();
    await expect(t.getByRole('button', { name: '多退一份 招牌跳跳蛙' })).toBeDisabled();
    await t.getByRole('button', { name: '多退一份 脆皮爆汁烤鱼' }).click();
    await t.getByLabel('退款原因').fill('鱼烤焦了');
    await expect(t.getByRole('status')).toHaveText('退款 RM 78：原路退回储值 RM 38，柜台退还 RM 40');
    await t.getByRole('button', { name: '确认退款' }).click();
    // 还没做的单全部菜都退了 → 自动取消，后厨看板上不再出现
    await expect(desk.locator('.cancelled')).toContainText('全部菜品已退款');
    // 前面几批取消的现金单也在这里等处理（已退还 / 未收款无需退），所以按金额找这一条
    const row = desk.getByRole('region', { name: '待柜台退还' }).locator('.counter-row', { hasText: 'RM 40' });
    await expect(row).toBeVisible();
    await shot(desk, '06-老板-待柜台退还');
    await row.getByRole('button', { name: '已退还' }).click();
    await expect(row).toHaveCount(0);
  });

  await test.step('顾客看到每一笔退款；储值余额回到 RM 90', async () => {
    await phone.goto(`${CUSTOMER}/#pickup`);
    await expect(phone.getByText('已全额退款：已退 RM 130')).toBeVisible();
    await expect(phone.locator('.hero-status')).toHaveText('已取消');
    await expect(phone.getByText('预计约')).toHaveCount(0);
    await shot(phone, '07-顾客-退款明细', true);
    await phone.goto(`${CUSTOMER}/#member`);
    await expect(phone.locator('.balance')).toHaveText('RM 90');
  });

  await test.step('收尾：农家一碗香恢复在售；招牌跳跳蛙改回菜单原价 48（第三批为合付算账改成了 52）', async () => {
    await nav('菜品管理').click();
    await desk.getByRole('group', { name: '农家一碗香 状态' }).getByRole('button', { name: '在售' }).click();
    const frog = desk.locator('.dish-table tbody tr', { has: desk.getByRole('cell', { name: '招牌跳跳蛙', exact: true }) });
    await desk.getByLabel('招牌跳跳蛙 价格').fill('48');
    await frog.getByRole('button', { name: '保存' }).click();
    await expect(frog).not.toContainText('菜单原价');
  });
});

/** 26号两态并行：顾客端每个页面，成品态 + 骨架态各一张 */
async function captureSkin(browser: Browser, skin: 'finished' | 'skeleton') {
  const page = await (await browser.newContext(PHONE)).newPage();
  const dir = resolve(TWO, skin);
  await page.goto(`${CUSTOMER}/?table=8&skin=${skin}`);
  await expect(page.getByRole('heading', { name: '招牌跳跳蛙' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(dir, '1-点单.png') });
  await page.goto(`${CUSTOMER}/?table=8#pickup`);
  await expect(page.getByRole('heading', { name: '还没有订单' })).toBeVisible();
  await page.screenshot({ path: resolve(dir, '2-取餐-空状态.png') });
  await page.goto(`${CUSTOMER}/?table=8#order`);
  await page.getByRole('button', { name: '加购 凉拌木耳' }).click();
  await page.locator('.cartbar-go').click();
  await expect(page.getByRole('heading', { name: '确认订单' })).toBeVisible();
  await page.screenshot({ path: resolve(dir, '3-结算.png') });
  await page.getByText('现金（到柜台）').click();
  await page.getByRole('button', { name: /提交订单/ }).click();
  await expect(page.locator('.hero-no')).toBeVisible();
  await page.screenshot({ path: resolve(dir, '4-取餐号.png') });
  await page.goto(`${CUSTOMER}/?table=8#member`);
  await expect(page.getByRole('form', { name: '会员登录' })).toBeVisible();
  await page.screenshot({ path: resolve(dir, '5-会员.png') });
  await page.goto(`${CUSTOMER}/?table=8#me`);
  await expect(page.getByRole('heading', { name: '关于这顿饭' })).toBeVisible();
  await page.screenshot({ path: resolve(dir, '6-我的.png') });
  // 骨架态必须没有任何品牌元素（26号规则1）
  if (skin === 'skeleton') {
    await page.goto(`${CUSTOMER}/?table=8#order`);
    await expect(page.getByRole('heading', { name: '招牌跳跳蛙' })).toBeVisible();
    expect(await page.locator('.seal').count()).toBe(0);
    expect(await page.getByText('湘', { exact: false }).locator('xpath=ancestor::div[@aria-hidden="true"]').count()).toBe(0);
  }
}

test('两态并行截图（成品态 + 骨架态）', async ({ browser }) => {
  test.setTimeout(180_000);
  await captureSkin(browser, 'finished');
  await captureSkin(browser, 'skeleton');
});
