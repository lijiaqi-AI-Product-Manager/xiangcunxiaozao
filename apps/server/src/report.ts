/**
 * 日结单 / 交接班报表（P2-4）
 *
 * 设计上只有一条原则：**不新写一套算账逻辑**。
 * 付款方式怎么拆、储值怎么记、退款怎么归属，全部和「数据看板」同一个口径，
 * 否则同一天看板和日结单会给出两个数——老板拿着两张纸对不上，比没有报表更糟。
 *
 * 与看板的差别只有两个：
 *   ① 看板按「营业日」（整天），这里按「任意时间段」，可以跨零点（晚市 17:00 到次日 02:00）
 *   ② 这里多算交接班必需的两项：每天菜卖了多少份、退款有多少是退卡里、多少要数现金
 */
import { shiftDay, type Brand, type DayReport } from '@pkg/contract';
import type { DB } from './db.ts';
import { businessDate, HttpError, type Clock } from './support.ts';

interface OrderRow { id: string; status: string; payment_method: string; total_sen: number; stored_sen: number; created_at: string }
interface RefundRow { order_id: string; stored: number; counter: number }
interface LedgerRow { created_at: string; type: 'recharge' | 'consume' | 'adjust' | 'refund' | 'import'; amount_sen: number }
interface ItemRow { name: string; qty: number; price_sen: number }

/** 时间段最长 31 天：老板真的需要更长的区间，应该去看板按周看，而不是打一张三米长的纸 */
const MAX_SPAN_DAYS = 31;

export class ReportService {
  private timeZone: string;
  private storedKey: string;
  constructor(private db: DB, brand: Brand, private clock: Clock) {
    this.timeZone = brand.timezone;
    this.storedKey = brand.paymentMethods.find((m) => m.requiresMember)?.key ?? 'stored';
  }

