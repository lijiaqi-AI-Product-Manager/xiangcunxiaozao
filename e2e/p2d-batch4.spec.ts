// P2 第四批验收：今日售罄 → 储值 + 现金合付 → 按菜品行部分退款（储值先退、其余待柜台退还）→ 两态截图
// 截图存进 docs/screenshots/p2-batch4/ 和 docs/screenshots/two-state/{finished,skeleton}/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { autoConfirm, confirmDialog, emptyCart, ensureMember } from './helpers.ts';
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
  // 老板端的确认是自定义弹窗（不是原生 dialog）。这里不用 autoConfirm：
  // 那个无限等待的循环会和本用例频繁的页面跳转互相干扰，改成在需要时显式点确认。
  const nav = (name: string) => desk.locator('.side').getByRole('link', { name: new RegExp(`^${name}`) });

  await test.step('老板把农家一碗香设为「今日售罄」；顾客端照常显示、置灰、不能加购', async () => {
    await desk.goto(ADMIN);
    await desk.getByLabel('老板密码').fill('e2e-test-password');
    await desk.getByRole('button', { name: '登录' }).click();
    await nav('菜品管理').click();
    // 把招牌跳跳蛙的价格复位成菜单原价 48：别的用例（p2c）会把它改成 52，
    // 本用例后面按「48 + 78 = 126，付 90 储值剩 36」算账。不复位就会算成 130-90=40，
    // 红在一个跟「合付、部分退款」毫无关系的地方。用例自己把要用的前提摆好。
    const frogRow = desk.locator('.dish-table tbody tr', { has: desk.getByRole('cell', { name: '招牌跳跳蛙', exact: true }) });
    const frogPrice = desk.getByLabel('招牌跳跳蛙 价格');
    if ((await frogPrice.inputValue()) !== '48') {
      await frogPrice.fill('48');
      await frogRow.getByRole('button', { name: '保存' }).click();
      await confirmDialog(desk, '确认改价');
    }
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

  // 这个用例原本依赖「上一个用例 p2b 办过会员 100001」——单独跑就是红的（干净库上没有这张卡）。
  // 用例之间不许有这种隐式依赖，这里自己把这张卡准备好、余额正好 90（共享的 ensureMember 见 helpers.ts）。
  await test.step('办一张会员卡，充 90', async () => {
    // 上一个步骤已经在同一台「浏览器上下文」里登录过，令牌还在 localStorage，
    // 这里再走一遍登录表单只会卡住（登录页根本不出现）。直接导航就行。
    await ensureMember(desk, ADMIN, '100001', '90');
  });

  await test.step('会员余额 RM 90，点 RM 126：储值先付 90，剩下 36 现金', async () => {
    await phone.goto(`${CUSTOMER}/#member`);
    const f = phone.getByRole('form', { name: '会员登录' });
    await f.getByLabel('会员号').fill('100001');
    await f.getByLabel('4 位密码').fill('2468');
    await f.getByRole('button', { name: '登录会员' }).click();
    await expect(phone.locator('.balance')).toHaveText('RM 90.00');
    await phone.goto(`${CUSTOMER}/?table=5#order`);
    // 金额断言之前先把车清空：车里多一道菜就会把「剩下 36 现金」算成别的数，
    // 那种红跟合付逻辑毫无关系，纯粹是前置状态不干净。
    await emptyCart(phone);
    await phone.getByRole('button', { name: '加购 招牌跳跳蛙' }).click(); // 48
    await phone.getByRole('tab', { name: '镇店硬菜' }).click();
    await phone.getByRole('button', { name: '加购 脆皮爆汁烤鱼' }).click(); // 78
    await phone.locator('.cartbar-go').click();
    await phone.getByText(/先用储值余额付 RM\s*90\.00/).click();
    await phone.getByText('现金（到柜台）').click();
    await expect(phone.getByRole('status')).toHaveText(/本单：储值\s*RM\s*90\.00\s*\+\s*现金（到柜台）\s*RM\s*36\.00/);
    await phone.getByRole('status').scrollIntoViewIfNeeded();
    await shot(phone, '03-顾客-储值加现金合付');
    await phone.getByRole('button', { name: /提交订单/ }).click();
    await expect(phone.getByText(/储值\s*RM\s*90\.00\s*\+\s*现金（到柜台）\s*RM\s*36\.00/)).toBeVisible();
    await shot(phone, '04-顾客-合付取餐页');
  });

  // 生产路径下，一个桌号只有一次「还没结算的当前单」（提交之后购物车就清了）。
  // 所以本用例分两轮：第一轮点蛙 + 鱼，退一行 → 部分退款；把单收掉后，
  // 第二轮只点蛙、整单退光 → 自动取消。
  // 柜台退还那条路由 p2 其他批次的现金单覆盖（本用例只走储值，退多少全额回储值）。
  await test.step('第一轮：充 180，再点一单蛙 + 鱼并全额走储值，退烤鱼 → 台上标「部分退款」', async () => {
    // 上一单已经把这 90 花掉了，要验「部分退款」得先有余额。
    // 充 180 而不是再充 90：余额给足才能让 126 全额走储值，退款也全额回储值，
    // 这样「退一行 ≠ 整单取消」的判断不会被柜台退款那一套逻辑搅在一起。
    await desk.goto(`${ADMIN}/#members`);
    await desk.getByRole('heading', { name: '会员 100001' }).click();
    const top2 = desk.getByRole('form', { name: '充值' });
    await top2.getByLabel('金额（RM）').fill('180');
    await top2.getByRole('button', { name: '充值' }).click();
    await confirmDialog(desk, /确认充值/);
    await expect(desk.locator('.member-balance strong')).toHaveText('RM 180.00');
    await phone.goto(`${CUSTOMER}/?table=6`);
    await phone.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
    await phone.getByRole('tab', { name: '镇店硬菜' }).click();
    await phone.getByRole('button', { name: '加购 脆皮爆汁烤鱼' }).click();
    await phone.locator('.cartbar-go').click();
    // 余额 180 ≥ 126 时不需要合付，直接选「储值支付」付整单
    await phone.getByText('储值支付', { exact: true }).click();
    await phone.getByRole('button', { name: /提交订单/ }).click();
    // 全额走储值时，取餐页只写支付方式名，不再写「储值 RM …」（那是合付才有的）
    await expect(phone.locator('.hero-status')).toHaveText('待制作');
    await nav('实时订单').click();
    const t = desk.getByRole('region', { name: '新单' }).locator('.ticket', { hasText: '桌 6' }).first();
    await expect(t).toBeVisible();
    await t.getByRole('button', { name: '退款' }).click();
    await t.getByRole('button', { name: '多退一份 脆皮爆汁烤鱼' }).click();
    await t.getByLabel('退款原因').fill('鱼烤焦了');
    await expect(t.getByRole('status')).toHaveText(/退款\s*RM\s*78\.00：原路退回储值\s*RM\s*78\.00/);
    await shot(desk, '05-老板-按行退款');
    // 这里的「确认退款」先弹出二次确认框（退款是要动钱的），要再点一次才真的退
    await t.getByRole('button', { name: '确认退款' }).click();
    await confirmDialog(desk, '确认退款');
    // 还剩跳跳蛙要做 → 不是整单取消，是部分退款。订单台必须单独把它拎出来，
    // 否则高峰期老板记不住这单已经退过钱，「完成」收钱时会按全价收。
    const partial = desk.getByRole('region', { name: '部分退款、还没做完的单' });
    await expect(partial).toContainText('桌 6');
    await expect(partial).toContainText(/还需收\s*RM\s*48\.00/);
    await expect(t.locator('.refund-badge')).toHaveText('部分退款');
    // 同一行不能再退（只点了 1 份）
    await t.getByRole('button', { name: '退款' }).click();
    await expect(t.getByRole('button', { name: '多退一份 脆皮爆汁烤鱼' })).toBeDisabled();
    await t.getByRole('button', { name: '返回' }).click();
    await shot(desk, '06-老板-部分退款');
    // 收掉这一单：后台不留悬着的票，顾客端也不会一直显示「制作中」
    await t.getByRole('button', { name: '开始制作' }).click();
    await desk.getByRole('region', { name: '制作中' }).locator('.ticket').first().getByRole('button', { name: '完成' }).click();
    await expect(desk.getByRole('region', { name: '新单' }).locator('.ticket', { hasText: '桌 6' })).toHaveCount(0);
  });

  await test.step('第二轮：另一桌只点跳跳蛙，整单退光 → 系统自动取消', async () => {
    await phone.goto(`${CUSTOMER}/?table=7`);
    await phone.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
    await phone.locator('.cartbar-go').click();
    // 余额还剩 102（180 - 126 + 78），够付这一单 48 → 直接全额储值
    await phone.getByText('储值支付', { exact: true }).click();
    await phone.getByRole('button', { name: /提交订单/ }).click();
    await expect(phone.locator('.hero-status')).toHaveText('待制作');
    await nav('实时订单').click();
    const only = desk.getByRole('region', { name: '新单' }).locator('.ticket', { hasText: '桌 7' }).first();
    await expect(only).toBeVisible();
    await only.getByRole('button', { name: '退款' }).click();
    await only.getByRole('button', { name: '多退一份 招牌跳跳蛙' }).click();
    await only.getByRole('button', { name: '上错菜' }).click();
    await expect(only.getByRole('status')).toHaveText(/退款\s*RM\s*48\.00：原路退回储值\s*RM\s*48\.00/);
    await only.getByRole('button', { name: '确认退款' }).click();
    await confirmDialog(desk, '确认退款');
    // 全退光 → 客人不用再等，系统自动取消
    await expect(desk.locator('.cancelled')).toContainText('全部菜品已退款');
    await expect(desk.getByRole('region', { name: '新单' }).locator('.ticket', { hasText: '桌 7' })).toHaveCount(0);
  });

  await test.step('顾客看到每一笔退款；储值余额把退的钱加回来了', async () => {
    await phone.goto(`${CUSTOMER}/#pickup`);
    // 最新一单（桌 7 那份蛙）已经全退光 → 整单取消，退款金额就是那一单的 48
    await expect(phone.getByText(/已全额退款：已退\s*RM\s*48\.00/)).toBeVisible();
    await expect(phone.locator('.hero-status')).toHaveText('已取消');
    await expect(phone.getByText('预计约')).toHaveCount(0);
    await shot(phone, '07-顾客-退款明细', true);
    await phone.goto(`${CUSTOMER}/#member`);
    // 180 - 126 + 78 - 48 + 48 = 132：每一笔退款都原路回了储值，一分不差
    await expect(phone.locator('.balance')).toHaveText('RM 132.00');
  });

  await test.step('收尾：农家一碗香恢复在售', async () => {
    await nav('菜品管理').click();
    const seg = desk.getByRole('group', { name: '农家一碗香 状态' });
    await seg.getByRole('button', { name: '在售' }).click();
    await expect(seg.getByRole('button', { name: '在售' })).toHaveAttribute('aria-pressed', 'true');
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
