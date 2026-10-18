// 54号 交付：问题一至五的前后对比图（同状态并排）。前 = 私密网页第 9 版（小样发布包，用 publish-prep.mjs 重新生成，目录由 V9_DIR 指定）；后 = 主程序
// 用法：V9_DIR=<发布包目录> npx playwright test -c e2e/playwright.config.ts p4c
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'docs', 'screenshots', 'p4-redesign');
mkdirSync(OUT, { recursive: true });
const V9 = process.env.V9_DIR ?? '';
const CUSTOMER = 'http://localhost:5183';
const API = 'http://localhost:8788';
const PHONE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const v9 = (f: string) => pathToFileURL(resolve(V9, f)).href;

test.skip(!V9 || !existsSync(resolve(V9, 'index.html')), '没有指定第 9 版发布包目录（V9_DIR）');
// 发布包的主页面没有自己的文档骨架（私密网页外面会包一层带手机视口的骨架）——这里照样包一层，手机宽度才对；body 上的属性照旧丢失，和线上一模一样
if (V9 && existsSync(resolve(V9, 'index.html'))) writeFileSync(resolve(V9, '_index-phone.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${readFileSync(resolve(V9, 'index.html'), 'utf8')}</body></html>`);
test.use({ actionTimeout: 10_000 });

const png = async (page: Page, clip?: { x: number; y: number; width: number; height: number }) => (await page.screenshot({ clip })).toString('base64');
async function calm(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}
/** 拼一张对比图：每列一个状态（图 + 说明），前后两行 */
async function sheet(page: Page, file: string, title: string, rows: { label: string; cells: { img: string; cap: string }[] }[]) {
  const cols = Math.max(...rows.map((r) => r.cells.length));
  await page.setViewportSize({ width: 40 + cols * 400, height: 400 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:20px;background:linen;font:15px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:black}
    h1{font-size:22px;margin:0 0 14px}.row{display:flex;gap:16px;margin-bottom:18px;align-items:flex-start}
    .lab{writing-mode:vertical-rl;font-weight:700;font-size:18px;padding:6px 4px;border-radius:6px;background:black;color:white}
    .row.after .lab{background:darkslategray}figure{margin:0;width:375px}img{display:block;width:375px;border-radius:12px;box-shadow:0 2px 10px silver}
    figcaption{padding:6px 2px 0;font-size:14px}</style><h1>${title}</h1>
    ${rows.map((r, i) => `<div class="row${i ? ' after' : ''}"><div class="lab">${r.label}</div>${r.cells.map((c) => `<figure><img src="data:image/png;base64,${c.img}"><figcaption>${c.cap}</figcaption></figure>`).join('')}</div>`).join('')}`);
  await page.screenshot({ path: resolve(OUT, file), fullPage: true });
}
async function setToday(page: Page, dishes: string[]) {
  const { token } = await (await page.request.post(`${API}/api/admin/login`, { data: { password: 'e2e-test-password' } })).json() as { token: string };
  await page.request.post(`${API}/api/admin/today`, { data: { dishes }, headers: { authorization: `Bearer ${token}` } });
}
/** 按住不放时截一块（点按小印还在） */
async function pressShot(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(140); // 盖下去停住的那一段（新旧都在 0.14–0.38 秒之间）
  const img = await png(page, { x: x - 90, y: y - 70, width: 180, height: 140 });
  await page.mouse.move(2, 400); // 松手前移开：按下点可能落在菜名链接上，原地松手会点进详情
  await page.mouse.up();
  return img;
}

test('问题一至五 前后对比图', async ({ browser }) => {
  test.setTimeout(240_000);
  const before = await (await browser.newContext(PHONE)).newPage();
  const after = await (await browser.newContext(PHONE)).newPage();
  const out = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  await setToday(after, ['e06', 'e01', 'v01']);

  // ---------- 问题一：印章 ----------
  await before.goto(v9('_index-phone.html'));
  await calm(before);
  await before.evaluate(() => window.scrollTo(0, 700));
  await calm(before);
  const b1List = await pressShot(before, 200, 520);
  await before.goto(v9('hero.html'));
  await calm(before);
  const b1Hero = await pressShot(before, 160, 150);
  await after.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await expect(after.locator('.deck-card')).toHaveCount(3);
  await calm(after);
  const a1Hero = await pressShot(after, 160, 150);
  await after.evaluate(() => window.scrollTo(0, 900));
  await calm(after);
  const a1List = await pressShot(after, 200, 520);
  await sheet(out, '对比-问题一-印章.png', '问题一：圆戳印章全站一种形态（大画态 / 主页面点按都是「湘」字红文圆戳）', [
    { label: '前（第 9 版）', cells: [{ img: b1Hero, cap: '大画态里点按：有字' }, { img: b1List, cap: '主页面里点按：空红圈（发布版 body 属性被搬走，读不到字）' }] },
    { label: '后（主程序）', cells: [{ img: a1Hero, cap: '大画态里点按：湘字圆戳 28px' }, { img: a1List, cap: '主页面里点按：同一组件，字从品牌配置传入' }] },
  ]);

  // ---------- 问题二：版本矩阵 ----------
  await before.goto(v9('_index-phone.html'));
  await before.evaluate(() => window.scrollTo(0, 0));
  await calm(before);
  const b2 = await png(before);
  await after.evaluate(() => window.scrollTo(0, 0));
  await calm(after);
  const a2 = await png(after);
  await sheet(out, '对比-问题二-版本矩阵.png', '问题二：版本切换器删除，大画态 = 唯一主基调', [
    { label: '前（第 9 版）', cells: [{ img: b2, cap: '顶部六个版本按钮（V2 墨字 / 马卡龙 / V1 并入 / 大画态 / 淡绿底 / 墨黑结构色）' }] },
    { label: '后（主程序）', cells: [{ img: a2, cap: '只有大画态：进店大画 + 门店框 + 水墨印基底列表' }] },
  ]);

  // ---------- 问题三：假堆叠 → 真堆叠（拖到一半） ----------
  await before.goto(v9('hero.html'));
  await calm(before);
  const b3rest = await png(before, { x: 0, y: 0, width: 375, height: 300 });
  await before.evaluate(() => { const t = document.querySelector<HTMLElement>('.hero-track')!; t.style.scrollSnapType = 'none'; t.scrollLeft = t.clientWidth * 0.5; });
  await calm(before);
  const b3half = await png(before, { x: 0, y: 0, width: 375, height: 300 });
  const box = (await after.locator('.deck').boundingBox())!;
  const a3rest = await png(after, { x: 0, y: 0, width: 375, height: 300 });
  await after.mouse.move(box.x + box.width - 50, box.y + 170);
  await after.mouse.down();
  for (let s = 1; s <= 12; s++) await after.mouse.move(box.x + box.width - 50 - s * 13, box.y + 170);
  await after.waitForTimeout(100);
  const a3half = await png(after, { x: 0, y: 0, width: 375, height: 300 });
  await after.mouse.up();
  await sheet(out, '对比-问题三-真堆叠.png', '问题三：堆叠改到右侧；拖动时下面的卡同步补位（同一手势驱动）', [
    { label: '前（第 9 版）', cells: [{ img: b3rest, cap: '停着：卡边在下方' }, { img: b3half, cap: '拖到一半：下面两层卡边纹丝不动（贴纸）' }] },
    { label: '后（主程序）', cells: [{ img: a3rest, cap: '停着：后两张在右边各露 14px' }, { img: a3half, cap: '拖到一半：第二张、第三张同时往左补位、变大' }] },
  ]);

  // ---------- 问题四：结算条生灭 ----------
  await before.goto(v9('_index-phone.html'));
  await calm(before);
  // 小样的减号被它自己的托盘盖住一部分，直接派发点击（小样的加减是文档上的点击监听）
  await before.$$eval('.minus:not([hidden])', (els) => els.forEach((e) => (e as HTMLElement).click()));
  await calm(before);
  const b4 = await png(before);
  await setToday(after, []);
  await after.goto(`${CUSTOMER}/?table=8&tier=normal`);
  await calm(after);
  const a4empty = await png(after);
  await after.getByRole('button', { name: '加购 招牌跳跳蛙' }).click();
  await after.waitForTimeout(240);
  const a4in = await png(after);
  await calm(after);
  await after.getByRole('button', { name: '减少 招牌跳跳蛙' }).click();
  await expect(after.locator('.cartbar')).toHaveCount(0);
  await calm(after);
  const a4out = await png(after);
  await sheet(out, '对比-问题四-结算条生灭.png', '问题四：0 道菜不出结算条；首菜弹入；清空隐去', [
    { label: '前（第 9 版）', cells: [{ img: b4, cap: '菜都减掉了，托盘还在：「RM 0」+ 去结算' }] },
    { label: '后（主程序）', cells: [{ img: a4empty, cap: '进店空态：底部只有 Dock' }, { img: a4in, cap: '点第一道菜：托盘弹入中（0.36s ease-out-back）' }, { img: a4out, cap: '清空：托盘隐去，不留占位' }] },
  ]);

  // ---------- 问题五：标题组留白 ----------
  await before.goto(v9('detail.html'));
  await calm(before);
  await before.evaluate(() => window.scrollTo(0, 300));
  await calm(before);
  const b5 = await png(before);
  const a5: string[] = [];
  for (const v of ['1', '2', '3']) {
    await after.goto(`${CUSTOMER}/?table=8&tier=normal&lockup=${v}#dish/e06`);
    await calm(after);
    await after.evaluate(() => window.scrollTo(0, 300));
    await calm(after);
    a5.push(await png(after));
  }
  await sheet(out, '对比-问题五-标题组.png', '问题五：竖排英文不再把标题下面撑出空白（三个变体，同菜同状态）', [
    { label: '前（第 9 版）', cells: [{ img: b5, cap: '竖排英文比菜名高一截，下面留出一块挤出来的白' }] },
    { label: '后（主程序）', cells: [{ img: a5[0]!, cap: '变体 1 侧边瘦身（主推）：英文缩一号成「书脊」，和菜名、价格、一句话一样高' }, { img: a5[1]!, cap: '变体 2 底部横排：英文 + 细金线当菜名和价格之间的地平线' }, { img: a5[2]!, cap: '变体 3 顶部眉批：英文放菜名上面，一个朱砂点起头' }] },
  ]);
});
