// 自托管字体（P3 第④项 + 41号）：书法字体、英文装饰字体都只裁出用得到的字，放进品牌目录，
// 顾客端从自己的服务器加载，不依赖谷歌字体。
// 用法：npm run build:font（菜单加了新菜、英文标签改了时重跑；数据校验会提醒）
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import subsetFont from 'subset-font';
import { Brand, Faq, Menu } from '@pkg/contract';
import { selfHostedFonts } from './font-chars.ts';

const brandId = process.env.BRAND;
if (!brandId) throw new Error('缺少 BRAND 环境变量（见根目录 .env）');
const dir = resolve('brands', brandId);
const brand = Brand.parse(JSON.parse(readFileSync(resolve(dir, 'brand.json'), 'utf8')));
const menu = Menu.parse(JSON.parse(readFileSync(resolve(dir, 'menu.json'), 'utf8')));
const faq = Faq.parse(JSON.parse(readFileSync(resolve(dir, 'faq.json'), 'utf8')));
const fonts = selfHostedFonts(brand, menu, faq);
if (!fonts.length) throw new Error('brand.json 没有配置任何自托管字体（brushFont / latinFont）');

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
for (const { name, font, chars } of fonts) {
  const source = resolve(dir, font.source);
  const output = resolve(dir, font.file);
  const list = chars();
  const subset = await subsetFont(readFileSync(source), list.join(''), {
    targetFormat: 'woff2',
    ...(font.pinWeight ? { variationAxes: { wght: font.pinWeight } } : {}),
    ...(font.weightRange ? { variationAxes: { wght: { min: font.weightRange[0], max: font.weightRange[1] } } } : {}),
  });
  writeFileSync(output, subset);
  // 字表和字体放在一起：数据校验拿它判断「新内容里有没有字体里没有的字」
  writeFileSync(output.replace(/\.woff2$/, '.chars.txt'), list.join(''));
  console.log(`${name}已生成：${list.length} 个字符，${kb(statSync(source).size)} → ${kb(subset.length)}（${font.file}）`);
}
