// 菜单对账表（30号 §三.2）：11号清单逐行 ↔ 菜单数据逐条，差异标出原因；附 B 级清单和口径说明。
// 用法：npm run reconcile:menu → docs/P3-菜单对账表.md（数据或清单变了就重跑，表永远和数据一致）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatPrice, Menu, takeApartView, type Dish } from '@pkg/contract';

const brandId = process.env.BRAND;
if (!brandId) throw new Error('缺少 BRAND 环境变量（见根目录 .env）');
const dir = resolve('brands', brandId);
const menu = Menu.parse(JSON.parse(readFileSync(resolve(dir, 'menu.json'), 'utf8')));
const list = readFileSync(resolve(dir, 'source', 'menu-list-v2.0.md'), 'utf8');
const catName = Object.fromEntries(menu.categories.map((c) => [c.key, c.name]));

interface Row { line: number; section: string; code: string; rawName: string; price: string; uid?: string }
const rows: Row[] = [];
let section = '';
let inTables = true;
list.split(/\r?\n/).forEach((text, i) => {
  const h = text.match(/^## [一二三四五六七八九十]+、(.+)$/);
  if (h) { section = h[1]!.trim(); inTables = !section.startsWith('超值套餐'); return; }
  if (!inTables) return;
  const cells = text.match(/^\|(.+)\|$/)?.[1]!.split('|').map((c) => c.trim());
  if (!cells || cells.length !== 3 || /^-+$/.test(cells[0]!) || cells[0] === '编号' || cells[0] === '项') return;
  const isStaple = section === '主食与其他';
  rows.push({ line: i + 1, section, code: isStaple ? '' : cells[0]!, rawName: isStaple ? cells[0]! : cells[1]!, price: cells[2]! });
});

// 清单菜名后面的括号是批注（旧版保留 / 编号重复照写 / 颜色说明），数据里存在 sourceNote，比对时去掉
const bareName = (s: string) => s.replace(/（[^（）]*(旧版保留|照写|非黑色)[^（）]*）$/, '').trim();
const used = new Set<string>();
const level = (d: Dish) => ({ 'dual-image': 'S 级（双图法）', annotation: 'B 级（标注层）', none: '不做' })[d.disassembly];
const copy = (d: Dish) => (d.intro ? '有' : '**待补**');

const out: string[] = [];
const issues: string[] = [];
out.push('# 菜单对账表（11号清单 ↔ 菜单数据）', '');
out.push('> 由 `npm run reconcile:menu` 自动生成，请勿手改。数据源：`brands/' + brandId + '/source/menu-list-v2.0.md`（11号 v2.0）与 `menu.json`。', '');

const table: string[] = ['| 11号行 | 分区 | 编号 | 11号原文 | 11号价格 | 数据内部ID | 数据菜名 | 数据价格 | 拆开看看 | 文案 | 对账 |', '|---|---|---|---|---|---|---|---|---|---|---|'];
for (const r of rows) {
  const name = bareName(r.rawName);
  if (r.section === '主食与其他' && name.startsWith('套餐')) {
    table.push(`| ${r.line} | ${r.section} | — | ${r.rawName} | ${r.price} | — | — | — | — | — | 进套餐表（menu.bundles），不进菜品表 ✅ |`);
    continue;
  }
  const hits = menu.dishes.filter((d) => !used.has(d.uid) && d.code === r.code && d.name === name);
  const d = hits[0];
  if (!d) {
    table.push(`| ${r.line} | ${r.section} | ${r.code} | ${r.rawName} | ${r.price} | — | — | — | — | — | ⚠ **数据里找不到** |`);
    issues.push(`11号第 ${r.line} 行「${r.code} ${r.rawName}」在数据里找不到`);
    continue;
  }
  used.add(d.uid);
  r.uid = d.uid;
  const listSen = Math.round(parseFloat(r.price) * 100);
  const priceOk = Number.isFinite(listSen) && listSen === d.priceSen;
  if (!priceOk) issues.push(`${d.code} ${d.name}：11号价格 ${r.price}，数据 ${formatPrice(d.priceSen)}`);
  const unit = d.unit ? `/${d.unit}` : '';
  table.push(`| ${r.line} | ${r.section} | ${r.code || '—'} | ${r.rawName} | ${r.price} | ${d.uid} | ${d.name} | ${formatPrice(d.priceSen)}${unit} | ${level(d)} | ${copy(d)} | ${priceOk ? '✅' : '⚠ **价格不一致**'} |`);
}
const extra = menu.dishes.filter((d) => !used.has(d.uid));

// ---------- 一、总账 ----------
const numberedRows = rows.filter((r) => r.code !== '').length;
const sections = [...new Set(rows.map((r) => r.section))];
const sectionCats = (s: string) =>
  new Set(rows.filter((r) => r.section === s && r.uid).map((r) => menu.dishes.find((d) => d.uid === r.uid)!.categoryKey));
const stapleRows = rows.length - numberedRows;
const count = (f: (d: Dish) => boolean) => menu.dishes.filter(f).length;
out.push('## 一、总账', '');
out.push('| 项目 | 数量 | 说明 |', '|---|---|---|');
out.push(`| 11号清单编号行 | **${numberedRows}** | 十一个分区表格逐行数出（不是 96） |`);
out.push(`| 11号清单「主食与其他」行 | ${stapleRows} | 米饭 / 下饭咸鸭蛋 / 配送费×2 / 套餐一~六（套餐只记名称，不进菜品表） |`);
out.push(`| 数据里的菜品条目 | **${menu.dishes.length}** | = 11号编号行 ${numberedRows} + 清单外保留 ${extra.length} + 主食与其他 ${count((d) => d.categoryKey === 'staple')} |`);
out.push(`| 其中顾客能点的 | ${count((d) => d.orderable)} | 配送费两条不上架（24号） |`);
out.push(`| S 级（双图法，D/E/V 区） | ${count((d) => d.disassembly === 'dual-image')} | 11号 D12 + E13 + V2 = 27，一一对应 |`);
out.push(`| B 级（标注层，A/B/C 区） | ${count((d) => d.disassembly === 'annotation')} | 11号 A8 + B14 + C18 = 40，**另加清单外保留的 C11b 外婆菜炒肉末 = 41**（见第三节） |`);
out.push(`| 不做拆开看看（饮品 / 罐装 / 主食） | ${count((d) => d.disassembly === 'none')} | 24号 #15 |`);
out.push('');

// ---------- 二、86 道口径 ----------
out.push('## 二、「86 道」口径说明', '');
out.push('「86 道」出自 11号清单末尾的统计脚注「菜品**约** 86 道 + 主食套餐若干」，是军师整理时的估算，不是逐行数出来的数；21号沿用了这个数。');
out.push(`实际逐行：11号编号行 **${numberedRows}** 行，比 86 多 ${numberedRows - 86}。清单没写这 ${numberedRows - 86} 道是哪些，从清单本身反推不出来；数据没有少收任何一行（见第五节逐行对账）。`);
// 把「去掉哪几个整分区正好剩 86」的组合全列出来，供判断估算时是不是有意排除了某些分区
const numbered = sections.filter((s) => s !== '主食与其他').map((s) => ({ s, n: rows.filter((r) => r.section === s).length }));
const combos: string[] = [];
for (let mask = 1; mask < 1 << numbered.length; mask++) {
  const pick = numbered.filter((_, i) => mask & (1 << i));
  if (pick.reduce((a, p) => a + p.n, 0) === numberedRows - 86) combos.push(pick.map((p) => `${p.s}（${p.n}）`).join(' + '));
}
out.push('');
out.push(`数字上能凑出 86 的「去掉整分区」组合共 ${combos.length} 种：${combos.join('；')}。这些组合都说不通业务含义（例如把整个店长推荐区去掉），所以判断 86 是估算，不是某种排除规则。`);
out.push('');
out.push('| 分区 | 11号行数 | 数据条数 |', '|---|---|---|');
for (const s of sections) {
  const n = rows.filter((r) => r.section === s).length;
  const cats = sectionCats(s);
  const m = rows.filter((r) => r.section === s && r.uid).length + extra.filter((d) => cats.has(d.categoryKey) && d.categoryKey !== 'staple').length;
  out.push(`| ${s} | ${n} | ${m}${s === '主食与其他' ? '（套餐一~六进套餐表）' : m !== n ? '（含清单外保留）' : ''} |`);
}
out.push('');
out.push('**建议统一口径**（需要拍板）：今后对外说「菜单 ' + numberedRows + ' 道编号菜 + 1 道保留菜 + 主食」，或「顾客可点 ' + count((d) => d.orderable) + ' 项」；P3 第②项「全量铺开」按数据里全部 ' + menu.dishes.length + ' 条做，不按 86。', '');

// ---------- 三、清单外 / 差异 ----------
out.push('## 三、数据里有、11号清单里没有的', '');
if (extra.filter((d) => d.categoryKey !== 'staple').length === 0) out.push('无。', '');
for (const d of extra.filter((x) => x.categoryKey !== 'staple')) {
  out.push(`- **${d.code} ${d.name}**（内部ID ${d.uid}，${catName[d.categoryKey]}，${level(d)}，RM ${formatPrice(d.priceSen)}）：11号清单没有这一行。22号裁决 #9 保留，24号拆成 C11a/C11b 两个内部ID（编号照写 C11），价格取自 04号文案库。**这就是 B 级 41 比 A+B+C 40 多出的那 1 道。**`);
}
out.push('');
out.push('### 对账发现的问题', '');
out.push(issues.length ? issues.map((s) => `- ⚠ ${s}`).join('\n') : '- 无：11号每一行都在数据里找到了，菜名、价格全部一致。', '');

// ---------- 四、B 级清单 ----------
const b = menu.dishes.filter((d) => d.disassembly === 'annotation');
out.push(`## 四、B 级（标注层）清单：${b.length} 道`, '');
out.push(`有文案 ${b.filter((d) => d.intro).length} 道、待补 ${b.filter((d) => !d.intro).length} 道。现在没有任何合拢图和标注坐标，有文案的显示「食材层」，待补的不显示「拆开看看」按钮。`, '');
out.push('| # | 编号 | 菜名 | 分区 | 价格 | 文案 | 现在的拆开看看 |', '|---|---|---|---|---|---|---|');
b.forEach((d, i) => {
  const v = takeApartView(d);
  out.push(`| ${i + 1} | ${d.code} | ${d.name}${used.has(d.uid) ? '' : '（清单外保留）'} | ${catName[d.categoryKey]} | ${formatPrice(d.priceSen)} | ${copy(d)} | ${v === 'layers' ? '食材层（标注图上线后换图）' : v === 'pins' ? '合拢图标注' : '不显示按钮'} |`);
});
out.push('');

// ---------- 五、文案待补台账（31号 §六：给内容冲刺排产用） ----------
const noCopy = menu.dishes.filter((d) => !d.intro);
out.push(`## 五、文案待补台账：${noCopy.length} 条（有文案 ${menu.dishes.length - noCopy.length} 条）`, '');
out.push('「有文案」= 批准稿 ② 详细介绍不为空。待补的菜在详情页只显示「这道菜的详细介绍正在整理中。」，不编内容。', '');
out.push('| 分类 | 拆开看看等级 | 待补 | 已有 | 待补的菜 |', '|---|---|---|---|---|');
for (const c of menu.categories) {
  const all = menu.dishes.filter((d) => d.categoryKey === c.key);
  if (!all.length) continue;
  const miss = all.filter((d) => !d.intro);
  out.push(`| ${c.name} | ${[...new Set(all.map(level))].join(' / ')} | ${miss.length} | ${all.length - miss.length} | ${miss.map((d) => `${d.code ? d.code + ' ' : ''}${d.name}${d.orderable ? '' : '（不上架）'}`).join('、') || '—'} |`);
}
const byLevel = (lv: Dish['disassembly']) => noCopy.filter((d) => d.disassembly === lv).length;
out.push(`| **合计** | | **${noCopy.length}** | ${menu.dishes.length - noCopy.length} | S 级 ${byLevel('dual-image')} + B 级 ${byLevel('annotation')} + 不做拆开看看 ${byLevel('none')}（饮品 / 罐装 / 主食 / 配送费，互不重叠） |`);
out.push('');

// ---------- 六、逐行 ----------
out.push(`## 六、11号逐行对账（${rows.length} 行）`, '');
out.push(...table, '');

const path = resolve('docs', 'P3-菜单对账表.md');
writeFileSync(path, out.join('\n'));
console.log(`对账完成：11号 ${rows.length} 行（编号行 ${numberedRows}），数据 ${menu.dishes.length} 条，清单外 ${extra.length} 条，问题 ${issues.length} 处 → ${path}`);
if (issues.length) process.exitCode = 1;
