import type { DB } from '../db.js';
import { HttpError } from '../middleware/errors.js';
import { nextOrderNo } from '../utils/orderNo.js';
import { klDate, klDayRangeUtc } from '../utils/time.js';
import { formatRM } from '../utils/money.js';

export const PAY_METHODS = ['tng', 'cash', 'alipay', 'wechat', 'card', 'member'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const PAY_LABELS: Record<string, string> = {
  tng: 'TnG',
  cash: '现金',
  alipay: '支付宝',
  wechat: '微信',
  card: '银行卡',
  member: '会员卡',
};

export interface CreateOrderInput {
  table_no?: unknown;
  items?: unknown;
  note?: unknown;
  client_id?: unknown;
}

export interface ManualOrderInput extends CreateOrderInput {
  discount_cents?: unknown;
  payment_method?: unknown;
}

export interface EditOrderInput {
  table_no?: unknown;
  note?: unknown;
  discount_cents?: unknown;
  payment_method?: unknown;
  items?: unknown;
}

interface OrderRow {
  id: number;
  order_no: string;
  client_id: string | null;
  table_no: string;
  status: string;
  total_cents: number;
  discount_cents: number;
  payment_method: string;
  paid_at: string | null;
  source: string;
  member_card_no: string | null;
  ip: string;
  note: string;
  created_at: string;
  confirmed_at: string | null;
  served_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  voided_at: string | null;
  cancel_reason: string;
}

export interface OrderItemDTO {
  id: number;
  dish_id: number;
  dish_name: string;
  qty: number;
  unit_price_cents: number;
  subtotal_cents: number;
  served: boolean;
}

export interface OrderFullDTO {
  order_no: string;
  table_no: string;
  status: string;
  total_cents: number;
  total_rm: string;
  discount_cents: number;
  discount_rm: string;
  payment_method: string;
  paid: boolean;
  member_card_no: string;
  source: string;
  note: string;
  reason: string;
  created_at: string;
  confirmed_at: string | null;
  served_at: string | null;
  items: OrderItemDTO[];
}

function loadItems(db: DB, orderId: number): OrderItemDTO[] {
  const rows = db
    .prepare(
      `SELECT id, dish_id, dish_name, qty, unit_price_cents, subtotal_cents,
              (served_at IS NOT NULL) AS served
       FROM order_items WHERE order_id = ? ORDER BY id`
    )
    .all(orderId) as Array<OrderItemDTO & { served: number | boolean }>;
  return rows.map((r) => ({ ...r, served: !!r.served }));
}

function toFullDTO(row: OrderRow, items: OrderItemDTO[]): OrderFullDTO {
  return {
    order_no: row.order_no,
    table_no: row.table_no,
    status: row.status,
    total_cents: row.total_cents,
    total_rm: formatRM(row.total_cents),
    discount_cents: row.discount_cents,
    discount_rm: formatRM(row.discount_cents),
    payment_method: row.payment_method,
    paid: !!row.paid_at,
    member_card_no: (row as { member_card_no?: string }).member_card_no ?? '',
    source: row.source,
    note: row.note,
    reason: row.cancel_reason,
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
    served_at: row.served_at,
    items,
  };
}

function findByOrderNo(db: DB, orderNo: string): OrderRow | undefined {
  return db
    .prepare('SELECT * FROM orders WHERE order_no = ?')
    .get(orderNo) as OrderRow | undefined;
}

export function getOrderFull(db: DB, orderNo: string): OrderFullDTO {
  const row = findByOrderNo(db, orderNo);
  if (!row) throw new HttpError(404, `订单不存在: ${orderNo}`);
  return toFullDTO(row, loadItems(db, row.id));
}

/** 审计日志：所有改账动作必须留痕 */
function logAction(db: DB, orderNo: string, action: string, detail: string): void {
  db.prepare(`INSERT INTO order_logs(order_no, action, detail) VALUES(?, ?, ?)`).run(
    orderNo,
    action,
    detail.slice(0, 500)
  );
}

interface BuiltLine {
  dish_id: number;
  dish_name: string;
  unit_price_cents: number;
  qty: number;
  subtotal_cents: number;
}

/**
 * 明细构造（服务端计价，绝不信任前端总价）。
 * allowPriceOverride：老板编辑时允许逐行改价（如议价/抹零），顾客下单绝不许。
 * allowInactive：手动建单允许点已下架菜（老板临时加单场景）。
 */
function buildLines(
  db: DB,
  rawItems: unknown,
  opts: { allowPriceOverride?: boolean; allowInactive?: boolean }
): BuiltLine[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, '菜品明细为空');
  if (rawItems.length > 50) throw new HttpError(400, '单笔菜品种类超过上限 50');

  const cache = new Map<number, { name: string; price: number }>();
  return rawItems.map((it: { dish_id?: unknown; qty?: unknown; price_cents?: unknown }) => {
    const dishId = Number(it.dish_id);
    const qty = Number(it.qty);
    if (!Number.isInteger(dishId) || dishId <= 0) throw new HttpError(400, '菜品编号非法');
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, '菜品数量非法');

    let d = cache.get(dishId);
    if (!d) {
      const row = db
        .prepare('SELECT name, price_cents, is_active FROM dishes WHERE id = ?')
        .get(dishId) as { name: string; price_cents: number; is_active: number } | undefined;
      if (!row) throw new HttpError(400, `菜品不存在（编号 ${dishId}）`);
      if (row.is_active !== 1 && !opts.allowInactive) {
        throw new HttpError(400, `「${row.name}」已下架，请刷新菜单`);
      }
      d = { name: row.name, price: row.price_cents };
      cache.set(dishId, d);
    }

    let unit = d.price;
    if (it.price_cents !== undefined && it.price_cents !== null) {
      if (!opts.allowPriceOverride) throw new HttpError(403, '顾客下单不能自定义价格');
      const p = Number(it.price_cents);
      if (!Number.isInteger(p) || p < 0 || p > 10_000_000) throw new HttpError(400, '改价非法');
      unit = p; // 老板逐行改价（含0元赠菜）
    }
    return {
      dish_id: dishId,
      dish_name: d.name,
      unit_price_cents: unit,
      qty,
      subtotal_cents: unit * qty,
    };
  });
}

