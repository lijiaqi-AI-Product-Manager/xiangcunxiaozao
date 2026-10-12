import { Router } from 'express';
import type { AppDeps } from '../types.js';
import { makeAuth } from '../middleware/auth.js';
import { klDate, klDayRangeUtc } from '../utils/time.js';
import { formatRM } from '../utils/money.js';
import { PAY_LABELS } from '../services/orders.js';

const NOT_REVENUE = `status NOT IN ('cancelled', 'rejected', 'voided')`;

function monthRange(month: string): { start: string; end: string; days: number } {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`月份格式应为 YYYY-MM，收到: ${month}`);
  const startD = new Date(`${month}-01T00:00:00+08:00`);
  if (isNaN(startD.getTime())) throw new Error(`非法月份: ${month}`);
  const endD = new Date(startD.getTime());
  endD.setUTCMonth(endD.getUTCMonth() + 1);
  const days = Math.round((endD.getTime() - startD.getTime()) / 86400000);
  return { start: startD.toISOString(), end: endD.toISOString(), days };
}

/** 购物篮共现：同单出现过的菜品对（外卖A/B套餐组合分析的通用算法） */
function coOccurrence(
  db: AppDeps['db'],
  start: string,
  end: string
): { a: string; b: string; count: number }[] {
  const rows = db
    .prepare(
      `SELECT o.id AS oid, oi.dish_name AS name FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at >= ? AND o.created_at < ? AND ${NOT_REVENUE}
       ORDER BY o.id`
    )
    .all(start, end) as { oid: number; name: string }[];
  const byOrder = new Map<number, string[]>();
  for (const r of rows) {
    const list = byOrder.get(r.oid) ?? [];
    if (!list.includes(r.name)) list.push(r.name);
    byOrder.set(r.oid, list);
  }
  const pairs = new Map<string, number>();
  for (const names of byOrder.values()) {
    if (names.length < 2) continue;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const key = [names[i], names[j]].sort().join('|||');
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  return [...pairs.entries()]
    .map(([k, count]) => {
      const [a, b] = k.split('|||');
      return { a, b, count };
    })
    .sort((x, y) => y.count - x.count)
    .slice(0, 15);
}

/** 日报+月报+CSV导出（导出给大模型做组合分析/强化学习） */
export default function reportsRoutes(deps: AppDeps): Router {
  const r = Router();
  const { db } = deps;
  const auth = makeAuth(deps.adminToken, deps.kitchenToken).admin;

  r.get('/daily', auth, (req, res) => {
    const date =
      typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : klDate();
    const { start, end } = klDayRangeUtc(date);

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS rev, COALESCE(SUM(discount_cents), 0) AS disc
         FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE}`
      )
      .get(start, end) as { n: number; rev: number; disc: number };

    const unpaid = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS amount
         FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE} AND paid_at IS NULL`
      )
      .get(start, end) as { n: number; amount: number };

    const payments = db
      .prepare(
        `SELECT payment_method AS m, COUNT(*) AS n, SUM(total_cents) AS amount
         FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE} AND payment_method != ''
         GROUP BY payment_method ORDER BY amount DESC`
      )
      .all(start, end) as { m: string; n: number; amount: number }[];

    const cancelledRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? AND status='cancelled'`
      )
      .get(start, end) as { n: number };
    const rejectedRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? AND status='rejected'`
      )
      .get(start, end) as { n: number };
    const voidedRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? AND status='voided'`
      )
      .get(start, end) as { n: number };

    const byStatus = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM orders WHERE created_at >= ? AND created_at < ? GROUP BY status`
      )
      .all(start, end) as { status: string; n: number }[];

    const topDishes = db
      .prepare(
        `SELECT oi.dish_name, SUM(oi.qty) AS qty, SUM(oi.subtotal_cents) AS amount
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= ? AND o.created_at < ? AND ${NOT_REVENUE.replace(/status/g, 'o.status')}
         GROUP BY oi.dish_id, oi.dish_name ORDER BY qty DESC LIMIT 20`
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
      discount_cents: totals.disc,
      discount_rm: formatRM(totals.disc),
      unpaid_n: unpaid.n,
      unpaid_cents: unpaid.amount,
      unpaid_rm: formatRM(unpaid.amount),
      payments: payments.map((p) => ({
        method: p.m,
        label: PAY_LABELS[p.m] ?? p.m,
        n: p.n,
        amount_cents: p.amount,
        amount_rm: formatRM(p.amount),
      })),
      cancelled: cancelledRow?.n ?? 0,
      rejected: rejectedRow?.n ?? 0,
      voided: voidedRow?.n ?? 0,
      by_status: byStatus,
      top_dishes: topDishes.map((d) => ({
        dish_name: d.dish_name,
        qty: d.qty,
        amount_cents: d.amount,
        amount_rm: formatRM(d.amount),
      })),
    });
  });

  r.get('/monthly', auth, (req, res) => {
    const month =
      typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
        ? req.query.month
        : klDate().slice(0, 7);
    let range: { start: string; end: string };
    try {
      range = monthRange(month);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    const { start, end } = range;

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS rev, COALESCE(SUM(discount_cents), 0) AS disc
         FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE}`
      )
      .get(start, end) as { n: number; rev: number; disc: number };

    // 分桶必须按吉隆坡日界（UTC+8）：SQLite date()+'+8 hours'，杜绝凌晨单归错天
    const klByDay = (
      db
        .prepare(
          `SELECT date(created_at, '+8 hours') AS date, COUNT(*) AS orders, SUM(total_cents) AS revenue_cents
           FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE}
           GROUP BY date ORDER BY date`
        )
        .all(start, end) as Array<{ date: string; orders: number; revenue_cents: number }>
    ).map((x) => ({ ...x, revenue_rm: formatRM(x.revenue_cents) }));

    const topDishes = db
      .prepare(
        `SELECT oi.dish_name, SUM(oi.qty) AS qty, SUM(oi.subtotal_cents) AS amount
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= ? AND o.created_at < ? AND ${NOT_REVENUE.replace(/status/g, 'o.status')}
         GROUP BY oi.dish_id, oi.dish_name ORDER BY qty DESC LIMIT 30`
      )
      .all(start, end) as { dish_name: string; qty: number; amount: number }[];

    const pairs = coOccurrence(db, start, end);

    res.json({
      month,
      orders: totals.n,
      revenue_cents: totals.rev,
      revenue_rm: formatRM(totals.rev),
      discount_rm: formatRM(totals.disc),
      avg_order_rm: formatRM(totals.n > 0 ? Math.round(totals.rev / totals.n) : 0),
      by_day: klByDay,
      top_dishes: topDishes.map((d) => ({
        dish_name: d.dish_name,
        qty: d.qty,
        amount_rm: formatRM(d.amount),
      })),
      top_pairs: pairs, // 组合分析：外卖A/B套餐上线后直接复用
    });
  });

  // CSV导出（带BOM，Excel直接开）：scope=daily|monthly
  r.get('/export', auth, (req, res) => {
    const scope = String(req.query.scope ?? 'daily');
    const csv: string[] = [];
    if (scope === 'daily') {
      const date =
        typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
          ? req.query.date
          : klDate();
      const { start, end } = klDayRangeUtc(date);
      const rows = db
        .prepare(
          `SELECT o.order_no, o.table_no, o.status, o.total_cents, o.discount_cents, o.payment_method,
                  o.paid_at, o.created_at,
                  (SELECT GROUP_CONCAT(oi.dish_name || ' x' || oi.qty || ' @' || oi.unit_price_cents, ' | ')
                   FROM order_items oi WHERE oi.order_id = o.id) AS items
           FROM orders o WHERE o.created_at >= ? AND o.created_at < ? ORDER BY o.id`
        )
        .all(start, end) as Record<string, unknown>[];
      csv.push('日期,订单号,桌号,状态,总金额(分),优惠(分),支付方式,已收款,下单时间,菜品明细');
      const label: Record<string, string> = { pending: '待接单', confirmed: '制作中', served: '已上桌', cancelled: '已取消', rejected: '已拒绝', voided: '已作废' };
      for (const o of rows) {
        csv.push(
          [
            date,
            o.order_no,
            o.table_no,
            label[String(o.status)] ?? o.status,
            o.total_cents,
            o.discount_cents,
            PAY_LABELS[String(o.payment_method)] ?? o.payment_method ?? '',
            o.paid_at ? '是' : '否',
            o.created_at,
            String(o.items ?? ''),
          ]
            .map((x) => `"${String(x).replace(/"/g, '""')}"`)
            .join(',')
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="xcz-daily-${date}.csv"`);
      res.send('\ufeff' + csv.join('\n'));
      return;
    }

    // monthly：三个区块——日汇总 / 菜品销量 / 组合共现
    const month =
      typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month)
        ? req.query.month
        : klDate().slice(0, 7);
    const range = monthRange(month);
    const byDay = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS d, COUNT(*) AS n, SUM(total_cents) AS rev
         FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE} GROUP BY d`
      )
      .all(range.start, range.end) as { d: string; n: number; rev: number }[];
    const topDishes = db
      .prepare(
        `SELECT oi.dish_name, SUM(oi.qty) AS qty, SUM(oi.subtotal_cents) AS amount
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.created_at >= ? AND o.created_at < ? AND ${NOT_REVENUE.replace(/status/g, 'o.status')}
         GROUP BY oi.dish_id, oi.dish_name ORDER BY qty DESC`
      )
      .all(range.start, range.end) as { dish_name: string; qty: number; amount: number }[];
    const pairs = coOccurrence(db, range.start, range.end);

    csv.push('# 湘村小灶月度报告（供分析）', `月份,${month}`, '');
    csv.push('## 每日汇总', '日期,订单数,营收(分)');
    for (const d of byDay) csv.push(`${d.d},${d.n},${d.rev}`);
    csv.push('', '## 菜品销量', '菜名,销量,销售额(分)');
    for (const d of topDishes) csv.push(`"${d.dish_name}",${d.qty},${d.amount}`);
    csv.push('', '## 组合共现（同单搭配次数，外卖套餐设计参考）', '菜品A,菜品B,同单次数');
    for (const p of pairs) csv.push(`"${p.a}","${p.b}",${p.count}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="xcz-monthly-${month}.csv"`);
    res.send('\ufeff' + csv.join('\n'));
  });

  return r;
}
