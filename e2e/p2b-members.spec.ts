// P2 第二批验收：办卡 → 充值（防重复）→ 调整（必须写原因）→ 顾客登录看余额 → 储值下单扣款
// → 余额不足不能选 → 老板取消原路退回 → 对账 → 打印流水。截图存进 docs/screenshots/p2-batch2/
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import { autoConfirm } from './helpers.ts';
const SHOTS = resolve(import.meta.dirname, '..', 'docs', 'screenshots', 'p2-batch2');
mkdirSync(SHOTS, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage });

test('会员与储值', async ({ browser }) => {
  const phone = await (await browser.newContext(PHONE)).newPage();
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  autoConfirm(desk); // 老板端的确认是自定义弹窗，不是原生 dialog
  const balance = desk.locator('.member-balance strong');
  const panel = desk.locator('.member-panel');

  await test.step('老板办卡', async () => {
    await desk.goto(ADMIN);
    await desk.getByLabel('老板密码').fill('e2e-test-password');
    await desk.getByRole('button', { name: '登录' }).click();
    await desk.getByRole('link', { name: '会员管理' }).click();
    await desk.getByRole('button', { name: '新办会员卡' }).click();
    const form = desk.getByRole('form', { name: '新办会员卡' });
    await form.getByLabel('手机号（可选）').fill('0123456789');
    await form.getByLabel('顾客设定的 4 位密码').fill('2468');
    await form.getByLabel('再输一次').fill('2468');
    await form.getByRole('button', { name: '办卡' }).click();
    await expect(desk.getByRole('heading', { name: '会员 100001' })).toBeVisible();
    await shot(desk, '01-老板-办卡完成');
  });

  await test.step('充值 RM 100：连点两下只入账一次', async () => {
    const f = desk.getByRole('form', { name: '充值' });
    await f.getByLabel('金额（RM）').fill('100');
    await f.getByLabel('备注（可选）').fill('柜台现金');
    await f.getByRole('button', { name: '充值' }).dblclick();
    await expect(balance).toHaveText('RM 100.00');
    await expect(panel.locator('tbody tr')).toHaveCount(1);
    await shot(desk, '02-老板-充值后');
  });

  await test.step('调整余额：不写原因不让提交；写了原因才扣', async () => {
    const f = desk.getByRole('form', { name: '余额调整' });
    await f.getByLabel('金额（RM）').fill('-10');
    await f.getByRole('button', { name: '余额调整' }).click();
    await expect(f.getByRole('alert')).toHaveText('调整余额必须写原因');
    await f.getByLabel('原因（必填）').fill('多充冲回');
    await f.getByRole('button', { name: '余额调整' }).click();
    await expect(balance).toHaveText('RM 90.00');
    await shot(desk, '03-老板-调整后');
  });

  await test.step('顾客登录会员：密码错有提示，对了看到余额和流水（手机号打码）', async () => {
    await phone.goto(`${CUSTOMER}/?table=3#member`);
    const f = phone.getByRole('form', { name: '会员登录' });
    await f.getByLabel('会员号').fill('100001');
    await f.getByLabel('4 位密码').fill('1111');
    await f.getByRole('button', { name: '登录会员' }).click();
    await expect(f.getByRole('alert')).toHaveText('会员号或密码不对，还可以再试 4 次');
    await shot(phone, '04-顾客-会员密码错误');
    await f.getByLabel('4 位密码').fill('2468');
    await f.getByRole('button', { name: '登录会员' }).click();
    await expect(phone.locator('.balance')).toHaveText('RM 90.00');
    await expect(phone.getByText('012****789')).toBeVisible();
    await shot(phone, '05-顾客-会员余额与流水', true);
  });

  await test.step('储值下单：结算页显示余额，下单即扣', async () => {
    await phone.goto(`${CUSTOMER}/?table=3#order`);
    await phone.getByRole('button', { name: '加购 农家一碗香' }).click();
    await phone.locator('.cartbar-go').click();
    await expect(phone.getByText(/余额\s*RM\s*90\.00/)).toBeVisible();
    await phone.getByText('储值支付').click();
    await phone.getByRole('button', { name: /提交订单/ }).scrollIntoViewIfNeeded();
    await shot(phone, '06-顾客-储值支付结算');
    await phone.getByRole('button', { name: /提交订单/ }).click();
    await expect(phone.locator('.hero-status')).toHaveText('待制作');
    await phone.goto(`${CUSTOMER}/#member`);
    await expect(phone.locator('.balance')).toHaveText('RM 65.00');
    await shot(phone, '07-顾客-扣款后余额', true);
  });

  await test.step('余额不够时储值支付不能选', async () => {
    await phone.goto(`${CUSTOMER}/#order`);
    await phone.getByRole('tab', { name: '镇店硬菜' }).click();
    await phone.getByRole('button', { name: '加购 脆皮爆汁烤鱼' }).click();
    await phone.locator('.cartbar-go').click();
    await expect(phone.getByText(/余额不足（RM\s*65\.00）/)).toBeVisible();
    await expect(phone.getByRole('radio', { name: /储值支付/ })).toBeDisabled();
    await phone.getByText(/余额不足（RM\s*65\.00）/).scrollIntoViewIfNeeded();
    await shot(phone, '08-顾客-余额不足');
    await phone.goto(`${CUSTOMER}/#order`);
    await phone.getByRole('button', { name: '查看购物车' }).click();
    await phone.getByRole('button', { name: '清空' }).click();
  });

  await test.step('老板取消储值订单 → 原路退回', async () => {
    await desk.getByRole('link', { name: '实时订单' }).click();
    const ticket = desk.locator('.ticket', { hasText: '储值支付' });
    await expect(ticket).toBeVisible();
    await ticket.getByRole('button', { name: '取消' }).click();
    await expect(ticket.getByText(/取消后 RM\s*25\.00\s*会自动退回会员余额/)).toBeVisible();
    await ticket.getByLabel('取消原因').fill('食材用完了');
    await ticket.getByRole('button', { name: '确认取消' }).click();
    await expect(desk.getByText(/已取消 \d+ 单/)).toBeVisible();
    await phone.goto(`${CUSTOMER}/#pickup`);
    await expect(phone.getByText(/储值 RM\s*25\.00\s*已原路退回会员余额/)).toBeVisible();
    await shot(phone, '09-顾客-取消后退回');
    await phone.goto(`${CUSTOMER}/#member`);
    await expect(phone.locator('.balance')).toHaveText('RM 90.00');
    await shot(phone, '10-顾客-退回后余额', true);
  });

  await test.step('老板查流水、对账、打印', async () => {
    await desk.getByRole('link', { name: '会员管理' }).click();
    await desk.getByRole('cell', { name: '100001' }).click();
    await expect(panel.locator('tbody tr')).toHaveCount(4); // 充值、调整、消费、退款
    // 日期必须是吉隆坡当天（曾经误用 UTC 日期，凌晨 0–8 点会显示成前一天）
    const todayKL = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    await expect(panel.locator('tbody tr').first()).toContainText(todayKL);
    await desk.getByRole('button', { name: '立即对账' }).click();
    await expect(desk.getByText(/对账正常：1 位会员/)).toBeVisible();
    await shot(desk, '11-老板-流水与对账');
    await desk.emulateMedia({ media: 'print' });
    await shot(desk, '12-老板-打印流水预览', true);
    await desk.emulateMedia({ media: 'screen' });
  });
});
