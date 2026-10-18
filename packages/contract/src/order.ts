import { z } from 'zod';

/**
 * 购物车与订单契约（21号 §4 状态机；23号 §2 购物车以服务器为准）。
 * 状态流转只有老板端能操作：待制作 → 制作中 → 已完成；待制作/制作中 → 已取消。
 */

export const OrderStatus = z.enum(['pending', 'cooking', 'done', 'cancelled']);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** 所有菜都退完、后厨还没做完时系统自动取消的原因（28号 #8 追认）；老板端据此高亮，区别于手动取消 */
export const AUTO_CANCEL_REASON = '全部菜品已退款';

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending: '待制作',
  cooking: '制作中',
  done: '已完成',
  cancelled: '已取消',
};

/** 老板端可以把订单推到哪些状态 */
export const NEXT_STATUS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['cooking', 'cancelled'],
  cooking: ['done', 'cancelled'],
  done: [],
  cancelled: [],
};

export const CartLine = z.object({
  dishUid: z.string(),
  code: z.string(),
  name: z.string(),
  priceSen: z.number().int().nullable(),
  qty: z.number().int().positive(),
  subtotalSen: z.number().int(),
  available: z.boolean(), // 菜品已下架或今日售罄时为 false，结算前需移除
  unavailableReason: z.enum(['soldout', 'off']).nullable(),
});
export type CartLine = z.infer<typeof CartLine>;

export const Cart = z.object({
  id: z.string(),
  lines: z.array(CartLine),
  count: z.number().int(),
  totalSen: z.number().int(),
  updatedAt: z.string(),
});
export type Cart = z.infer<typeof Cart>;

export const OrderItem = z.object({
  line: z.number().int().positive(),
  dishUid: z.string(),
  code: z.string(),
  name: z.string(),
  priceSen: z.number().int(),
  qty: z.number().int().positive(),
  refundedQty: z.number().int().nonnegative(), // 这一行已经退了几份
});

/** 退款情况（28号 §三-2）：不改订单状态机，单独标「部分退款 / 已全额退款」 */
export const RefundState = z.enum(['none', 'partial', 'full']);
export type RefundState = z.infer<typeof RefundState>;
export const REFUND_STATE_LABEL: Record<RefundState, string> = { none: '', partial: '部分退款', full: '已全额退款' };

export const RefundRecord = z.object({
  id: z.number().int(),
  line: z.number().int(),
  name: z.string(),
  qty: z.number().int(),
  amountSen: z.number().int(),
  storedSen: z.number().int(), // 原路退回储值的部分
  counterSen: z.number().int(), // 要在柜台退还的部分
  reason: z.string(),
  at: z.string(),
});
export type RefundRecord = z.infer<typeof RefundRecord>;

/** 待柜台退还：非储值部分的退款，老板在柜台办完后标记 */
export const CounterRefund = z.object({
  id: z.number().int(),
  orderId: z.string(),
  pickupNo: z.number().int(),
  tableNo: z.string(),
  method: z.string(),
  amountSen: z.number().int(),
  createdAt: z.string(),
  resolution: z.enum(['refunded', 'not-collected']).nullable(),
  resolvedAt: z.string().nullable(),
});
export type CounterRefund = z.infer<typeof CounterRefund>;

export const Order = z.object({
  id: z.string(),
  pickupNo: z.number().int().positive(),
  businessDate: z.string(),
  tableNo: z.string(),
  paymentMethod: z.string(),
  note: z.string().nullable(),
  totalSen: z.number().int(),
  status: OrderStatus,
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(OrderItem),
  etaMinutes: z.number().int().nullable(), // 预计还要多久（只对待制作/制作中有值）
  // 混合支付（28号 §三-1）：储值付了多少，其余 otherSen 由 paymentMethod 那种方式付
  storedSen: z.number().int().nonnegative(),
  otherSen: z.number().int().nonnegative(),
  refundState: RefundState,
  refundedSen: z.number().int().nonnegative(),
  refunds: z.array(RefundRecord),
  autoCancelled: z.boolean(), // 系统因「全部菜品已退款」自动取消
});
export type Order = z.infer<typeof Order>;

export const WaitInfo = z.object({
  minutes: z.number().int().nonnegative(),
  queue: z.number().int().nonnegative(), // 当前在做和待做的单数
  source: z.enum(['auto', 'manual']),
});
export type WaitInfo = z.infer<typeof WaitInfo>;

export const SubmitOrderInput = z.object({
  cartId: z.string(),
  tableNo: z.string().nullish(),
  paymentMethod: z.string().nullish(),
  note: z.string().nullish(),
  // 「储值 + 其他方式」合付：余额先扣完，剩下的用 paymentMethod 付
  useStoredValue: z.boolean().nullish(),
});

/** 付款方式的显示文字：纯储值 / 纯其他 / 「储值 RM X + 现金 RM Y」 */
export function paymentText(o: Pick<Order, 'paymentMethod' | 'storedSen' | 'otherSen'>, labelOf: (key: string) => string, money: (sen: number) => string): string {
  if (o.storedSen > 0 && o.otherSen > 0) return `储值 ${money(o.storedSen)} + ${labelOf(o.paymentMethod)} ${money(o.otherSen)}`;
  return labelOf(o.paymentMethod);
}
export type SubmitOrderInput = z.infer<typeof SubmitOrderInput>;
