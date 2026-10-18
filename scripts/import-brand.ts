// 运行当前店的导入器：原始文档 → menu.json / faq.json / reports/validation.md
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const brand = process.env.BRAND;
if (!brand) throw new Error('缺少 BRAND 环境变量（见根目录 .env）');
const brandDir = resolve('brands', brand);
const mod = (await import(pathToFileURL(resolve(brandDir, 'import', 'import.ts')).href)) as {
  run: (dir: string) => { menu: { dishes: unknown[] } };
};
const { menu } = mod.run(brandDir);
console.log(`导入完成：${menu.dishes.length} 条菜品 → ${brandDir}`);
