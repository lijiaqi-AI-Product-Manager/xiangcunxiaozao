// 把小样截图拼成并排对比图，方便老板一眼比较（先跑 capture.mjs）
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules', 'playwright', 'index.mjs')).href);
const SHOTS = join(HERE, 'shots');
const browser = await chromium.launch();
const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();
const b64 = (f) => readFileSync(join(SHOTS, f)).toString('base64');
const sheet = async (name, items) => {
  await page.setViewportSize({ width: items.length * 391 + 16, height: 900 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:8px;font:700 20px/1.4 system-ui,"Microsoft YaHei",sans-serif;display:flex;gap:16px}figure{margin:0}img{display:block;width:375px;height:812px;border:1px solid}figcaption{padding:6px 2px}</style>${items.map(([f, cap]) => `<figure><figcaption>${cap}</figcaption><img src="data:image/png;base64,${b64(f)}"></figure>`).join('')}`);
  await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};
await sheet('对比-Dock两版-同一状态.png', [['点单-淡黄-V1并入.png', 'V1 购物车并入 Dock'], ['点单-淡黄-V2现状.png', 'V2 现状版（购物车条 + Dock）']]);
await sheet('对比-淡黄vs淡绿-点单.png', [['点单-淡黄-V2现状.png', '淡黄底（推荐）'], ['点单-淡绿-V2现状.png', '淡绿底']]);
await sheet('对比-淡黄vs淡绿-详情.png', [['详情-淡黄.png', '淡黄底（推荐）'], ['详情-淡绿.png', '淡绿底']]);
await sheet('对比-结构色-深墨绿vs墨黑.png', [['详情-淡黄.png', '深墨绿（推荐）'], ['详情-淡黄-墨黑结构色.png', '墨黑']]);
await sheet('对比-氛围色-湘菜区vs饮品区.png', [['点单-淡黄-V2现状.png', '湘菜区（淡黄）'], ['点单-淡黄-饮品区氛围色.png', '滑到饮品区（过渡到淡绿）']]);
await sheet('对比-拆开看看-合拢vs展开.png', [['详情-淡黄.png', '合拢'], ['详情-淡黄-拆开看看.png', '展开（舞台升起）']]);
await browser.close();
console.log('对比图已生成');
