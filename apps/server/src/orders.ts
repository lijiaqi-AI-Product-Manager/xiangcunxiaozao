import { randomUUID } from 'node:crypto';
import {
  AUTO_CANCEL_REASON, formatMoney, NEXT_STATUS, ORDER_SEARCH_MAX_Q, ORDER_STATUS_LABEL, OrderStatus,
  type Brand, type CounterRefund, type Order, type OrderSearchResult, type OrderStatus as Status, type RefundRecord, type SubmitOrderInput, type WaitInfo,
} from '@pkg/contract';
import type { CartService } from './cart.ts';
import type { DB } from './db.ts';
import { postLedger } from './members.ts';
import { businessDate, EventBus, HttpError, type Clock } from './support.ts';

export type OrderEvent = { type: 'order.created' | 'order.updated'; order: Order };

/**
 * 时间段解析由调用方注入（ReportService 已经有一份按门店时区解释「墙上钟」的实现）。
 * 历史查询和日结单必须用同一套解释，否则「查 10-25 的单」和「结 10-25 的账」会差几个小时。
 */
export type RangeParser = (from: string, to: string) => { from: Date; to: Date; rangeText: string };

interface OrderRow {
  id: string; business_date: string; pickup_no: number; device_id: string; table_no: string; payment_method: string;
  note: string | null; total_sen: number; status: Status; cancel_reason: string | null; created_at: string; updated_at: string;
  member_id: string | null; stored_sen: number; version: number;
  // 加菜（P2-6）：子单指向主单；主单这三个字段都是 null
  parent_order_id: string | null; added_at: string | null; add_seq: number | null;
}
interface ItemRow { line: number; dish_uid: string; code: string; name: string; price_sen: number; qty: number; spice: string; note: string }
interface RefundRow { id: number; line: number; qty: number; amount_sen: number; stored_sen: number; counter_sen: number; reason: string; at: string }

const ACTIVE = "status IN ('pending', 'cooking')";
const no3 = (n: number) => String(n).padStart(3, '0');
// 报错文案里的金额和账单一样固定两位小数：同一个「余额不足」提示，
// 以前这条写 RM 2、members.ts 那条写 RM 2.00，顾客看到两种写法会以为不是一个东西。
const rm = (sen: number) => `RM ${formatMoney(sen)}`;

/** better-sqlite3 的唯一约束冲突（SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY） */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