function parseDiscount(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const d = Number(v);
  if (!Number.isInteger(d) || d < 0 || d > 100_000_00) throw new HttpError(400, '优惠金额非法');
  return d;
}

function parsePayMethod(v: unknown): string {
  const m = String(v ?? '').trim();
  if (m === '') return '';
  if (!(PAY_METHODS as readonly string[]).includes(m)) {
    throw new HttpError(400, `支付方式非法：${m}（可选 tng/cash/alipay/wechat/card）`);
  }
  return m;
}

function insertLines(db: DB, orderId: number, lines: BuiltLine[]): void {
  const ins = db.prepare(
    `INSERT INTO order_items(order_id, dish_id, dish_name, unit_price_cents, qty, subtotal_cents)
     VALUES(?, ?, ?, ?, ?, ?)`
  );
  for (const l of lines) ins.run(orderId, l.dish_id, l.dish_name, l.unit_price_cents, l.qty, l.subtotal_cents);
}

/**
 * 顾客下单（幂等）—— 财务红线同前：单事务/服务端计价/订单号原子自增
 */
export function createOrder(
  db: DB,
  input: CreateOrderInput,
  ip = ''
): OrderFullDTO & { duplicate: boolean } {
  const table = String(input.table_no ?? '').trim();
  if (!table || table.length > 20) throw new HttpError(400, '桌号缺失或超长');
  const note = String(input.note ?? '').slice(0, 200);
  const clientId = input.client_id ? String(input.client_id).slice(0, 64) : null;

  /* ===== 反滥用五层（调研结论#3，10-12深夜版） ===== */
  // 第0层 幂等前置：网络重试必须拿回原单，绝不能吃429（财务红线优先于防滥用）
  if (clientId) {
    const existed = db
      .prepare('SELECT * FROM orders WHERE client_id = ?')
      .get(clientId) as OrderRow | undefined;
    if (existed) return { ...toFullDTO(existed, loadItems(db, existed.id)), duplicate: true };
  }
  // 第1层 蜜罐：正常用户永远看不见这个字段，机器人自动填充即拒绝
  if (String((input as Record<string, unknown>).hp ?? '').length > 0) {
    throw new HttpError(400, '请求异常');
  }
  // 第2层 后厨积压熔断：待接单堆到阈值先拒新单，防洪水单淹没后厨
  const backlog = (
    db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'`).get() as { n: number }
  ).n;
  if (backlog >= 60) throw new HttpError(503, '后厨繁忙，请稍后再试');
  // 第3层 桌位冷却30秒：机器速度的洪水单被拦，人类加菜节奏（分钟级）不受影响
  const cooldown = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders WHERE table_no = ? AND created_at > datetime('now', '-30 seconds')`
      )
      .get(table) as { n: number }
  ).n;
  if (cooldown > 0) throw new HttpError(429, '该桌刚刚已下单，请稍等片刻再追加');
  // 第4层 单IP每日上限50单（吉隆坡时区计日）
  if (ip) {
    const { start } = klDayRangeUtc(klDate());
    const ipCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM orders WHERE ip = ? AND created_at >= ?`)
        .get(ip, start) as { n: number }
    ).n;
    if (ipCount >= 50) throw new HttpError(429, '今日下单次数已达上限');
  }
  // 第5层 express限流（app.ts 20单/分/IP）+ Cloudflare代理层防DDoS（已开）

  const tx = db.transaction((): { row: OrderRow; items: OrderItemDTO[]; duplicate: boolean } => {
    if (clientId) {
      const existed = db
        .prepare('SELECT * FROM orders WHERE client_id = ?')
        .get(clientId) as OrderRow | undefined;
      if (existed) return { row: existed, items: loadItems(db, existed.id), duplicate: true };
    }
    const lines = buildLines(db, input.items, {});
    if (lines.length > 20) throw new HttpError(400, '单笔订单菜品数超出上限');
    const total = lines.reduce((s, l) => s + l.subtotal_cents, 0);
    if (total > 100_000_00) throw new HttpError(400, '单笔订单金额超出上限');

    const orderNo = nextOrderNo(db);
    const info = db
      .prepare(
        `INSERT INTO orders(order_no, client_id, table_no, status, total_cents, note, ip)
         VALUES(?, ?, ?, 'pending', ?, ?, ?)`
      )
      .run(orderNo, clientId, table, total, note, ip);
    insertLines(db, Number(info.lastInsertRowid), lines);
    return {
      row: db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid) as OrderRow,
      items: loadItems(db, Number(info.lastInsertRowid)),
      duplicate: false,
    };
  });

  try {
    const r = tx();
    return { ...toFullDTO(r.row, r.items), duplicate: r.duplicate };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (clientId && msg.includes('UNIQUE constraint failed')) {
      const existed = db
        .prepare('SELECT * FROM orders WHERE client_id = ?')
        .get(clientId) as OrderRow | undefined;
      if (existed) return { ...toFullDTO(existed, loadItems(db, existed.id)), duplicate: true };
    }
    throw e;
  }
}

