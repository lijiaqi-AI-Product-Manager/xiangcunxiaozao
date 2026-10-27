import { formatDateTime, formatMoney } from '@pkg/contract';
import type { Order } from '@pkg/contract';

/**
 * 历史订单导出 CSV。
 *
 * 三个必须做对的地方，任何一个错了老板都会觉得「导出的文件是坏的」：
 *
 * ① **BOM**。Excel 打开没有 BOM 的 UTF-8 CSV，中文全是乱码（「剁椒鱼头」变「??½·½」）。
 *    加一个 U+FEFF 就好了，Excel 认它。这是中文 CSV 最常见的坑。
 *
 * ② **以 = + - @ 开头的单元格前面要加 '**。Excel 会把它们当公式执行，
 *    一张写着「=1+1」的备注被打开就变成 2，更糟的是配方可以直接执行（CSV 注入）。
 *    备注是顾客随手写的，完全可能有这种内容。
 *
 * ③ **首行不写 sep=,**。那是给欧洲区 Excel（分号分隔）用的，
 *    在中文区 Excel 里反而会多出一行垃圾。用逗号 + 双引号包裹就够了。
 *
 * 另外：金额一律「元」两位小数（不是「仙」）。财务/记账软件认的是 48.00，不是 4800。
 */

/** 一行订单 = CSV 的一行。菜品摊平成「菜名×份数」一串，老板在 Excel 里还能直接筛选 */
const HEADER = [
  '单号', '取餐号', '营业日', '下单时间', '桌号', '菜品明细', '总份数',
  '金额(元)', '已退(元)', '实收(元)', '付款方式', '状态', '备注', '退款/取消说明',
];

const STATUS_ZH: Record<string, string> = {
  pending: '待制作', cooking: '制作中', done: '已完成', cancelled: '已取消',
};

/** CSV 单元格转义：内容里有逗号/引号/换行，就要用双引号包起来，内部引号翻倍 */
export function csvCell(v: string | number | null | undefined): string {
  const raw = v === null || v === undefined ? '' : String(v);
  // 公式注入防护（见文件头 ②）
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * 元、两位小数。走全站同一个 formatMoney：以前这里自己算分→元并补两位，
 * 一旦别处改了规则（比如负数、非整数），导出文件和界面就会对不上账。
 */
const yuan = (sen: number) => formatMoney(sen);

export function ordersToCsv(orders: Order[], timeZone: string, payLabel: (key: string) => string): string {
  const lines: string[] = [HEADER.map(csvCell).join(',')];
  for (const o of orders) {
    const items = o.items
      .map((i) => {
        const extra = [i.spice && `辣度:${i.spice}`, i.note && `备注:${i.note}`].filter(Boolean).join(' ');
        return `${i.name}×${i.qty}${extra ? `(${extra})` : ''}`;
      })
      .join('；');
    const qty = o.items.reduce((s, i) => s + i.qty, 0);
    lines.push([
      o.id,
      o.pickupNo,
      o.businessDate,
      formatDateTime(o.createdAt, timeZone),
      o.tableNo,
      items,
      qty,
      yuan(o.totalSen),
      yuan(o.refundedSen),
      yuan(Math.max(0, o.totalSen - o.refundedSen)),
      payLabel(o.paymentMethod),
      STATUS_ZH[o.status] ?? o.status,
      o.note ?? '',
      o.cancelReason ?? (o.autoCancelled ? '全部退完后系统自动取消' : ''),
    ].map(csvCell).join(','));
  }
  // BOM + CRLF：Excel 对 CRLF 的兼容性最好（用 \n 也行，但 Windows 记事本打开会连成一行）
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** 文件名里不能有 : / \ 这些字符，日期时间改成 2026-10-26_1530 这种 */
export function csvFileName(prefix: string, from: string, to: string): string {
  const clean = (s: string) => s.replace(/[^0-9A-Za-z-]/g, '').slice(0, 10) || 'x';
  return `${prefix}_${clean(from)}_${clean(to)}.csv`;
}
