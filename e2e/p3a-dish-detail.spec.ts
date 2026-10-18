// P3 第一批验收：菜品详情页（拆开看看双轨 / 源流 / 工序 / 风味之路）+ 自动取消单醒目标出
// 截图存进 docs/screenshots/p3-batch1/{finished,skeleton}/；成品态同时存一份进 docs/design/baseline/（待老板确认为基线）
// 3 倍像素密度 + 整页长图：375 宽的手机页面出图 1125 像素宽，打印到 A4 上文字仍能逐字核对
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

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

  // 已下架的菜（第三批测试把爆炒土豆丝下架了）：旧链接打开只说找不到，不报错
  await page.goto(`${CUSTOMER}/?table=8#dish/b02`);
  await expect(page.getByRole('heading', { name: '没有找到这道菜' })).toBeVisible();
  await page.getByRole('button', { name: '回到菜单' }).click();

  // 30号 §三.4：前面几批测试跑完，招牌跳跳蛙恢复原样（原价 48、没有测试图）
  await page.goto(`${CUSTOMER}/?table=8#dish/e01`);
  await expect(page.locator('.detail-price')).toContainText('RM 48');
  await expect(page.locator('.detail-hero img')).toHaveCount(0);

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
  // 第四批测试里已经产生过一张「全部菜品已退款」自动取消单，以及若干店员手动取消单
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await desk.goto(ADMIN);
  await desk.getByLabel('老板密码').fill('e2e-test-password');
  await desk.getByRole('button', { name: '登录' }).click();
  const panel = desk.locator('details.cancelled');
  await expect(panel.locator('summary')).toContainText('其中 1 单系统自动取消');
  await panel.locator('summary').click();
  const auto = panel.locator('.cancel-row.auto');
  await expect(auto).toHaveCount(1);
  await expect(auto).toContainText('系统自动取消');
  await expect(auto).toContainText('全部菜品已退款');
  expect(await panel.locator('.cancel-row:not(.auto) .auto-badge').count()).toBe(0);
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: resolve(SHOTS, '老板-自动取消单标出.png') });
});
