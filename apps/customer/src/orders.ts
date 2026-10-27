/**
 * 加菜单据的「收成一组」（P2-6）。
 *
 * 加菜在账上是另开一张子单（见迁移 012 的说明）：钱各记各的、退款按单退、
 * 已经下给后厨的菜不被悄悄改掉。对外则永远是「一桌一个取餐号」。
 *
 * 但接口返回的是**平的列表**，按 created_at 倒序，所以加菜的子单一定排在它父单前面。
 * 直接把第一条当「最近这单」显示，取餐页就会拿到子单——号码是对的（toDto 换成了父单号），
 * 但 addCount / groupTotalSen 这两个「这一桌一共」的字段只算在父单上，
 * 于是页面会显示成「没加过菜、合计算少了」。客人看到的号没错、钱却不对，这比报错更难发现。
 *
 * 所以列表一律先过一遍这里：子单不单独出现，它的存在只体现为父单上的 addCount。
 */
export type Groupable = {
  id: string;
  parentOrderId: string | null;
  createdAt: string;
};

/**
 * @param list 接口原样返回的订单（已按时间倒序）
 * @returns 去掉子单后的列表，顺序与原来一致
 */
export function rollUpAdditions<T extends Groupable>(list: T[]): T[] {
  const rootIds = new Set(list.filter((o) => o.parentOrderId === null).map((o) => o.id));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const o of list) {
    if (o.parentOrderId !== null) {
      // 父单不在这一页（列表被 limit 截断）时保留子单：
      // 宁可多显示一张，也不要让顾客的一顿饭凭空消失
      if (rootIds.has(o.parentOrderId)) continue;
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      out.push(o);
      continue;
    }
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push(o);
  }
  return out;
}