/** 老板手动建单（walk-in/电话单）：可带优惠和收款方式，允许点下架菜 */
export function createManualOrder(db: DB, input: ManualOrderInput): OrderFullDTO {
  const table = String(input.table_no ?? '').trim();
  if (!table || table.length > 20) throw new HttpError(400, '桌号缺失或超长');
  const note = String(input.note ?? '').slice(0, 200);
  const discount = parseDiscount(input.discount_cents);
  const pay = parsePayMethod(input.payment_method);

  const tx = db.transaction((): OrderFullDTO => {
    const lines = buildLines(db, input.items, { allowPriceOverride: true, allowInactive: true });
    const gross = lines.reduce((s, l) => s + l.subtotal_cents, 0);
    if (discount > gross) throw new HttpError(400, '优惠不能超过订单金额');
    const total = gross - discount;

    const orderNo = nextOrderNo(db);
    const info = db
      .prepare(
        `INSERT INTO orders(order_no, table_no, status, total_cents, discount_cents,
           payment_method, paid_at, source, note)
         VALUES(?, ?, 'pending', ?, ?, ?, ?, 'manual', ?)`
      )
      .run(orderNo, table, total, discount, pay, pay ? new Date().toISOString() : null, note);
    insertLines(db, Number(info.lastInsertRowid), lines);
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid) as OrderRow;
    logAction(db, orderNo, 'manual_create', `手动建单 ${formatRM(total)}`);
    return toFullDTO(row, loadItems(db, row.id));
  });
  return tx();
}

