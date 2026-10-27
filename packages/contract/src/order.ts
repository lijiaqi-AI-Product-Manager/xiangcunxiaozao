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
  /**
   * 这一行的编号（P1-9）。同一种菜可以有多行——「剁椒鱼 微辣」和「剁椒鱼 特辣」是两行，
   * 所以前端改数量/删行必须认 id，不能再按 dishUid。
   */
  id: z.string(),
  dishUid: z.string(),
  code: z.string(),
  name: z.string(),
  priceSen: z.number().int().nullable(),
  qty: z.number().int().positive(),
  subtotalSen: z.number().int(),
  /** 这一行的辣度（brand.spiceOptions 的值）；空串 = 没选 */
  spice: z.string().default(''),
  /** 这一行的备注（不要香菜 / 打包）；空串 = 没有 */
  note: z.string().default(''),
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
  /** 下单时这一行选的辣度；空串 = 没选（P1-9） */
  spice: z.string().default(''),
  /** 下单时这一行的备注；空串 = 没有（P1-9） */
  note: z.string().default(''),
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
  // 乐观锁版本号：老板端改状态时带回来，对不上说明别的设备刚改过（防止两台设备互相覆盖）。
  // 老数据没有这个字段，给默认值 0，避免前端解析失败。
  version: z.number().int().nonnegative().default(0),
  /**
   * 这单是不是一张「加菜单」（P2-6）。
   *
   * 加菜另开一张子单，钱各记各的，但客人和老板看到的都是父单那个取餐号。
   * 所以 pickupNo 一律返回**父单的号**；要区分「第几次加菜」看 addSeq。
   */
  parentOrderId: z.string().nullable().default(null),
  /** 第几次加菜（1、2、3…）；主单为 null */
  addSeq: z.number().int().positive().nullable().default(null),
  /**
   * 这张单自己付了多少钱、退了多少。
   *
   * 加菜后「这一桌一共多少」= 父单 totalSen + 各子单 totalSen。
   * 为了不让每个调用方自己加一遍（漏掉子单是最容易犯的错），接口同时给一个 groupTotalSen。
   */
  groupTotalSen: z.number().int().nonnegative().default(0),
  /** 这一桌一共退了多少（父子相加） */
  groupRefundedSen: z.number().int().nonnegative().default(0),
  /** 还有几次加菜单挂在它下面（只在父单上有值，方便老板端说「又加了 2 次」） */
  addCount: z.number().int().nonnegative().default(0),
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
  // 幂等编号：顾客网络一抖就会重试，带同一个编号重试必须返回同一张单，不能变成两张
  requestId: z.string().nullish(),
  /**
   * 这台手机的固定编号（存在本地，见 apps/customer/src/api.ts 的 deviceId()）。
   *
   * 以前订单的 device_id 存的是购物车 id，而「我的订单 / 取餐页」拿的是设备号去查，
   * 两边永远不相等 —— 顾客下完单回头一看，永远是「还没有订单」，取餐页也找不到自己的单。
   * 购物车每单都会换一个，设备号才跟着这台手机走，所以必须由前端明确带上来。
   */
  deviceId: z.string().nullish(),
});

/**
 * 加菜（P2-6）：往**已经下过的**那张单后面再挂一张子单。
 *
 * 只允许点「这张单还是这一桌的菜」的时候加。规则写在这里，服务端照着执行：
 *   • 父单已取消 / 已完成：不能再加（做完了再加，就该重新开一单）
 *   • 父单本身是加菜单：不能再套一层，永远挂到最上面那张主单（避免出现三层、四层）
 *   • 付款方式跟父单走，不再让顾客选一次——一桌一单的账，付款方式应该一致
 */
export const AddDishesInput = z.object({
  /** 挂在哪个取餐号下面。顾客手上只有这个号，他也只可能提供这个 */
  pickupNo: z.number().int().positive(),
  cartId: z.string(),
  note: z.string().nullish(),
  requestId: z.string().nullish(),
  deviceId: z.string().nullish(),
});
export type AddDishesInput = z.infer<typeof AddDishesInput>;

/** 一张单现在的显示号：加菜子单显示成「018+1」 */
export function pickupLabel(pickupNo: number, addSeq: number | null | undefined): string {
  return `${String(pickupNo).padStart(3, '0')}${addSeq ? `+${addSeq}` : ''}`;
}

/** 付款方式的显示文字：纯储值 / 纯其他 / 「储值 RM X + 现金 RM Y」 */
export function paymentText(o: Pick<Order, 'paymentMethod' | 'storedSen' | 'otherSen'>, labelOf: (key: string) => string, money: (sen: number) => string): string {
  if (o.storedSen > 0 && o.otherSen > 0) return `储值 ${money(o.storedSen)} + ${labelOf(o.paymentMethod)} ${money(o.otherSen)}`;
  return labelOf(o.paymentMethod);
}
export type SubmitOrderInput = z.infer<typeof SubmitOrderInput>;