  /**
   * 生成一份报表。
   * from / to 是 ISO 时刻或「YYYY-MM-DD HH:mm」本地时间字符串；
   * 只给日期时，from 取当天 00:00、to 取次日 00:00（不含）——即「这一整天」。
   */
  build(fromInput: string, toInput: string): DayReport {
    const { from, to } = this.parseRange(fromInput, toInput);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const orders = this.db
      .prepare('SELECT id, status, payment_method, total_sen, stored_sen, created_at FROM orders WHERE created_at >= ? AND created_at < ?')
      .all(fromIso, toIso) as OrderRow[];
    const refunds = new Map(
      (this.db
        .prepare(`SELECT r.order_id, SUM(r.stored_sen) AS stored, SUM(r.counter_sen) AS counter
                  FROM order_refunds r WHERE r.at >= ? AND r.at < ? GROUP BY r.order_id`)
        .all(fromIso, toIso) as RefundRow[]).map((r) => [r.order_id, r]),
    );
    // 这张单有没有退过款（不限本时间段）。决定它算不算营收，见下面 live 的注释
    const refundedOrders = new Set(
      (this.db.prepare('SELECT DISTINCT order_id FROM order_refunds').all() as { order_id: string }[]).map((r) => r.order_id),
    );
    const ledger = this.db
      .prepare('SELECT created_at, type, amount_sen FROM ledger_entries WHERE created_at >= ? AND created_at < ?')
      .all(fromIso, toIso) as LedgerRow[];

    /**
     * 哪些单计入营收。
     *
     * 规则：状态不是「已取消」，**或者**这张单退过款。
     *
     * 为什么不能简单按「已取消就不算」：
     * 一整单全部退完之后，系统会把它自动置为 cancelled（顾客看到「全部退款」）。
     * 如果这单的下单和退款落在同一个时间段里，两边一起消失、净额仍是 0，看不出问题；
     * 但只要跨了时间段（今天卖、明天退），就会变成：今天的账上没有这笔收入，明天的账上也没有这笔退款，
     * 钱在两个班次之间凭空消失——交接班对账时最难解释的就是这种情况。
     * 保留退过款的取消单，「下单 +19.90 / 退款 −19.90」就能在同一张报表里互相抵消，
     * 老板看到的永远是「这一班实际净收多少」，而不是「这一班还有哪些单没被取消」。
     */
    const live = orders.filter((o) => o.status !== 'cancelled' || refundedOrders.has(o.id));
    const liveIds = new Set(live.map((o) => o.id));

    const methods = new Map<string, { orders: number; grossSen: number; refundSen: number }>();
    const add = (method: string, gross: number, refund: number) => {
      const m = methods.get(method) ?? { orders: 0, grossSen: 0, refundSen: 0 };
      m.orders += 1;
      m.grossSen += gross;
      m.refundSen += refund;
      methods.set(method, m);
    };
    let gross = 0;
    let refundStored = 0;
    let refundCounter = 0;

    /**
     * 退款总额：独立按「退款发生的时间」统计，不依赖那张单本身在不在这个时间段里。
     *
     * 这一点和看板不同，是有意为之。看板按整天看，单和退款落在同一天的窗口内，挂在订单上没问题；
     * 但日结单是按「班次」切的，最常见的情形恰恰是：晚班卖了，第二天早班客人来投诉退款。
     * 如果退款只能挂在「时间段内的订单」上，这笔退款就哪一班都进不去——柜台明明退出去 19.90，
     * 两张纸上都看不见。退款属于「谁掏的钱算谁的班」，所以按退款时刻归属。
     */
    for (const r of refunds.values()) {
      refundStored += r.stored;
      refundCounter += r.counter;
    }

    // 这些退款对应的单不在本时间段（典型的「今天退昨天的单」）。
    // 它们没有订单可挂，但钱确实从收银台出去了，必须给它们一个落点，
    // 否则付款方式明细加起来会比报表总额少一截，对不上账。
    const orphanRefunds = [...refunds].filter(([orderId]) => !liveIds.has(orderId));
    for (const [orderId, r] of orphanRefunds) {
      if (r.stored > 0) add(this.storedKey, 0, r.stored);
      if (r.counter > 0) {
        // 按原单当时选的付款方式归类，这样「现金退了多少」和当初「现金收了多少」在同一行里对得上
        const row = this.db.prepare('SELECT payment_method FROM orders WHERE id = ?').get(orderId) as { payment_method: string } | undefined;
        add(row?.payment_method ?? 'cash', 0, r.counter);
      }
    }
    for (const o of live) {
      // 这一单在「本时间段内」退的钱（跨班次的退款已经单独算进退款总额，不在这里重复）
      const r = refunds.get(o.id) ?? { stored: 0, counter: 0 };
      gross += o.total_sen;
      // 混合支付的单拆成两条：储值那部分记储值，剩下的记这单选的付款方式（与看板同一规则）
      if (o.stored_sen > 0) add(this.storedKey, o.stored_sen, r.stored);
      if (o.total_sen - o.stored_sen > 0) add(o.payment_method, o.total_sen - o.stored_sen, r.counter);
    }
    const refund = refundStored + refundCounter;

    // 卖了什么：只统计这一班里的有效订单，同一道菜（同名同价）合并成一行
    const dishMap = new Map<string, { name: string; qty: number; netSen: number }>();
    if (liveIds.size) {
      const ids = [...liveIds];
      const items = this.db
        .prepare(`SELECT name, qty, price_sen FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as ItemRow[];
      for (const it of items) {
        const key = `${it.name}|${it.price_sen}`;
        const row = dishMap.get(key) ?? { name: it.name, qty: 0, netSen: 0 };
        row.qty += it.qty;
        row.netSen += it.price_sen * it.qty;
        dishMap.set(key, row);
      }
    }
    const topDishes = [...dishMap.values()].sort((a, b) => b.qty - a.qty || b.netSen - a.netSen);

    const sum = (t: LedgerRow['type']) => ledger.filter((l) => l.type === t).reduce((n, l) => n + l.amount_sen, 0);
    const stored = {
      rechargeSen: sum('recharge'),
      consumeSen: sum('consume'),
      refundSen: sum('refund'),
      adjustSen: sum('adjust'),
      importSen: sum('import'),
      netSen: 0,
      entries: ledger.length,
    };
    stored.netSen = stored.rechargeSen + stored.consumeSen + stored.refundSen + stored.adjustSen + stored.importSen;

    const net = gross - refund;
    const balance = (this.db.prepare('SELECT COALESCE(SUM(balance_sen), 0) AS n FROM members').get() as { n: number }).n;
    const fmt = (d: Date) => this.local(d).slice(5, 16);

    return {
      from: fromIso,
      to: toIso,
      rangeText: `${fmt(from)} ~ ${fmt(to)}`,
      generatedAt: this.clock().toISOString(),
      orders: live.length,
      // 「取消」只报真正白卖掉的那些（取消时没退过款、也没收款）；退款自动取消的单已在营收里抵消，不重复计入
      cancelled: orders.filter((o) => o.status === 'cancelled' && !refundedOrders.has(o.id)).length,
      grossSen: gross,
      refundSen: refund,
      netSen: net,
      avgPerOrderSen: live.length ? Math.round(net / live.length) : 0,
      byMethod: [...methods]
        .map(([method, m]) => ({ method, ...m, netSen: m.grossSen - m.refundSen }))
        .sort((a, b) => b.netSen - a.netSen),
      refundStoredSen: refundStored,
      refundCounterSen: refundCounter,
      stored,
      storedBalanceSen: balance,
      topDishes,
    };
  }

  /**
   * 时间段最长 31 天：老板真的需要更长的区间，应该去看板按周看，而不是打一张三米长的纸
   */
  static readonly MAX_SPAN_DAYS = 31;

  /**
   * 给「历史订单查询」用的同一个解析器（P2-5）。
   *
   * 历史查询必须和日结单用完全一致的时区解释，否则「查 10-25 的单」和「结 10-25 的账」
   * 会差出几个小时（马来西亚是 UTC+8，用 UTC 解释就整整差一天）。
   * 所以这里不复制一份，而是把 ReportService 自己的能力包成函数交出去。
   */
  rangeParser(): (from: string, to: string) => { from: Date; to: Date; rangeText: string } {
    return (from, to) => {
      const r = this.parseRange(from, to);
      const f = (d: Date) => this.local(d).slice(5, 16);
      return { ...r, rangeText: `${f(r.from)} ~ ${f(r.to)}` };
    };
  }

  /** 门店时区的本地时间字符串（sv-SE 出来就是 2026-10-25 17:00:00 这种好切的格式） */
  private local(d: Date): string {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: this.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
  }

  /**
   * 解析时间段。故意不接收带时区偏移的复杂格式：
   * 老板输入的就是墙上钟的时间（「今天 10 点到 22 点」），一律按门店时区解释，
   * 否则在马来西亚输入 10:00 会变成 02:00，算出来的账全错。
   */
  private parseRange(fromInput: string, toInput: string): { from: Date; to: Date } {
    const from = this.parseLocal(fromInput);
    const to = this.parseLocal(toInput);
    if (!from || !to) throw new HttpError(400, '时间段格式不对，例如 2026-10-25 或 2026-10-25 17:00');
    if (to.getTime() <= from.getTime()) throw new HttpError(400, '结束时间必须晚于开始时间');
    if (to.getTime() - from.getTime() > MAX_SPAN_DAYS * 86400_000) throw new HttpError(400, '一次最多结 31 天，更长请看数据看板');
    if (from.getTime() > this.clock().getTime() + 86400_000) throw new HttpError(400, '不能结还没到的时间');
    return { from, to };
  }

  /**
   * 只给日期 → 该日 00:00；给到时分 → 那个时刻。
   * 「结束时间」传进来的日期本身就是次日（前端会把 to 给成明天），所以这里不做 +1，
   * 由调用方决定时间段怎么写——少一层隐式换算，就少一个算错账的地方。
   */
  private parseLocal(v: string): Date | null {
    const s = v.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const withTime = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s);
    let y: number;
    let mo: number;
    let d: number;
    let h = 0;
    let mi = 0;
    if (dateOnly) {
      y = Number(dateOnly[1]); mo = Number(dateOnly[2]); d = Number(dateOnly[3]);
    } else if (withTime) {
      y = Number(withTime[1]); mo = Number(withTime[2]); d = Number(withTime[3]);
      h = Number(withTime[4]); mi = Number(withTime[5]);
      if (h > 23 || mi > 59) return null;
    } else {
      return null;
    }
    // 用「本地墙上钟 → UTC」的反向换算：先按 UTC 造一个时刻，再量出这个时区在那一刻的偏移，减回去
    const naive = Date.UTC(y, mo - 1, d, h, mi);
    return new Date(naive - this.offsetAt(new Date(naive)));
  }

  /** 该时刻在门店时区的偏移（毫秒，东八区为 +8h） */
  private offsetAt(d: Date): number {
    const s = new Intl.DateTimeFormat('sv-SE', {
      timeZone: this.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
    const asUtc = Date.parse(s.replace(' ', 'T') + 'Z');
    return asUtc - d.getTime();
  }

  /** 今天整天（老板端「一键结今天」用这个默认值） */
  todayRange(): { from: string; to: string } {
    const today = businessDate(this.clock(), this.timeZone);
    return { from: today, to: shiftDay(today, 1) };
  }

  /**
   * 历史订单查询的默认时间段：最近 7 天（含今天）。
   * 老板说「翻一下上周三」，多数时候是这一周内的事；更早的自己选日期。
   */
  searchRange(): { from: string; to: string } {
    const today = businessDate(this.clock(), this.timeZone);
    return { from: shiftDay(today, -6), to: shiftDay(today, 1) };
  }
}
