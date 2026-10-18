// 43号任务 F：列表页「一句话」文案质量标记（只标记，不改写；清单交军师排文案库 v2.0）
// 用法：node docs/design/redesign/小样/copy-scan.mjs → 写出 文案扫描清单.md
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const brand = JSON.parse(readFileSync(join(ROOT, 'brands', env.BRAND, 'brand.json'), 'utf8'));
const menu = JSON.parse(readFileSync(join(ROOT, 'brands', env.BRAND, 'menu.json'), 'utf8'));
const catName = Object.fromEntries(menu.categories.map((c) => [c.key, c.name]));
const order = new Map(brand.categoryOrder.map((k, i) => [k, i]));

// 感官词（味觉 / 嗅觉 / 口感 / 温度 / 火候）：43号点名的 鲜 香 嫩 脆 烟火 灶 油 辣，再补同类词
const SENSE = ['鲜', '香', '嫩', '脆', '烟火', '灶', '油', '辣', '酥', '糯', '滑', '爽', '甜', '酸', '麻', '焦', '韧', '弹', '绵', '浓', '醇', '润', '甘', '咸', '烫', '冰', '凉', '汁', '镬气', '锅气', '下饭', '入味', '软', '烂', '清'];
// 纯功能描述：只说有什么、多少、怎么配
const FUNC = [/^含/, /含.{1,8}(配菜|配料)/, /附(送|赠|带)/, /可选/, /份量|分量|规格/, /\d+\s*(克|g|ml|毫升|升|L)\b/i, /适合\s*\d*\s*人/, /^(内含|配有|搭配)/];
const len = (s) => [...s.replace(/[\s，。！？；：、“”"'（）()·…—-]/g, '')].length;

const dishes = menu.dishes.filter((d) => d.orderable).sort((a, b) => order.get(a.categoryKey) - order.get(b.categoryKey) || a.code.localeCompare(b.code));
const flagged = [];
const missing = [];
for (const d of dishes) {
  if (!d.hook) { missing.push(d); continue; }
  const lacks = [];
  const sense = SENSE.filter((w) => d.hook.includes(w));
  if (!sense.length) lacks.push('缺感官词（没有味道 / 口感 / 香气 / 火候的字）');
  if (FUNC.some((r) => r.test(d.hook))) lacks.push('纯功能描述（只说有什么、怎么配）');
  if (len(d.hook) > 20) lacks.push(`超 20 字（${len(d.hook)} 字）`);
  if (lacks.length) flagged.push({ d, lacks });
}

const row = ({ d, lacks }) => `| ${d.code} | ${d.name} | ${d.hook.replace(/\|/g, '｜')} | ${lacks.join('；')} |`;
const md = `# 列表页「一句话」文案扫描清单（43号任务 F）

> 自动扫描，**只标记、不改写**，交军师排文案库 v2.0 扩版。数据来源：品牌菜单数据（可点的 ${dishes.length} 道）。
> 重新生成：\`node docs/design/redesign/小样/copy-scan.mjs\`

## 扫描规则

| 标记 | 判定 |
|---|---|
| 缺感官词 | 一句话里一个都没有：${SENSE.join(' ')} |
| 纯功能描述 | 「含 XX 配菜」「附送」「可选」「份量 / 规格」「X 克 / 毫升」「适合 X 人」「内含 / 配有 / 搭配」开头 |
| 超 20 字 | 去掉标点后超过 20 个字 |

机器判断有边界：「香」字可能出现在茶名里（如「鸭屎香」），会被算成有感官词；反过来，有画面感但没用这些字的句子会被标「缺感官词」。请军师过目时以人眼为准。

## 一、有一句话但要回炉的（${flagged.length} 道）

| 菜号 | 菜名 | 现文案 | 缺什么 |
|---|---|---|---|
${flagged.map(row).join('\n')}

## 二、还没有一句话的（${missing.length} 道）

列表页这些菜名下面是空的。按分类：

${[...new Set(missing.map((d) => d.categoryKey))].map((k) => `- **${catName[k] ?? k}**（${missing.filter((d) => d.categoryKey === k).length}）：${missing.filter((d) => d.categoryKey === k).map((d) => `${d.code ? `${d.code} ` : ''}${d.name}`).join('、')}`).join('\n')}

## 三、过线的（${dishes.length - flagged.length - missing.length} 道）

有感官词、不是功能描述、20 字以内。不在上面两张表里的就是过线的。
`;
writeFileSync(join(HERE, '文案扫描清单.md'), md);
console.log(`可点 ${dishes.length} 道：要回炉 ${flagged.length}，没有一句话 ${missing.length}，过线 ${dishes.length - flagged.length - missing.length}`);
