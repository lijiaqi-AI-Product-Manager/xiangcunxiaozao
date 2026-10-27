/**
 * e2e 公共小工具：老板端的「确认」弹窗。
 *
 * 为什么需要它：老板端所有危险操作（退款、取消、充值、改价…）都会 await askConfirm()，
 * 弹的是自定义对话框（`.confirm-box`），不是浏览器原生 confirm()。
 * 以前测试里写 `page.on('dialog', d => d.accept())` 是**完全无效**的——原生对话框根本不会出现，
 * 于是操作被卡在等待确认上，表现为「点了没反应」，很容易被误判成产品 bug。
 */
import { expect, type Page } from '@playwright/test';

/** 点确认弹窗里的确认按钮（按钮文字各页面不同，这里按 role 找那个 primary/danger 的按钮） */
export async function confirmDialog(page: Page, buttonText?: string | RegExp): Promise<void> {
  const box = page.locator('.confirm-box');
  await expect(box).toBeVisible();
  const btn = buttonText
    ? box.getByRole('button', { name: buttonText })
    : box.locator('.confirm-actions .btn.primary, .confirm-actions .btn.danger');
  await btn.first().click();
  await expect(box).toHaveCount(0);
}

/** 取消弹窗 */
export async function cancelDialog(page: Page): Promise<void> {
  const box = page.locator('.confirm-box');
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: '取消' }).click();
  await expect(box).toHaveCount(0);
}

/**
 * 让这个页面「所有确认弹窗都自动点确认」。
 *
 * 用它代替老的 `page.on('dialog', d => d.accept())`——那行代码从来没起过作用，
 * 因为老板端用的是自定义弹窗。返回一个取消订阅的函数（测试结束时会随 page 一起销毁，不调也行）。
 *
 * 注意：只适合「走完整流程」的用例。要验证「点取消就不该生效」这种行为的，
 * 请显式用 confirmDialog / cancelDialog。
 */
export function autoConfirm(page: Page): void {
  void (async () => {
    for (;;) {
      try {
        const btn = page.locator('.confirm-box .confirm-actions .btn.primary, .confirm-box .confirm-actions .btn.danger').first();
        await btn.waitFor({ state: 'visible', timeout: 0 });
        await btn.click({ timeout: 2000 }).catch(() => undefined);
      } catch {
        return; // 页面关了就退出
      }
    }
  })();
}

/**
 * 确保测试库里有这张会员卡、并且余额正好是 target（如 '90'）：没有就办一张、余额不对就充值补到 target。
 *
 * 为什么必须有它：会员号由服务器按顺序发（100001、100002…），而多个用例都在用 100001。
 * 以前每个用例都写「新办会员卡 → 期望出现 会员 100001」，单跑时库是空的所以绿；
 * 连跑时前面已经办过，服务器回「会员号重复」，用例就红在一个跟它要验的东西毫无关系的步骤上。
 *
 * 余额用「补差额」而不是「再充一遍」：否则每次重跑余额都会叠加，后续金额断言全错。
 */
export async function ensureMember(desk: Page, adminUrl: string, memberNo: string, target: string): Promise<void> {
  await desk.goto(`${adminUrl}/#members`);
  const rowOf = () => desk.locator('.member-list tbody tr', { hasText: memberNo });
  // 会员详情面板是点左侧列表某一行才渲染的，所以「已存在」必须靠选中那一行来确认
  const pick = async () => {
    if ((await rowOf().count()) === 0) return false;
    await rowOf().first().click();
    await expect(desk.getByRole('heading', { name: `会员 ${memberNo}` })).toBeVisible();
    return true;
  };
  if (!(await pick())) {
    await desk.getByRole('button', { name: '新办会员卡' }).click();
    const form = desk.getByRole('form', { name: '新办会员卡' });
    await form.getByLabel('顾客设定的 4 位密码').fill('2468');
    await form.getByLabel('再输一次').fill('2468');
    await form.getByRole('button', { name: '办卡' }).click();
    if (!(await pick())) await expect(desk.getByRole('heading', { name: `会员 ${memberNo}` })).toBeVisible();
  }
  // 余额补到 target（两位小数）
  const now = await desk.locator('.member-balance strong').innerText();
  const nowSen = Math.round(Number(now.replace(/[^\d.]/g, '')) * 100);
  const wantSen = Math.round(Number(target) * 100);
  if (nowSen !== wantSen) {
    const top = desk.getByRole('form', { name: '充值' });
    await top.getByLabel('金额（RM）').fill(((wantSen - nowSen) / 100).toFixed(2));
    await top.getByRole('button', { name: '充值' }).click();
    await confirmDialog(desk, /确认充值/);
  }
  await expect(desk.locator('.member-balance strong')).toHaveText(`RM ${(wantSen / 100).toFixed(2)}`);
}

/**
 * 把这台「手机」的购物车彻底清空。
 *
 * 为什么要显式清：购物车是**一机一车**、存在服务器上，车号记在 localStorage。
 * 同一个浏览器上下文（同一条用例、或者用例里复用了上下文）如果前面加过菜没下单，
 * 后面的金额断言就会无缘无故多出几十块——表现成「合付算出来 40 而不是 36」这种
 * 跟被测逻辑完全无关的失败。金额断言之前先清一次，就不用去猜车里有什么。
 */
export async function emptyCart(phone: Page): Promise<void> {
  const bar = phone.locator('.cartbar-summary');
  if ((await bar.count()) === 0) return; // 车上没有菜，底部托盘根本不渲染
  await bar.click();
  const clear = phone.getByRole('button', { name: '清空' });
  if ((await clear.count()) > 0) {
    await clear.click();
    const box = phone.locator('.confirm-box');
    if (await box.isVisible().catch(() => false)) {
      await box.locator('.confirm-actions .btn.primary, .confirm-actions .btn.danger').first().click().catch(() => undefined);
    }
  }
  await expect(phone.locator('.cartbar')).toHaveCount(0);
}
