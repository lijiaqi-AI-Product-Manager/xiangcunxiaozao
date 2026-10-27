// P3 第一批验收：菜品详情页（拆开看看双轨 / 源流 / 工序 / 风味之路）+ 自动取消单醒目标出
// 截图存进 docs/screenshots/p3-batch1/{finished,skeleton}/；成品态同时存一份进 docs/design/baseline/（待老板确认为基线）
// 3 倍像素密度 + 整页长图：375 宽的手机页面出图 1125 像素宽，打印到 A4 上文字仍能逐字核对
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { confirmDialog } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p3-batch1');
const BASELINE = resolve(ROOT, 'docs', 'design', 'baseline');
for (const d of [resolve(SHOTS, 'finished'), resolve(SHOTS, 'skeleton'), BASELINE]) mkdirSync(d, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
// 截图时关掉动画（减弱动态效果），保证每张图都是展开完成后的样子；动画本身另有一条测试单独检查
const PRINT = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce' as const };

// 每道菜开一个新页面整页加载，不靠同页改地址栏跳转（整套测试连跑时那种跳转偶发没跟上）
async function open(ctx: BrowserContext, uid: string, skin: 'finished' | 'skeleton') {
  for (const p of ctx.pages()) await p.close();
  const page = await ctx.newPage();
  await page.goto(`${CUSTOMER}/?table=8&skin=${skin}#dish/${uid}`);
  await expect(page.locator('.detail-name')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function captureDetail(browser: Browser, skin: 'finished' | 'skeleton') {
  const ctx = await browser.newContext(PRINT);
  let page: Page;
  const dir = resolve(SHOTS, skin);
  const shot = async (name: string) => {
    const path = resolve(dir, `${name}.png`);
    // 不用 fullPage：那样底部固定的加购栏和页签会被印在长图中间。把窗口拉到整页高度再截，固定栏落在最底下
    // 水印字号按屏幕高度算；拉长窗口前先把它定在手机屏上的实际大小，长图里的水印才和真机一样大
    await page.evaluate(() => {
      const wm = document.querySelector<HTMLElement>('.watermark > span');
      if (wm) wm.style.fontSize = getComputedStyle(wm).fontSize;
    });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: 375, height });
    await page.screenshot({ path });
    await page.setViewportSize({ width: 375, height: 812 });
    if (skin === 'finished') copyFileSync(path, resolve(BASELINE, `详情页-成品态-${name}.png`));
  };

  // S 级（双图法）有文案：合拢 + 展开。样张用 E06（P3 批1 选定，基线沿用）
  page = await open(ctx, 'e06', skin);
  await expect(page.getByRole('heading', { name: '湘味油泼牛肉', level: 1 })).toBeVisible();
  await expect(page.getByText('鲜牛肉切薄片，辣子堆上滚油一激。')).toBeVisible();
  for (const t of ['详细介绍', '源流', '工序三步', '风味之路']) await expect(page.getByRole('heading', { name: t })).toBeVisible();
  const btn = page.getByRole('button', { name: /拆开看看/ });
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await shot('1-E06-S级-合拢');
  await btn.click();
  await expect(page.getByRole('button', { name: /合拢/ })).toHaveAttribute('aria-expanded', 'true');
  for (const n of ['牛肉', '辣子面', '花椒', '香菜']) await expect(page.locator('.layer-name', { hasText: n })).toBeVisible();
  await expect(page.getByText('分解图上线中，先看食材清单')).toBeVisible();
  await shot('2-E06-S级-拆开看看');

  // B 级（标注层）有文案：展开
  page = await open(ctx, 'b03', skin);
  await page.getByRole('button', { name: /拆开看看/ }).click();
  await expect(page.getByText('标注图上线中，先看食材清单')).toBeVisible();
  await shot('3-B03-B级-拆开看看');

  // 饮品：不做拆开看看，食材档案单独成卡
  page = await open(ctx, 'l02', skin);
  await expect(page.getByRole('button', { name: /拆开看看/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '食材档案' })).toBeVisible();
  await shot('4-L02-饮品');

  // 批准稿还没写文案的 S 级菜：不出现拆开看看按钮，只说「整理中」，不编内容
  page = await open(ctx, 'e02', skin);
  await expect(page.getByRole('button', { name: /拆开看看/ })).toHaveCount(0);
  await expect(page.getByText('这道菜的详细介绍正在整理中。')).toBeVisible();
  await shot('5-E02-文案整理中');

  if (skin === 'skeleton') {
    expect(await page.locator('.seal').count()).toBe(0); // 骨架态没有任何品牌元素（26号规则1）
  }
  await ctx.close();
}

test('详情页：成品态 + 骨架态，打印分辨率整页截图', async ({ browser }) => {
  test.setTimeout(180_000);
  await captureDetail(browser, 'finished');
  await captureDetail(browser, 'skeleton');
});

test('详情页交互：从菜单点进、加购、返回原位置；拆开看看逐层错峰 120ms', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })).newPage();
  await page.goto(`${CUSTOMER}/?table=8`);
  await page.getByRole('tab', { name: '家常小炒' }).click();
  // 54号起点分类是平滑滚动定位到那一组：等滚动停稳再记位置
  await page.waitForFunction(() => {
    const w = window as unknown as { __y?: number; __n?: number };
    w.__n = w.__y === window.scrollY ? (w.__n ?? 0) + 1 : 0;
    w.__y = window.scrollY;
    return w.__n >= 6;
  }, null, { polling: 50 });
  await page.getByRole('heading', { name: '农家一碗香' }).scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  await page.getByRole('link', { name: '农家一碗香' }).click();
  await expect(page).toHaveURL(/#dish\/c03$/);
  await expect(page.getByRole('heading', { name: '农家一碗香', level: 1 })).toBeVisible();

  // 详情页底部加购，和菜单页是同一个购物车
  await page.getByRole('button', { name: '加购 农家一碗香' }).click();
  await expect(page.getByLabel('农家一碗香 已选 1 份')).toBeVisible();
  await expect(page.getByRole('button', { name: /去结算 · 1/ })).toBeVisible();

  // 拆开看看：每一层的出场延迟依次递增 120ms（09号 §五.1）
  await page.getByRole('button', { name: /拆开看看/ }).click();
  const delays = await page.locator('.explode.open .layer').evaluateAll((els) => els.map((e) => getComputedStyle(e).transitionDelay.split(',')[0]!.trim()));
  expect(delays.slice(0, 3)).toEqual(['0.12s', '0.24s', '0.36s']);
  // 54号：拆开看看是从下方升起的舞台（盖住大图），先合拢再返回
  await page.getByRole('button', { name: /合拢/ }).click();

  // 返回菜单：回到点进来之前的分类和位置
  await page.getByRole('button', { name: '返回菜单' }).click();
  await expect(page.getByRole('tab', { name: '家常小炒' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
  await expect(page.getByLabel('农家一碗香 已选 1 份')).toBeVisible();

  // 已下架的菜：旧链接打开只说找不到，不报错。
  // 这里不用「指望第三批把爆炒土豆丝下架了」——单独跑这条时它还在售，链接就能正常打开。
  // 自己先把它下架，验完再恢复，用例之间不留依赖。
  {
    const db = new Database(resolve(ROOT, 'data', 'e2e.db'));
    try {
      db.prepare("INSERT INTO dish_overrides (dish_uid, listed, price_sen, image_closed, sold_out_date, updated_at) VALUES ('b02', 0, NULL, NULL, NULL, ?) ON CONFLICT(dish_uid) DO UPDATE SET listed = 0, updated_at = excluded.updated_at")
        .run(new Date().toISOString());
    } finally {
      db.close();
    }
  }
  await page.goto(`${CUSTOMER}/?table=8#dish/b02`);
  await expect(page.getByRole('heading', { name: '没有找到这道菜' })).toBeVisible();
  await page.getByRole('button', { name: '回到菜单' }).click();
  {
    const db = new Database(resolve(ROOT, 'data', 'e2e.db'));
    try {
      db.prepare("DELETE FROM dish_overrides WHERE dish_uid = 'b02'").run();
    } finally {
      db.close();
    }
  }

  // 没传图的菜：菜名照常显示，大图位是占位（不空着、不裂图）。
  //
  // 以前这里写的是「招牌跳跳蛙没有测试图」——那是在断言**别的用例没给它传图**，
  // 属于隐式依赖：单跑绿、连跑红，红在一个跟详情页毫无关系的地方。
  // 现在先把这张图清干净（自己造前提），验完就结束，不改动别的用例的数据。
  {
    const db = new Database(resolve(ROOT, 'data', 'e2e.db'));
    try {
      db.prepare("DELETE FROM dish_overrides WHERE dish_uid = 'e01'").run();
    } finally {
      db.close();
    }
  }
  await page.goto(`${CUSTOMER}/?table=8#dish/e01`);
  await expect(page.locator('.detail-price')).toContainText('RM 48');
  await expect(page.locator('.detail-hero img')).toHaveCount(0);
  await expect(page.locator('.detail-hero .hero-img.ph')).toBeVisible();

  // 30号 高斯：背景水印在手机上完整显示，不被屏幕上下左右切掉
  const wm = await page.locator('.watermark > span').boundingBox();
  expect(wm).not.toBeNull();
  expect(wm!.y).toBeGreaterThanOrEqual(0);
  expect(wm!.y + wm!.height).toBeLessThanOrEqual(812);
  expect(wm!.x + wm!.width).toBeLessThanOrEqual(375.5);

  // 收尾：回菜单页清空购物车，不影响后面的测试
  await page.getByRole('button', { name: '返回菜单' }).click();
  await page.locator('.cartbar-summary').click();
  await page.getByRole('button', { name: '清空' }).click();
  await page.context().close();
});

test('老板端：系统自动取消（全部菜品已退款）的单醒目标出，和手动取消分开', async ({ browser }) => {
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const phone = await (await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })).newPage();

  // 以前这条靠「第四批测试已经产生过一张自动取消单」，单独跑就是红的。
  // 自己造一张：下单 → 把唯一的菜整行退款 → 系统自动取消。
  // 注意不能假设「整个系统里只有我这一张」：连跑时前面的用例也会造自动取消单，
  // 所以下面一律按**单号**定位，不断言总数。
  let myNo = '';
  await test.step('自己造一张「全部菜品已退款」自动取消单', async () => {
    await phone.goto(`${CUSTOMER}/?table=11`);
    await phone.getByRole('button', { name: '加购 农家一碗香' }).click();
    await expect(phone.locator('.cartbar-go')).toBeVisible({ timeout: 10000 });
    await phone.locator('.cartbar-go').click();
    await phone.getByText('现金（到柜台）').click();
    await phone.getByRole('button', { name: /提交订单/ }).click();
    const no = (await phone.locator('.hero-no').innerText()).trim();
    myNo = no;

    await desk.goto(ADMIN);
    await desk.getByLabel('老板密码').fill('e2e-test-password');
    await desk.getByRole('button', { name: '登录' }).click();
    const ticket = desk.locator('.ticket', { has: desk.locator('.ticket-no', { hasText: no }) });
    await expect(ticket).toBeVisible();
    await ticket.getByRole('button', { name: '退款' }).first().click();
    // 退款框要先选份数、写原因，「确认退款」才会亮
    const box = ticket.getByRole('group', { name: /号单退款/ });
    await box.getByRole('button', { name: '多退一份 农家一碗香' }).click();
    await box.getByRole('button', { name: '客人退菜' }).click();
    await box.getByRole('button', { name: '确认退款' }).click();
    await confirmDialog(desk, '确认退款');
    await expect(desk.locator('.cancelled')).toContainText(no);
  });

  const panel = desk.locator('details.cancelled');
  // 折叠标题里带「其中 N 单系统自动取消」，N 至少 1（我这张），别人造的不算错
  await expect(panel.locator('summary')).toContainText(/其中 \d+ 单系统自动取消/);
  await panel.locator('summary').click();
  // 我这张单必须**在自动取消那一组里**，并且写明原因
  const mine = panel.locator('.cancel-row.auto', { hasText: myNo });
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText('系统自动取消');
  await expect(mine).toContainText('全部菜品已退款');
  // 手动取消的那些行不许挂「自动」角标（两类必须分得开，这是这条用例真正要验的事）
  expect(await panel.locator('.cancel-row:not(.auto) .auto-badge').count()).toBe(0);
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: resolve(SHOTS, '老板-自动取消单标出.png') });
});
