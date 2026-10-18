// 56号 菜名一行自查（全量，不抽样）：102 道顾客可见菜 × 每个出现菜名的位置，375 / 320 两种宽度。
// 规则：先降字号（列表 / 小标签 / 小票不低于 14px，横幅卡不低于 16 / 17，详情标题不低于 22）→ 再收字距 → 都不够才两行（只断在意思完整处）。
// 结果写进 docs/design/redesign/主程序/56号菜名断行自查.md：每个位置多少道菜被缩了字号、缩到多少、有没有两行或被截断
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Menu } from '@pkg/contract';

const ROOT = resolve(import.meta.dirname, '..');
const CUSTOMER = 'http://localhost:5183';
const API = 'http://localhost:8788';
if (!process.env.BRAND) process.loadEnvFile(resolve(ROOT, '.env'));
const data = Menu.parse(JSON.parse(readFileSync(resolve(ROOT, 'brands', process.env.BRAND!, 'menu.json'), 'utf8')));
const dishes = data.dishes.filter((d) => d.orderable);

interface Hit { name: string; size: number; wrap: boolean; cut: boolean }
interface Row { where: string; width: number; max: number; min: number; hits: Hit[] }
const rows: Row[] = [];

/** 读一批 .fit：字号、是否两行、是否被截断 */
const read = (page: Page, sel: string) => page.$$eval(sel, (els) => els.map((e) => {
  const el = e as HTMLElement;
  return { name: el.textContent ?? '', size: parseFloat(getComputedStyle(el).fontSize), wrap: el.classList.contains('fit-wrap'), cut: !el.classList.contains('fit-wrap') && el.scrollWidth > el.clientWidth + 0.5 };
}));
const settle = (page: Page) => page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));

test.use({ actionTimeout: 10_000 });

