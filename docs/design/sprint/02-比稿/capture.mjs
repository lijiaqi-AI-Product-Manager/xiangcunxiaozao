// 比稿截图：3 倍像素、375 宽手机；量一屏能看全几道菜；拼三方向并排对比图。
// 用法：node docs/design/sprint/02-比稿/capture.mjs（先跑 build.mjs）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const SHOTS = join(HERE, 'shots');
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN' });
const page = await ctx.newPage();
const open = async (rel) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(pathToFileURL(join(HERE, rel)).href);
  // 中文书法字按字分片懒加载：把页面上出现的字全部请求一遍，等加载完再截，不截到兜底字体
  await page.evaluate(async () => {
    const brush = getComputedStyle(document.documentElement).getPropertyValue('--font-brush').trim(); // 字体名来自品牌 token，不写死
    await document.fonts.load(`32px ${brush}`, document.body.innerText);
    await document.fonts.ready;
  });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
};
// 整页长图：把窗口拉到整页高度再截，底部固定栏落在最底下（不用 fullPage，避免固定栏印在图中间）
const longShot = async (path) => {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 375, height: h });
  await page.screenshot({ path });
  await page.setViewportSize({ width: 375, height: 812 });
};
// 一屏能看全几道菜：菜卡（列表行 + 主推大卡）完整落在顶部到购物车条之间
const density = () => page.evaluate(() => {
  const limit = document.querySelector('.cartbar').getBoundingClientRect().top;
  const all = [...document.querySelectorAll('article')];
  const full = all.filter((a) => { const r = a.getBoundingClientRect(); return r.top >= 0 && r.bottom <= limit && r.left >= 0 && r.right <= window.innerWidth + 0.5; }).length;
  return full;
});

const result = {};
for (const d of ['A', 'B', 'C']) {
  await open(`${d}/list.html`);
  result[d] = { perScreen: await density() };
  await page.screenshot({ path: join(SHOTS, `${d}-列表-首屏.png`) });
  await open(`${d}/detail.html`);
  await page.screenshot({ path: join(SHOTS, `${d}-详情-首屏.png`) });
  await longShot(join(SHOTS, `${d}-详情-整页.png`));
}
await open('A/list-ink.html');
await page.screenshot({ path: join(SHOTS, 'A-列表-首屏-墨色首字.png') });

// 并排对比图（同一页面、同一数据、同一状态）
const b64 = (f) => readFileSync(join(SHOTS, f)).toString('base64');
const sheet = async (name, items) => {
  await page.setViewportSize({ width: items.length * 391 + 16, height: 900 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:8px;font:700 20px/1.4 system-ui,"Microsoft YaHei",sans-serif;display:flex;gap:16px}figure{margin:0}img{display:block;width:375px;height:812px;border:1px solid}figcaption{padding:6px 2px}</style>${items.map(([f, cap]) => `<figure><figcaption>${cap}</figcaption><img src="data:image/png;base64,${b64(f)}"></figure>`).join('')}`);
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};
await sheet('对比-列表页.png', [['A-列表-首屏.png', `A 紧凑效率 · 一屏 ${result.A.perScreen} 道`], ['B-列表-首屏.png', `B 主次大卡 · 一屏 ${result.B.perScreen} 道`], ['C-列表-首屏.png', `C 纸本菜谱 · 一屏 ${result.C.perScreen} 道`]]);
await sheet('对比-详情页.png', [['A-详情-首屏.png', 'A 紧凑效率'], ['B-详情-首屏.png', 'B 主次大卡'], ['C-详情-首屏.png', 'C 纸本菜谱']]);
await sheet('对比-缩略图首字-墨vs红.png', [['A-列表-首屏.png', '首字：品牌红'], ['A-列表-首屏-墨色首字.png', '首字：墨色']]);
await browser.close();
writeFileSync(join(SHOTS, 'density.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
