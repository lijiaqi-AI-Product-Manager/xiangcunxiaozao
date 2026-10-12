import { Router } from 'express';
import type { AppDeps } from '../types.js';
import type { OrderEvent } from '../events.js';
import type { OrderFullDTO } from '../services/orders.js';
import { makeAuth } from '../middleware/auth.js';
import {
  createOrder,
  createManualOrder,
  editOrder,
  getOrderFull,
  getOrderLogs,
  listOrders,
  payOrder,
  transitionOrder,
} from '../services/orders.js';

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

  // 老板手动建单（walk-in/电话单，可带优惠与收款方式）
  r.post('/manual', auth.admin, (req, res) => {
    const o = createManualOrder(db, req.body ?? {});
    bus.emit('order:new', toEvent('order:new', o));
    res.status(201).json(o);
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

  // 订单操作审计日志（老板）
  r.get('/:orderNo/logs', auth.admin, (req, res) => {
    res.json(getOrderLogs(db, req.params.orderNo));
  });

  // 老板：编辑订单（桌号/备注/明细/逐行价格/优惠/支付方式）
  r.put('/:orderNo', auth.admin, (req, res) => {
    const o = editOrder(db, req.params.orderNo, req.body ?? {});
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 老板：一键标记收款（body: {method: 'tng'|'cash'|'alipay'|'wechat'|'card'|''}）
  r.post('/:orderNo/pay', auth.admin, (req, res) => {
    const o = payOrder(db, req.params.orderNo, req.body?.method);
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 后厨：确认接单（人工点“收到”——推送≠接单，这是防漏单红线）
  r.post('/:orderNo/confirm', auth.any, (req, res) => {
    const o = transitionOrder(db, req.params.orderNo, 'confirmed');
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 后厨：上桌完成
  r.post('/:orderNo/serve', auth.any, (req, res) => {
    const o = transitionOrder(db, req.params.orderNo, 'served');
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 后厨：拒绝接单（没菜/太忙等，必须留原因）
  r.post('/:orderNo/reject', auth.kitchen, (req, res) => {
    const o = transitionOrder(db, req.params.orderNo, 'rejected', String(req.body?.reason ?? ''));
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 老板：取消（仅待接单状态，必须留原因——对账留痕）
  r.post('/:orderNo/cancel', auth.admin, (req, res) => {
    const reason = String(req.body?.reason ?? '');
    const o = transitionOrder(db, req.params.orderNo, 'cancelled', reason);
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 老板：作废（=可控删除：留档+原因，不计营收，可筛选审计）
  r.delete('/:orderNo', auth.admin, (req, res) => {
    const reason = String(req.body?.reason ?? '');
    const o = transitionOrder(db, req.params.orderNo, 'voided', reason);
    bus.emit('order:status', toEvent('order:status', o));
    res.json(o);
  });

  // 老板：拒绝单改完后重新提交后厨
  r.post('/:orderNo/resubmit', auth.admin, (req, res) => {
    const o = transitionOrder(db, req.params.orderNo, 'resubmit');
    bus.emit('order:new', toEvent('order:new', o));
    res.json(o);
  });

  return r;
}
