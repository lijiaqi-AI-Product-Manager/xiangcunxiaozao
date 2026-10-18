// 把「单页最强样」整理成可以发布成私密网页的一包文件（42号：老板手机看动效）
// 用法：node docs/design/redesign/小样/publish-prep.mjs <输出目录>
// 主页面 = 点单页（淡黄、现状版 Dock），第二页 = 详情页；字体、样式、脚本、纹理作为同目录文件一起发布
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const OUT = resolve(process.argv[2] ?? join(HERE, 'publish'));
const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const brand = JSON.parse(readFileSync(join(ROOT, 'brands', env.BRAND, 'brand.json'), 'utf8'));
mkdirSync(join(OUT, 'fonts'), { recursive: true });

for (const f of ['mock.css', 'mock.js', 'ink-wash-warm.svg', 'ink-wash-cool.svg', 'paper-grain.svg', 'xuan-fiber.svg', 'ink-bloom-warm.svg', 'ink-bloom-cool.svg', 'brush-stroke.svg', 'brush-stroke-wide.svg']) copyFileSync(join(HERE, f), join(OUT, f));
copyFileSync(join(HERE, 'tokens-淡黄.css'), join(OUT, 'tokens.css')); // 发布路径用英文名
copyFileSync(join(HERE, 'tokens-淡绿.css'), join(OUT, 'tokens-green.css'));
for (const font of [brand.brushFont, brand.latinFont, brand.bodyFont].filter(Boolean)) copyFileSync(join(ROOT, 'brands', env.BRAND, font.file), join(OUT, 'fonts', font.file.split('/').pop()));

// 中文文件名 → 发布用的英文路径（链接一起改）
const RENAME = [
  ['详情-淡黄-墨黑结构色.html', 'detail-ink.html'], ['详情-淡绿.html', 'detail-green.html'], ['详情-淡黄.html', 'detail.html'],
  ['点单-淡黄-墨黑-大画态结构.html', 'ink.html'], ['点单-淡绿-大画态结构.html', 'green.html'], ['点单-淡黄-大画态结构.html', 'hero.html'],
  ['点单-淡黄-现状版-马卡龙.html', 'mac.html'], ['点单-淡黄-Dock并入.html', 'v1.html'], ['点单-淡黄-现状版.html', 'index.html'],
  ['tokens-淡黄.css', 'tokens.css'], ['tokens-淡绿.css', 'tokens-green.css'],
];
const fix = (html) => RENAME.reduce((h, [from, to]) => h.replaceAll(from, to), html.replaceAll(`../../../../brands/${env.BRAND}/fonts/`, 'fonts/')); // 字体改成同目录

// 47号：高斯要在手机上二选一（V1 / V2、墨字 / 马卡龙）和看大画态结构——发布版顶部加一条看版本的链接（只在发布包里，设计稿本身没有）
// 48号：淡绿底、墨黑结构色两个变体（带大画态）也放进来
const VARIANTS = [['index.html', '点单-淡黄-现状版.html', 'V2 墨字'], ['mac.html', '点单-淡黄-现状版-马卡龙.html', 'V2 马卡龙'], ['v1.html', '点单-淡黄-Dock并入.html', 'V1 并入'], ['hero.html', '点单-淡黄-大画态结构.html', '大画态（多张）'],
  ['green.html', '点单-淡绿-大画态结构.html', '淡绿底'], ['ink.html', '点单-淡黄-墨黑-大画态结构.html', '墨黑结构色']];
const nav = (current) => `<nav style="position:relative;z-index:6;display:flex;gap:6px;overflow-x:auto;padding:10px 16px 0;font-size:14px;line-height:1">${VARIANTS.map(([out, , label]) => `<a href="${out}" style="flex:none;padding:8px 12px;border-radius:999px;text-decoration:none;${out === current ? 'background:#1F3D2E;color:#fff' : 'background:rgba(255,255,255,.7);color:#2B2622'}">${label}</a>`).join('')}</nav>`;
const withNav = (html, out) => html.replace(/(<div class="app">)/, `$1${nav(out)}`);

for (const [out, src] of VARIANTS) {
  const html = withNav(fix(readFileSync(join(HERE, src), 'utf8')), out);
  if (out !== 'index.html') { writeFileSync(join(OUT, out), html); continue; }
  // 主页面：发布时外面会自动包一层文档骨架，所以去掉自己的 doctype / html / head / body 标签，内容原样保留
  const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta charset[^>]*>/, '').replace(/<meta name="viewport"[^>]*>/, '').replace(/<title>[^<]*<\/title>/, '');
  const bodyAttrs = html.match(/<body([^>]*)>/)[1];
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
  writeFileSync(join(OUT, 'index.html'), `<title>湘村点单小样</title>\n${head}\n<div${bodyAttrs} hidden></div>\n${body}\n`);
}
for (const [src, out] of [['详情-淡黄.html', 'detail.html'], ['详情-淡绿.html', 'detail-green.html'], ['详情-淡黄-墨黑结构色.html', 'detail-ink.html']]) writeFileSync(join(OUT, out), fix(readFileSync(join(HERE, src), 'utf8')));
console.log(`发布包已生成：${OUT}`);
