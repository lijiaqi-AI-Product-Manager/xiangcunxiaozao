import { z } from 'zod';

/**
 * 日结单 / 交接班报表（P2-4）
 *
 * 为什么要有它：以前老板一天忙完，只能靠看板上一堆数字自己对，交接班更是「口头说一句今天卖了多少」。
 * 现在可以按任意时间段把账「结」出来：交给谁、这一班收了多少现金、退了多少、储值进出多少，
 * 打印一张纸签个字，出了分歧纸上有据。
 *
 * 口径与看板完全一致（同一套计算，不另写一遍），唯一的区别是：
 *   - 看板按「营业日」（整天）算；日结单按「任意时间段」（含跨零点，例如 17:00 到次日 02:00 的一整个晚市）
 *   - 日结单多两样交接班必需的东西：付款方式明细里的「张数」和退款来源（储值退 / 柜台退）
 */
const Sen = z.number().int();

/** 报表里的一个付款方式：这一班收了多少张、多少钱、退了多少 */
export const ReportMethod = z.object({
  method: z.string(),
  orders: z.number().int(),
  grossSen: Sen,
  refundSen: Sen,
  netSen: Sen,
});
export type ReportMethod = z.infer<typeof ReportMethod>;

/** 卖得动的菜：按数量排，用于老板一眼看今天什么卖得好、什么备多了 */
export const ReportDish = z.object({
  name: z.string(),
  qty: z.number().int(),
  netSen: Sen,
});
export type ReportDish = z.infer<typeof ReportDish>;

export const DayReport = z.object({
  from: z.string(), // ISO 时刻
  to: z.string(),
  /** 按门店时区格式化好的人话时间段，例如「10-25 10:00 ~ 22:00」 */
  rangeText: z.string(),
  /** 这份报表是什么时候生成的 */
  generatedAt: z.string(),

  orders: z.number().int(), // 有效订单（未取消）
  cancelled: z.number().int(),
  grossSen: Sen,
  refundSen: Sen,
  netSen: Sen,
  /** 客人的人均：净收入 ÷ 订单数，取整到分。没有订单时为 0 */
  avgPerOrderSen: Sen,

  byMethod: z.array(ReportMethod),
  /** 退款按去向拆：退回储值卡的分得回来，柜台退的现金要数 */
  refundStoredSen: Sen,
  refundCounterSen: Sen,

  stored: z.object({
    rechargeSen: Sen,
    consumeSen: Sen,
    refundSen: Sen,
    adjustSen: Sen,
    importSen: Sen,
    netSen: Sen,
    entries: z.number().int(),
  }),
  /** 报表末端的全店储值余额（此刻，不随所选时间段变化） */
  storedBalanceSen: Sen,

  topDishes: z.array(ReportDish),
});
export type DayReport = z.infer<typeof DayReport>;

export const ReportRange = z.object({
  /** 交接班名称，例如「早班」「晚班」，可空 */
  shift: z.string(),
  /** 经手人，可空 */
  operator: z.string(),
});
export type ReportRange = z.infer<typeof ReportRange>;
