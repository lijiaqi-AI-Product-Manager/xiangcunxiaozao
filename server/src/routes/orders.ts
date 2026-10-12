import { Router } from 'express';
import type { AppDeps } from '../types.js';
import type { OrderEvent } from '../events.js';
import type { OrderFullDTO } from '../services/orders.js';
import { makeAuth } from '../middleware/auth.js';
import { createOrder, getOrderFull, listOrders, transitionOrder } from '../services/orders.js';

function toEvent(type: OrderEvent['type'], o: OrderFullDTO): OrderEvent {
  return {
    type,
    order_no: o.order_no,
    table_no: o.table_no,
    status: o.status,
    total_rm: o.total_rm,
    note: o.note,
    created_at: o.created_at,
    items: o.items.map((i) => ({ dish_name: i.dish_name, qty: i.qty })),
  };
}

export default function ordersRoutes(deps: AppDeps): Router {
  const r = Router();
  const { db, bus } = deps;
  const auth = makeAuth(deps.adminToken, deps.kitchenToken);

  // 顾客下单（公开；限流在 app.ts 挂载）
  r.post('/', (req, res) => {
    const result = createOrder(db, req.body ?? {});
    if (!result.duplicate) {
      bus.emit('order:new', toEvent('order:new', result));
    }
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  // 顾客查自己那单的状态（凭订单号，只读）
  r.get('/:orderNo', (req, res) => {
    res.json(getOrderFull(db, req.params.orderNo));
  });

  // 后厨/老板：订单列表（默认今天，吉隆坡时区）
  r.get('/', auth.any, (req, res) => {
    res.json(
      listOrders(db, {
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        date: typeof req.query.date === 'string' ? req.query.date : undefined,
        limit: Number(req.query.limit) || undefined,
      })
    );
  });

  // 后厨：确认接单（人工点“收到”——推送≠接单，这是防漏单红线）
  r.post('/:orderNo/confirm', auth.kitchen, (req, res) => {
    const o = transitionOrder(db, req.params.orderNo, 'confirmed');
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 后厨：上桌完成
  r.post('/:orderNo/serve', auth.kitchen, (req, res) => {
    const o = transitionOrder(db, req.params.orderNo, 'served');
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 老板：取消（仅待接单状态可取消，必须留原因——对账留痕）
  r.post('/:orderNo/cancel', auth.admin, (req, res) => {
    const reason = String(req.body?.reason ?? '');
    const o = transitionOrder(db, req.params.orderNo, 'cancelled', reason);
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  return r;
}
