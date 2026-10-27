/**
 * 打印模块对外入口
 *
 * 把「一张订单」翻译成「两张纸」的整条链路：
 *   Order(DTO) → PrintOrder → 小票字节 / 标签字节 → 通道 → 纸
 *
 * 配置全部走环境变量，缺省 = 关闭。一台不配，系统照常跑，只是不打纸。
 */

import { createChannel, type TransportKind } from './transport.ts';
import type { PrintConfig, PrintOrder, ShopInfo } from './templates.ts';
import { PrintDispatcher, type PrintJobResult, type TargetName, type TargetSpec } from './dispatcher.ts';

export { PrintDispatcher } from './dispatcher.ts';
export type { PrintJobResult, TargetName } from './dispatcher.ts';
export { renderReceipt, renderCups } from './templates.ts';
export type { PrintOrder, ShopInfo, PrintConfig } from './templates.ts';

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());

const num = (v: string | undefined, dflt: number): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : dflt;
};

export interface PrintEnv {
  receiptEnabled: boolean;
  receiptKind: TransportKind;
  receiptHost?: string;
  receiptPort: number;
  receiptDevice?: string;
  receiptQueue?: string;
  receiptPaper: '80' | '58';
  receiptCutter: boolean;
  receiptDrawer: boolean;
  labelEnabled: boolean;
  labelKind: TransportKind;
  labelHost?: string;
  labelPort: number;
  labelDevice?: string;
  labelQueue?: string;
  labelCutter: boolean;
  encoding: 'gbk' | 'utf8';
  retries: number;
  backoffMs: number;
  /** 两台的接法可以不同，但纸宽/切刀等分机配置各自独立 */
}

export function readPrintEnv(env: NodeJS.ProcessEnv = process.env): PrintEnv {
  const kind = (v: string | undefined): TransportKind => {
    const k = (v ?? 'mock').toLowerCase() as TransportKind;
    return ['net', 'usb', 'system', 'mock'].includes(k) ? k : 'mock';
  };
  const rOn = bool(env.PRINT_RECEIPT_ON, false);
  const lOn = bool(env.PRINT_LABEL_ON, false);
  return {
    receiptEnabled: rOn,
    receiptKind: kind(env.PRINT_RECEIPT_KIND),
    receiptHost: env.PRINT_RECEIPT_HOST,
    receiptPort: num(env.PRINT_RECEIPT_PORT, 9100),
    receiptDevice: env.PRINT_RECEIPT_DEVICE,
    receiptQueue: env.PRINT_RECEIPT_QUEUE,
    receiptPaper: env.PRINT_RECEIPT_PAPER === '58' ? '58' : '80',
    receiptCutter: bool(env.PRINT_RECEIPT_CUTTER, true),
    receiptDrawer: bool(env.PRINT_RECEIPT_DRAWER, false),
    labelEnabled: lOn,
    labelKind: kind(env.PRINT_LABEL_KIND),
    labelHost: env.PRINT_LABEL_HOST,
    labelPort: num(env.PRINT_LABEL_PORT, 9100),
    labelDevice: env.PRINT_LABEL_DEVICE,
    labelQueue: env.PRINT_LABEL_QUEUE,
    labelCutter: bool(env.PRINT_LABEL_CUTTER, true),
    encoding: env.PRINT_ENCODING === 'utf8' ? 'utf8' : 'gbk',
    retries: num(env.PRINT_RETRIES, 2),
    backoffMs: num(env.PRINT_BACKOFF_MS, 800),
  };
}

/** 支付方式 key → 中文名（来自 brand.json 的 paymentMethods，找不到就用原值） */
export function payLabelOf(methods: { key: string; label: string }[], key: string | undefined): string | null {
  if (!key) return null;
  return methods.find((m) => m.key === key)?.label ?? key;
}

