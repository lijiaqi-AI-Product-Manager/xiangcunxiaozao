// 58号 任务5：把顾客端主程序导出成「演示版」静态网页（发老板看效果、验收走查、给任何人展示——不连生产库）
// 用法：npm run build:demo [-- <输出目录>]（默认 apps/customer/dist-demo）
// 1. 用内存数据库起一份真服务器，按正式接口拿菜单 / 问答 / 门店信息快照，今日招牌放示例配置 → demo-data.json
// 2. 用正式的构建配置打包顾客端，只多开一个开关 VITE_DEMO：页面里的 /api/* 由浏览器内模拟回答（apps/customer/src/demo.ts）
// 3. 首页整理成私密网页要的样子：去掉自己的 doctype / html / head / body（发布时会自动包一层），脚本、样式、字体用相对路径
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { createApp } from '../apps/server/src/app.ts';
import { openDb } from '../apps/server/src/db.ts';

const ROOT = resolve(import.meta.dirname, '..');
const APP = resolve(ROOT, 'apps', 'customer');
const OUT = resolve(process.argv[2] ?? join(APP, 'dist-demo'));
const BRAND_DIR = resolve(ROOT, 'brands', process.env.BRAND ?? '');
// 今日招牌示例配置：和 54号起的截图 / 录屏同一组（招牌两道 + 饮品一道），只存菜品编号，图名价都从菜单现读
const SAMPLE_TODAY = ['e06', 'e01', 'v01'];

const brand = JSON.parse(readFileSync(join(BRAND_DIR, 'brand.json'), 'utf8')) as { shortName: string };

// ---------- 1. 数据快照 ----------
const uploads = mkdtempSync(join(tmpdir(), 'xc-demo-'));
const password = `demo-${Math.random().toString(36).slice(2)}-${Date.now()}`; // 一次性内存库的临时密码，用完即弃
const { app } = createApp(openDb(':memory:'), BRAND_DIR, { adminPassword: password, uploadDir: uploads, clock: () => new Date() });
const call = async (path: string, body?: unknown, token?: string) => {
  const r = await app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<unknown>;
};
const { token } = (await call('/api/admin/login', { password })) as { token: string };
await call('/api/admin/today', { dishes: SAMPLE_TODAY }, token);
const data = {
  menu: await call('/api/menu'),
  faq: await call('/api/faq'),
  today: await call('/api/store/today'),
  info: await call('/api/store/info'), // 门店信息没提供就是全空——演示版也不编
};
rmSync(uploads, { recursive: true, force: true });

// ---------- 2. 打包 ----------
await build({
  root: APP,
  configFile: join(APP, 'vite.config.ts'),
  base: './',
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  build: { outDir: OUT, emptyOutDir: true },
  logLevel: 'warn',
});
writeFileSync(join(OUT, 'demo-data.json'), JSON.stringify(data));

// ---------- 3. 首页整理 ----------
const html = readFileSync(join(OUT, 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)![1]!
  .replace(/<meta charset[^>]*>/, '').replace(/<meta name="viewport"[^>]*>/, '')
  .replace(/<title>[^<]*<\/title>/, `<title>${brand.shortName}点单演示</title>`);
const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)![1]!;
// 字体（预加载 + @font-face）在脚本跑起来之前就会去取，构建时就改成相对路径；水墨纹理写在 CSS 变量里，由 demo.ts 运行时改成完整地址
const relFonts = (s: string) => s.replaceAll('href="/brand-font/', 'href="brand-font/').replaceAll('url("/brand-font/', 'url("brand-font/');
writeFileSync(join(OUT, 'index.html'), `${relFonts(head.trim())}\n${body.trim()}\n`);

const dishes = (data.menu as { dishes: unknown[] }).dishes.length;
console.log(`演示版已生成：${OUT}（${dishes} 道菜，今日招牌 ${(data.today as { dishes: string[] }).dishes.length} 道）`);
