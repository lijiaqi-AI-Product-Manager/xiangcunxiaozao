import { Router } from 'express';
import type { AppDeps } from '../types.js';
import { makeAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/errors.js';
import { klDate, klDayRangeUtc } from '../utils/time.js';
import { formatRM } from '../utils/money.js';
import { PAY_LABELS } from '../services/orders.js';

const NOT_REVENUE = `status NOT IN ('cancelled', 'rejected', 'voided')`;


function monthEndNext(month: string): string {
  const d = new Date(`${month}-01T00:00:00+08:00`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

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

    // 调账（人工修正）：当日净调账 + 明细，最终营收 = 订单营收 + 净调账
    const adjRows = db
      .prepare(`SELECT id, amount_cents, reason, created_at FROM day_adjustments WHERE adj_date = ? ORDER BY id`)
      .all(date) as { id: number; amount_cents: number; reason: string; created_at: string }[];
    const adjNet = adjRows.reduce((s2, a) => s2 + a.amount_cents, 0);

    const avg = totals.n > 0 ? Math.round(totals.rev / totals.n) : 0;
    res.json({
      date,
      orders: totals.n,
      revenue_cents: totals.rev,
      revenue_rm: formatRM(totals.rev),
      adjustments: adjRows.map((a) => ({ id: a.id, amount_cents: a.amount_cents, amount_rm: (a.amount_cents >= 0 ? '+' : '-') + formatRM(Math.abs(a.amount_cents)), reason: a.reason, at: a.created_at })),
      adjustment_cents: adjNet,
      adjustment_rm: (adjNet >= 0 ? '+' : '-') + formatRM(Math.abs(adjNet)),
      final_revenue_cents: totals.rev + adjNet,
      final_revenue_rm: totals.rev + adjNet >= 0 ? formatRM(totals.rev + adjNet) : '-' + formatRM(Math.abs(totals.rev + adjNet)),
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
    const mAdj = (
      db
        .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM day_adjustments WHERE adj_date >= ? AND adj_date < ?`)
        .get(month.slice(0, 8) + '01', monthEndNext(month)) as { n: number }
    ).n;

    res.json({
      month,
      orders: totals.n,
      revenue_cents: totals.rev,
      revenue_rm: formatRM(totals.rev),
      adjustment_cents: mAdj,
      adjustment_rm: (mAdj >= 0 ? '+' : '-') + formatRM(Math.abs(mAdj)),
      final_revenue_cents: totals.rev + mAdj,
      final_revenue_rm: totals.rev + mAdj >= 0 ? formatRM(totals.rev + mAdj) : '-' + formatRM(Math.abs(totals.rev + mAdj)),
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

  // ========== 区间流水：近7天/近30天/本周/本月（10-13 高斯令） ==========
  const PRESETS = ['last7', 'last30', 'this_week', 'this_month'] as const;
  function presetRange(preset: string, ref: string): { label: string; from: string; to: string } {
    const base = new Date(`${ref}T12:00:00Z`);
    const ymd = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
    const dowMon = (d: Date) => (d.getUTCDay() + 6) % 7;
    let from: Date, to: Date, label: string;
    if (preset === 'last7') { from = addDays(base, -6); to = base; label = '近7天'; }
    else if (preset === 'last30') { from = addDays(base, -29); to = base; label = '近30天'; }
    else if (preset === 'this_week') { from = addDays(base, -dowMon(base)); to = addDays(from, 6); label = '本周'; }
    else { const m0 = new Date(`${ref.slice(0, 7)}-01T12:00:00Z`); from = m0; to = addDays(new Date(m0.getTime() + 31 * 86400000), -1); label = '本月'; }
    return { label, from: ymd(from), to: ymd(to) };
  }

  r.get('/range', auth, (req, res) => {
    const preset = (PRESETS as readonly string[]).includes(String(req.query.preset)) ? String(req.query.preset) : 'last7';
    const ref = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : klDate();
    const { label, from, to } = presetRange(preset, ref);
    const start = klDayRangeUtc(from).start;
    const end = klDayRangeUtc(to).end;

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS rev, COALESCE(SUM(discount_cents), 0) AS disc
         FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE}`
      )
      .get(start, end) as { n: number; rev: number; disc: number };
    const unpaid = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS a FROM orders
         WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE} AND paid_at IS NULL`
      )
      .get(start, end) as { n: number; a: number };
    const adjNet = (
      db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM day_adjustments WHERE adj_date >= ? AND adj_date <= ?`).get(from, to) as { n: number }
    ).n;
    const byDay = db
      .prepare(
        `SELECT date(created_at, '+8 hours') AS date, COUNT(*) AS n, SUM(total_cents) AS rev
         FROM orders WHERE created_at >= ? AND created_at < ? AND ${NOT_REVENUE} GROUP BY date ORDER BY date`
      )
      .all(start, end) as { date: string; n: number; rev: number }[];
    const list = db
      .prepare(
        `SELECT order_no, created_at, table_no, total_cents, payment_method, paid_at, status, source, note
         FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY id DESC LIMIT 500`
      )
      .all(start, end) as Array<{ order_no: string; created_at: string; table_no: string; total_cents: number; payment_method: string; paid_at: string | null; status: string; source: string; note: string }>;

    res.json({
      preset, label, from, to,
      orders: totals.n,
      revenue_cents: totals.rev,
      revenue_rm: formatRM(totals.rev),
      discount_rm: formatRM(totals.disc),
      unpaid_n: unpaid.n,
      unpaid_rm: formatRM(unpaid.a),
      adjustment_cents: adjNet,
      adjustment_rm: (adjNet >= 0 ? '+' : '-') + formatRM(Math.abs(adjNet)),
      final_revenue_cents: totals.rev + adjNet,
      final_revenue_rm: totals.rev + adjNet >= 0 ? formatRM(totals.rev + adjNet) : '-' + formatRM(Math.abs(totals.rev + adjNet)),
      by_day: byDay.map((d) => ({ date: d.date, orders: d.n, revenue_rm: formatRM(d.rev) })),
      list: list.map((o) => ({
        order_no: o.order_no, time: o.created_at, table_no: o.table_no, total_rm: formatRM(o.total_cents),
        pay: o.payment_method, paid: !!o.paid_at, status: o.status, source: o.source, note: o.note.slice(0, 40),
      })),
    });
  });

  // ========== 调账 CRUD（人工修正日报/月报：不改订单，加修正项，全程留痕） ==========
  r.post('/adjust', auth, (req, res) => {
    const date = String(req.body?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, '日期格式应为 YYYY-MM-DD');
    const amount = Math.round(Number(req.body?.amount_cents));
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10_000_000) {
      throw new HttpError(400, '调账金额非法（非零，±RM 10万以内）');
    }
    const reason = String(req.body?.reason ?? '').trim().slice(0, 120);
    if (!reason) throw new HttpError(400, '调账必须写原因（对账留痕红线）');
    db.prepare(`INSERT INTO day_adjustments(adj_date, amount_cents, reason) VALUES(?, ?, ?)`).run(date, amount, reason);
    res.status(201).json({ ok: true });
  });

  r.delete('/adjust/:id', auth, (req, res) => {
    const info = db.prepare(`DELETE FROM day_adjustments WHERE id = ?`).run(Number(req.params.id));
    if (info.changes === 0) throw new HttpError(404, '调账记录不存在');
    res.json({ ok: true });
  });

  // CSV导出（带BOM，Excel直接开）：scope=daily|monthly
  r.get('/export', auth, (req, res) => {
    if (req.query.scope === 'range') {
      const preset = (PRESETS as readonly string[]).includes(String(req.query.preset)) ? String(req.query.preset) : 'last7';
      const ref = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : klDate();
      const { label, from, to } = presetRange(preset, ref);
      const start = klDayRangeUtc(from).start;
      const end = klDayRangeUtc(to).end;
      const list = db
        .prepare(`SELECT order_no, created_at, table_no, total_cents, payment_method, paid_at, status, source, note
           FROM orders WHERE created_at >= ? AND created_at < ? ORDER BY id`)
        .all(start, end) as Array<{ order_no: string; created_at: string; table_no: string; total_cents: number; payment_method: string; paid_at: string | null; status: string; source: string; note: string }>;
      const csvR: string[] = [`# 湘村小灶区间流水（${label} ${from}~${to}）`, '单号,时间(UTC),桌号,金额(分),支付,已收,状态,来源,备注'];
      for (const o of list) csvR.push(`"${o.order_no}","${o.created_at}","${o.table_no}",${o.total_cents},"${o.payment_method}",${o.paid_at ? '是' : '否'},${o.status},${o.source},"${o.note.replace(/"/g, '""').slice(0, 60)}"`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="xcz-range-${preset}.csv"`);
      res.send('\ufeff' + csvR.join('\n'));
      return;
    }
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
