/**
 * 两种纸的排版：小票（receipt）与饮料标签（label）
 *
 * 三条原则：
 * 1. 纯函数——进订单数据，出 ESC/POS 字节。不碰网络，可单测、可离线预览。
 * 2. 店名/地址一律从参数传入，代码里不写死（沿用项目 check:brand 规矩）。
 * 3. 打印失败绝不反噬下单——调用方负责兜底，这里只管排版。
 */

import { CMD, PAPER_COLS, type PaperSize, barcode, lr, text, wrap } from './escpos.ts';

export interface PrintOrderItem {
  /** 菜品 uid，用来判断是不是饮品（饮品才出杯贴） */
  dish_uid: string;
  code: string;
  name: string;
  qty: number;
  price_rm: string;
  subtotal_rm: string;
  /** 菜品级备注（这杯少冰）；整单备注在 PrintOrder.note */
  note?: string | null;
  /** 菜品级辣度（不辣 / 微辣 …）；空 = 没选（P1-9） */
  spice?: string | null;
  is_drink: boolean;
}

export interface PrintOrder {
  order_no: string;
  pickup_no: number;
  table_no: string;
  status: string;
  total_rm: string;
  note: string | null;
  /** 已按门店时区格式化好的本地时间（YYYY-MM-DD HH:mm:ss），避免打印时再做时区换算 */
  created_at: string;
  pay_method_label?: string | null;
  /** 第几次加菜（P2-6）：非空表示这是某张单的加菜单，小票上要单独标一行 */
  add_seq?: number | null;
  shop?: { address?: string | null; phone?: string | null; hours?: string | null } | null;
  items: PrintOrderItem[];
}

export interface ShopInfo {
  name: string;
  address?: string | null;
  phone?: string | null;
  footer?: string | null;
}

export interface PrintConfig {
  paper: PaperSize;
  encoding: 'gbk' | 'utf8';
  /** 有没有切刀；没有就多走几行空白让手撕 */
  cutter: boolean;
  /** 是否开钱箱（小票机 RJ11 口接钱箱） */
  cashDrawer: boolean;
}

/**
 * 小票版式（80mm / 48 列）
 *   店名（居中 双高双宽）
 *   取餐号（三倍字号，厨房最关心）
 *   桌号 / 单号 / 时间
 *   ----
 *   菜名            小计
 *    单价x数量
 *   ----
 *   合计 RM xx
 *   备注
 *   条码（单号）
 *
 * 小票给顾客和收银看，所以列全单（含炒菜）；杯贴才只贴饮品。
 */
export function renderReceipt(o: PrintOrder, shop: ShopInfo, cfg: PrintConfig): Buffer {
  const cols = PAPER_COLS[cfg.paper];
  // 双宽字一个字符吃两列：店名地址这类放大行必须按半宽折，否则折出来的行会超出纸边
  const colsHalf = Math.floor(cols / 2);
  const W = (s: string): Buffer => text(s, cfg.encoding);
  const p: Buffer[] = [CMD.init, CMD.align('center')];

  p.push(CMD.emphasis(true, true, true), W(shop.name), W('\n'), CMD.normal);
  p.push(W('\n'), CMD.size(3), W(`取餐号 ${o.pickup_no}`), W('\n'), CMD.size(1));
  // 加菜单（P2-6）：取餐号下面单独一行大字标出来。后厨拿着一叠票，靠这一行才不会
  // 把「018 的加菜」当成重复打印的 018 丢掉
  if (o.add_seq) p.push(W('\n'), CMD.emphasis(true), W(`** 加菜 第 ${o.add_seq} 次 **`), W('\n'), CMD.normal);
  p.push(W(`桌号 ${o.table_no}`), W('\n\n'));

  p.push(CMD.align('left'));
  const sep = '-'.repeat(cols);
  p.push(W(sep), W('\n'));
  // 单号本身就是「营业日-取餐号」，取餐号已经用超大字号印在上面了，
  // 这里只印后面的流水号，不重复印一遍取餐号
  p.push(W(`单号 ${o.order_no.split('-')[1] ?? o.order_no}`), W('\n'));
  p.push(W(`时间 ${o.created_at}`), W('\n'));
  p.push(W(sep), W('\n'));

  for (const it of o.items) {
    const sub = `RM ${it.subtotal_rm}`; // 带 RM 前缀才能和下面「合计 RM xx」右边缘对齐
    const mid = `${it.price_rm}x${it.qty}`;
    const nameCols = Math.max(8, cols - sub.length - 2);
    // 辣度直接跟在菜名后面：「剁椒鱼（特辣）」——后厨扫一眼就知道这份怎么做，
    // 不用去翻备注那行。同菜不同辣度会是两条明细，各自带各自的口味（P1-9）
    const shown = it.spice ? `${it.name}（${it.spice}）` : it.name;
    const lines = wrap(shown, nameCols);
    lines.forEach((l, i) => {
      p.push(W(i === 0 ? lr(l, sub, cols) : l), W('\n'));
    });
    p.push(W(lr(`  单价 ${mid}`, '', cols)), W('\n'));
    if (it.note) p.push(W(lr(`  * ${it.note}`, '', cols)), W('\n'));
  }

  p.push(W(sep), W('\n'));
  p.push(CMD.emphasis(true), W(lr('合计', `RM ${o.total_rm}`, cols)), W('\n'), CMD.normal);
  if (o.pay_method_label) p.push(W('支付  ' + o.pay_method_label), W('\n'));

  if (o.note) {
    p.push(W(sep), W('\n'));
    for (const l of wrap(`备注：${o.note}`, cols)) p.push(W(l), W('\n'));
  }

  // 店名下方那行小字：营业时间 / 地址 / 电话。没填就整段不出，不留空行。
  const tail: string[] = [];
  if (shop.footer) tail.push(shop.footer);
  const info = o.shop ?? {};
  if (info.hours) tail.push(`营业时间 ${info.hours}`);
  if (info.address) tail.push(info.address);
  if (info.phone) tail.push(`电话 ${info.phone}`);
  if (tail.length) {
    p.push(W(sep), W('\n'));
    for (const line of tail) for (const l of wrap(line, cols)) p.push(W(l), W('\n'));
  }

  const code = o.order_no.replace(/[^0-9A-Z-]/gi, '').toUpperCase();
  if (code.length >= 4) p.push(W('\n'), CMD.align('center'), barcode(code), W('\n'));

  if (cfg.cashDrawer) p.push(CMD.kickDrawer);
  p.push(CMD.align('left'), CMD.feed(3));
  if (cfg.cutter) p.push(CMD.cut(false));
  return Buffer.concat(p);
}

