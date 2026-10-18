import { randomUUID } from 'node:crypto';
import {
  AUTO_CANCEL_REASON, NEXT_STATUS, ORDER_STATUS_LABEL, OrderStatus,
  type Brand, type CounterRefund, type Order, type OrderStatus as Status, type RefundRecord, type SubmitOrderInput, type WaitInfo,
} from '@pkg/contract';
import type { CartService } from './cart.ts';
import type { DB } from './db.ts';
import { postLedger } from './members.ts';
import { businessDate, EventBus, HttpError, type Clock } from './support.ts';

export type OrderEvent = { type: 'order.created' | 'order.updated'; order: Order };

interface OrderRow {
  id: string; business_date: string; pickup_no: number; device_id: string; table_no: string; payment_method: string;
  note: string | null; total_sen: number; status: Status; cancel_reason: string | null; created_at: string; updated_at: string;
  member_id: string | null; stored_sen: number;
}
interface ItemRow { line: number; dish_uid: string; code: string; name: string; price_sen: number; qty: number }
interface RefundRow { id: number; line: number; qty: number; amount_sen: number; stored_sen: number; counter_sen: number; reason: string; at: string }

const ACTIVE = "status IN ('pending', 'cooking')";
const no3 = (n: number) => String(n).padStart(3, '0');
const rm = (sen: number) => `RM ${(sen / 100).toFixed(2).replace(/\.00$/, '')}`;

export class OrderService {
  readonly events = new EventBus<OrderEvent>();

  constructor(private db: DB, private carts: CartService, private brand: Brand, private clock: Clock) {}

