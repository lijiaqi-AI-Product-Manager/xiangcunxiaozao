import { Router } from 'express';
import type { AppDeps } from '../types.js';
import { makeAuth } from '../middleware/auth.js';
import { createOrder, getOrderFull, listOrders, transitionOrder } from '../services/orders.js';

export default function ordersRoutes(deps: AppDeps): Router {
  const r = Router();
  const { db } = deps;
  const auth = makeAuth(deps.adminToken, deps.kitchenToken);

  // 顾客下单（公开；限流在 app.ts 挂载）
  r.post('/', (req, res) => {
    const result = createOrder(db, req.body ?? {});
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
    res.json(transitionOrder(db, req.params.orderNo, 'confirmed'));
  });

  // 后厨：上桌完成
  r.post('/:orderNo/serve', auth.kitchen, (req, res) => {
    res.json(transitionOrder(db, req.params.orderNo, 'served'));
  });

  // 老板：取消（仅待接单状态可取消，必须留原因——对账留痕）
  r.post('/:orderNo/cancel', auth.admin, (req, res) => {
    const reason = String(req.body?.reason ?? '');
    res.json(transitionOrder(db, req.params.orderNo, 'cancelled', reason));
  });

  return r;
}
