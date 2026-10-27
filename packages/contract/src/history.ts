import { z } from 'zod';
import { Order, OrderStatus } from './order.ts';

/**
 * 历史订单查询（P2-5）
 *
 * 老板的真实场景：「上周三 8 号桌那桌吃了什么？喝了没有？」「上个月卖了多少份剁椒鱼？」
 *
 * 以前只能看「今天」——`GET /api/admin/orders` 只按单个营业日查，翻昨天的单得改系统时间，
 * 想搜一句「8 号桌」更是完全做不到。日结单给的是钱的汇总，看不到具体哪一桌点了什么。
 *
 * 这里的查询规则只有两条，但都是老板最常用的思路：
 *   ① 按时间段找（默认最近 7 天，可以按天/按周/按月往前推）
 *   ② 按「桌上说得出来的东西」找：桌号、取餐号、菜品名、单号
 * 关键词故意做「全字段模糊」：老板不会记得自己当时填的是桌号还是取餐号，
 * 他只会记得「8」或「剁椒鱼」，系统去猜是哪个字段反而是添乱。
 */

/** 一次最多返回多少单：够老板滚一屏半，再多就该滚页面而不是把手机拖死 */
export const ORDER_SEARCH_MAX_LIMIT = 200;

/**
 * 老板端每页显示多少单。
 * 放在契约里而不是页面上：前端算页数、后端算总条数，两边用同一个数才不会「最后一页是空的」。
 */
export const orderSearchPageSize = 20;

/** 关键词最长多少个字：防止有人贴一整段话进来把查询拖慢 */
export const ORDER_SEARCH_MAX_Q = 40;

export const OrderSearchQuery = z.object({
  /** 起始时刻（含），ISO 或「YYYY-MM-DD」/「YYYY-MM-DDTHH:mm」，按门店时区解释 */
  from: z.string(),
  /** 结束时刻（不含）。只给日期时是这个日期的 00:00 —— 想看某一天就写 from=那天, to=次日 */
  to: z.string(),
  /** 桌号 / 取餐号 / 菜品名 / 单号，任意一个片段。空串 = 不过滤 */
  q: z.string().default(''),
  /** 只看某个状态；'all' = 不限 */
  status: z.union([OrderStatus, z.literal('all')]).default('all'),
  limit: z.number().int().min(1).max(ORDER_SEARCH_MAX_LIMIT).default(50),
  offset: z.number().int().min(0).default(0),
});
export type OrderSearchQuery = z.infer<typeof OrderSearchQuery>;

export const OrderSearchResult = z.object({
  orders: z.array(Order),
  /** 符合条件的总数（不受 limit/offset 影响），前端据此显示「共 37 单」和翻页 */
  total: z.number().int(),
  /** 这一批的净额合计与单数：老板搜出一批单，最想知道的还是「这些一共多少钱」 */
  sumSen: z.number().int(),
  refundSen: z.number().int(),
  /**
   * 这段时间里「卖出去了什么」：按份数倒序的前几名菜品。
   * 老板查「上个月剁椒鱼卖了多少」时，明细里翻页数不清，这里直接给答案。
   */
  dishes: z.array(z.object({ name: z.string(), qty: z.number().int() })),
  /** 服务器按门店时区理解出来的实际时间段，原样显示给老板确认「我查的是不是我想要的那一段」 */
  rangeText: z.string(),
});
export type OrderSearchResult = z.infer<typeof OrderSearchResult>;