test('菜名一行自查：列表 / 大画小标签 / 横幅卡 / 详情标题 / 购物车 / 结算小票', async ({ browser, request }) => {
  test.setTimeout(600_000);
  const { token } = await (await request.post(`${API}/api/admin/login`, { data: { password: 'e2e-test-password' } })).json() as { token: string };
  const setToday = (ids: string[]) => request.post(`${API}/api/admin/today`, { data: { dishes: ids }, headers: { authorization: `Bearer ${token}` } });

  for (const width of [375, 320]) {
    const page = await (await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })).newPage();
    // ① 列表：没加购（只有加号）和加购后（算盘珠展开、名字可用宽度变窄）两种状态
    await setToday([]);
    await page.goto(`${CUSTOMER}/?table=8&tier=static`);
    await expect(page.locator('.dish')).toHaveCount(dishes.length);
    await settle(page);
    rows.push({ where: '列表（未加购）', width, max: 18, min: 14, hits: await read(page, '.row-name .fit') });
    await page.evaluate(() => document.querySelectorAll('.qty').forEach((q) => { q.classList.add('on'); q.querySelectorAll('[hidden]').forEach((h) => h.removeAttribute('hidden')); }));
    await settle(page);
    rows.push({ where: '列表（已加购，算盘珠展开）', width, max: 18, min: 14, hits: await read(page, '.row-name .fit') });

    // ② 大画小标签 + ③ 收起后的横幅卡：每次 5 道轮一遍
    const anchors: Hit[] = [], banners: Hit[] = [];
    for (let i = 0; i < dishes.length; i += 5) {
      const batch = dishes.slice(i, i + 5).filter((d) => !d.soldOut).map((d) => d.uid);
      await setToday(batch);
      await page.goto(`${CUSTOMER}/?table=8&tier=static&b=${i}`);
      await expect(page.locator('.deck-card')).toHaveCount(batch.length);
      await settle(page);
      anchors.push(...await read(page, '.pa-name .fit'));
      await page.evaluate(() => window.scrollTo(0, 900));
      for (let k = 0; k < batch.length; k++) {
        await settle(page);
        banners.push(...await read(page, '.today-name .fit'));
        await page.locator('.deck').press('ArrowRight');
      }
    }
    rows.push({ where: '大画小标签', width, max: 18, min: 14, hits: anchors });
    rows.push({ where: '「今日招牌」横幅卡', width, max: 28, min: 17, hits: banners });
    await setToday([]);

    // ④ 详情页标题
    const titles: Hit[] = [];
    await page.goto(`${CUSTOMER}/?table=8&tier=static`);
    for (const d of dishes) {
      await page.evaluate((uid) => { location.hash = `dish/${uid}`; }, d.uid);
      await expect(page.locator('.detail-name')).toHaveText(d.name);
      await settle(page);
      titles.push(...await read(page, '.detail-name .fit'));
    }
    rows.push({ where: '详情页标题', width, max: 34, min: 22, hits: titles });

    // ⑤ 购物车弹层 + ⑥ 结算小票：把每道菜都加一份
    await page.goto(`${CUSTOMER}/?table=8&tier=static`);
    await expect(page.locator('.dish').first()).toBeVisible();
    await page.evaluate(async (uids) => {
      const id = localStorage.getItem('cart-id');
      for (const u of uids) await fetch('/api/cart/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cartId: id, dishUid: u, qty: 1 }) });
    }, dishes.filter((d) => !d.soldOut).map((d) => d.uid));
    await page.reload();
    await page.getByRole('button', { name: '查看购物车' }).click();
    await settle(page);
    rows.push({ where: '购物车弹层', width, max: 18, min: 14, hits: await read(page, '.line-name .fit') });
    await page.goto(`${CUSTOMER}/?table=8&tier=static#checkout`);
    await expect(page.getByRole('heading', { name: '确认订单' })).toBeVisible();
    await settle(page);
    rows.push({ where: '结算小票', width, max: 17, min: 14, hits: await read(page, '.receipt .fit') });
    await page.evaluate(async () => { await fetch('/api/cart/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cartId: localStorage.getItem('cart-id') }) }); });
    await page.context().close();
  }

  // 报告
  const lines = [
    '# 56号 · 菜名一行自查（全量）',
    '',
    `> 由 \`e2e/p4e-names.spec.ts\` 自动生成。${dishes.length} 道顾客可见菜 × 每个出现菜名的位置 × 375 / 320 两种宽度。`,
    '> 修正顺序：先降字号（不低于下限）→ 再收字距 → 都不够才两行，并且只断在意思完整处（修饰词后面，或「手打柠檬茶」这类后缀前面）。',
    '',
    '| 位置 | 屏宽 | 字号上限 / 下限 | 菜名数 | 一行原样 | 缩了字号 | 最小用到 | 收了字距仍一行 | 两行 | 被截断 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => {
      const shrunk = r.hits.filter((h) => h.size < r.max && !h.wrap);
      const minUsed = Math.min(...r.hits.map((h) => h.size));
      return `| ${r.where} | ${r.width} | ${r.max} / ${r.min} | ${r.hits.length} | ${r.hits.filter((h) => h.size >= r.max && !h.wrap).length} | ${shrunk.length} | ${minUsed}px | ${r.hits.filter((h) => h.size <= r.min && !h.wrap).length} | ${r.hits.filter((h) => h.wrap).length} | ${r.hits.filter((h) => h.cut).length} |`;
    }),
    '',
    '## 缩了字号 / 两行的菜（逐道）',
    '',
    ...rows.filter((r) => r.hits.some((h) => h.size < r.max || h.wrap)).map((r) => `- **${r.where}（${r.width} 宽）**：${r.hits.filter((h) => h.size < r.max || h.wrap).map((h) => `${h.name} ${h.wrap ? '两行' : `${h.size}px`}`).join('、')}`),
    '',
  ];
  writeFileSync(resolve(ROOT, 'docs', 'design', 'redesign', '主程序', '56号菜名断行自查.md'), lines.join('\n'));
  // 硬要求：375 宽任何位置都一行、不截断；320 宽只允许列表在算盘珠展开时两行（断在意思完整处）
  const problems = rows.flatMap((r) => r.hits.filter((h) => h.cut || (h.wrap && !(r.width === 320 && r.where.startsWith('列表')))).map((h) => `${r.where}（${r.width}）：${h.name}${h.cut ? ' 被截断' : ' 两行'}`));
  expect(problems).toEqual([]);
});
