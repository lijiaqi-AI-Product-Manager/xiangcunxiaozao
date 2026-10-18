// P3 第二批：全量铺开验收（31号：范围 = 数据全部 104 条；顾客端可见 102 条，两条配送费按 24号不上架）
// 逐道打开详情页，和 menu.json 逐字段对照（菜名/编号/价格/各区块该不该出现/拆开看看按钮），
// 检查 375 和 320 两种手机宽度下没有横向溢出；每道菜首屏截图拼成总览图存进 docs/screenshots/p3-batch2/，
// 逐道结果写进 docs/P3-批2-铺量验收清单.md。截图每次从当前代码重截（31号 ④）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Brand, flavorRouteLabel, formatPrice, Menu, takeApartView, type Dish } from '@pkg/contract';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p3-batch2');
mkdirSync(SHOTS, { recursive: true });
const CUSTOMER = 'http://localhost:5183';
const ADMIN = 'http://localhost:5184';
// 品牌 ID 和其他脚本一样从根目录 .env 读，代码里不写死
if (!process.env.BRAND) process.loadEnvFile(resolve(ROOT, '.env'));
const data = Menu.parse(JSON.parse(readFileSync(resolve(ROOT, 'brands', process.env.BRAND!, 'menu.json'), 'utf8')));
const brand = Brand.parse(JSON.parse(readFileSync(resolve(ROOT, 'brands', process.env.BRAND!, 'brand.json'), 'utf8')));
const catName = Object.fromEntries(data.categories.map((c) => [c.key, c.name]));
const flat = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const money = (sen: number | null) => `RM ${formatPrice(sen)}`;

interface Result { dish: Dish; problems: string[]; sections: string[]; button: string }

// 任何一步点不到、等不到，10 秒就报错，不让一道菜拖住整轮验收
test.use({ actionTimeout: 10_000 });

async function openDetail(page: Page, d: Dish) {
  await page.evaluate((uid) => { location.hash = `dish/${uid}`; window.scrollTo(0, 0); }, d.uid);
  await expect(page.locator('.detail-name')).toHaveText(d.name);
}

/** 逐项对照一道菜：返回发现的问题（空数组 = 通过） */
async function audit(page: Page, d: Dish): Promise<Result> {
  const problems: string[] = [];
  const has = async (sel: string) => (await page.locator(sel).count()) > 0;
  // 元素不在就当空字符串：缺了东西要记成问题，而不是卡在那里等它出现
  const text = async (sel: string) => ((await has(sel)) ? flat(await page.locator(sel).first().textContent()) : '');
  const heading = async (t: string) => (await page.getByRole('heading', { name: t, exact: true }).count()) > 0;
  const expectIf = async (label: string, should: boolean, present: boolean) => {
    if (should !== present) problems.push(`${label}${should ? '应显示却没有' : '不该显示却出现了'}`);
  };

  const code = await text('.detail-code');
  if (code !== d.code) problems.push('编号不一致');
  const price = await text('.detail-price');
  if (!price.startsWith(money(d.priceSen))) problems.push('价格不一致');
  if (d.unit && !price.includes(`/ ${d.unit}`)) problems.push('单位没显示');
  await expectIf('一句话', Boolean(d.hook), await has('.detail-hook'));
  if (d.hook && (await has('.detail-hook')) && (await text('.detail-hook')) !== flat(d.hook)) problems.push('一句话和批准稿不一致');

  const view = takeApartView(d);
  const btn = page.getByRole('button', { name: /拆开看看/ });
  await expectIf('拆开看看按钮', view !== null, (await btn.count()) > 0);
  const route = flavorRouteLabel(d.flavorRoute);
  const sections: string[] = [];
  const checks: [string, boolean][] = [
    ['详细介绍', Boolean(d.intro)], ['源流', Boolean(d.origin)], ['风味之路', Boolean(route)],
    ['食材档案', d.disassembly === 'none' && d.ingredients.length > 0],
  ];
  for (const [t, should] of checks) {
    const present = await heading(t);
    await expectIf(t, should, present);
    if (present) sections.push(t);
  }
  const stepsShown = (await page.getByRole('heading', { name: /^工序/ }).count()) > 0;
  await expectIf('工序', d.steps.length > 0, stepsShown);
  if (stepsShown) sections.push('工序');
  if (route && (await has('.route-tag')) && (await text('.route-tag')) !== route) problems.push('风味之路文字不对');
  const hasCopy = Boolean(d.intro || d.origin || d.steps.length || d.ingredients.length);
  // 34号 B：主食这类只显示图、菜名、价格，不写「整理中」
  const plain = brand.plainDetailCategories.includes(d.categoryKey);
  await expectIf('「介绍整理中」', !hasCopy && !plain, (await page.getByText('这道菜的详细介绍正在整理中。').count()) > 0);
  // 底部：售罄 / 加购按钮
  await expectIf('加购按钮', !d.soldOut, (await page.getByRole('button', { name: `加购 ${d.name}` }).count()) > 0);
  // 横向溢出（375）
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) problems.push('375 宽横向溢出');

  if (view) {
    await btn.click();
    const layers = await page.locator('.explode.open .layer').count();
    if (layers !== d.ingredients.length) problems.push(`食材层 ${layers} 层，档案 ${d.ingredients.length} 样`);
    await page.getByRole('button', { name: /合拢/ }).click();
  }
  return { dish: d, problems, sections, button: view === null ? '不放' : view === 'layers' ? '食材层' : view === 'pins' ? '标注' : '分解图' };
}