/**
 * 把用户输入里的 LIKE 通配符按字面转义（配 SQL 里的 ESCAPE '\'）。
 * 顺序要紧：先转反斜杠本身，再转 % 和 _，否则会把刚加上的反斜杠又转一遍。
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export class OrderService {
  readonly events = new EventBus<OrderEvent>();

  constructor(private db: DB, private carts: CartService, private brand: Brand, private clock: Clock) {}

  /**
   * 下单。校验桌号必填 + 付款方式已选（21号 §3.1）。
   * 空购物车、已下架/售罄菜品属于「没东西可下」，不是防御机制。
   *
   * 幂等：带同一个 requestId 重复提交，返回第一次那张单，不再建第二张。
   * 这是「顾客网络抖动重试」的唯一正确解法——见 migrations/007_order_idempotency.sql 的说明。
   *
   * 付款三种情况：
   * - 纯储值（paymentMethod = 储值）：余额必须够整单
   * - 储值 + 其他方式合付（useStoredValue = true，paymentMethod = 现金等）：余额先扣完，剩下的用该方式付（28号 §三-1）
   * - 纯其他方式
   * 储值部分与订单在同一事务：余额不够或任何一步失败，整单不成立。
   */
  /**
   * 下单。第二个返回值 replay 表示「这个请求编号之前已经下过一张单，这次是把那张单还回去」
   * —— 接口层用它区分 201（真新建）和 200（重放），日志里一眼能看出哪些是网络重试。
   */
  submit(input: SubmitOrderInput, member: { id: string; memberNo: string } | null = null): Order & { replay?: boolean } {
    const tableNo = (input.tableNo ?? '').trim();
    const method = (input.paymentMethod ?? '').trim();
    if (!tableNo) throw new HttpError(400, '请填写桌号');
    const pm = this.brand.paymentMethods.find((m) => m.key === method);
    if (!pm) throw new HttpError(400, '请选择付款方式');
    const mixed = !pm.requiresMember && input.useStoredValue === true;
    // 用到储值就必须先验证会员身份（22号裁决）；这是付款方式本身的前提，不是下单防御
    if ((pm.requiresMember || mixed) && !member) throw new HttpError(401, '储值支付需要先在「会员」页登录');

    // ① 幂等第一道：这个请求编号已经下过单，直接把那张单还回去。
    //    放在最前面，且在任何校验之前——重试的请求购物车已经是空的，走后面的校验必然报「购物车是空的」。
    const requestId = typeof input.requestId === 'string' && /^[\w-]{8,64}$/.test(input.requestId) ? input.requestId : null;
    const requestKey = requestId ? `${input.cartId}:${requestId}` : null;
    if (requestKey) {
      const hit = this.byRequestKey(requestKey);
      if (hit) return { ...hit, replay: true };
    }

    const cart = this.carts.view(input.cartId);
    if (cart.lines.length === 0) throw new HttpError(400, '购物车是空的');
    // 订单归属哪台手机：优先用前端带上来的设备号。
    // 回退到 cart.id 只是为了兼容老版本前端（已经装到客人手机上的页面），新版本都会带设备号。
    const deviceId = typeof input.deviceId === 'string' && /^[\w-]{8,64}$/.test(input.deviceId) ? input.deviceId : input.cartId;
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

    let next = 0;
    try {
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
        next = (this.db.prepare('SELECT COALESCE(MAX(pickup_no), 0) + 1 FROM orders WHERE business_date = ?').pluck().get(day) as number);
        this.db.prepare(`INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, note, total_sen, status, created_at, updated_at, member_id, stored_sen, request_key)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
          .run(id, day, next, deviceId, tableNo, finalMethod, note, total, now.toISOString(), now.toISOString(), stored > 0 ? member!.id : null, stored, requestKey);
        if (stored > 0) {
          postLedger(this.db, {
            memberId: member!.id, type: 'consume', amountSen: -stored, operator: `member:${member!.memberNo}`,
            note: stored < total ? `订单 ${no3(next)}（储值 + 其他方式合付）` : `订单 ${no3(next)}`, orderId: id, key: `order:${id}`, at: now.toISOString(),
          });
        }
        // 辣度和备注跟着行走：后厨小票、老板端、退款都对得上「哪一份是谁的」
        const insert = this.db.prepare('INSERT INTO order_items (order_id, line, dish_uid, code, name, price_sen, qty, spice, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        cart.lines.forEach((l, i) => insert.run(id, i + 1, l.dishUid, l.code, l.name, l.priceSen, l.qty, l.spice, l.note));
        this.db.prepare(`INSERT INTO order_events (order_id, from_status, to_status, operator, at) VALUES (?, NULL, 'pending', 'customer', ?)`).run(id, now.toISOString());
        this.db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cart.id);
        return { orderId: id, pickupNo: next, itemCount: cart.lines.length };
      })();
    } catch (e: unknown) {
      // ② 幂等第二道：两个重试请求几乎同时到达时，都通过了第一道检查，
      //    其中一个先写入，另一个撞上 request_key 唯一索引。这不是错误，是「重复提交」，
      //    把先写入的那张单还回去即可——所以这里不需要事务也没有副作用残留。
      if (requestKey && isUniqueViolation(e)) {
        const hit = this.byRequestKey(requestKey);
        if (hit) return { ...hit, replay: true };
      }
      throw e;
    }

    const order = this.get(id);
    this.events.emit({ type: 'order.created', order });
    return order;
  }

  /**
   * 加菜（P2-6）：往一张还没做完的单后面挂一张子单。
   *
   * 为什么这么设计（完整理由见 migrations/012 的注释）：
   * 账务体系是「一张单 = 下单那一刻的钱」，退款按行、账本只增不删、明细不可改。
   * 所以加菜不往原单里塞行，而是另开一张子单——钱各算各的，客人看到的还是一个取餐号。
   * 这样日结单、看板、退款分摊全都不用改口径，天然就是对的。
   *
   * 三条业务规则（都是现场一定会遇到的）：
   *   ① 已取消的单不能加菜 —— 那桌的单已经退了，再加就成了两张单的钱走两条路
   *   ② 已完成的单不能加菜 —— 吃完了还想加，那是新的一单（新的取餐号才对）
   *   ③ 加菜单再想加菜，一律挂到最上面那张主单 —— 否则会出 3 层、4 层，
   *      「这一桌一共多少钱」要递归算，极易算漏
   *
   * 付款方式跟父单走，不再让顾客选：一桌一单的账，付款方式不一致，结账时最难解释的就是这种。
   */
  addDishes(input: { pickupNo: number; cartId: string; note?: string | null; requestId?: string | null; deviceId?: string | null }, member: { id: string; memberNo: string } | null = null): Order & { replay?: boolean } {
    /**
     * 幂等第一道必须放在**所有校验之前**。
     *
     * 踩过的坑（下单那边同一处，见 submit 的注释）：重试时购物车已经被第一次成功清空了，
     * 如果先检查「购物车是空的」，重试拿到的永远是 400 —— 顾客看到「购物车是空的」，
     * 以为加菜失败，其实是加成功了。所以先认请求编号，认出来就直接还回去。
     */
    const requestId = typeof input.requestId === 'string' && /^[\w-]{8,64}$/.test(input.requestId) ? input.requestId : null;
    const requestKey = requestId ? `${input.cartId}:${requestId}` : null;
    if (requestKey) {
      const hit = this.byRequestKey(requestKey);
      if (hit) return { ...hit, replay: true };
    }

    const cart = this.carts.view(input.cartId);
    if (cart.lines.length === 0) throw new HttpError(400, '购物车是空的');
    const gone = cart.lines.filter((l) => !l.available);
    if (gone.length) {
      const why = (l: (typeof gone)[number]) => `${l.name}（${l.unavailableReason === 'soldout' ? '今日售罄' : '已下架'}）`;
      throw new HttpError(409, `以下菜品暂时不能点，请先从购物车移除：${gone.map(why).join('、')}`);
    }

    const day = businessDate(this.clock(), this.brand.timezone);
    // 顾客只提供取餐号，那就按「今天这个号的单」去找主单（加菜只可能加当天的单）
    const roots = this.db
      .prepare("SELECT * FROM orders WHERE business_date = ? AND pickup_no = ? AND parent_order_id IS NULL AND status <> 'cancelled'")
      .all(day, input.pickupNo) as OrderRow[];
    const root = roots[0];
    if (!root) throw new HttpError(404, `找不到今天的 ${String(input.pickupNo).padStart(3, '0')} 号单，可能已经取消了`);
    if (root.status === 'done') throw new HttpError(409, `${no3(root.pickup_no)} 号已经做完了，再加菜请重新点一单`);

    const deviceId = typeof input.deviceId === 'string' && /^[\w-]{8,64}$/.test(input.deviceId) ? input.deviceId : input.cartId;
    const now = this.clock();
    const id = randomUUID();
    const note = (input.note ?? '').trim() || null;
    const total = cart.totalSen;
    // 父单的付款方式：加菜沿用。父单是混合支付（储值 + 现金）时，子单也按同样的方式记账
    const method = root.payment_method;
    const pm = this.brand.paymentMethods.find((m) => m.key === method);

    try {
      this.db.transaction(() => {
        // 子单自己也要过一遍储值校验：父单是储值付的，加菜同样要余额够
        let stored = 0;
        const memberId = member?.id ?? root.member_id;
        if (memberId && (pm?.requiresMember || root.stored_sen > 0)) {
          const balance = memberId === root.member_id
            ? (this.db.prepare('SELECT balance_sen FROM members WHERE id = ?').pluck().get(memberId) as number)
            : -1;
          if (pm?.requiresMember) {
            if (balance < total) throw new HttpError(409, `余额不足：当前余额 ${rm(Math.max(0, balance))}，加菜 ${rm(total)}`);
            stored = total;
          } else {
            stored = Math.min(Math.max(0, balance), total);
            if (stored === 0) throw new HttpError(409, '储值余额为 0，加菜请到柜台付现');
          }
        }
        const seq = (this.db.prepare('SELECT COALESCE(MAX(add_seq), 0) + 1 FROM orders WHERE parent_order_id = ?').pluck().get(root.id) as number);
        // 取餐号：子单不占号，但仍要满足 (business_date, pickup_no) 唯一 —— 取当天最大号 + 1，只用于满足约束，
        // 对外一律返回父单的号（见 toDto）
        const fakeNo = (this.db.prepare('SELECT COALESCE(MAX(pickup_no), 0) + 1 FROM orders WHERE business_date = ?').pluck().get(day) as number);
        this.db.prepare(`INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, note, total_sen, status, created_at, updated_at, member_id, stored_sen, request_key, parent_order_id, added_at, add_seq)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, day, fakeNo, deviceId, root.table_no, method, note, total, now.toISOString(), now.toISOString(), stored > 0 ? memberId : null, stored, requestKey, root.id, now.toISOString(), seq);
        if (stored > 0 && memberId) {
          postLedger(this.db, {
            memberId, type: 'consume', amountSen: -stored, operator: `member:${member?.memberNo ?? root.member_id}`,
            note: `订单 ${no3(root.pickup_no)}+${seq}（加菜）`, orderId: id, key: `order:${id}`, at: now.toISOString(),
          });
        }
        const insert = this.db.prepare('INSERT INTO order_items (order_id, line, dish_uid, code, name, price_sen, qty, spice, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        cart.lines.forEach((l, i) => insert.run(id, i + 1, l.dishUid, l.code, l.name, l.priceSen, l.qty, l.spice, l.note));
        this.db.prepare(`INSERT INTO order_events (order_id, from_status, to_status, operator, at) VALUES (?, NULL, 'pending', 'customer', ?)`).run(id, now.toISOString());
        this.db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cart.id);
      })();
    } catch (e: unknown) {
      if (requestKey && isUniqueViolation(e)) {
        const hit = this.byRequestKey(requestKey);
        if (hit) return { ...hit, replay: true };
      }
      // 两个人同时给同一桌加菜：add_seq 唯一索引会拦下第二个
      if (isUniqueViolation(e)) throw new HttpError(409, '这桌刚好也在加菜，请刷新后再试一次');
      throw e;
    }

    const order = this.get(id);
    // 用 order.updated 而不是 created：老板端按 id 合并，子单是新的 id，走 created 也一样，
    // 但用 updated 语义更准——这一桌的单变了，不是来了一张新的单
    this.events.emit({ type: 'order.updated', order });
    return order;
  }

  /**
   * 老板端推动状态。合法流转由数据库触发器二次把关。
   *
   * expectedVersion：前端看到那一单时的版本号。两台设备同时改单时，先写入的成功，
   * 后到的版本对不上就返回 409——而不是悄悄覆盖。不传则不做并发检查（内部调用用）。
   */
  setStatus(id: string, to: string, reason: string | null | undefined, operator: string, expectedVersion?: number | null): Order {
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
      // 乐观锁：只有版本还是前端看到的那一版才允许改
      const r = this.db.prepare('UPDATE orders SET status = ?, cancel_reason = COALESCE(?, cancel_reason), updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
        .run(parsed.data, parsed.data === 'cancelled' ? why : null, now, id, expectedVersion ?? row.version);
      if (r.changes === 0) {
        throw new HttpError(409, '这单刚好被另一台设备改过了（可能是别的同事在操作），已为你刷新，请确认后再操作');
      }
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
      const done0 = this.refundedTotals(id);
      const storedLeft0 = row.stored_sen - done0.stored;
      const counterLeft0 = row.total_sen - row.stored_sen - done0.counter;
      // 按「还剩多少储值 / 还剩多少现金」的比例分摊，而不是「先退储值」。
      //
      // 原来的算法（先退储值，退满才退现金）有个实际问题：顾客储值 20 + 现金 28 付了 48，
      // 现在退一半 24 元 —— 24 元全退进储值余额，柜台一分现金都不用给。
      // 顾客会觉得「你说退钱，结果退的是券」。按比例分摊：退储值 10、退现金 14，双方都不吃亏，
      // 而且比例和当初的付款结构一致，最好解释。
      const poolStored = Math.max(0, storedLeft0);
      const poolCounter = Math.max(0, counterLeft0);
      const poolTotal = poolStored + poolCounter;
      const rowsToRefund = [...wanted]
        .map(([line, qty]) => ({ item: items.find((i) => i.line === line)!, qty }))
        .filter((x) => x.item.price_sen * x.qty > 0)
        .map((x) => ({ ...x, amount: x.item.price_sen * x.qty }));
      const totalRefund = rowsToRefund.reduce((n, x) => n + x.amount, 0);

      // 逐行分摊。每一行按「当前还没退的储值 : 当前还没退的总额」的比例切。
      //
      // 两个容易写错的地方，都踩过：
      // ① 分母必须是「这一行之前还剩多少可退」（remainTotal），不是「整单总额」，
      //    否则 storedLeft/remainTotal 恒等于 1，退的又全进储值了。
      // ② 「最后一行拿走余数」只在**这次退完把整单退干净**时才有意义。
      //    如果只是退其中一道菜，它既是第一行也是最后一行，就会被判成「最后一行」→ 全退储值，等于没改。
      //    所以这里的条件是「这一行退完后，整单剩余的应退金额归零」，而不是「这是本次请求的最后一行」。
      const wholeOrderCovered = totalRefund >= poolTotal; // 这次退完，整单就退干净了吗
      let storedLeft = poolStored;
      let remainTotal = poolTotal;
      let allocated = 0;
      for (const { item, qty, amount } of rowsToRefund) {
        allocated += amount;
        // 只有「这次把整单退干净」且「这也是最后一行」时，才把余数清掉，保证两边精确归零
        const isFinalRow = wholeOrderCovered && allocated >= totalRefund;
        let storedPart: number;
        if (remainTotal <= 0 || storedLeft <= 0) storedPart = 0;
        else if (isFinalRow) storedPart = Math.min(amount, storedLeft);
        // 按比例取，四舍五入；再夹到「不超过这一行金额」和「不超过剩余储值」之间
        else storedPart = Math.min(amount, storedLeft, Math.round((amount * storedLeft) / remainTotal));
        const counterPart = amount - storedPart;
        storedLeft -= storedPart;
        remainTotal -= amount; // 分母减掉这一行的应退金额，下一步的比例就对得上了
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

  /** 按幂等键找订单：找到说明这个请求之前已经成功下过单了 */
  private byRequestKey(key: string): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE request_key = ?').get(key) as OrderRow | undefined;
    return row ? this.toDto(row) : null;
  }

  listByDay(day: string): Order[] {
    const rows = this.db.prepare('SELECT * FROM orders WHERE business_date = ? ORDER BY pickup_no').all(day) as OrderRow[];
    return rows.map((r) => this.toDto(r));
  }

  /**
   * 历史订单查询（P2-5）。
   *
   * 三个容易写错的地方，这里都特意避开了：
   *
   * ① **关键词要在整张表上先筛，再分页**，不能「先取 50 单再筛」。
   *    老板搜「剁椒鱼」，命中可能在三天前，先取最近 50 单再筛就永远搜不到。
   *    所以筛选条件是 SQL 里的，`total` 和这一批都来自同一个 WHERE。
   *
   * ② **取餐号每天从 001 重新开始**，搜「12」如果模糊匹配，会同时命中「12 号桌」「12 元」「12 月」……
   *    所以取餐号只做**精确**匹配（012、12 都认 12 号）；模糊只给桌号、菜品名、单号这些本来就不规整的字段。
   *
   * ③ **分页之后才拼明细**。`toDto` 每单要查两次明细，200 单一屏就是 400 次查询，
   *    在老板的老笔记本上会明显卡一下。这里只对当前这一页做转换。
   *
   * 统计（合计金额 / 退款 / 菜品销量）用同一个 WHERE 单独算，不受分页影响——
   * 老板搜完一批，看到的是「这 37 单一共多少钱」，不是「这一页多少钱」。
   */
  search(input: { from: string; to: string; q: string; status: string; limit: number; offset: number }, parseRange: RangeParser): OrderSearchResult {
    const { from, to, rangeText } = parseRange(input.from, input.to);
    // 命名参数：同一个筛选条件要喂给四条 SQL，用位置参数很容易在复制时多一个少一个，
    // 而那种错只在「既有关键词又有状态过滤」的特定组合下才炸，测不出来。
    const p: Record<string, unknown> = { from: from.toISOString(), to: to.toISOString() };
    const where: string[] = ['o.created_at >= @from', 'o.created_at < @to'];

    const q = input.q.trim().slice(0, ORDER_SEARCH_MAX_Q);
    if (q) {
      p.pickup = /^\d{1,4}$/.test(q) ? Number(q) : -1;
      /**
       * 模糊匹配之前必须转义。SQL 的 LIKE 里 `_` 是「任意一个字符」、`%` 是「任意一串」，
       * 转义后配 ESCAPE '\'，`%` `_` `\` 一律按字面比。
       */
      p.like = `%${escapeLike(q)}%`;
      /**
       * 单号只做**前缀**匹配（`q%`），不做 `%q%`。
       *
       * 这一条是踩出来的：订单 id 是 UUID（`78fcac7b-0a9f-…`），用 `%8%` 模糊搜，
       * 搜「8」会把所有 id 里含 8 的单都捞出来——实测 8 号桌和 20 号桌一起出现，
       * 而 20 那单的桌号、菜名里根本没有 8，看起来像系统乱给结果。
       * 实际场景是「老板从小票上抄下前几位去找」，前缀匹配正好够用，也不会误伤。
       */
      p.idPrefix = `${escapeLike(q)}%`;
      /**
       * 只搜**人说得出来的东西**：桌号、菜品名、单号。
       *
       * 特意没做进去的两样：
       * ① 菜品 uid（`b12`、`c10`）。看着像编号，但店里没人用，且会把搜索变成噩梦——
       *    搜「8」一下冒出「酸菜炒小笋（b08）」「肉末茄子煲（c08）」这些跟 8 号桌毫无关系的单。
       *    uid 是给程序用的，不该出现在人的搜索范围里。
       * ② 取餐号的模糊匹配。每天从 001 重来，模糊搜「1」等于把当天所有单都捞出来。
       */
      where.push(`(o.table_no LIKE @like ESCAPE '\\' OR o.id LIKE @idPrefix ESCAPE '\\' OR o.pickup_no = @pickup
                   OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.name LIKE @like ESCAPE '\\'))`);
    }
    if (input.status !== 'all') {
      where.push('o.status = @status');
      p.status = input.status;
    }
    const clause = where.join(' AND ');

    const total = this.db.prepare(`SELECT COUNT(*) FROM orders o WHERE ${clause}`).pluck().get(p) as number;

    // 合计与销量按「全部命中」算，不是这一页。退款按退款发生的时间段之外不另算——
    // 这里统计的是「这批单身上一共退出去多少」，和日结单的口径不同，注释写清楚免得日后有人来「对齐」。
    const agg = this.db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN o.status <> 'cancelled' THEN o.total_sen ELSE 0 END), 0) AS sumSen,
                   COALESCE(SUM((SELECT COALESCE(SUM(r.amount_sen), 0) FROM order_refunds r WHERE r.order_id = o.id)), 0) AS refundSen
            FROM orders o WHERE ${clause}`)
      .get(p) as { sumSen: number; refundSen: number } | undefined;

    const dishes = this.db
      .prepare(`SELECT i.name AS name, SUM(i.qty - COALESCE(rf.q, 0)) AS qty
                FROM order_items i
                JOIN orders o ON o.id = i.order_id
                LEFT JOIN (SELECT order_id, line, SUM(qty) AS q FROM order_refunds GROUP BY order_id, line) rf
                  ON rf.order_id = i.order_id AND rf.line = i.line
                WHERE ${clause} AND o.status <> 'cancelled'
                GROUP BY i.name
                HAVING qty > 0
                ORDER BY qty DESC, i.name
                LIMIT 12`)
      .all(p) as { name: string; qty: number }[];

    const rows = this.db
      .prepare(`SELECT o.* FROM orders o WHERE ${clause} ORDER BY o.created_at DESC, o.pickup_no DESC LIMIT @limit OFFSET @offset`)
      .all({ ...p, limit: input.limit, offset: input.offset }) as OrderRow[];

    return {
      orders: rows.map((r) => this.toDto(r)),
      total,
      sumSen: agg?.sumSen ?? 0,
      refundSen: agg?.refundSen ?? 0,
      dishes,
      // 负份额（超退）不出现在销量里，但合计金额仍按实退算，两边口径不同要写明白
      rangeText,
    };
  }

  today(): string {
    return businessDate(this.clock(), this.brand.timezone);
  }

  /**
   * 导出用：把命中的单**全部**取出来（不分页）。
   *
   * 为什么不复用 search()：那个接口的 limit 上限是 200（防止有人把手机拖死）。
   * 但老板导出一个月账就是要几千单——分页导出要么得前端拼，要么得一页页点，
   * 两种都容易漏。这里单独一条查询，上限设 5000 单：一家店一个月的单量够用了，
   * 超过就明确报错让老板缩小范围，而不是悄悄截断（导出少了一半数据比导不出来更糟）。
   */
  exportAll(input: { from: string; to: string; q: string; status: string }, parseRange: RangeParser): { orders: Order[]; total: number; truncated: boolean } {
    const { from, to } = parseRange(input.from, input.to);
    const p: Record<string, unknown> = { from: from.toISOString(), to: to.toISOString() };
    const where: string[] = ['o.created_at >= @from', 'o.created_at < @to'];
    const q = input.q.trim().slice(0, ORDER_SEARCH_MAX_Q);
    if (q) {
      p.pickup = /^\d{1,4}$/.test(q) ? Number(q) : -1;
      p.like = `%${escapeLike(q)}%`;
      p.idPrefix = `${escapeLike(q)}%`;
      where.push(`(o.table_no LIKE @like ESCAPE '\\' OR o.id LIKE @idPrefix ESCAPE '\\' OR o.pickup_no = @pickup
                   OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.name LIKE @like ESCAPE '\\'))`);
    }
    if (input.status !== 'all') {
      where.push('o.status = @status');
      p.status = input.status;
    }
    const clause = where.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) FROM orders o WHERE ${clause}`).pluck().get(p) as number;
    const CAP = 5000;
    const rows = this.db
      .prepare(`SELECT o.* FROM orders o WHERE ${clause} ORDER BY o.created_at DESC, o.pickup_no DESC LIMIT @cap`)
      .all({ ...p, cap: CAP }) as OrderRow[];
    return { orders: rows.map((r) => this.toDto(r)), total, truncated: total > CAP };
  }

  /**
   * 等待时长（24号 #6）：老板手动设置时以手动为准；否则按当前排队的单估。
   *
   * 口径很关键——以前是「(排队单数 + 1) × 每单平均分钟」，把「制作中」的单也按整单算，
   * 结果店里 8 单未完成、每单 8 分钟，首页就显示「约 72 分钟」，顾客看一眼就走了。
   * 实际上制作中的单已经做了一半，不该算满。现在的算法：
   *   待制作 × 每单分钟 + 制作中 × 每单分钟的一半 + 自己这一单
   * 8 单全待制作 → 72 分钟（确实是这个量）；4 待制作 + 4 制作中 → 52 分钟，更贴近实际。
   */
  waitInfo(): WaitInfo {
    const perOrder = this.minutesPerOrder();
    const count = (status: string) =>
      this.db.prepare('SELECT COUNT(*) FROM orders WHERE business_date = ? AND status = ?').pluck().get(this.today(), status) as number;
    const pending = count('pending');
    const cooking = count('cooking');
    const queue = pending + cooking;
    const manual = this.setting('wait.manualMinutes');
    if (manual !== null) return { minutes: Number(manual), queue, source: 'manual' };
    // 制作中的按半单算；至少 1 分钟，别算出 0
    const minutes = Math.max(1, Math.round((pending + cooking / 2 + 1) * perOrder));
    return { minutes, queue, source: 'auto' };
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
    return this.db.prepare('SELECT line, dish_uid, code, name, price_sen, qty, spice, note FROM order_items WHERE order_id = ? ORDER BY line').all(id) as ItemRow[];
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
      const ahead = this.db.prepare(`SELECT COUNT(*) FROM orders WHERE business_date = ? AND ${ACTIVE} AND pickup_no <= ? AND pickup_no > 0`).pluck().get(r.business_date, r.pickup_no) as number;
      eta = ahead * this.minutesPerOrder();
    }
    const refundedSen = refunds.reduce((n, x) => n + x.amount_sen, 0);
    const allRefunded = items.every((i) => (refundedByLine.get(i.line) ?? 0) >= i.qty);
    const nameOf = (line: number) => items.find((i) => i.line === line)?.name ?? '';

    /**
     * 加菜分组（P2-6）。
     *
     * 子单的 pickup_no 是为了满足数据库唯一约束才写的（当天最大号 + 1），**不是给客人看的号**。
     * 这里统一换算成父单的号：客人和老板看到的永远是「018」，而不是「018 和 031」两个号。
     * 同时把「这一桌一共多少」算好一起返回，省得每个页面各加一遍——漏掉子单是最容易犯的错。
     */
    const rootId = r.parent_order_id ?? r.id;
    const rootPickup = r.parent_order_id
      ? (this.db.prepare('SELECT pickup_no FROM orders WHERE id = ?').pluck().get(rootId) as number | undefined) ?? r.pickup_no
      : r.pickup_no;
    const sibs = r.parent_order_id
      ? []
      : (this.db.prepare('SELECT id, total_sen FROM orders WHERE parent_order_id = ?').all(r.id) as { id: string; total_sen: number }[]);
    // 主单视角：自己 + 所有子单；子单视角：父单 + 所有兄弟。两种视角算出来的数必须一样，
    // 否则顾客在「我的订单」看到的钱和老板那边对不上——所以两种视角都收回到 rootId 上算
    const agg = this.db
      .prepare(`SELECT COALESCE(SUM(total_sen), 0) AS total,
                   COALESCE((SELECT SUM(rf.amount_sen) FROM order_refunds rf
                             WHERE rf.order_id IN (SELECT id FROM orders WHERE id = @root OR parent_order_id = @root)), 0) AS refunded
                FROM orders WHERE id = @root OR parent_order_id = @root`)
      .get({ root: rootId }) as { total: number; refunded: number };

    return {
      id: r.id, pickupNo: rootPickup, businessDate: r.business_date, tableNo: r.table_no, paymentMethod: r.payment_method,
      note: r.note, totalSen: r.total_sen, status: r.status, cancelReason: r.cancel_reason, createdAt: r.created_at, updatedAt: r.updated_at,
      items: items.map((i) => ({
        line: i.line, dishUid: i.dish_uid, code: i.code, name: i.name, priceSen: i.price_sen, qty: i.qty, refundedQty: refundedByLine.get(i.line) ?? 0,
        spice: i.spice ?? '', note: i.note ?? '',
      })),
      etaMinutes: eta,
      storedSen: r.stored_sen,
      otherSen: r.total_sen - r.stored_sen,
      refundState: refunds.length === 0 ? 'none' : allRefunded ? 'full' : 'partial',
      refundedSen,
      autoCancelled: r.status === 'cancelled' && r.cancel_reason === AUTO_CANCEL_REASON,
      version: r.version ?? 0,
      parentOrderId: r.parent_order_id,
      addSeq: r.add_seq,
      groupTotalSen: agg.total,
      groupRefundedSen: agg.refunded,
      addCount: sibs.length,
      refunds: refunds.map((x): RefundRecord => ({
        id: x.id, line: x.line, name: nameOf(x.line), qty: x.qty, amountSen: x.amount_sen, storedSen: x.stored_sen,
        counterSen: x.counter_sen, reason: x.reason, at: x.at,
      })),
    };
  }
}