  /**
   * 下单。只校验两项：桌号必填 + 付款方式已选（21号 §3.1）。不防重复、不限频率。
   * 空购物车、已下架/售罄菜品属于「没东西可下」，不是防御机制。
   *
   * 付款三种情况：
   * - 纯储值（paymentMethod = 储值）：余额必须够整单
   * - 储值 + 其他方式合付（useStoredValue = true，paymentMethod = 现金等）：余额先扣完，剩下的用该方式付（28号 §三-1）
   * - 纯其他方式
   * 储值部分与订单在同一事务：余额不够或任何一步失败，整单不成立。
   */
  submit(input: SubmitOrderInput, member: { id: string; memberNo: string } | null = null): Order {
    const tableNo = (input.tableNo ?? '').trim();
    const method = (input.paymentMethod ?? '').trim();
    if (!tableNo) throw new HttpError(400, '请填写桌号');
    const pm = this.brand.paymentMethods.find((m) => m.key === method);
    if (!pm) throw new HttpError(400, '请选择付款方式');
    const mixed = !pm.requiresMember && input.useStoredValue === true;
    // 用到储值就必须先验证会员身份（22号裁决）；这是付款方式本身的前提，不是下单防御
    if ((pm.requiresMember || mixed) && !member) throw new HttpError(401, '储值支付需要先在「会员」页登录');

    const cart = this.carts.view(input.cartId);
    if (cart.lines.length === 0) throw new HttpError(400, '购物车是空的');
    const gone = cart.lines.filter((l) => !l.available);
    if (gone.length) {
      const why = (l: (typeof gone)[number]) => `${l.name}（${l.unavailableReason === 'soldout' ? '今日售罄' : '已下架'}）`;
      throw new HttpError(409, `以下菜品暂时不能点，请先从购物车移除：${gone.map(why).join('、')}`);
    }

    const now = this.clock();
    const day = businessDate(now, this.brand.timezone);
    const id = randomUUID();
    const note = (input.note ?? '').trim() || null;
    const total = cart.totalSen;

    this.db.transaction(() => {
      // 储值部分：在事务里读余额，读和扣之间不会被别的请求插队
      let stored = 0;
      let finalMethod = method;
      if (member && (pm.requiresMember || mixed)) {
        const balance = this.db.prepare('SELECT balance_sen FROM members WHERE id = ?').pluck().get(member.id) as number;
        if (pm.requiresMember) {
          if (balance < total) throw new HttpError(409, `余额不足：当前余额 ${rm(balance)}，本单 ${rm(total)}。可以选「储值 + 其他方式」合付`);
          stored = total;
        } else {
          stored = Math.min(balance, total);
          if (stored === 0) throw new HttpError(409, '储值余额为 0，请直接选择其他付款方式');
          if (stored === total) finalMethod = this.storedKey(); // 余额其实够付整单，就记为纯储值
        }
      }
      const next = (this.db.prepare('SELECT COALESCE(MAX(pickup_no), 0) + 1 FROM orders WHERE business_date = ?').pluck().get(day) as number);
      this.db.prepare(`INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, note, total_sen, status, created_at, updated_at, member_id, stored_sen)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
        .run(id, day, next, cart.id, tableNo, finalMethod, note, total, now.toISOString(), now.toISOString(), stored > 0 ? member!.id : null, stored);
      if (stored > 0) {
        postLedger(this.db, {
          memberId: member!.id, type: 'consume', amountSen: -stored, operator: `member:${member!.memberNo}`,
          note: stored < total ? `订单 ${no3(next)}（储值 + 其他方式合付）` : `订单 ${no3(next)}`, orderId: id, key: `order:${id}`, at: now.toISOString(),
        });
      }
      const insert = this.db.prepare('INSERT INTO order_items (order_id, line, dish_uid, code, name, price_sen, qty) VALUES (?, ?, ?, ?, ?, ?, ?)');
      cart.lines.forEach((l, i) => insert.run(id, i + 1, l.dishUid, l.code, l.name, l.priceSen, l.qty));
      this.db.prepare(`INSERT INTO order_events (order_id, from_status, to_status, operator, at) VALUES (?, NULL, 'pending', 'customer', ?)`).run(id, now.toISOString());
      this.db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cart.id);
    })();

    const order = this.get(id);
    this.events.emit({ type: 'order.created', order });
    return order;
  }

  /** 老板端推动状态。合法流转由数据库触发器二次把关。 */
  setStatus(id: string, to: string, reason: string | null | undefined, operator: string): Order {
    const parsed = OrderStatus.safeParse(to);
    if (!parsed.success) throw new HttpError(400, '未知的订单状态');
    const row = this.row(id);
    if (!NEXT_STATUS[row.status].includes(parsed.data)) {
      throw new HttpError(409, `订单当前是「${ORDER_STATUS_LABEL[row.status]}」，不能改成「${ORDER_STATUS_LABEL[parsed.data]}」`);
    }
    const why = (reason ?? '').trim() || null;
    if (parsed.data === 'cancelled' && !why) throw new HttpError(400, '取消订单需要填写原因');
    const now = this.clock().toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE orders SET status = ?, cancel_reason = COALESCE(?, cancel_reason), updated_at = ? WHERE id = ?')
        .run(parsed.data, parsed.data === 'cancelled' ? why : null, now, id);
      this.db.prepare('INSERT INTO order_events (order_id, from_status, to_status, reason, operator, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, row.status, parsed.data, why, operator, now);
      if (parsed.data === 'cancelled') {
        // 整单取消：把「还没退过的部分」退掉。储值部分原路退回（24号 #7），其余部分进「待柜台退还」
        const done = this.refundedTotals(id);
        const storedLeft = row.stored_sen - done.stored;
        const counterLeft = row.total_sen - row.stored_sen - done.counter;
        if (storedLeft > 0 && row.member_id) {
          postLedger(this.db, {
            memberId: row.member_id, type: 'refund', amountSen: storedLeft, operator,
            note: `订单 ${no3(row.pickup_no)} 取消：${why}`, orderId: id, key: `refund:${id}`, at: now,
          });
        }
        if (counterLeft > 0) {
          this.db.prepare('INSERT INTO counter_refunds (order_id, refund_id, method, amount_sen, created_at) VALUES (?, NULL, ?, ?, ?)')
            .run(id, row.payment_method, counterLeft, now);
        }
      }
    })();
    const order = this.get(id);
    this.events.emit({ type: 'order.updated', order });
    return order;
  }

  /**
   * 按菜品行部分退款（28号 §三-2/3）。
   * - 每一行单独一条退款记录、单独一笔红字冲销流水；账本只增不删
   * - 同一行累计退的份数不能超过下单份数（这里先查给出中文提示，数据库触发器再把一道关）
   * - 下架的菜也能退；已取消的单不能再退（取消时已整单退过）
   * - 金额分配：先退回储值部分，储值退完的剩余进「待柜台退还」
   */
  refund(id: string, input: { lines?: unknown; reason?: unknown; requestId?: unknown }, operator: string): Order {
    const row = this.row(id);
    if (row.status === 'cancelled') throw new HttpError(409, '这张单已经整单取消（取消时已全额退回），不能再退款');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason) throw new HttpError(400, '退款需要填写原因');
    const requestId = typeof input.requestId === 'string' && /^[\w-]{8,64}$/.test(input.requestId) ? input.requestId : null;
    if (!requestId) throw new HttpError(400, '请求编号缺失，请刷新页面后重试');
    // 同一个请求编号重复提交（手抖点两下）：第一次已经退过，直接返回结果，不再退第二次
    if (this.db.prepare('SELECT 1 FROM order_refunds WHERE instr(request_key, ?) = 1').get(`${requestId}:`)) return this.get(id);

    // 同一行在一次请求里出现多次时先合并，再检查「最多还能退几份」
    const wanted = new Map<number, number>();
    for (const x of Array.isArray(input.lines) ? (input.lines as unknown[]) : []) {
      const { line, qty } = (x && typeof x === 'object' ? x : {}) as { line?: unknown; qty?: unknown };
      if (qty === 0) continue;
      if (typeof line !== 'number' || typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0) throw new HttpError(400, '退款份数需为正整数');
      wanted.set(line, (wanted.get(line) ?? 0) + qty);
    }
    if (wanted.size === 0) throw new HttpError(400, '请选择要退的菜品和份数');

    const items = this.items(id);
    const refunded = this.refundedQtyByLine(id);
    for (const [line, qty] of wanted) {
      const item = items.find((i) => i.line === line);
      if (!item) throw new HttpError(400, '退款的菜品不在这张单里');
      const left = item.qty - (refunded.get(item.line) ?? 0);
      if (qty > left) throw new HttpError(409, `「${item.name}」最多还能退 ${left} 份（下单 ${item.qty} 份，已退 ${item.qty - left} 份）`);
    }

    const now = this.clock().toISOString();
    this.db.transaction(() => {
      let storedLeft = row.stored_sen - this.refundedTotals(id).stored;
      for (const [line, qty] of wanted) {
        const item = items.find((i) => i.line === line)!;
        const amount = item.price_sen * qty;
        if (amount === 0) continue;
        const storedPart = Math.min(amount, Math.max(0, storedLeft));
        const counterPart = amount - storedPart;
        storedLeft -= storedPart;
        const r = this.db.prepare(`INSERT INTO order_refunds (order_id, line, qty, amount_sen, stored_sen, counter_sen, reason, operator, at, request_key)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, item.line, qty, amount, storedPart, counterPart, reason, operator, now, `${requestId}:${item.line}`);
        const refundId = Number(r.lastInsertRowid);
        if (storedPart > 0 && row.member_id) {
          postLedger(this.db, {
            memberId: row.member_id, type: 'refund', amountSen: storedPart, operator,
            note: `订单 ${no3(row.pickup_no)} 退「${item.name}」×${qty}：${reason}`, orderId: id, key: `refund:${id}:${refundId}`, at: now,
          });
        }
        if (counterPart > 0) {
          this.db.prepare('INSERT INTO counter_refunds (order_id, refund_id, method, amount_sen, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, refundId, row.payment_method, counterPart, now);
        }
      }
      this.db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(now, id);
      // 还没做完的单如果所有菜都退了，后厨就不该再做：自动转「已取消」，避免白做一桌菜。
      // （钱已经在上面逐行退完，取消时不会再多退）已完成的单保持「已完成 + 已全额退款」。
      const after = this.refundedQtyByLine(id);
      if ((row.status === 'pending' || row.status === 'cooking') && items.every((i) => (after.get(i.line) ?? 0) >= i.qty)) {
        this.db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?").run(AUTO_CANCEL_REASON, now, id);
        this.db.prepare("INSERT INTO order_events (order_id, from_status, to_status, reason, operator, at) VALUES (?, ?, 'cancelled', ?, ?, ?)")
          .run(id, row.status, AUTO_CANCEL_REASON, operator, now);
      }
    })();
    const order = this.get(id);
    this.events.emit({ type: 'order.updated', order });
    return order;
  }