/**
 * 老板编辑订单（pending/confirmed/rejected/served 均可改）：
 * 桌号/备注/优惠/支付方式/整组明细（可逐行改价）。取消与作废的单不可编辑。
 */
export function editOrder(db: DB, orderNo: string, patch: EditOrderInput): OrderFullDTO {
  const tx = db.transaction((): OrderFullDTO => {
    const row = findByOrderNo(db, orderNo);
    if (!row) throw new HttpError(404, `订单不存在: ${orderNo}`);
    if (row.status === 'cancelled' || row.status === 'voided') {
      throw new HttpError(409, '已取消/已作废的订单不可编辑');
    }

    const table = patch.table_no !== undefined ? String(patch.table_no).trim() : row.table_no;
    if (!table || table.length > 20) throw new HttpError(400, '桌号缺失或超长');
    const note = patch.note !== undefined ? String(patch.note).slice(0, 200) : row.note;

    const lines = patch.items !== undefined ? buildLines(db, patch.items, { allowPriceOverride: true, allowInactive: true }) : null;
    const gross = lines ? lines.reduce((s, l) => s + l.subtotal_cents, 0) : null;

    const discount = patch.discount_cents !== undefined ? parseDiscount(patch.discount_cents) : row.discount_cents;
    const pay = patch.payment_method !== undefined ? parsePayMethod(patch.payment_method) : row.payment_method;

    const base = gross ?? row.total_cents + row.discount_cents;
    if (discount > base) throw new HttpError(400, '优惠不能超过订单金额');
    const total = base - discount;

    const paidAt = pay
      ? row.paid_at ?? new Date().toISOString()
      : null; // 清空支付方式 = 标记未收

    db.prepare(
      `UPDATE orders SET table_no=?, note=?, total_cents=?, discount_cents=?, payment_method=?, paid_at=? WHERE id=?`
    ).run(table, note, total, discount, pay, paidAt, row.id);

    if (lines) {
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(row.id);
      insertLines(db, row.id, lines);
    }

    logAction(
      db,
      orderNo,
      'edit',
      `${row.table_no}桌 ${formatRM(row.total_cents)} → ${table}桌 ${formatRM(total)}` +
        (lines ? '；明细已改' : '') + (pay ? `；收款=${PAY_LABELS[pay]}` : '')
    );
    return getOrderFull(db, orderNo);
  });
  return tx();
}

