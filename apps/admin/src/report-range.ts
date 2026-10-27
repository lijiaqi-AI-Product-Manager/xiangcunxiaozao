/**
 * 日结单「常用时间段」的计算（纯函数，便于单测）
 *
 * 为什么单独抽出来：这段逻辑全靠「现在是几点」分支，而老板最容易踩的坑恰恰是时间——
 * 凌晨 2 点收档点「昨晚市」，如果算成今天 17:00~明天 02:00，得到的就是一张全是 0 的单子，
 * 而且它看着完全正常（时间段、班次、签字栏都在），老板会以为今天没生意。
 *
 * 一条总原则：**老板按下去，看到的必须是「现在能算的那一班」，而且这一班上已经发生的单一张都不能漏。**
 * 反过来说，只要「这张单属于今天」且「它已经发生了」，点「刚收的晚市」就必须看得到它。
 * 这条原则踩过两次坑：
 *   - 营业中（17:00 之后）：窗口指向昨天那一班，今晚的单全在外面；
 *   - 白天（02:00~17:00）：窗口也指向昨天那一班，白天这一单同样在外面
 *     （服务端的营业日按自然日算，白天下的单营业日就是今天）。
 * 现在的做法是：晚市 17:00 开、次日收档；收档之后到下一个 17:00 之间，属于「同一班还在结账」，
 * 窗口一律从这一班的开始时刻一直拉到此刻。
 */

import { addDays, hourLocal, todayLocal } from './date-local.ts';

// 日期工具已经合到 date-local.ts（历史订单页也用同一份）。这里原样再导出，
// 只是为了让已有调用方不用改 import；新代码请直接从 date-local.ts 引。
export { addDays, hourLocal, todayLocal };

export type Preset = 'today' | 'yesterday' | 'lastShift' | 'shift';
export type Range = { from: string; to: string; shift: string };

export const SHIFT_START_HOUR = 17; // 晚市 17:00 开
export const SHIFT_END_HOUR = 2; // 标准 02:00 收
export const SHIFT_HARD_END_HOUR = 6; // 06:00 之后肯定已经收完档

/**
 * 现在这个时刻属于「哪一天的晚市」——也就是这一班的开始日期。
 *
 * 17:00 之后 → 今天开的这一班正在营业；
 * 17:00 之前（含凌晨收尾、白天）→ 还没到今晚，最近的那一班是昨天开的。
 * lastShift 和 shift 共用这个判定，两者之差就是「这一班 / 下一班」。
 */
function shiftStartDay(today: string, hour: number): string {
  return hour >= SHIFT_START_HOUR ? today : addDays(today, -1);
}

/**
 * 「结到此刻」的结束点：**下一分钟的开头**，形如 `2026-10-26T18:44`。
 *
 * 两个坑都要绕：
 *   1. 光到整点（18:00）会把 18:00~18:59 这一整小时的单全部漏掉；
 *   2. 到分钟但取当前这一分钟（18:43），而服务端的「到」是**不含**的，
 *      18:43:56 下的单仍落在窗口外——刚下的单在「刚收的晚市」里看不见。
 * 取下一分钟开头，就把「此刻之前的所有单」都包进来了，而且不会把未来的单算进来。
 */
function endOfThisMinute(now: Date, timeZone: string): string {
  const hhmm = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(now); // 2026-10-26 18:43
  const [date, time] = hhmm.split(' ');
  const [h, m] = time!.split(':').map(Number) as [number, number];
  // 只用日期加减（addDays）避夏令时；小时回绕到 24 就顺延到次日 00:00
  const nextDay = h === 23 && m === 59 ? addDays(date!, 1) : date!;
  const nh = h === 23 && m === 59 ? 0 : m === 59 ? h + 1 : h;
  const nm = m === 59 ? 0 : m + 1;
  return `${nextDay}T${pad(nh)}:${pad(nm)}`;
}

export function presetRange(kind: Preset, now: Date, timeZone: string): Range {
  const t = todayLocal(now, timeZone);
  const hour = hourLocal(now, timeZone);
  const startDay = shiftStartDay(t, hour);

  if (kind === 'today') {
    // 整天不是某一班：班次必须清空，否则单子上会印着「晚市」却是 00:00~24:00 的全天账
    return { from: `${t}T00:00`, to: `${addDays(t, 1)}T00:00`, shift: '' };
  }
  if (kind === 'yesterday') {
    return { from: `${addDays(t, -1)}T00:00`, to: `${t}T00:00`, shift: '' };
  }
  if (kind === 'lastShift') {
    // 从这一班的开门时刻（17:00）一直结到此刻——**不管现在是几点**。
    // 这样「今天已经发生的单」永远不会落在窗口外面：
    //   18:20 → 今天 17:00 ~ 18:21（今晚的单在）
    //   01:30 → 昨天 17:00 ~ 01:31（凌晨的尾单在）
    //   11:20 → 昨天 17:00 ~ 11:21（白天这一单也在，它也属于今天）
    // 只有「收档之后到下一个 17:00」这段其实都在结同一班账，所以窗口一路拉着是合理的。
    return { from: `${startDay}T${pad(SHIFT_START_HOUR)}:00`, to: endOfThisMinute(now, timeZone), shift: '晚市' };
  }
  // 下一班（还没开始）：这一班的次日 17:00 到再下一日 02:00
  const nextDay = addDays(startDay, 1);
  return { from: `${nextDay}T${pad(SHIFT_START_HOUR)}:00`, to: `${addDays(nextDay, 1)}T${pad(SHIFT_END_HOUR)}:00`, shift: '晚市' };
}

const pad = (n: number) => String(n).padStart(2, '0');
