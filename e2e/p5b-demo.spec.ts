// 58号 任务5 演示版：npm run build:demo 生成的静态包，放在一个「不是站点根」的子路径下（和私密网页一样），
// 不起任何后端服务，走一遍：点单页有菜和今日招牌 → 加菜 → 结算下单 → 取餐页出号 → 「我的」页有这张单。
// 同时确认正式构建里没有演示代码。截图存进 docs/screenshots/p5-closeout/
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'apps', 'customer', 'dist-demo');
const SHOTS = resolve(ROOT, 'docs', 'screenshots', 'p5-closeout');
const PORT = 5190;
const PREFIX = '/artifact/demo-check/';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
let server: Server;

test.beforeAll(async () => {
  execSync('npm run build:demo', { cwd: ROOT, stdio: 'pipe' });
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    if (!path.startsWith(PREFIX)) { res.writeHead(404).end(); return; } // 站点根上什么都没有：用了绝对路径就会 404
    // 发布时首页外面会包一层文档骨架，这里照样包
    const file = join(OUT, path.slice(PREFIX.length) || 'index.html');
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    let body: Buffer | string = readFileSync(file);
    if (file.endsWith('index.html')) body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${body}</body></html>`;
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((ok) => server.listen(PORT, ok));
});
test.afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

test('演示版：不连后端，点单 → 下单 → 取餐出号；资源都用相对路径', async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  const missing: string[] = [];
  page.on('response', (r) => { if (r.status() >= 400) missing.push(r.url()); });
  await page.goto(`http://localhost:${PORT}${PREFIX}`);

  await expect(page.getByRole('button', { name: '加购 农家一碗香' })).toBeVisible();
  expect(await page.getByRole('button', { name: /^加购 / }).count()).toBeGreaterThan(50);
  await expect(page.locator('.deck')).toBeVisible(); // 今日招牌示例配置
  await expect(page.getByText('当前等待约')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length)).toBeGreaterThan(0);
  await page.screenshot({ path: resolve(SHOTS, '演示版-点单首屏.png') });

  await page.getByRole('button', { name: '加购 农家一碗香' }).click();
  await expect(page.locator('.cartbar-badge')).toHaveText('1');
  await page.locator('.cartbar-go').click();
  await expect(page.getByRole('heading', { name: '确认订单' })).toBeVisible();
  await page.getByText('现金（到柜台）').click();
  await page.getByRole('button', { name: /提交订单/ }).click();
  await expect(page.locator('.hero-no')).toHaveText('001');
  await expect(page.locator('.hero-status')).toHaveText('待制作');
  await page.screenshot({ path: resolve(SHOTS, '演示版-取餐出号.png') });

  // 会员登录不模拟：给一句看得懂的话，不编会员数据
  await page.goto(`http://localhost:${PORT}${PREFIX}#member`);
  const f = page.getByRole('form', { name: '会员登录' });
  await f.getByLabel('会员号').fill('100001');
  await f.getByLabel('4 位密码').fill('0000');
  await f.getByRole('button', { name: '登录会员' }).click();
  await expect(page.getByRole('alert')).toContainText('演示版不连会员数据');

  await page.goto(`http://localhost:${PORT}${PREFIX}#me`);
  await expect(page.getByRole('button', { name: '再来一单' }).first()).toBeVisible();
  expect(missing, `这些资源没加载到：${missing.join('\n')}`).toEqual([]);
});

test('正式构建里没有演示代码', () => {
  execSync('npm run build -w @app/customer', { cwd: ROOT, stdio: 'pipe' });
  const dir = resolve(ROOT, 'apps', 'customer', 'dist', 'assets');
  const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
  expect(js.some((f) => f.startsWith('demo-'))).toBe(false);
  for (const f of js) expect(readFileSync(join(dir, f), 'utf8')).not.toContain('demo-data.json');
});