/** 一键标记收款/撤销收款 */
export function payOrder(db: DB, orderNo: string, method: unknown, cardNo?: unknown): OrderFullDTO {
  const row = findByOrderNo(db, orderNo);
  if (!row) throw new HttpError(404, `订单不存在: ${orderNo}`);
  if (row.status === 'cancelled' || row.status === 'voided' || row.status === 'rejected') {
    throw new HttpError(409, '已取消/已拒绝/已作废的订单不能收款');
  }
  const pay = parsePayMethod(method);

  // 撤销收款：永远放行（会员单撤销=原路退款，全程流水）
  if (pay === '') {
    if (row.payment_method === 'member' && row.member_card_no) {
      const card = row.member_card_no;
      const tx = db.transaction(() => {
        const m = db.prepare('SELECT * FROM members WHERE card_no = ?').get(card) as
          | { id: number; balance_cents: number }
          | undefined;
        if (!m) throw new HttpError(400, `会员卡不存在，无法退款: ${card}`);
        db.prepare('UPDATE members SET balance_cents = balance_cents + ? WHERE id = ?').run(
          row.total_cents,
          m.id
        );
        const after = (
          db.prepare('SELECT balance_cents FROM members WHERE id = ?').get(m.id) as { balance_cents: number }
        ).balance_cents;
        if (after !== m.balance_cents + row.total_cents) throw new HttpError(500, '退款校验失败，已回滚');
        db.prepare(
          `INSERT INTO member_logs(card_no, action, amount_cents, balance_after, order_no, detail)
           VALUES(?, 'refund', ?, ?, ?, '撤销收款退款')`
        ).run(card, row.total_cents, after, orderNo);
      });
      tx();
      db.prepare(`UPDATE orders SET payment_method='', member_card_no=NULL, paid_at=NULL WHERE id=?`).run(row.id);
      logAction(db, orderNo, 'unpay', `会员卡 ${card} 退款 ${formatRM(row.total_cents)}`);
      return getOrderFull(db, orderNo);
    }
    db.prepare(`UPDATE orders SET payment_method='', member_card_no=NULL, paid_at=NULL WHERE id=?`).run(row.id);
    logAction(db, orderNo, 'pay', '撤销收款标记');
    return getOrderFull(db, orderNo);
  }

  // 幂等红线：已收款的单不允许重复收款动作（会员卡尤其不能二次扣款）
  if (row.paid_at) return getOrderFull(db, orderNo);

  if (pay === 'member') {
    const card = String(cardNo ?? '').trim();
    if (!card || card.length < 2 || card.length > 32) throw new HttpError(400, '请填写会员卡号');
    const tx = db.transaction(() => {
      const m = db.prepare('SELECT * FROM members WHERE card_no = ?').get(card) as
        | { id: number; balance_cents: number; is_active: number; name: string }
        | undefined;
      if (!m) throw new HttpError(400, `会员卡不存在: ${card}`);
      if (!m.is_active) throw new HttpError(400, '该会员卡已停用');
      if (m.balance_cents < row.total_cents) {
        throw new HttpError(
          400,
          `余额不足：卡内 ${formatRM(m.balance_cents)}，本单需 ${formatRM(row.total_cents)}`
        );
      }
      db.prepare(`UPDATE members SET balance_cents = balance_cents - ? WHERE id = ?`).run(
        row.total_cents,
        m.id
      );
      // 二次验证：扣完重读，余额必须等于 预期值，且不得为负
      const after = db
        .prepare('SELECT balance_cents FROM members WHERE id = ?')
        .get(m.id) as { balance_cents: number };
      const expected = m.balance_cents - row.total_cents;
      if (after.balance_cents !== expected || after.balance_cents < 0) {
        throw new HttpError(500, '扣款校验失败，已回滚'); // 事务内抛出=自动回滚，钱不会错
      }
      db.prepare(
        `INSERT INTO member_logs(card_no, action, amount_cents, balance_after, order_no, detail)
         VALUES(?, 'consume', ?, ?, ?, ?)`
      ).run(card, -row.total_cents, after.balance_cents, orderNo, `消费 ${PAY_LABELS.member}`);
      db.prepare(
        `UPDATE orders SET payment_method='member', member_card_no=?, paid_at=? WHERE id=?`
      ).run(card, new Date().toISOString(), row.id);
    });
    tx();
    logAction(db, orderNo, 'pay', `会员卡 ${card} 扣款 ${formatRM(row.total_cents)}`);
    return getOrderFull(db, orderNo);
  }

  db.prepare(`UPDATE orders SET payment_method=?, paid_at=? WHERE id=?`).run(
    pay,
    pay ? new Date().toISOString() : null,
    row.id
  );
  logAction(db, orderNo, 'pay', pay ? `收款 ${PAY_LABELS[pay]} ${formatRM(row.total_cents)}` : '撤销收款标记');
  return getOrderFull(db, orderNo);
}

