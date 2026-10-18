// P2 第一批验收：顾客下单 → 老板实时收单 → 推进状态 → 顾客看到完成 → 再来一单
// 每一步截图存进 docs/screenshots/p2-batch1/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = resolve(import.meta.dirname, '..', 'docs', 'screenshots', 'p2-batch1');
mkdirSync(SHOTS, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const shot = (page: Page, name: string) => page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
/** 旧系统出过「桌undefined / Invalid Date」：每个关键页面都检查一遍 */
async function assertNoBrokenText(page: Page) {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/undefined|Invalid Date|NaN|null/);
}
const ticket = (page: Page, no: string) => page.locator('.ticket', { has: page.locator('.ticket-no', { hasText: no }) });

test('点单闭环', async ({ browser }) => {
  const phone = await (await browser.newContext(PHONE)).newPage();
  const phone2 = await (await browser.newContext(PHONE)).newPage();
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();

  await test.step('顾客扫码进店：桌号、等待时长', async () => {
    await phone.goto(`${CUSTOMER}/?table=12`);
    await expect(phone.getByText('桌 12')).toBeVisible();
    await expect(phone.getByText('当前等待约')).toBeVisible();
    await shot(phone, '01-顾客-点单页');
    await assertNoBrokenText(phone);
  });

  await test.step('分类导航：不切半个字；选中的分类完整显示', async () => {
    await phone.getByRole('button', { name: '全部分类' }).click();
    await shot(phone, '01b-顾客-全部分类展开');
    await phone.getByRole('group', { name: '全部分类' }).getByRole('button', { name: '手打柠檬茶' }).click();
    await expect(phone.getByRole('tab', { name: '手打柠檬茶' })).toHaveAttribute('aria-selected', 'true');
    // 选中项必须整个落在「不透明」区域：左边渐隐 28px 之外、右边渐隐（距右 96px）之前
    const box = await phone.evaluate(() => {
      const tab = document.querySelector('[role=tab][aria-selected=true]')!.getBoundingClientRect();
      const bar = document.querySelector('.catbar')!.getBoundingClientRect();
      return { left: tab.left - bar.left, right: bar.right - tab.right };
    });
    expect(box.left).toBeGreaterThanOrEqual(28);
    expect(box.right).toBeGreaterThanOrEqual(96);
    await shot(phone, '01c-顾客-选中手打柠檬茶');
    await phone.getByRole('tab', { name: '全部' }).click();
  });

  await test.step('加购：连点两下只算两份；米饭按份点', async () => {
    await phone.getByRole('button', { name: '加购 招牌跳跳蛙' }).dblclick();
    await expect(phone.getByLabel('招牌跳跳蛙 已选 2 份')).toBeVisible();
    await phone.getByRole('tab', { name: '主食' }).click();
    await phone.getByRole('button', { name: '加购 米饭' }).click();
    await expect(phone.locator('.cartbar-badge')).toHaveText('3');
    await expect(phone.locator('.cartbar-total')).toHaveText('RM 98');
    await shot(phone, '02-顾客-购物车条');
    await phone.getByRole('button', { name: '查看购物车' }).click();
    await expect(phone.getByRole('dialog', { name: '购物车' })).toBeVisible();
    await shot(phone, '03-顾客-购物车');
    await phone.getByRole('dialog', { name: '购物车' }).getByRole('button', { name: /去结算/ }).click();
  });

  await test.step('结算：只校验付款方式和桌号；辣度写进备注', async () => {
    await expect(phone.getByRole('heading', { name: '确认订单' })).toBeVisible();
    await shot(phone, '04-顾客-结算页');
    await phone.getByRole('button', { name: /提交订单/ }).click();
    await expect(phone.getByRole('alert')).toHaveText('请选择付款方式');
    await phone.getByRole('button', { name: '微辣' }).click();
    await phone.getByText('现金（到柜台）').click();
    await expect(phone.getByText('备注将写入：辣度：微辣')).toBeVisible();
    await phone.getByRole('button', { name: /提交订单/ }).scrollIntoViewIfNeeded();
    await shot(phone, '05-顾客-已选辣度与付款');
    await phone.getByRole('button', { name: /提交订单/ }).click();
  });

  await test.step('取餐号 001，状态待制作', async () => {
    await expect(phone.locator('.hero-no')).toHaveText('001');
    await expect(phone.locator('.hero-status')).toHaveText('待制作');
    await shot(phone, '06-顾客-取餐号');
    await assertNoBrokenText(phone);
  });

  await test.step('老板登录（错误密码有提示）', async () => {
    await desk.goto(ADMIN);
    await desk.getByLabel('老板密码').fill('wrong-password');
    await desk.getByRole('button', { name: '登录' }).click();
    await expect(desk.getByRole('alert')).toContainText('密码不对');
    await shot(desk, '07-老板-密码错误提示');
    await desk.getByLabel('老板密码').fill('e2e-test-password');
    await desk.getByRole('button', { name: '登录' }).click();
    await expect(desk.getByText('实时连接正常')).toBeVisible();
    await expect(ticket(desk, '001')).toBeVisible();
    await expect(ticket(desk, '001')).toContainText('备注：辣度：微辣');
    await shot(desk, '08-老板-看板-还没点开始接单');
    await desk.getByRole('button', { name: /开始接单/ }).click();
    await expect(desk.getByText('接单中')).toBeVisible();
  });

  await test.step('另一桌下单，老板端不刷新就收到（实时推送）', async () => {
    await phone2.goto(`${CUSTOMER}/?table=7`);
    await phone2.getByRole('button', { name: '加购 农家一碗香' }).click();
    await phone2.locator('.cartbar-go').click();
    await phone2.getByText("Touch 'n Go").click();
    await phone2.getByRole('button', { name: /提交订单/ }).click();
    await expect(phone2.locator('.hero-no')).toHaveText('002');
    await expect(desk.locator('.ticket.flash .ticket-no')).toHaveText('002');
    await expect(desk.getByText('（自动：前面 2 单）')).toBeVisible();
    await shot(desk, '09-老板-新单实时出现');
  });

  await test.step('老板推进状态：开始制作 → 完成；另一单取消（必须写原因）', async () => {
    await ticket(desk, '001').getByRole('button', { name: '开始制作' }).click();
    await expect(desk.getByRole('region', { name: '制作中' }).locator('.ticket-no')).toHaveText('001');
    await desk.getByRole('region', { name: '制作中' }).getByRole('button', { name: '完成' }).click();
    await expect(desk.getByRole('region', { name: '已完成' }).locator('.ticket-no')).toHaveText('001');
    await ticket(desk, '002').getByRole('button', { name: '取消' }).click();
    await ticket(desk, '002').getByLabel('取消原因').fill('客人临时离开');
    await ticket(desk, '002').getByRole('button', { name: '确认取消' }).click();
    await expect(desk.getByText('已取消 1 单')).toBeVisible();
    await expect(desk.getByText('（自动：前面 0 单）')).toBeVisible(); // 等待时长跟着订单变化刷新
    await shot(desk, '10-老板-推进状态后');
    await assertNoBrokenText(desk);
  });

  await test.step('顾客看到「已完成」；另一桌看到取消原因', async () => {
    await phone.goto(`${CUSTOMER}/#pickup`);
    await expect(phone.locator('.hero-status')).toHaveText('已完成');
    await shot(phone, '11-顾客-已完成');
    await phone2.goto(`${CUSTOMER}/#pickup`);
    await expect(phone2.getByText('原因：客人临时离开')).toBeVisible();
    await shot(phone2, '12-另一桌-已取消');
  });

  await test.step('再来一单：上一单整单进购物车', async () => {
    await phone.goto(`${CUSTOMER}/#me`);
    await phone.getByRole('button', { name: '再来一单' }).first().click();
    await expect(phone.locator('.cartbar-badge')).toHaveText('3');
    await expect(phone.getByRole('status')).toHaveText('已把上一单加入购物车');
    await expect(phone.getByRole('button', { name: /招牌跳跳蛙/ }).first()).toBeVisible();
    await shot(phone, '13-顾客-再来一单');
  });
});
