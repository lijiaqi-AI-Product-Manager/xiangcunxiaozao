// 数据看板简版：每个数都直接从订单、退款、储值流水三本账现算，不另存一份「统计表」（不会和账本对不上）
import { shiftDay, type Brand, type Dashboard, type DaySummary } from '@pkg/contract';
import type { DB } from './db.ts';
import { businessDate, HttpError, type Clock } from './support.ts';

interface OrderRow { id: string; business_date: string; status: string; payment_method: string; total_sen: number; stored_sen: number }
interface RefundSum { order_id: string; stored: number; counter: number }
interface LedgerRow { created_at: string; type: 'recharge' | 'consume' | 'adjust' | 'refund' | 'import'; amount_sen: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class DashboardService {
  private storedKey: string;
  private timeZone: string;
  constructor(private db: DB, brand: Brand, private clock: Clock) {
    this.timeZone = brand.timezone;
    // 储值这种付款方式的 key 取自品牌配置（要求会员的那一种），代码里不写死
    this.storedKey = brand.paymentMethods.find((m) => m.requiresMember)?.key ?? 'stored';
  }

  get(dayParam?: string | null): Dashboard {
    const today = businessDate(this.clock(), this.timeZone);
    const day = dayParam ?? today;
    if (!DAY.test(day)) throw new HttpError(400, '日期格式不对，例如 2026-10-17');
    if (day > today) throw new HttpError(400, '不能查看还没到的日子');
    const first = shiftDay(day, -6);
    const orders = this.db.prepare('SELECT id, business_date, status, payment_method, total_sen, stored_sen FROM orders WHERE business_date BETWEEN ? AND ?')
      .all(first, day) as OrderRow[];
    const refunds = new Map((this.db.prepare(`SELECT r.order_id, SUM(r.stored_sen) AS stored, SUM(r.counter_sen) AS counter
      FROM order_refunds r JOIN orders o ON o.id = r.order_id WHERE o.business_date BETWEEN ? AND ? GROUP BY r.order_id`).all(first, day) as RefundSum[])
      .map((r) => [r.order_id, r]));
    // 流水存的是时刻（UTC）；先按日历日前后各放宽一天取出来，再按门店时区换算成营业日筛选
    const ledger = (this.db.prepare('SELECT created_at, type, amount_sen FROM ledger_entries WHERE created_at >= ? AND created_at < ?')
      .all(shiftDay(first, -1), shiftDay(day, 2)) as LedgerRow[])
      .map((l) => ({ ...l, day: businessDate(new Date(l.created_at), this.timeZone) }));

    const summary = (d: string): DaySummary => {
      const live = orders.filter((o) => o.business_date === d && o.status !== 'cancelled');
      const methods = new Map<string, { orders: number; grossSen: number; refundSen: number }>();
      const add = (method: string, gross: number, refund: number) => {
        const m = methods.get(method) ?? { orders: 0, grossSen: 0, refundSen: 0 };
        m.orders += 1; m.grossSen += gross; m.refundSen += refund;
        methods.set(method, m);
      };
      let gross = 0;
      let refund = 0;
      for (const o of live) {
        const r = refunds.get(o.id) ?? { stored: 0, counter: 0 };
        gross += o.total_sen;
        refund += r.stored + r.counter;
        // 储值部分（含混合支付里的储值）记在储值；其余部分记在这单选的付款方式
        if (o.stored_sen > 0) add(this.storedKey, o.stored_sen, r.stored);
        if (o.total_sen - o.stored_sen > 0) add(o.payment_method, o.total_sen - o.stored_sen, r.counter);
      }
      const entries = ledger.filter((l) => l.day === d);
      const sum = (t: LedgerRow['type']) => entries.filter((l) => l.type === t).reduce((n, l) => n + l.amount_sen, 0);
      const stored = { rechargeSen: sum('recharge'), consumeSen: sum('consume'), refundSen: sum('refund'), adjustSen: sum('adjust'), importSen: sum('import'), netSen: 0, entries: entries.length };
      stored.netSen = stored.rechargeSen + stored.consumeSen + stored.refundSen + stored.adjustSen + stored.importSen;
      return {
        day: d,
        orders: live.length,
        cancelled: orders.filter((o) => o.business_date === d && o.status === 'cancelled').length,
        grossSen: gross,
        refundSen: refund,
        netSen: gross - refund,
        byMethod: [...methods].map(([method, m]) => ({ method, ...m, netSen: m.grossSen - m.refundSen })).sort((a, b) => b.netSen - a.netSen),
        stored,
      };
    };

    const week = Array.from({ length: 7 }, (_, i) => summary(shiftDay(first, i))).map((s) => ({ day: s.day, orders: s.orders, netSen: s.netSen, storedNetSen: s.stored.netSen }));
    const balance = (this.db.prepare('SELECT COALESCE(SUM(balance_sen), 0) AS n FROM members').get() as { n: number }).n;
    return { today, day: summary(day), week, storedBalanceSen: balance };
  }
}
