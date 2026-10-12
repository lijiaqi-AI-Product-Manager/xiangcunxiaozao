const KL_TZ = 'Asia/Kuala_Lumpur';

/** UTC ISO 串（缺省=当前时刻）→ 吉隆坡时区的 YYYY-MM-DD */
export function klDate(isoUtc?: string): string {
  const d = isoUtc ? new Date(isoUtc) : new Date();
  if (isNaN(d.getTime())) throw new Error(`非法时间: ${isoUtc}`);
  // en-CA locale 固定输出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** 当前吉隆坡时间可读串（日志用） */
export function klNowLabel(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: KL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

/**
 * 某个吉隆坡日期对应的 UTC 时间范围 [start, end)。
 * 马来西亚无夏令时，固定 UTC+8，直接数学换算。
 */
export function klDayRangeUtc(klDateStr: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(klDateStr)) {
    throw new Error(`日期格式应为 YYYY-MM-DD，收到: ${klDateStr}`);
  }
  const start = new Date(`${klDateStr}T00:00:00+08:00`);
  if (isNaN(start.getTime())) throw new Error(`非法日期: ${klDateStr}`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}
