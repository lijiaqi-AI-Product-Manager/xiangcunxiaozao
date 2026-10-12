import type { DB } from '../db.js';
import { HttpError } from '../middleware/errors.js';
import { nextOrderNo } from '../utils/orderNo.js';
import { klDate, klDayRangeUtc } from '../utils/time.js';
import { formatRM } from '../utils/money.js';

export const PAY_METHODS = ['tng', 'cash', 'alipay', 'wechat', 'card'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const PAY_LABELS: Record<string, string> = {
  tng: 'TnG',
  cash: '现金',
  alipay: '支付宝',
  wechat: '微信',
  card: '银行卡',
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
  dish_id: number;
  dish_name: string;
  qty: number;
  unit_price_cents: number;
  subtotal_cents: number;
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
  source: string;
  note: string;
  reason: string;
  created_at: string;
  confirmed_at: string | null;
  served_at: string | null;
  items: OrderItemDTO[];
}

function loadItems(db: DB, orderId: number): OrderItemDTO[] {
  return db
    .prepare(
      `SELECT dish_id, dish_name, qty, unit_price_cents, subtotal_cents
       FROM order_items WHERE order_id = ? ORDER BY id`
    )
    .all(orderId) as OrderItemDTO[];
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
export function createOrder(db: DB, input: CreateOrderInput): OrderFullDTO & { duplicate: boolean } {
  const table = String(input.table_no ?? '').trim();
  if (!table || table.length > 20) throw new HttpError(400, '桌号缺失或超长');
  const note = String(input.note ?? '').slice(0, 200);
  const clientId = input.client_id ? String(input.client_id).slice(0, 64) : null;

  const tx = db.transaction((): { row: OrderRow; items: OrderItemDTO[]; duplicate: boolean } => {
    if (clientId) {
      const existed = db
        .prepare('SELECT * FROM orders WHERE client_id = ?')
        .get(clientId) as OrderRow | undefined;
      if (existed) return { row: existed, items: loadItems(db, existed.id), duplicate: true };
    }
    const lines = buildLines(db, input.items, {});
    const total = lines.reduce((s, l) => s + l.subtotal_cents, 0);
    if (total > 100_000_00) throw new HttpError(400, '单笔订单金额超出上限');

    const orderNo = nextOrderNo(db);
    const info = db
      .prepare(
        `INSERT INTO orders(order_no, client_id, table_no, status, total_cents, note)
         VALUES(?, ?, ?, 'pending', ?, ?)`
      )
      .run(orderNo, clientId, table, total, note);
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
export function payOrder(db: DB, orderNo: string, method: unknown): OrderFullDTO {
  const row = findByOrderNo(db, orderNo);
  if (!row) throw new HttpError(404, `订单不存在: ${orderNo}`);
  if (row.status === 'cancelled' || row.status === 'voided') {
    throw new HttpError(409, '已取消/已作废的订单不能收款');
  }
  const pay = parsePayMethod(method);
  db.prepare(`UPDATE orders SET payment_method=?, paid_at=? WHERE id=?`).run(
    pay,
    pay ? new Date().toISOString() : null,
    row.id
  );
  logAction(db, orderNo, 'pay', pay ? `收款 ${PAY_LABELS[pay]} ${formatRM(row.total_cents)}` : '撤销收款标记');
  return getOrderFull(db, orderNo);
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