/** 逐菜上桌（KDS行业标准bump）：全勾自动整单上桌 */
export function serveItem(db: DB, orderNo: string, itemId: number): OrderFullDTO {
  const row = findByOrderNo(db, orderNo);
  if (!row) throw new HttpError(404, `订单不存在: ${orderNo}`);
  if (row.status === 'cancelled' || row.status === 'voided' || row.status === 'rejected') {
    throw new HttpError(409, '该订单已终止，不能上菜');
  }
  const it = db
    .prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?')
    .get(itemId, row.id) as { id: number; dish_name: string; served_at: string | null } | undefined;
  if (!it) throw new HttpError(404, '菜品行不存在');
  if (it.served_at) return getOrderFull(db, orderNo); // 幂等：重复勾选无害
  const now = new Date().toISOString();
  db.prepare(`UPDATE order_items SET served_at = ? WHERE id = ?`).run(now, itemId);
  logAction(db, orderNo, 'item_serve', `上菜：${it.dish_name}`);
  const left = (
    db
      .prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ? AND served_at IS NULL')
      .get(row.id) as { n: number }
  ).n;
  if (left === 0 && row.status !== 'served') {
    db.prepare(`UPDATE orders SET status='served', served_at=? WHERE id=?`).run(now, row.id);
    logAction(db, orderNo, 'serve', '全部菜品上桌，整单完成');
  }
  return getOrderFull(db, orderNo);
}

