import { Router } from 'express';
import type { AppDeps } from '../types.js';
import { makeAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';
import { klDate, klDayRangeUtc } from '../utils/time.js';
import { formatRM } from '../utils/money.js';

/** 日报（老板后台）。收入口径：非 cancelled 订单；按吉隆坡时区归日 */
export default function reportsRoutes(deps: AppDeps): Router {
  const r = Router();
  const { db } = deps;
  const auth = makeAuth(deps.adminToken, deps.kitchenToken);

  r.get('/daily', auth.admin, (req, res) => {
    const date =
      typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : klDate();
    const { start, end } = klDayRangeUtc(date);
    try {
      klDayRangeUtc(date); // 双保险校验
    } catch (e) {
      throw new HttpError(400, `日期非法: ${req.query.date}`);
    }

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS rev
         FROM orders
         WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'`
      )
      .get(start, end) as { n: number; rev: number };

    const byStatus = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM orders
         WHERE created_at >= ? AND created_at < ? GROUP BY status`
      )
      .all(start, end) as { status: string; n: number }[];

    const cancelledRow = byStatus.find((x) => x.status === 'cancelled');
    const topDishes = db
      .prepare(
        `SELECT oi.dish_name, SUM(oi.qty) AS qty, SUM(oi.subtotal_cents) AS amount
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled'
         GROUP BY oi.dish_id, oi.dish_name
         ORDER BY qty DESC LIMIT 10`
      )
      .all(start, end) as { dish_name: string; qty: number; amount: number }[];

    const avg = totals.n > 0 ? Math.round(totals.rev / totals.n) : 0;
    res.json({
      date,
      orders: totals.n,
      revenue_cents: totals.rev,
      revenue_rm: formatRM(totals.rev),
      avg_order_cents: avg,
      avg_order_rm: formatRM(avg),
      cancelled: cancelledRow?.n ?? 0,
      by_status: byStatus,
      top_dishes: topDishes.map((d) => ({
        dish_name: d.dish_name,
        qty: d.qty,
        amount_cents: d.amount,
        amount_rm: formatRM(d.amount),
      })),
    });
  });

  return r;
}
