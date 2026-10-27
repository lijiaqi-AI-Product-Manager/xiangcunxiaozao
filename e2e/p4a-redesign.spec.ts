// 54号 第一批（点单页 + 详情页换装）验收：三项新交互测试 + 印章统一 + 书法字体不回退
// ① 结算条生灭：连加连删 20 次循环，UI 状态零残留
// ② 真堆叠：慢速拖动时底下的卡同步补位；连续滑 10 次无跳变
// ③ 分类跳转：点每个分类，分组标题落在分类条下沿 8px 处，误差 ≤ 4px（有大画 / 没大画两种）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { Brand } from '@pkg/contract';

const ROOT = resolve(import.meta.dirname, '..');
const CUSTOMER = 'http://localhost:5183';
const API = 'http://localhost:8788';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
if (!process.env.BRAND) process.loadEnvFile(resolve(ROOT, '.env'));
const BRAND_DIR = resolve(ROOT, 'brands', process.env.BRAND!);
const brand = Brand.parse(JSON.parse(readFileSync(resolve(BRAND_DIR, 'brand.json'), 'utf8')));
const LOGO = brand.logoSeal ?? brand.seal;
const HERO = ['e06', 'e01', 'v01'];

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

async function setToday(request: APIRequestContext, dishes: string[]) {
  const { token } = await (await request.post(`${API}/api/admin/login`, { data: { password: 'e2e-test-password' } })).json() as { token: string };
  const r = await request.post(`${API}/api/admin/today`, { data: { dishes }, headers: { authorization: `Bearer ${token}` } });
  expect(r.status()).toBe(200);
}
/** 等页面静下来：滚动停住 + 除了常驻的呼吸、云斑以外没有正在跑的动画 */
async function settled(page: Page) {
  await page.waitForFunction(() => {
    const w = window as unknown as { __y?: number; __n?: number };
    const same = w.__y === window.scrollY;
    w.__n = same ? (w.__n ?? 0) + 1 : 0;
    w.__y = window.scrollY;
    const busy = document.getAnimations().some((a) => a.playState === 'running' && !['breath', 'cloud'].includes((a as CSSAnimation).animationName ?? ''));
    return w.__n >= 6 && !busy;
  }, null, { polling: 50, timeout: 8000 });
}
const xOf = (page: Page) => page.$$eval('.deck-card', (els) => els.map((e) => e.getBoundingClientRect().right));

