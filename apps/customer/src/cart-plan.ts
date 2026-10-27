/**
 * 菜单页 / 详情页上那个「+」按下去之后，到底该发什么请求。
 *
 * 抽成纯函数是因为这里犯过一次代价很大的错：原来的写法是「先找到这道菜在购物车里的那一行，
 * 改它的数量」，找不到就什么都不做（`return null`）。听起来合理，实际后果是——
 * **顾客第一次点某道菜的「+」永远没反应**。而「第一次点」是每一道菜都会经历的那一次，
 * 所以整站点不了单。菜单页和详情页用的是同一个函数，两个入口一起坏。
 *
 * 没被发现的原因很典型：服务端测试直接打接口，实拍脚本也用接口备菜，两条路都绕过了这段代码。
 * 现在决策部分有了单元测试，纯逻辑不再需要浏览器才能验。
 */
export type PlanLine = { id: string; dishUid: string; qty: number };

export type Plan =
  /** 按「菜 + 数量」加：车里还没有这道菜时走这条 */
  | { kind: 'addDish'; dishUid: string; qty: number }
  /** 改某一行的数量：0 表示删掉这一行 */
  | { kind: 'setLine'; lineId: string; qty: number }
  /** 什么都不用做（减号点在一个本来就没有的菜上） */
  | { kind: 'none' };

const clamp = (n: number) => Math.max(0, Math.min(99, n));

/**
 * @param lines 当前购物车的行
 * @param dishUid 按哪道菜
 * @param delta +1 / -1
 */
export function planChange(lines: PlanLine[], dishUid: string, delta: number): Plan {
  const mine = lines.filter((l) => l.dishUid === dishUid);
  // 车里没有这道菜：只有加号有意义；减号点在一个本来就没有的东西上，静默忽略
  if (mine.length === 0) return delta > 0 ? { kind: 'addDish', dishUid, qty: clamp(delta) } : { kind: 'none' };
  // 同菜多行（不同辣度）时动「数量最多的那一行」：菜单页上的 + 不区分辣度，
  // 挑最多的那行加减，至少不会让顾客看到「加了两份却按了没反应」
  const top = [...mine].sort((a, b) => b.qty - a.qty)[0]!;
  return { kind: 'setLine', lineId: top.id, qty: clamp(top.qty + delta) };
}
