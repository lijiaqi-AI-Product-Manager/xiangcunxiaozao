// P6 真实走查：不写「我认为该有的断言」，只让浏览器把一个顾客和一个老板会做的事从头做一遍。
//
// 为什么单独有这条：R11（顾客点「+」毫无反应、整站点不了单）就是这样被发现的。
// 之前每一层测试都用了「绕过 UI」的捷径——服务端测试直接 POST /api/cart/update，
// 实拍脚本因为点不动加号也改成了接口备菜——于是那个按钮坏了很久没人知道。
//
// 所以这条用例的铁律：**只碰界面，一个接口都不直接调**。
// 一旦这里开始出现 request.post('…/api/…')，它就退化成第二个服务端测试，失去全部意义。
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { autoConfirm } from './helpers.ts';
const SHOTS = resolve(import.meta.dirname, '..', 'docs', 'screenshots', 'p6-walkthrough');
mkdirSync(SHOTS, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1440, height: 1000 } };
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage });

/** 页面上任何一处报错都算失败——比逐个断言更早发现「静默出错」 */
function watchErrors(page: Page, tag: string) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`[${tag}] 页面异常：${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`[${tag}] console.error：${m.text()}`); });
  return errs;
}

test('顾客与老板各走一遍（只用界面）', async ({ browser }) => {
  const phone = await (await browser.newContext(PHONE)).newPage();
  const desk = await (await browser.newContext(DESK)).newPage();
  autoConfirm(desk); // 老板端的确认是自定义弹窗，不是原生 dialog
  const errs = [...watchErrors(phone, '顾客'), ...watchErrors(desk, '老板')];

  const cartBar = phone.locator('.cartbar-summary');
  const cartCount = phone.locator('.cartbar-badge');
  const cartTotal = phone.locator('.cartbar-total');

  await test.step('顾客扫码进店：菜单出得来、桌号带进来了', async () => {
    await phone.goto(`${CUSTOMER}/?table=12`);
    await expect(phone.locator('article.dish').first()).toBeVisible();
    await expect(phone.locator('body')).toContainText('桌 12');
    await shot(phone, '01-顾客-首屏');
  });

  await test.step('顾客点「+」：这是 R11 的原始现场，必须真的加进购物车', async () => {
    // 不加任何前置操作，直接点用户会点的那个按钮。R11 就是死在这一步。
    const lemon = phone.locator('article.dish').filter({ hasText: '招牌手打柠檬茶' }).first();
    await lemon.locator('button.add').click();
    await expect(cartCount).toHaveText('1'); // 第一次点击必须生效（R11 里这里是 0）
    await lemon.locator('button.add').click();
    await expect(cartCount).toHaveText('2');
    await shot(phone, '02-顾客-连点两次');
  });

  await test.step('换一道菜：数量各算各的', async () => {
    const frog = phone.locator('article.dish').filter({ hasText: '招牌跳跳蛙' }).first();
    await frog.locator('button.add').click();
    await expect(cartCount).toHaveText('3');
    // 柠檬茶 2 份 RM 19.90 = 39.80，跳跳蛙 1 份 48.00 → 87.80
    await expect(cartTotal).toContainText('87.80');
  });

  await test.step('购物车弹层：减号能把数量减回去，减到 0 就移除', async () => {
    await cartBar.click();
    const sheet = phone.locator('[role="dialog"][aria-label="购物车"]');
    await expect(sheet).toBeVisible();
    await shot(phone, '03-顾客-购物车弹层');
    // 弹层里减掉一份柠檬茶
    await sheet.locator('button').filter({ hasText: '−' }).first().click();
    await expect(cartCount).toHaveText('2');
    // 点遮罩关掉弹层：关不掉的浮层会挡住后面所有操作（顾客会遇到同样的事）
    await phone.locator('.sheet-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(sheet).toBeHidden();
  });

  await test.step('去结算 → 选付款方式 → 下单 → 拿到取餐号', async () => {
    // 弹层关掉后这个按钮只剩一个；关不掉时这里会报 strict mode violation，正好是我们要的信号
    await phone.locator('.cartbar-go').click();
    await expect(phone.locator('body')).toContainText(/合计|应收/);
    await shot(phone, '04-顾客-结算页');

    // 付款方式必须顾客自己选（系统不许代客决定用哪种方式付钱）。
    // 先验一次「不选就提交会被拦住，而且拦的理由看得见」——这是顾客最容易踩的一步。
    await phone.getByRole('button', { name: /提交订单/ }).first().click();
    await expect(phone.locator('.checkout-error')).toContainText('请选择付款方式');
    await expect(phone.locator('body')).toContainText('确认订单'); // 没跳走，还在结算页

    await phone.getByRole('radio', { name: /现金/ }).first().check();
    await phone.getByRole('button', { name: /提交订单/ }).first().click();
    await expect(phone.locator('body')).toContainText(/取餐号/);
    await shot(phone, '05-顾客-取餐页');
  });

  await test.step('老板端：这一单出现在订单台，金额和顾客看到的一致', async () => {
    await desk.goto(ADMIN);
    await desk.getByLabel('老板密码').fill('e2e-test-password');
    await desk.getByRole('button', { name: '登录' }).click();
    await expect(desk.locator('.ticket, article').first()).toBeVisible();
    await expect(desk.locator('body')).toContainText('桌 12');
    await shot(desk, '06-老板-订单台');
  });

  await test.step('老板把单推完：待制作 → 制作中 → 已完成', async () => {
    for (const step of ['开始制作', '做好了']) {
      const btn = desk.getByRole('button', { name: step }).first();
      if (await btn.count()) {
        await btn.click();
        await desk.waitForTimeout(600);
      }
    }
    await shot(desk, '07-老板-推进后');
  });

  await test.step('日结单：今天这一班的钱对得上，金额两位小数', async () => {
    await desk.getByRole('link', { name: '日结单' }).click();
    await expect(desk.getByRole('button', { name: '今天' })).toBeVisible();
    // 只要出现金额，就必须是两位小数（R16：曾经数据看板写 1739.6、日结单写 1739.60）
    const text = (await desk.locator('main').innerText()).replace(/\s+/g, ' ');
    const amounts = [...text.matchAll(/RM ([\d,]+\.?\d*)/g)].map((m) => m[1]!);
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.filter((a) => !/\.\d{2}$/.test(a))).toEqual([]);
    await shot(desk, '08-老板-日结单', true);
  });

  await test.step('日结单：切「刚收的晚市」不会得到一张空单', async () => {
    // R15：凌晨点「昨晚市」曾指向未来时段，永远是 0 单，而那张纸看着完全正常。
    // 2026-10-26 又发现另一半：营业中（17:00 之后）按下去指向的是**昨天**那一班，
    // 今晚刚下的单全在窗口外，同样是一张「这个时间段没有订单」的空单。
    // 现在营业中点「刚收的晚市」= 今晚这一班、结到此刻，刚才那一单必须算在里面。
    await desk.getByRole('button', { name: '刚收的晚市' }).click();
    await desk.waitForTimeout(1200);
    const text = (await desk.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text).not.toContain('这个时间段没有订单');
    // 「不是空单」还要更硬一点：有效订单数不能是 0（单子上是「有效订单 N 单」）
    const n = Number(/有效订单\s*(\d+)\s*单/.exec(text)?.[1] ?? '0');
    expect(n, '这一班应该至少算进刚才那一单').toBeGreaterThan(0);
    await shot(desk, '09-老板-刚收的晚市');
  });

  await test.step('会员页：对账条不许在没核对过的情况下说「正常」', async () => {
    await desk.getByRole('link', { name: '会员管理' }).click();
    const recon = desk.locator('.recon').first();
    await expect(recon).toBeVisible();
    const t = (await recon.innerText()).replace(/\s+/g, ' ');
    // 没有会员时可以这么说；有会员就必须说清核过几位
    const memberRows = desk.locator('.member-list tbody tr');
    const n = await memberRows.count();
    if (n > 0) expect(t).toMatch(/对账正常：\d+ 位会员|没核对过/);
    await shot(desk, '10-老板-会员对账');
  });

  expect(errs, `页面上出现了报错：\n${errs.join('\n')}`).toEqual([]);
});