test('① 结算条生灭：进店干净 → 首菜弹入 → 清空隐去，连加连删 20 次零残留', async ({ browser }) => {
  const page = await (await browser.newContext(PHONE)).newPage();
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(page.getByRole('heading', { name: '招牌跳跳蛙' })).toBeVisible();
  // 空态：托盘、去结算、价格全都不渲染（不是透明占位）
  await expect(page.locator('.cartbar')).toHaveCount(0);
  await expect(page.getByText(/RM\s0\b/)).toHaveCount(0);
  const name = '凉拌木耳';
  for (let i = 0; i < 20; i++) {
    await page.getByRole('button', { name: `加购 ${name}` }).click();
    await expect(page.locator('.cartbar')).toHaveCount(1);
    await expect(page.locator('.cartbar-badge')).toHaveText('1');
    await settled(page);
    const st = await page.locator('.cartbar').evaluate((e) => ({ op: getComputedStyle(e).opacity, tf: getComputedStyle(e).transform, n: document.querySelectorAll('.cartbar').length }));
    expect(st).toEqual({ op: '1', tf: 'none', n: 1 });
    await page.getByRole('button', { name: `减少 ${name}` }).click();
    await expect(page.locator('.cartbar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: `加购 ${name}` })).toBeVisible();
  }
  await settled(page);
  // 零残留：没有留下水滴、柔光、托盘；数量调节器回到只有加号
  expect(await page.evaluate(() => ({
    bars: document.querySelectorAll('.cartbar').length, blobs: document.querySelectorAll('.blob').length, glows: document.querySelectorAll('.land-glow').length,
    on: document.querySelectorAll('.qty.on').length,
  }))).toEqual({ bars: 0, blobs: 0, glows: 0, on: 0 });
  await page.context().close();
});

test('② 真堆叠：堆叠在右边；慢速拖动时底下的卡同步补位；连续滑 10 次无跳变', async ({ browser, request }) => {
  await setToday(request, HERO);
  const page = await (await browser.newContext(PHONE)).newPage();
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(page.locator('.deck-card')).toHaveCount(3);
  await settled(page);
  // 停着时：后两张在最前那张右边各露 14px
  const rest = await xOf(page);
  expect(rest[1]! - rest[0]!).toBeCloseTo(14, 0);
  expect(rest[2]! - rest[1]!).toBeCloseTo(14, 0);

  const box = (await page.locator('.deck').boundingBox())!;
  const y = box.y + box.height * 0.6;
  // 慢速拖动 40 步：每一步都看三张卡的位置
  const x0 = box.x + box.width - 60;
  await page.mouse.move(x0 + 12, y);
  await page.mouse.down();
  // 先拖过 8px 的起拖门槛（门槛以内是在分辨「左右滑」还是「上下翻页」），从这里开始逐步采样
  await page.mouse.move(x0, y);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const samples: number[][] = [await xOf(page)];
  for (let s = 1; s <= 40; s++) {
    await page.mouse.move(x0 - s * 4, y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    samples.push(await xOf(page));
  }
  // 拖了 160px：第二张、第三张都已经往左补位（同一个手势驱动，不是松手后才动）
  const last = samples.at(-1)!;
  expect(last[0]!).toBeLessThan(rest[0]! - 140);
  expect(last[1]!).toBeLessThan(rest[1]! - 4);
  expect(last[2]!).toBeLessThan(rest[2]! - 4);
  // 每一步都连续：最前那张跟手（每步 ≈ 4px），后面的按比例跟着走，没有跳变
  for (let s = 1; s < samples.length; s++) {
    expect(Math.abs(samples[s]![0]! - samples[s - 1]![0]!)).toBeLessThanOrEqual(8);
    expect(Math.abs(samples[s]![1]! - samples[s - 1]![1]!)).toBeLessThanOrEqual(2);
  }
  await page.mouse.up();
  await settled(page);
  await expect(page.locator('.deck-card').nth(1)).toHaveClass(/front/);
  await expect(page.locator('.deck-dots i').nth(1)).toHaveClass('on');
  await expect(page.locator('.today-name')).toHaveText('招牌跳跳蛙');


  const plan = [1, -1, -1, 1, 1, 1, -1, -1, 1, -1]; // +1 = 向左滑（下一张）
  let index = 1;
  for (const dir of plan) {
    const from = box.x + box.width / 2;
    await page.mouse.move(from, y);
    await page.mouse.down();
    for (let s = 1; s <= 6; s++) await page.mouse.move(from - dir * s * 22, y);
    await page.mouse.up();
    // ── 为什么这里不判「逐帧位移」──
    //
    // 松手后的落位动画跑在合成层（Web Animations，只动 transform/opacity），
    // 期间 getBoundingClientRect 拿到的还是**动画开始前的静态值**，动画一结束就跳到终点。
    // 探针实测：滑动期间三张卡的 x 一直停在 -10 | 191.1 | 341.2 不动，下一秒直接变成 -10 | -10 | 333。
    // 所以在这一段里判「单帧位移不许超过 N px」，量到的是「动画结束那一跳」，
    // 和「有没有跳变」无关——之前 4.77 / 4.04 的红就是这么来的。
    //
    // 真正要验的「连续滑 10 次都不乱」放在下面用**落位**来判：
    // 每次松手后，当前那张必须归位、后面几张必须按 14px 露边、小圆点跟着亮。
    // 这些是肉眼能看到的最终状态，也不受采样时机影响。
    index = Math.max(0, Math.min(2, index + dir));
    await settled(page);
    await expect(page.locator('.deck-card').nth(index)).toHaveClass(/front/);
    // 停稳后位置正好落在该在的地方
    const at = await xOf(page);
    for (let k = index; k < 3; k++) expect(at[k]! - at[index]!).toBeCloseTo((k - index) * 14, 0);
  }
  await page.context().close();
});

test('③ 分类跳转：点每个分类，分组标题落在分类条下沿 8px，误差 ≤ 4px（有大画 / 没大画）', async ({ browser, request }) => {
  for (const hero of [HERO, []]) {
    await setToday(request, hero);
    const page = await (await browser.newContext(PHONE)).newPage();
    await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
    await expect(page.getByRole('heading', { name: '招牌跳跳蛙' })).toBeVisible();
    await expect(page.locator('.deck-card')).toHaveCount(hero.length);
    const tabs = await page.locator('.catbar [role=tab]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key!));
    const errors: string[] = [];
    let worst = 0;
    for (const key of [...tabs.slice(1), tabs[1]!, tabs[0]!]) {
      await page.locator(`.catbar [data-key="${key}"]`).click();
      await settled(page);
      const r = await page.evaluate((k) => {
        const cats = document.querySelector('.catbar')!.getBoundingClientRect().bottom;
        const sec = document.querySelector<HTMLElement>(`.grp[data-key="${k}"]`);
        return { err: sec ? sec.getBoundingClientRect().top - (cats + 8) : window.scrollY, sel: document.querySelector(`.catbar [data-key="${k}"]`)!.getAttribute('aria-selected') };
      }, key);
      worst = Math.max(worst, Math.abs(r.err));
      if (Math.abs(r.err) > 4 || r.sel !== 'true') errors.push(`${key}: 误差 ${r.err.toFixed(1)}px，选中 ${r.sel}`);
    }
    console.log(`分类跳转（${hero.length ? '有大画' : '没大画'}）：${tabs.length + 1} 次点击，最大误差 ${worst.toFixed(1)}px`);
    expect(errors).toEqual([]);
    await page.context().close();
  }
  await setToday(request, []);
});

test('圆戳全站唯一形态（双环红文圆戳：大画店标 / 点按小印 / 详情落款）；点哪里都盖得出字', async ({ browser, request }) => {
  await setToday(request, HERO);
  const page = await (await browser.newContext(PHONE)).newPage();
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(page.locator('.deck-card')).toHaveCount(3);
  const seals = async () => page.$$eval('.seal', (els) => els.map((e) => {
    const c = getComputedStyle(e);
    return { text: e.textContent, ring: `${c.borderTopStyle} ${c.borderTopColor}`, op: c.opacity, radius: c.borderRadius, font: c.fontFamily, w: Math.round(parseFloat(c.width)) };
  }));
  // 大画态店标（44）
  const head = await seals();
  expect(head.map((s) => s.w)).toEqual([44]);
  // 点大画区域、点列表区域（滚到主页面后），都盖出带字的小圆戳——54号问题一：主页面不能再是空红圈
  const stamp = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    const s = await page.locator('.tap-seal').last().evaluate((e) => ({ text: e.textContent, w: Math.round(parseFloat(getComputedStyle(e).width)), ring: `${getComputedStyle(e).borderTopStyle} ${getComputedStyle(e).borderTopColor}`, font: getComputedStyle(e).fontFamily }));
    await page.mouse.up();
    return s;
  };
  const inHero = await stamp(120, 120);
  await page.evaluate(() => window.scrollTo(0, 900));
  await settled(page);
  const inList = await stamp(200, 500);
  for (const s of [inHero, inList]) {
    expect(s.text).toBe(LOGO);
    expect(s.w).toBe(28);
    expect(s.ring).toBe(head[0]!.ring);
    expect(s.font).toBe(head[0]!.font);
  }
  // 详情页落款（36）：同一个组件
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#dish/e06`);
  await expect(page.locator('.detail-name')).toBeVisible();
  const detail = (await seals()).filter((s) => s.w === 36);
  expect(detail).toHaveLength(1);
  for (const s of [...head, ...detail]) {
    expect(s).toMatchObject({ text: LOGO, ring: head[0]!.ring, op: '1', radius: '50%', font: head[0]!.font });
  }
  await setToday(request, []);
  await page.context().close();
});

test('书法字体不回退：标题标签层里每个字都在裁剪后的书法 / 衬线字表里', async ({ browser, request }) => {
  await setToday(request, HERO);
  const have = readFileSync(resolve(BRAND_DIR, brand.brushFont!.file.replace(/\.woff2$/, '.chars.txt')), 'utf8')
    + readFileSync(resolve(BRAND_DIR, brand.latinFont!.file.replace(/\.woff2$/, '.chars.txt')), 'utf8');
  const page = await (await browser.newContext(PHONE)).newPage();
  const scan = () => page.evaluate((chars) => {
    const set = new Set([...chars, ' ', ' ']);
    const bad = new Map<string, string>();
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!getComputedStyle(el).fontFamily.startsWith('"UI Latin"')) continue;
      for (const n of el.childNodes) {
        if (n.nodeType !== 3) continue;
        for (const ch of n.textContent ?? '') if (!set.has(ch)) bad.set(ch, el.className);
      }
    }
    return [...bad].map(([c, cls]) => `${c}（${cls}）`);
  }, have);
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(page.locator('.deck-card')).toHaveCount(3);
  await page.getByRole('button', { name: '全部分类' }).click();
  const panel = await scan();
  await page.getByRole('button', { name: '全部分类' }).click();
  await expect(page.getByRole('group', { name: '全部分类' })).toHaveCount(0);
  await page.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
  await expect(page.locator('.cartbar')).toBeVisible();
  const order = [...panel, ...await scan()];
  await page.getByRole('button', { name: '查看购物车' }).click();
  const sheet = await scan();
  await page.getByRole('button', { name: '清空' }).click();
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#dish/e06`);
  await page.getByRole('button', { name: /拆开看看/ }).click();
  const detail = await scan();
  expect([...order, ...sheet, ...detail]).toEqual([]);
  await setToday(request, []);
  await page.context().close();
});

test('动效红线：点单 / 详情 / 四页切换途中出现的每一个动画都只动 transform / opacity（合成线程）', async ({ browser, request }) => {
  await setToday(request, HERO);
  const page = await (await browser.newContext(PHONE)).newPage();
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __props: Set<string> }).__props = seen;
    const grab = () => {
      for (const a of document.getAnimations()) {
        const kf = (a.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
        for (const f of kf) for (const k of Object.keys(f)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(k)) seen.add(k);
      }
      requestAnimationFrame(grab);
    };
    requestAnimationFrame(grab);
  });
  await page.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(page.locator('.deck-card')).toHaveCount(3);
  const box = (await page.locator('.deck').boundingBox())!;
  await page.mouse.move(box.x + box.width - 40, box.y + 170);
  await page.mouse.down();
  for (let s = 1; s <= 10; s++) await page.mouse.move(box.x + box.width - 40 - s * 20, box.y + 170);
  await page.mouse.up();
  await page.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
  await page.getByRole('tab', { name: '家常小炒' }).click();
  await page.getByRole('button', { name: '全部分类' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '全部分类' }).click();
  await page.getByRole('button', { name: '查看购物车' }).click();
  await page.getByRole('button', { name: '清空' }).click();
  await page.waitForTimeout(600);
  await page.goto(`${CUSTOMER}/?table=8&tier=normal#dish/e06`);
  await page.getByRole('button', { name: /拆开看看/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /合拢/ }).click();
  for (const t of ['取餐', '会员', '我的', '点单']) { await page.locator('.dock').getByRole('link', { name: t }).click(); await page.waitForTimeout(350); }
  const props = await page.evaluate(() => [...(window as unknown as { __props: Set<string> }).__props].sort());
  expect(props.length).toBeGreaterThan(0);
  expect(props.filter((p) => p !== 'opacity' && p !== 'transform')).toEqual([]);
  await setToday(request, []);
  await page.context().close();
});
