import type { DB } from '../db.js';
import { HttpError } from '../middleware/errors.js';
import { nextOrderNo } from '../utils/orderNo.js';
import { klDate, klDayRangeUtc } from '../utils/time.js';
import { formatRM } from '../utils/money.js';

export interface CreateOrderInput {
  table_no?: unknown;
  items?: unknown;
  note?: unknown;
  client_id?: unknown;
}

interface OrderRow {
  id: number;
  order_no: string;
  client_id: string | null;
  table_no: string;
  status: string;
  total_cents: number;
  note: string;
  created_at: string;
  confirmed_at: string | null;
  served_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
}

export interface OrderItemDTO {
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
  note: string;
  created_at: string;
  confirmed_at: string | null;
  items: OrderItemDTO[];
}

function loadItems(db: DB, orderId: number): OrderItemDTO[] {
  return db
    .prepare(
      `SELECT dish_name, qty, unit_price_cents, subtotal_cents
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
    note: row.note,
    created_at: row.created_at,
    confirmed_at: row.confirmed_at,
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

/**
 * 创建订单 —— 财务正确性核心：
 * 1. 单个事务内完成（防半单：订单和明细要么都在，要么都不在）
 * 2. 金额全部服务端按数据库现价计算，绝不信任前端传来的总价
 * 3. client_id 幂等：顾客端重复点击/断网重试不会重复下单
 * 4. 订单号在事务内原子自增，并发不重号
 */
export function createOrder(db: DB, input: CreateOrderInput): OrderFullDTO & { duplicate: boolean } {
  const table = String(input.table_no ?? '').trim();
  if (!table || table.length > 20) throw new HttpError(400, '桌号缺失或超长');

  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, '购物车为空');
  if (rawItems.length > 50) throw new HttpError(400, '单笔菜品种类超过上限 50');

  const note = String(input.note ?? '').slice(0, 200);
  const clientId = input.client_id ? String(input.client_id).slice(0, 64) : null;

  const tx = db.transaction((): { row: OrderRow; items: OrderItemDTO[]; duplicate: boolean } => {
    // 幂等：事务内先查一次
    if (clientId) {
      const existed = db
        .prepare('SELECT * FROM orders WHERE client_id = ?')
        .get(clientId) as OrderRow | undefined;
      if (existed) return { row: existed, items: loadItems(db, existed.id), duplicate: true };
    }

    const cache = new Map<number, { name: string; price: number }>();
    let total = 0;
    const lines = rawItems.map((it: { dish_id?: unknown; qty?: unknown }) => {
      const dishId = Number((it as { dish_id?: unknown }).dish_id);
      const qty = Number((it as { qty?: unknown }).qty);
      if (!Number.isInteger(dishId) || dishId <= 0) throw new HttpError(400, '菜品编号非法');
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, '菜品数量非法');

      let d = cache.get(dishId);
      if (!d) {
        const row = db
          .prepare('SELECT name, price_cents, is_active FROM dishes WHERE id = ?')
          .get(dishId) as { name: string; price_cents: number; is_active: number } | undefined;
        if (!row || row.is_active !== 1) {
          throw new HttpError(400, `菜品不存在或已下架（编号 ${dishId}），请刷新菜单`);
        }
        d = { name: row.name, price: row.price_cents };
        cache.set(dishId, d);
      }
      const subtotal = d.price * qty; // 整数分运算
      total += subtotal;
      if (total > 100_000_00) throw new HttpError(400, '单笔订单金额超出上限');
      return {
        dish_id: dishId,
        dish_name: d.name,
        unit_price_cents: d.price,
        qty,
        subtotal_cents: subtotal,
      };
    });

    const orderNo = nextOrderNo(db);
    const info = db
      .prepare(
        `INSERT INTO orders(order_no, client_id, table_no, status, total_cents, note)
         VALUES(?, ?, ?, 'pending', ?, ?)`
      )
      .run(orderNo, clientId, table, total, note);
    const orderId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO order_items(order_id, dish_id, dish_name, unit_price_cents, qty, subtotal_cents)
       VALUES(?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      ins.run(orderId, l.dish_id, l.dish_name, l.unit_price_cents, l.qty, l.subtotal_cents);
    }
    return {
      row: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow,
      items: loadItems(db, orderId),
      duplicate: false,
    };
  });

  try {
    const r = tx();
    return { ...toFullDTO(r.row, r.items), duplicate: r.duplicate };
  } catch (e: unknown) {
    // 并发同 client_id 撞唯一键 → 幂等返回已有订单
    const msg = e instanceof Error ? e.message : String(e);
    if (clientId && msg.includes('UNIQUE constraint failed')) {
      const existed = db
        .prepare('SELECT * FROM orders WHERE client_id = ?')
        .get(clientId) as OrderRow | undefined;
      if (existed) {
        return { ...toFullDTO(existed, loadItems(db, existed.id)), duplicate: true };
      }
    }
    throw e;
  }
}

/** 状态机：pending → confirmed（后厨点收到）→ served（上桌）；cancelled 仅限 pending */
export function transitionOrder(
  db: DB,
  orderNo: string,
  to: 'confirmed' | 'served' | 'cancelled',
  reason?: string
): OrderFullDTO {
  const row = findByOrderNo(db, orderNo);
  if (!row) throw new HttpError(404, `订单不存在: ${orderNo}`);

  const now = new Date().toISOString();
  const allowed: Record<string, Record<string, string>> = {
    pending: { confirmed: 'confirmed', cancelled: 'cancelled' },
    confirmed: { served: 'served' },
    served: {},
    cancelled: {},
  };
  const next = allowed[row.status]?.[to];
  if (!next) {
    const label: Record<string, string> = {
      pending: '待接单',
      confirmed: '已接单',
      served: '已上桌',
      cancelled: '已取消',
    };
    throw new HttpError(409, `订单当前是「${label[row.status]}」，不能变更为「${to}」`);
  }

  if (to === 'cancelled') {
    const r = String(reason ?? '').trim();
    if (!r || r.length > 100) throw new HttpError(400, '取消订单必须填写原因（100字内）');
    db.prepare(
      `UPDATE orders SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=?`
    ).run(now, r, row.id);
  } else if (to === 'confirmed') {
    db.prepare(`UPDATE orders SET status='confirmed', confirmed_at=? WHERE id=?`).run(now, row.id);
  } else {
    db.prepare(`UPDATE orders SET status='served', served_at=? WHERE id=?`).run(now, row.id);
  }
  return getOrderFull(db, orderNo);
}

/** 订单列表（后厨页/老板后台共用）：可选状态、吉隆坡日期过滤 */
export function listOrders(
  db: DB,
  q: { status?: string; date?: string; limit?: number }
): OrderFullDTO[] {
  const date = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : klDate();
  const { start, end } = klDayRangeUtc(date);
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);

  let sql = `SELECT * FROM orders WHERE created_at >= ? AND created_at < ?`;
  const args: unknown[] = [start, end];
  if (q.status && ['pending', 'confirmed', 'served', 'cancelled'].includes(q.status)) {
    sql += ` AND status = ?`;
    args.push(q.status);
  }
  sql += ` ORDER BY id DESC LIMIT ?`;
  args.push(limit);

  const rows = db.prepare(sql).all(...args) as OrderRow[];
  const itemStmt = db.prepare(
    `SELECT dish_name, qty, unit_price_cents, subtotal_cents FROM order_items WHERE order_id = ? ORDER BY id`
  );
  return rows.map((r) => toFullDTO(r, itemStmt.all(r.id) as OrderItemDTO[]));
}
