/**
 * 所有「可能为空」的字段只能通过这里显示。
 * 旧系统出过「桌undefined / Invalid Date」，这里是唯一出口，缺值一律兜底（21号 §3.1）。
 */

/** 1990 → "19.9"，4800 → "48"，与菜单原文写法一致 */
export function formatPrice(sen: number | null | undefined): string {
  if (typeof sen !== 'number' || !Number.isInteger(sen)) return '—';
  const sign = sen < 0 ? '-' : '';
  const abs = Math.abs(sen);
  const whole = Math.trunc(abs / 100);
  const cents = abs % 100;
  if (cents === 0) return `${sign}${whole}`;
  return cents % 10 === 0 ? `${sign}${whole}.${cents / 10}` : `${sign}${whole}.${String(cents).padStart(2, '0')}`;
}

/**
 * 1990 → "19.90"，4800 → "48.00"。**固定两位小数，只给账单类场景用。**
 *
 * 为什么不能直接用 formatPrice：
 * 菜单上「19.9」看着清爽，但日结单、看板这种一列金额叠着的地方，
 * 「553.3 / 29.7 / 0」上下对不齐，而且老板会怀疑是不是少打了一位。
 * 账单上两位小数是行业惯例，也是给顾客看的凭据该有的样子。
 */
export function formatMoney(sen: number | null | undefined): string {
  if (typeof sen !== 'number' || !Number.isInteger(sen)) return '—';
  const sign = sen < 0 ? '-' : '';
  const abs = Math.abs(sen);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatTable(table: string | number | null | undefined): string {
  if (table === null || table === undefined) return '桌 —';
  const s = String(table).trim();
  if (s === '' || s === 'undefined' || s === 'null' || s === 'NaN') return '桌 —';
  return `桌 ${s}`;
}

/**
 * 门店时区的日期 YYYY-MM-DD。不能直接截取 ISO 字符串的前 10 位：那是 UTC 日期，
 * 吉隆坡凌晨 0–8 点的记录会显示成前一天。
 */
export function formatDate(value: string | number | Date | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === '') return '----';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '----';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** 门店时区的「日期 时间」，short=true 时省略年份：10-17 00:37 */
export function formatDateTime(value: string | number | Date | null | undefined, timeZone: string, short = false): string {
  const date = formatDate(value, timeZone);
  return `${short ? date.slice(5) : date} ${formatClock(value, timeZone)}`;
}

/** 取餐号固定三位：7 → "007"；缺值 → "---" */
export function formatPickupNo(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return '---';
  return String(n).padStart(3, '0');
}

export function formatClock(value: string | number | Date | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === '') return '--:--';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '--:--';
  return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/**
 * 门店时区的「时:分:秒」，用于打印记录这类要精确到秒的场景。
 *
 * 为什么单独开一个函数：老板端原来写的是 `at.slice(11, 19)`——at 是 ISO 的 UTC 时间，
 * 截出来的是 UTC 的时分秒，吉隆坡要比它大 8 小时。晚上 7 点打的单显示成上午 11 点，
 * 老板对不上「刚才那单到底打没打出来」。
 */
export function formatClockSec(value: string | number | Date | null | undefined, timeZone: string): string {
  if (value === null || value === undefined || value === '') return '--:--:--';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

/**
 * 营业日加减天数（'2026-10-17', -1 → '2026-10-16'）。营业日本身已经是门店时区的日历日，
 * 这里只做纯日历运算，和任何时区无关，所以放在时间规范的唯一出口里。
 */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