test('全量铺开：102 道顾客可见菜逐道对照 + 首屏总览图', async ({ browser }) => {
  test.setTimeout(600_000);

  // 第三批测试把爆炒土豆丝下架了（测试下架功能），这里先上架回来，铺量验收要看全部菜
  const desk = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await desk.goto(ADMIN);
  await desk.getByLabel('老板密码').fill('e2e-test-password');
  await desk.getByRole('button', { name: '登录' }).click();
  await desk.locator('.side').getByRole('link', { name: /^菜品管理/ }).click();
  await desk.getByRole('group', { name: '爆炒土豆丝 状态' }).getByRole('button', { name: '在售' }).click();
  await expect(desk.getByRole('group', { name: '爆炒土豆丝 状态' }).getByRole('button', { name: '在售' })).toHaveAttribute('aria-pressed', 'true');
  await desk.context().close();

  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage();

  // 1. 顾客端菜单接口 = 数据里可点的全部菜，菜名价格编号一字不差（前面几批测试改过的都已恢复）
  const live = Menu.parse(await (await page.request.get(`${CUSTOMER}/api/menu`)).json());
  const expected = data.dishes.filter((d) => d.orderable);
  expect(data.dishes).toHaveLength(104);
  expect(live.dishes.map((d) => d.uid)).toEqual(expected.map((d) => d.uid));
  for (const d of expected) {
    const l = live.dishes.find((x) => x.uid === d.uid)!;
    expect({ uid: l.uid, code: l.code, name: l.name, priceSen: l.priceSen }).toEqual({ uid: d.uid, code: d.code, name: d.name, priceSen: d.priceSen });
  }

  // 现在还没有任何菜品图：前面测试上传过的测试图必须已经撤掉，总览里不能出现测试图
  expect(live.dishes.filter((d) => d.images.closed !== null).map((d) => d.uid)).toEqual([]);

  // 2. 菜单列表「全部」：102 道都在，每道都能点进详情
  await page.goto(`${CUSTOMER}/?table=8&skin=finished`);
  await expect(page.locator('.dish')).toHaveCount(expected.length);
  await expect(page.locator('.dish-name a')).toHaveCount(expected.length);

  // 3. 逐道详情页对照 + 首屏截图
  const results: Result[] = [];
  const tiles: { dish: Dish; png: string }[] = [];
  for (const d of live.dishes) {
    await openDetail(page, d);
    await page.evaluate(() => document.fonts.ready);
    // 以后有图了：等图加载完再截，不截到加载中的空框
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    tiles.push({ dish: d, png: (await page.screenshot()).toString('base64') });
    results.push(await audit(page, d));
  }

  // 4. 320 宽（小屏安卓 / iPhone SE 一代）与骨架态：不溢出、菜名正确
  for (const [width, skin] of [[320, 'finished'], [375, 'skeleton']] as const) {
    const p = await (await browser.newContext({ viewport: { width, height: 700 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })).newPage();
    await p.goto(`${CUSTOMER}/?table=8&skin=${skin}`);
    for (const d of live.dishes) {
      await openDetail(p, d);
      if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) {
        results.find((r) => r.dish.uid === d.uid)!.problems.push(`${width} 宽${skin === 'skeleton' ? '骨架态' : ''}横向溢出`);
      }
    }
    if (skin === 'skeleton') expect(await p.locator('.seal').count()).toBe(0);
    await p.context().close();
  }

  // 5. 总览图：每张 12 道（6 列 × 2 行），图下标编号菜名
  const PER = 12;
  for (let i = 0; i < tiles.length; i += PER) {
    const chunk = tiles.slice(i, i + PER);
    await page.setViewportSize({ width: 6 * 391 + 16, height: Math.ceil(chunk.length / 6) * 860 + 16 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:8px;font:600 18px/1.3 system-ui,"Microsoft YaHei",sans-serif;display:grid;grid-template-columns:repeat(6,375px);gap:16px}
      figure{margin:0}img{display:block;width:375px;height:812px;border:1px solid}figcaption{padding:4px 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style>${chunk.map((t) => `<figure><img src="data:image/png;base64,${t.png}"><figcaption>${t.dish.code || '—'} ${t.dish.name}</figcaption></figure>`).join('')}`);
    await page.screenshot({ path: resolve(SHOTS, `总览-${String(i / PER + 1).padStart(2, '0')}.png`), fullPage: true });
  }
  await ctx.close();

  // 6. 逐道清单
  const bad = results.filter((r) => r.problems.length);
  const lines = [
    '# P3 第二批 · 全量铺开验收清单',
    '',
    '> 由端到端测试 `e2e/p3b-rollout.spec.ts` 自动生成，请勿手改。每道菜打开顾客端详情页，和 `menu.json` 逐字段对照。',
    '',
    `- 数据共 ${data.dishes.length} 条；顾客端可见 ${live.dishes.length} 条（配送费两条按 24号不上架，只在老板端）。`,
    `- 逐道检查项：菜名、编号、价格与单位、一句话、拆开看看按钮该不该有、展开后食材层数 = 食材档案条数、详细介绍 / 源流 / 工序 / 风味之路 / 食材档案该不该出现、风味之路不带括号、没文案的显示「整理中」（主食除外，34号 B）、售罄与加购按钮、375 / 320 宽和骨架态无横向溢出。`,
    `- 结果：**${live.dishes.length - bad.length} 道通过，${bad.length} 道有问题**。`,
    `- 首屏总览图：\`docs/screenshots/p3-batch2/总览-01.png\` ~ \`总览-${String(Math.ceil(tiles.length / PER)).padStart(2, '0')}.png\`（每张 12 道）。`,
    '',
    '| # | 编号 | 菜名 | 分类 | 价格 | 拆开看看 | 显示的区块 | 结果 |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.dish.code || '—'} | ${r.dish.name} | ${catName[r.dish.categoryKey]} | ${formatPrice(r.dish.priceSen)}${r.dish.unit ? `/${r.dish.unit}` : ''} | ${r.button} | ${r.sections.join('、') || (brand.plainDetailCategories.includes(r.dish.categoryKey) ? '（只显示图、菜名、价格）' : '（整理中）')} | ${r.problems.length ? `⚠ ${r.problems.join('；')}` : '✅'} |`),
    '',
  ];
  writeFileSync(resolve(ROOT, 'docs', 'P3-批2-铺量验收清单.md'), lines.join('\n'));
  expect(bad.map((r) => `${r.dish.uid}: ${r.problems.join('；')}`)).toEqual([]);
});
