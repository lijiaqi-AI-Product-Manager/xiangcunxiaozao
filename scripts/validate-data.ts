// 数据校验：品牌配置 / token / 菜单 / 问答 四份文件逐条体检，任何一条不过就失败退出
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Brand, Faq, Menu, Tokens } from '@pkg/contract';
import { selfHostedFonts } from './font-chars.ts';

const brandId = process.env.BRAND;
if (!brandId) throw new Error('缺少 BRAND 环境变量（见根目录 .env）');
const dir = resolve('brands', brandId);
const read = (f: string): unknown => JSON.parse(readFileSync(resolve(dir, f), 'utf8'));

const problems: string[] = [];
const brand = Brand.parse(read('brand.json'));
const tokens = Tokens.parse(read('tokens.json'));
const menu = Menu.parse(read('menu.json'));
const faq = Faq.parse(read('faq.json'));

// 1. 内部ID唯一（编号允许重复，内部ID绝不允许）
const seen = new Set<string>();
for (const d of menu.dishes) {
  if (seen.has(d.uid)) problems.push(`内部ID重复：${d.uid}`);
  seen.add(d.uid);
}
// 2. 每道菜的分类都在品牌配置里登记过
for (const d of menu.dishes) {
  if (!brand.categoryOrder.includes(d.categoryKey)) problems.push(`${d.uid} 分类未登记：${d.categoryKey}`);
}
// 2b. 「详情页不写整理中」的分类也必须登记过（写错一个字母就会悄悄失效）
for (const k of brand.plainDetailCategories) if (!brand.categoryOrder.includes(k)) problems.push(`plainDetailCategories 里的分类未登记：${k}`);
// 3. 可点单的菜必须有价格
for (const d of menu.dishes) if (d.orderable && d.priceSen === null) problems.push(`${d.uid} 可点单但没有价格`);
// 4. 图片路径：只允许空或 assets/ 下的新图路径，杜绝旧图钩子（24号 #1）
for (const d of menu.dishes) {
  for (const p of [d.images.closed, d.images.exploded]) {
    if (p !== null && !p.startsWith('assets/')) problems.push(`${d.uid} 图片路径不在 assets/ 下：${p}`);
  }
}
// 5. 双图法菜才允许有分解图
for (const d of menu.dishes) {
  if (d.images.exploded !== null && d.disassembly !== 'dual-image') problems.push(`${d.uid} 不是双图法却有分解图`);
}
// 5b. 标注坐标只给 B 级（标注层）菜，且每个标注必须对应食材档案里真有的食材
for (const d of menu.dishes) {
  if (d.annotations.length && d.disassembly !== 'annotation') problems.push(`${d.uid} 不是标注层菜却有标注坐标`);
  const names = new Set(d.ingredients.map((i) => i.name));
  for (const a of d.annotations) if (!names.has(a.ingredient)) problems.push(`${d.uid} 标注「${a.ingredient}」不在食材档案里`);
}
// 6. provisional 列表里的 token 必须真实存在
for (const name of tokens.provisional) {
  const [side, key] = name.split('.') as ['customer' | 'customerSkeleton' | 'admin', string];
  if (!(key in (tokens[side] ?? {}))) problems.push(`provisional 指向不存在的 token：${name}`);
}
// 6b. 骨架态与成品态的 token 名必须一一对应（切换外观时不能缺变量）
for (const k of Object.keys(tokens.customer)) if (!(k in tokens.customerSkeleton)) problems.push(`骨架态缺少 token：${k}`);
for (const k of Object.keys(tokens.customerSkeleton)) if (!(k in tokens.customer)) problems.push(`成品态缺少 token：${k}`);
// 6c. 自托管字体（P3 第④项 + 41号）：要用某个字体画的每个字，都必须在裁剪后的字体里；新内容出现新字就提醒重新生成
for (const { name, font, chars } of selfHostedFonts(brand, menu, faq)) {
  const file = resolve(dir, font.file);
  const listFile = file.replace(/\.woff2$/, '.chars.txt');
  if (!existsSync(file) || !existsSync(listFile)) { problems.push(`${name}还没生成（${font.file}），请运行 npm run build:font`); continue; }
  const have = new Set([...readFileSync(listFile, 'utf8')]);
  const missing = chars().filter((c) => !have.has(c));
  if (missing.length) problems.push(`${name}缺 ${missing.length} 个字（${missing.slice(0, 20).join('')}），请运行 npm run build:font`);
}
// 6d. 英文标签（41号）只给登记过的分类配
for (const k of Object.keys(brand.englishLabels.categories)) if (!brand.categoryOrder.includes(k)) problems.push(`英文标签里的分类未登记：${k}`);
// 7. 问答必须是十条
const faqCount = faq.boards.reduce((n, b) => n + b.items.length, 0);
if (faqCount !== 10) problems.push(`问答应为 10 条，实际 ${faqCount}`);

if (problems.length) {
  console.error(`数据校验失败（${problems.length} 处）：\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`数据校验通过：${menu.dishes.length} 条菜品、${menu.categories.length} 个分类、${faqCount} 条问答、${brand.paymentMethods.length} 种付款方式`);
