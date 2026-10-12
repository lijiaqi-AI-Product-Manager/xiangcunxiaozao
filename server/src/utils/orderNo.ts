import type { DB } from '../db.js';
import { klDate } from './time.js';

/**
 * 订单号 = 吉隆坡日期 + 当日流水，如 20261012-0007。
 * 必须在订单创建事务内调用（upsert counters 原子自增，并发安全不重号）。
 */
export function nextOrderNo(db: DB, nowUtc?: string): string {
  const day = klDate(nowUtc).replace(/-/g, ''); // 20261012
  const name = `order_${day}`;
  const row = db
    .prepare(
      `INSERT INTO counters(name, value) VALUES(?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1
       RETURNING value`
    )
    .get(name) as { value: number } | undefined;
  if (!row) throw new Error('生成订单号失败');
  return `${day}-${String(row.value).padStart(4, '0')}`;
}