/** 哪些菜要出杯贴 */
export function cupItems(o: PrintOrder): PrintOrderItem[] {
  return o.items.filter((it) => it.is_drink && it.qty > 0);
}

/**
 * 饮料标签：**一杯一张**，且**只贴饮品**
 *
 * 关键点：
 * - 标签机没有大脑，分装在代码里做完。数量 3 杯 → 输出 3 张，
 *   而不是打一张写「x3」（那样贴不到三个杯子上）。
 * - 炒菜不出杯贴。吧台一天几十单，废纸和撕标签的时间都是真金白银。
 *
 * 版式（79.5mm 纸，按 32 列排）：
 *   桌 12        ← 大字号，出杯时一眼对上托盘
 *   菜名
 *   少冰          ← 菜品级备注，印在名字正下方，调饮时最先看到
 *   时间 + 取餐号
 *   1/3
 *
 * 版式按 58mm（32 列）保守排：80mm 纸上会窄一点居中，但绝不会折行出错。
 * 标签纸宽度各家不同，宁可窄不可溢。
 */
export function renderCups(
  o: PrintOrder,
  label: { bigTable: boolean },
  cfg: PrintConfig
): Buffer[] {
  const cols = 32;
  const W = (s: string): Buffer => text(s, cfg.encoding);
  // 取餐号是流水号（3 位），不是单号后 4 位——所以从单号里取「-」后面那段
  const shortNo = o.order_no.split('-')[1] ?? o.order_no.slice(-3);
  const hhmm = o.created_at.slice(11, 16);
  const cups: Buffer[] = [];

  for (const it of cupItems(o)) {
    // 序号按「这道菜自己的杯数」从 1 数起，不能跨菜累加
    for (let k = 1; k <= it.qty; k++) {
      const p: Buffer[] = [CMD.init, CMD.align('center')];
      p.push(CMD.size(label.bigTable ? 3 : 2), W(`桌 ${o.table_no}`), W('\n'), CMD.size(1), W('\n'));
      // 名字最长两行：标签纸就那么大，溢出去的内容等于没印
      const nameLines = wrap(it.name, Math.floor(cols / 2)).slice(0, 2);
      p.push(CMD.emphasis(true), W(nameLines.join('\n')), W('\n'), CMD.normal);
      if (it.note) {
        for (const l of wrap(it.note, cols).slice(0, 2)) p.push(CMD.emphasis(true), W(l), W('\n'), CMD.normal);
      }
      p.push(W('\n'), W(`${hhmm}  #${shortNo}`), W('\n'));
      if (it.qty > 1) p.push(W(`${k}/${it.qty}`), W('\n'));
      p.push(CMD.feed(2));
      // 标签纸是整卷的模切纸，没有切刀；只有配置说有时候才发切纸指令
      if (cfg.cutter) p.push(CMD.cut(false));
      cups.push(Buffer.concat(p));
    }
  }
  return cups;
}
