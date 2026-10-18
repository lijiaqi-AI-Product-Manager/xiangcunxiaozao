// 列表缩略图没有实拍图时的「水墨意境占位」用哪个字（43号 C2 / 47号 / 48号裁定，小样定稿规则原样搬进来）
import type { Dish } from '@pkg/contract';

/** 名字以这些字开头、又比较长时，开头两个字多半是修饰词（招牌、金秋、糖醋、湘西、湘味、特色、脆皮），跳过 */
const MODIFIER_HEADS = new Set([...'招金糖特湘脆']);

export function stripModifier(name: string): string[] {
  const c = [...name];
  return MODIFIER_HEADS.has(c[0]!) && c.length > 3 ? c.slice(2) : c;
}

/**
 * 56号：菜名实在一行放不下（字号已降到下限）才允许两行，而且只断在意思完整的地方：
 * 修饰词后面（招牌 / 剁椒鱼），或常见的饮品后缀前面（单枞鸭香 / 手打柠檬茶）；都不是就从中间断
 */
const TAILS = ['手打柠檬茶', '轻乳茶', '柠檬茶', '柠檬水', '海底椰', '（瓶装）', '（罐装）'];
export function splitName(name: string): [string, string] {
  const c = [...name];
  if (c.length < 4) return [name, ''];
  if (MODIFIER_HEADS.has(c[0]!)) return [c.slice(0, 2).join(''), c.slice(2).join('')];
  const tail = TAILS.find((t) => name.endsWith(t) && name.length > t.length + 1);
  if (tail) return [name.slice(0, name.length - tail.length), tail];
  const mid = Math.ceil(c.length / 2);
  return [c.slice(0, mid).join(''), c.slice(mid).join('')];
}

/** 同一分组里首字撞了，取（去掉修饰词后的）第三个字；第三个字也撞了就往后找没用过的字 */
export function thumbChars(groups: { dishes: Pick<Dish, 'uid' | 'name'>[] }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) {
    const used = new Set<string>();
    for (const d of g.dishes) {
      const c = stripModifier(d.name);
      let ch = c[0] ?? '';
      if (used.has(ch)) ch = [c[2], ...c.slice(3), ...c].find((x): x is string => Boolean(x) && !used.has(x!)) ?? c[0] ?? '';
      used.add(ch);
      out.set(d.uid, ch);
    }
  }
  return out;
}