/** 菜品当月销量（吉隆坡时区本月，剔除取消/拒绝/作废） */
export function monthlySold(db: DB, dishId: number, override: number | null | undefined): number {
  if (override !== null && override !== undefined) return override;
  const now = new Date();
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
  }).format(now); // YYYY-MM
  const start = new Date(`${month}-01T00:00:00+08:00`).toISOString();
  const end = new Date(new Date(`${month}-01T00:00:00+08:00`).getTime() + 31 * 24 * 3600 * 1000).toISOString();
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(oi.qty), 0) AS q FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE oi.dish_id = ? AND o.created_at >= ? AND o.created_at < ?
         AND o.status NOT IN ('cancelled', 'rejected', 'voided')`
    )
    .get(dishId, start, end) as { q: number };
  return r.q;
}

/** 顾客端会员卡扣款（下单时选"会员卡支付"）：逻辑与管理端收款完全同源，仅鉴权层不同 */
export function memberPayOrder(db: DB, orderNo: string, cardNo: string): OrderFullDTO {
  return payOrder(db, orderNo, 'member', cardNo);
}

/**
 * 状态机（全图）：
 * pending   → confirmed（后厨接）/ cancelled（老板取消）/ rejected（后厨拒）/ voided（老板作废）
 * confirmed → served（上桌）/ voided
 * rejected  → resubmit（老板改单后重提，回 pending）/ voided
 * served    → voided
 * 终态：cancelled / voided
 */
export function transitionOrder(
  db: DB,
  orderNo: string,
  to: 'confirmed' | 'served' | 'cancelled' | 'rejected' | 'voided' | 'resubmit',
  reason?: string
): OrderFullDTO {
  const row = findByOrderNo(db, orderNo);
  if (!row) throw new HttpError(404, `订单不存在: ${orderNo}`);

  const allowed: Record<string, Partial<Record<string, string>>> = {
    pending: { confirmed: 'confirmed', cancelled: 'cancelled', rejected: 'rejected', voided: 'voided' },
    confirmed: { served: 'served', voided: 'voided' },
    rejected: { resubmit: 'pending', voided: 'voided' },
    served: { voided: 'voided' },
    cancelled: {},
    voided: {},
  };
  const next = allowed[row.status]?.[to];
  if (!next) {
    const label: Record<string, string> = {
      pending: '待接单',
      confirmed: '已接单',
      served: '已上桌',
      cancelled: '已取消',
      rejected: '已拒绝',
      voided: '已作废',
    };
    throw new HttpError(409, `订单当前是「${label[row.status]}」，不能执行该操作`);
  }

  const now = new Date().toISOString();
  const needReason = to === 'cancelled' || to === 'rejected' || to === 'voided';
  const r = String(reason ?? '').trim();
  if (needReason && (!r || r.length > 100)) {
    throw new HttpError(400, `${to === 'rejected' ? '拒绝' : to === 'voided' ? '作废' : '取消'}必须填写原因（100字内）`);
  }

  if (to === 'confirmed') {
    db.prepare(`UPDATE orders SET status='confirmed', confirmed_at=? WHERE id=?`).run(now, row.id);
  } else if (to === 'served') {
    db.prepare(`UPDATE orders SET status='served', served_at=? WHERE id=?`).run(now, row.id);
  } else if (to === 'rejected') {
    db.prepare(`UPDATE orders SET status='rejected', rejected_at=?, cancel_reason=? WHERE id=?`).run(now, r, row.id);
  } else if (to === 'voided') {
    db.prepare(`UPDATE orders SET status='voided', voided_at=?, cancel_reason=? WHERE id=?`).run(now, r, row.id);
  } else if (to === 'cancelled') {
    db.prepare(`UPDATE orders SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=?`).run(now, r, row.id);
  } else {
    // resubmit：拒绝单重提，清掉拒绝痕迹回 pending
    db.prepare(`UPDATE orders SET status='pending', rejected_at=NULL, cancel_reason='' WHERE id=?`).run(row.id);
  }
  logAction(db, orderNo, to, r);
  return getOrderFull(db, orderNo);
}

const LISTABLE = ['pending', 'confirmed', 'served', 'cancelled', 'rejected', 'voided'];

/** 订单列表（后厨页/老板后台共用）：状态+吉隆坡日期过滤 */
export function listOrders(
  db: DB,
  q: { status?: string; date?: string; limit?: number }
): OrderFullDTO[] {
  const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : klDate();
  const { start, end } = klDayRangeUtc(date);
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);

  let sql = `SELECT * FROM orders WHERE created_at >= ? AND created_at < ?`;
  const args: unknown[] = [start, end];
  if (q.status && LISTABLE.includes(q.status)) {
    sql += ` AND status = ?`;
    args.push(q.status);
  }
  sql += ` ORDER BY id DESC LIMIT ?`;
  args.push(limit);

  const rows = db.prepare(sql).all(...args) as OrderRow[];
  const itemStmt = db.prepare(
    `SELECT dish_id, dish_name, qty, unit_price_cents, subtotal_cents FROM order_items WHERE order_id = ? ORDER BY id`
  );
  return rows.map((r) => toFullDTO(r, itemStmt.all(r.id) as OrderItemDTO[]));
}

/** 订单操作日志（老板后台审计视图） */
export function getOrderLogs(db: DB, orderNo: string) {
  return db
    .prepare(`SELECT action, detail, at FROM order_logs WHERE order_no = ? ORDER BY id DESC LIMIT 50`)
    .all(orderNo) as { action: string; detail: string; at: string }[];
}