export function buildDispatcher(cfg: PrintEnv, sink?: (r: PrintJobResult) => void): PrintDispatcher {
  const base: PrintConfig = { paper: cfg.receiptPaper, encoding: cfg.encoding, cutter: true, cashDrawer: false };
  const targets: TargetSpec[] = [];

  if (cfg.receiptEnabled) {
    targets.push({
      name: 'receipt',
      enabled: true,
      channel: createChannel(cfg.receiptKind, {
        host: cfg.receiptHost,
        port: cfg.receiptPort,
        device: cfg.receiptDevice,
        queue: cfg.receiptQueue,
      }),
      config: { ...base, cutter: cfg.receiptCutter, cashDrawer: cfg.receiptDrawer },
      retries: cfg.retries,
      backoffMs: cfg.backoffMs,
    });
  }
  if (cfg.labelEnabled) {
    targets.push({
      name: 'label',
      enabled: true,
      channel: createChannel(cfg.labelKind, {
        host: cfg.labelHost,
        port: cfg.labelPort,
        device: cfg.labelDevice,
        queue: cfg.labelQueue,
      }),
      config: { ...base, paper: '80', cutter: cfg.labelCutter },
      retries: cfg.retries,
      backoffMs: cfg.backoffMs,
    });
  }
  return new PrintDispatcher({ targets, sink });
}

/**
 * 订单 DTO → 打印用数据结构（字段名转换集中在这一处，DTO 改了只改这里）
 * order: apps/server/src/orders.ts 里的 Order
 *
 * opts.drinkUids：哪些菜属于饮品（brand.drinkCategories）。
 *   标签机只贴饮料杯，炒菜不该出杯贴——否则吧台一天撕掉几十张废纸。
 * opts.itemNotes：菜品级备注（「这杯少冰」）。单子级备注是整桌的，不能当每杯的规格用。
 */
export function toPrintOrder(
  o: {
    pickupNo: number;
    /** 第几次加菜（P2-6）：非空表示这是「018 号单的加菜单」，小票上要印出来 */
    addSeq?: number | null;
    tableNo: string;
    status: string;
    totalSen: number;
    note: string | null;
    createdAt: string;
    paymentMethod?: string;
    items: { dishUid?: string; code?: string; name: string; priceSen: number; qty: number; note?: string | null; spice?: string | null }[];
    id?: string;
  },
  opts: {
    timezone: string;
    payLabel?: string | null;
    businessDate?: string;
    shop?: { address?: string | null; phone?: string | null; hours?: string | null } | null;
    drinkUids?: Set<string> | string[];
  }
): PrintOrder {
  const rm = (sen: number): string => (sen / 100).toFixed(2);
  const drinks = opts.drinkUids instanceof Set ? opts.drinkUids : new Set(opts.drinkUids ?? []);
  // 按门店时区格式化成本地时间字符串（打印时不希望看到 UTC）
  const local = new Intl.DateTimeFormat('sv-SE', {
    timeZone: opts.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(o.createdAt));
  // 单号用「月日 + 3 位取餐号」（如 1025-034）：营业日当天的单一眼能念出来，条码也短。
  // 注意不能从本地时间取营业日——凌晨到打烊之间跨零点，本地日期和营业日不是一回事。
  const biz = (opts.businessDate ?? local.slice(0, 10)).replace(/-/g, '');
  // 加菜单的单号加后缀 A1/A2：条码和图上的单号一眼能看出是「018 的第 1 次加菜」。
  // 不加的话，同一桌的两次小票长得一模一样，后厨分不清哪张是补的
  const addSuffix = o.addSeq ? `A${o.addSeq}` : '';
  const day = biz.length >= 8 ? biz.slice(4, 8) : biz.slice(-4);
  const orderNo = `${day}-${String(o.pickupNo).padStart(3, '0')}${addSuffix}`;
  return {
    order_no: orderNo,
    pickup_no: o.pickupNo,
    table_no: o.tableNo,
    status: o.status,
    total_rm: rm(o.totalSen),
    note: o.note,
    created_at: local,
    pay_method_label: opts.payLabel ?? o.paymentMethod ?? null,
    add_seq: o.addSeq ?? null,
    shop: opts.shop ?? null,
    items: o.items.map((i) => ({
      dish_uid: i.dishUid ?? '',
      code: i.code ?? '',
      name: i.name,
      qty: i.qty,
      price_rm: rm(i.priceSen),
      subtotal_rm: rm(i.priceSen * i.qty),
      note: i.note ?? null,
      // 辣度逐行带下去，小票上直接印在菜名后面（P1-9）
      spice: i.spice ?? null,
      // 菜的码表里没有就按「不是饮品」处理：宁可不贴，也别乱贴
      is_drink: drinks.size === 0 ? true : Boolean(i.dishUid && drinks.has(i.dishUid)),
    })),
  };
}
