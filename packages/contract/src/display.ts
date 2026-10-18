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
 * 营业日加减天数（'2026-10-17', -1 → '2026-10-16'）。营业日本身已经是门店时区的日历日，
 * 这里只做纯日历运算，和任何时区无关，所以放在时间规范的唯一出口里。
 */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
