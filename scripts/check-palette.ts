// 56号 色彩纪律：顾客端成品态的每一个颜色 token 按色相归类。
// 允许：朱砂 / 印泥红系、暖土 / 鎏金 / 赭石系（暖色相）、墨色 / 纸白等低饱和中性色。
// 其余色相（绿、青、蓝、紫、粉）一律不许新增；仓库里已批准、特意保留的几个写在 KEEP 里，并写明理由。
// 用法：npm run check:palette            （发现未登记的异色相就失败）
//       npm run check:palette -- --base <旧 tokens.json> --write <输出 md>   （出改前→改后审计表）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Tokens } from '@pkg/contract';

const KEEP: Record<string, string> = {
  struct: '41号批准的结构色（深墨绿）：只用在英文标签、分类选中字、详情工序数字——高斯点名保留绿色的 CHEF\'S PICKS 英文',
  'alt-1': '43–49号批准的饮品区氛围（滑到饮品区背景过渡到淡绿）',
  'alt-2': '同上',
  'light-alt': '同上（饮品区光源）',
  'breath-cool': '同上（饮品区呼吸层）',
  'card-light-cool': '同上（饮品区菜卡环境光）',
};

// 审计表里「用在哪」一栏
const USE: Record<string, string> = {
  'st-done': '取餐「请取餐」状态字', 'st-done-bg': '取餐「请取餐」状态底',
  'tone-sage': '我的页「我的订单」格', 'tone-clay': '我的页「门店信息」格', 'tone-mist': '我的页「会员储值」格', 'tone-wheat': '我的页「常见问题」格',
  'struct-card': '我的页顶卡（深墨绿）', 'struct-shadow': '我的页顶卡投影', 'struct-spot': '我的页顶卡光斑',
};

type Family = '红' | '暖土/金' | '中性' | '异色相';
const parse = (s: string): [number, number, number, number][] => {
  const out: [number, number, number, number][] = [];
  for (const m of s.matchAll(/#([0-9a-fA-F]{6})\b/g)) out.push([parseInt(m[1]!.slice(0, 2), 16), parseInt(m[1]!.slice(2, 4), 16), parseInt(m[1]!.slice(4, 6), 16), 1]);
  for (const m of s.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/g)) out.push([+m[1]!, +m[2]!, +m[3]!, m[4] === undefined ? 1 : +m[4]]);
  return out;
};
function family([r, g, b, a]: [number, number, number, number]): { fam: Family; hue: number; sat: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) hue = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
  if (hue < 0) hue += 360;
  // 几乎透明、或饱和度很低（墨、纸白、灰）都算中性
  if (a < 0.06 || sat < 0.14 || l > 0.96 || l < 0.06) return { fam: '中性', hue, sat };
  if (hue >= 345 || hue < 15) return { fam: '红', hue, sat };
  if (hue < 62) return { fam: '暖土/金', hue, sat };
  return { fam: '异色相', hue, sat };
}
function audit(tokens: Record<string, string>) {
  return Object.entries(tokens).flatMap(([k, v]) => parse(v).map((c) => ({ k, v, c, ...family(c) })));
}

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!process.env.BRAND) process.loadEnvFile(resolve('.env'));
const now = Tokens.parse(JSON.parse(readFileSync(resolve('brands', process.env.BRAND!, 'tokens.json'), 'utf8'))).customer;
const rows = audit(now);
const foreign = rows.filter((r) => r.fam === '异色相');
const bad = foreign.filter((r) => !(r.k in KEEP));
const hex = ([r, g, b, a]: number[]) => `红${r} 绿${g} 蓝${b}${a! < 1 ? ` 透明度${a}` : ''}`;

const base = opt('--base');
if (base) {
  const old = Tokens.parse(JSON.parse(readFileSync(base, 'utf8'))).customer;
  const oldForeign = audit(old).filter((r) => r.fam === '异色相' && !(r.k in KEEP));
  const changed = [...new Set(oldForeign.map((r) => r.k))].map((k) => ({ k, before: old[k]!, after: now[k] ?? '（删除）' }));
  const lines = [
    '# 56号 · 色彩审计表（顾客端成品态 token）',
    '',
    '> 由 `npm run check:palette -- --base … --write …` 生成。规则：只许 朱砂 / 印泥红、暖土 / 鎏金 / 赭石、墨 / 纸白等中性色；其余色相不许新增，已批准保留的写明理由。`npm run check` 里会自动拦住新的异色相。',
    '',
    `- 改前异色相 token：${new Set(oldForeign.map((r) => r.k)).size} 个 → 改后未登记异色相：**${new Set(bad.map((r) => r.k)).size} 个**`,
    `- 特意保留（已批准）：${Object.keys(KEEP).length} 个`,
    '',
    '## 改掉的',
    '',
    '| token | 用在哪 | 改前 | 改后 |',
    '|---|---|---|---|',
    ...changed.map((c) => `| \`${c.k}\` | ${USE[c.k] ?? ''} | \`${c.before}\` | \`${c.after}\` |`),
    '',
    '## 保留的（请高斯 / 军师确认）',
    '',
    '| token | 值 | 理由 |',
    '|---|---|---|',
    ...Object.entries(KEEP).map(([k, why]) => `| \`${k}\` | \`${now[k] ?? '—'}\` | ${why} |`),
    '',
    '## 全部颜色按色相归类（改后）',
    '',
    '| 色相 | token 数 | 例子 |',
    '|---|---|---|',
    ...(['红', '暖土/金', '中性', '异色相'] as Family[]).map((f) => {
      const ks = [...new Set(rows.filter((r) => r.fam === f).map((r) => r.k))];
      return `| ${f} | ${ks.length} | ${ks.slice(0, 12).map((k) => `\`${k}\``).join(' ')}${ks.length > 12 ? ' …' : ''} |`;
    }),
    '',
  ];
  writeFileSync(opt('--write') ?? 'palette-audit.md', lines.join('\n'));
}
if (bad.length) {
  console.error(`色彩检查失败：${bad.length} 处未登记的异色相（绿 / 青 / 蓝 / 紫 / 粉）：\n- ${bad.map((r) => `${r.k}：${hex(r.c)}（色相 ${r.hue.toFixed(0)}°）`).join('\n- ')}`);
  process.exit(1);
}
console.log(`色彩检查通过：${new Set(rows.map((r) => r.k)).size} 个颜色 token，异色相只剩已批准保留的 ${new Set(foreign.map((r) => r.k)).size} 个`);
