/**
 * 老板端共用的「门店日期」工具。
 *
 * 为什么单独一个文件：日结单（report-range.ts）和历史订单（History.tsx）本来各自写了一份
 * 一模一样的 todayLocal / addDays。两边一旦分叉，「查 10-25 的单」和「结 10-25 的账」
 * 就会差出几个小时——在 UTC+8 甚至差一整天。方案书 R7 已经踩过一次，这里彻底合掉。
 *
 * 这里的函数只处理「日期」（YYYY-MM-DD），不处理「时刻」。
 * 时刻转成给人看的字符串一律走 @pkg/contract 的 formatDate / formatDateTime / formatClock。
 */

/** 门店时区的今天（YYYY-MM-DD）。用 sv-SE 是因为它固定输出 2026-10-26 这种格式，不用自己拼。 */
export function todayLocal(now: Date = new Date(), timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** 门店时区的当前小时（0-23） */
export function hourLocal(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('sv-SE', { timeZone, hour: '2-digit', hour12: false }).format(now).slice(0, 2),
  );
}

/**
 * 纯日期加减：把 2026-10-31 往后挪 1 天得到 2026-11-01。
 * 走 UTC 中午是为了避开夏令时边界（有的时区某天只有 23 小时，用本地时间加减会漏一天）。
 * 这里的 UTC 截取不是「显示时间」，是取日期本身，所以不违反时区规则。
 */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // 中午，离任何边界都远
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10); // check-allow-utc-date 纯日期加减，取日期本身，不是显示时刻
}