  /** 待柜台退还列表（默认只看还没处理的） */
  counterRefunds(pendingOnly: boolean): CounterRefund[] {
    const rows = this.db.prepare(`SELECT c.*, o.pickup_no, o.table_no FROM counter_refunds c JOIN orders o ON o.id = c.order_id
                                  ${pendingOnly ? 'WHERE c.resolution IS NULL' : ''} ORDER BY c.id DESC LIMIT 200`).all() as
      { id: number; order_id: string; pickup_no: number; table_no: string; method: string; amount_sen: number; created_at: string; resolution: CounterRefund['resolution']; resolved_at: string | null }[];
    return rows.map((r) => ({
      id: r.id, orderId: r.order_id, pickupNo: r.pickup_no, tableNo: r.table_no, method: r.method, amountSen: r.amount_sen,
      createdAt: r.created_at, resolution: r.resolution, resolvedAt: r.resolved_at,
    }));
  }

  /** 老板在柜台办完：已退给顾客 / 当初没收到钱无需退。只能处理一次 */
  resolveCounterRefund(refundId: number, resolution: unknown, operator: string): CounterRefund {
    if (resolution !== 'refunded' && resolution !== 'not-collected') throw new HttpError(400, '处理结果只能是「已退还」或「未收款无需退」');
    const r = this.db.prepare('SELECT resolution FROM counter_refunds WHERE id = ?').get(refundId) as { resolution: string | null } | undefined;
    if (!r) throw new HttpError(404, '找不到这条待退记录');
    if (r.resolution) throw new HttpError(409, '这条已经处理过了');
    this.db.prepare('UPDATE counter_refunds SET resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
      .run(resolution, this.clock().toISOString(), operator, refundId);
    return this.counterRefunds(false).find((x) => x.id === refundId)!;
  }

  get(id: string): Order {
    return this.toDto(this.row(id));
  }

  /** 这台手机的订单（最近 20 单），用于取餐页和「再来一单」 */
  listByDevice(deviceId: string): Order[] {
    const rows = this.db.prepare('SELECT * FROM orders WHERE device_id = ? ORDER BY created_at DESC LIMIT 20').all(deviceId) as OrderRow[];
    return rows.map((r) => this.toDto(r));
  }

  listByDay(day: string): Order[] {
    const rows = this.db.prepare('SELECT * FROM orders WHERE business_date = ? ORDER BY pickup_no').all(day) as OrderRow[];
    return rows.map((r) => this.toDto(r));
  }

  today(): string {
    return businessDate(this.clock(), this.brand.timezone);
  }

  /** 等待时长（24号 #6）：自动 =（排队单数 + 1）× 每单平均分钟；老板手动设置时以手动为准 */
  waitInfo(): WaitInfo {
    const queue = this.db.prepare(`SELECT COUNT(*) FROM orders WHERE business_date = ? AND ${ACTIVE}`).pluck().get(this.today()) as number;
    const manual = this.setting('wait.manualMinutes');
    if (manual !== null) return { minutes: Number(manual), queue, source: 'manual' };
    return { minutes: (queue + 1) * this.minutesPerOrder(), queue, source: 'auto' };
  }

  waitSettings() {
    const manual = this.setting('wait.manualMinutes');
    return { minutesPerOrder: this.minutesPerOrder(), manualMinutes: manual === null ? null : Number(manual) };
  }

  updateWaitSettings(input: { minutesPerOrder?: unknown; manualMinutes?: unknown }) {
    const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
    if (input.minutesPerOrder !== undefined) {
      if (!intIn(input.minutesPerOrder, 1, 120)) throw new HttpError(400, '每单平均分钟需在 1 到 120 之间');
      this.putSetting('wait.minutesPerOrder', String(input.minutesPerOrder));
    }
    if (input.manualMinutes !== undefined) {
      if (input.manualMinutes === null) this.db.prepare("DELETE FROM settings WHERE key = 'wait.manualMinutes'").run();
      else if (!intIn(input.manualMinutes, 0, 300)) throw new HttpError(400, '手动等待时长需在 0 到 300 分钟之间');
      else this.putSetting('wait.manualMinutes', String(input.manualMinutes));
    }
    return this.waitSettings();
  }

  private storedKey(): string {
    return this.brand.paymentMethods.find((m) => m.requiresMember)?.key ?? 'stored-value';
  }
  private minutesPerOrder(): number {
    const v = this.setting('wait.minutesPerOrder');
    return v === null ? this.brand.wait.minutesPerOrder : Number(v);
  }
  private setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as string | undefined) ?? null;
  }
  private putSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private row(id: string): OrderRow {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    if (!r) throw new HttpError(404, '找不到这张订单');
    return r;
  }
  private items(id: string): ItemRow[] {
    return this.db.prepare('SELECT line, dish_uid, code, name, price_sen, qty FROM order_items WHERE order_id = ? ORDER BY line').all(id) as ItemRow[];
  }
  private refundRows(id: string): RefundRow[] {
    return this.db.prepare('SELECT id, line, qty, amount_sen, stored_sen, counter_sen, reason, at FROM order_refunds WHERE order_id = ? ORDER BY id').all(id) as RefundRow[];
  }
  private refundedQtyByLine(id: string): Map<number, number> {
    const m = new Map<number, number>();
    for (const r of this.refundRows(id)) m.set(r.line, (m.get(r.line) ?? 0) + r.qty);
    return m;
  }
  private refundedTotals(id: string) {
    return this.refundRows(id).reduce((t, r) => ({ stored: t.stored + r.stored_sen, counter: t.counter + r.counter_sen }), { stored: 0, counter: 0 });
  }

  private toDto(r: OrderRow): Order {
    const items = this.items(r.id);
    const refunds = this.refundRows(r.id);
    const refundedByLine = this.refundedQtyByLine(r.id);
    let eta: number | null = null;
    if (r.status === 'pending' || r.status === 'cooking') {
      const ahead = this.db.prepare(`SELECT COUNT(*) FROM orders WHERE business_date = ? AND ${ACTIVE} AND pickup_no <= ?`).pluck().get(r.business_date, r.pickup_no) as number;
      eta = ahead * this.minutesPerOrder();
    }
    const refundedSen = refunds.reduce((n, x) => n + x.amount_sen, 0);
    const allRefunded = items.every((i) => (refundedByLine.get(i.line) ?? 0) >= i.qty);
    const nameOf = (line: number) => items.find((i) => i.line === line)?.name ?? '';
    return {
      id: r.id, pickupNo: r.pickup_no, businessDate: r.business_date, tableNo: r.table_no, paymentMethod: r.payment_method,
      note: r.note, totalSen: r.total_sen, status: r.status, cancelReason: r.cancel_reason, createdAt: r.created_at, updatedAt: r.updated_at,
      items: items.map((i) => ({
        line: i.line, dishUid: i.dish_uid, code: i.code, name: i.name, priceSen: i.price_sen, qty: i.qty, refundedQty: refundedByLine.get(i.line) ?? 0,
      })),
      etaMinutes: eta,
      storedSen: r.stored_sen,
      otherSen: r.total_sen - r.stored_sen,
      refundState: refunds.length === 0 ? 'none' : allRefunded ? 'full' : 'partial',
      refundedSen,
      autoCancelled: r.status === 'cancelled' && r.cancel_reason === AUTO_CANCEL_REASON,
      refunds: refunds.map((x): RefundRecord => ({
        id: x.id, line: x.line, name: nameOf(x.line), qty: x.qty, amountSen: x.amount_sen, storedSen: x.stored_sen,
        counterSen: x.counter_sen, reason: x.reason, at: x.at,
      })),
    };
  }
}
