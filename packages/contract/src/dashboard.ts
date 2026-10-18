import { z } from 'zod';

/**
 * 数据看板简版（29号 / 31号：今日营收、订单数、储值变动；表格 + 大数字，不用图表库）。
 * 口径（页面上也逐条写明）：
 * - 订单按「营业日」归属（门店时区的日历日，和取餐号归零、售罄恢复同一条线）；已取消的单不计入营收。
 * - 下单金额 = 未取消订单的合计；退款 = 这些订单上的按菜品行退款；实收 = 下单金额 − 退款。
 * - 按付款方式：混合支付的单，储值部分记在储值、其余部分记在另一种方式，两边各算一单。
 * - 储值变动按流水发生的营业日统计，和订单无关；「此刻全店储值余额」不随所选日期变化。
 */
const Sen = z.number().int();

export const MethodSummary = z.object({
  method: z.string(), // 付款方式 key，显示名由前端按品牌配置取
  orders: z.number().int(),
  grossSen: Sen,
  refundSen: Sen,
  netSen: Sen,
});

export const StoredSummary = z.object({
  rechargeSen: Sen, // 充值（正）
  consumeSen: Sen, // 消费（负）
  refundSen: Sen, // 退回（正）
  adjustSen: Sen, // 调整（可正可负）
  importSen: Sen, // 老系统导入（正）
  netSen: Sen, // 当日净变动 = 以上合计
  entries: z.number().int(),
});

export const DaySummary = z.object({
  day: z.string(),
  orders: z.number().int(), // 有效订单（未取消）
  cancelled: z.number().int(),
  grossSen: Sen,
  refundSen: Sen,
  netSen: Sen,
  byMethod: z.array(MethodSummary),
  stored: StoredSummary,
});
export type DaySummary = z.infer<typeof DaySummary>;

export const Dashboard = z.object({
  today: z.string(),
  day: DaySummary,
  /** 所选日期往前共 7 天（含当天），最早的在前 */
  week: z.array(z.object({ day: z.string(), orders: z.number().int(), netSen: Sen, storedNetSen: Sen })),
  storedBalanceSen: Sen,
});
export type Dashboard = z.infer<typeof Dashboard>;
