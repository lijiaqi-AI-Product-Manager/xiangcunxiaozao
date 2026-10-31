/**
 * TSPL / TSPL2 指令拼装（标签模式专用）
 *
 * 为什么需要这一份：芯烨 XP-236B 是「票据 + 标签」双模机。
 *   票据模式（Receipt）→ 认 ESC/POS，按连续纸收字符流，走纸靠走纸指令；
 *   标签模式（Label）  → 认 TSPL，按**模切标签**定位，靠 Gap 传感器找缝。
 * 两种模式**互相听不懂**：把 ESC/POS 字节丢给 Label 模式，出来的是空白或几行乱码；
 * 反过来把 TSPL 丢给 Receipt 模式，机器会一直等一个永远不来的标签缝。
 * 所以协议必须由配置显式选，不能靠猜。
 *
 * 指令集只用到最小一组（TSPL 手册里的经典写法）：
 *   SIZE   标签宽高（mm）      GAP   标签间隙（mm）
 *   CLS    清上一张的画布      TEXT  印一行字（坐标是**点**，203dpi = 8 点/mm）
 *   BAR    画一条横线          PRINT 出纸（1 张，1 份）
 *
 * 中文的坑：TSPL 没有「汉字模式」这种开关，中文靠机器**内置点阵字库**，
 * 常见名字是 TSS24.BF2（TSC 系）或 TST24.BF2（部分芯烨固件）。
 * 字体名写错不会报错，只会打出一串空格——所以字体名做成配置项，出问题换名字重打即可。
 * 24 点阵字：全角 24 点宽、半角 12 点宽，放大 n 倍就是 24n / 12n。
 */

import { displayWidth, text, type Encoding } from './escpos.ts';

/** 203dpi 热敏机：1mm = 8 点。TSPL 里所有坐标都是点，不是毫米 */
export const DOTS_PER_MM = 8;

/** 24 点阵字库的基准尺寸（点） */
const BASE_DOTS = 24;
/** 半角字符在 24 点阵下占 12 点 */
const HALF_DOTS = BASE_DOTS / 2;

export interface LabelGeometry {
  widthMm: number;
  heightMm: number;
  /** 标签之间的缝；连续纸填 0 */
  gapMm: number;
  /** 机器内置中文字库名 */
  font: string;
}

/** 店里这卷是 30×40 间隙纸；字体名用 TSC 系最常见的那支 */
export const DEFAULT_LABEL_GEOMETRY: LabelGeometry = {
  widthMm: 30,
  heightMm: 40,
  gapMm: 2,
  font: 'TSS24.BF2',
};

/** 一杯饮品要印的全部内容（渲染层不认订单，只认这几个字段） */
export interface CupLabel {
  tableNo: string;
  name: string;
  /** 菜品级备注：少冰、少糖、去柠檬 */
  spec?: string | null;
  /** HH:mm */
  time: string;
  /** 取餐号（3 位流水） */
  orderNo: string;
  /** 第几杯 / 共几杯；单杯不印 */
  seq?: { k: number; n: number } | null;
  /** 桌号是否放大一倍（大桌号出杯时一眼对上托盘） */
  bigTable?: boolean;
}

/**
 * TSPL 字符串里的双引号必须处理：机器按引号截断指令，
 * 菜名里出现一个 " 就会把后面的指令吞掉（表现为少印几行）。
 * 统一换成单引号，再把换行/制表压成空格——标签上没有折行指令，换行只能靠我们自己算 y。
 */
export function escapeTspl(s: string): string {
  return s
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/"/g, "'")
    // 控制字符会让打印机把指令流当成二进制图，整张作废
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
}

/** 一个字符串在 24 点阵、放大 mx 倍时占多少点宽 */
export function dotsWidth(s: string, mx = 1): number {
  return displayWidth(s) * HALF_DOTS * mx;
}

/** 按点宽折行：标签是窄条，名字长了必须折，折出去的部分等于没印 */
export function wrapToDots(s: string, maxDots: number, mx = 1): string[] {
  const maxUnits = Math.max(1, Math.floor(maxDots / (HALF_DOTS * mx)));
  const out: string[] = [];
  let line = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > maxUnits && line !== '') {
      out.push(line);
      line = '';
      w = 0;
    }
    line += ch;
    w += cw;
  }
  if (line) out.push(line);
  return out;
}

/**
 * 一张杯贴。
 *
 * 版式（30×40mm = 240×320 点，左右各留 6 点）：
 *   桌 12          ← 放大 2 倍（48 点高），吧台一眼对上托盘
 *   招牌手打柠檬茶  ← 最多两行
 *   少冰 少糖       ← 最多两行，调饮时最先看
 *   ─────
 *   19:42  #034
 *   1/3            ← 只有多杯才印
 *
 * 为什么每行都自己算 y：TSPL 没有「自动换行」，TEXT 的 y 是绝对的。
 * 交给机器排版只能是一行一个字位，字多了直接压到标签外。
 */
export function renderCupLabelTspl(label: CupLabel, geom: LabelGeometry, encoding: Encoding = 'gbk'): Buffer {
  const W = Math.round(geom.widthMm * DOTS_PER_MM);
  const H = Math.round(geom.heightMm * DOTS_PER_MM);
  const M = 6;
  const inner = W - M * 2;
  const font = escapeTspl(geom.font) || 'TSS24.BF2';
  const parts: Buffer[] = [];

  const ascii = (s: string): void => {
    parts.push(Buffer.from(s, 'latin1'));
  };
  /** 一行文字：坐标 + 字体 + 放大倍数 + 内容（内容单独按目标编码出字节） */
  const textLine = (x: number, y: number, mx: number, my: number, s: string): void => {
    ascii(`TEXT ${x},${y},"${font}",0,${mx},${my},"`);
    parts.push(text(escapeTspl(s), encoding));
    ascii('"\n');
  };
  const centered = (y: number, mx: number, my: number, s: string): void =>
    textLine(Math.max(M, Math.round((W - dotsWidth(s, mx)) / 2)), y, mx, my, s);

  parts.push(Buffer.from('', 'latin1'));
  ascii(`SIZE ${geom.widthMm} mm,${geom.heightMm} mm\n`);
  ascii(`GAP ${geom.gapMm} mm,0 mm\n`);
  ascii('DIRECTION 1\n');
  ascii('REFERENCE 0,0\n');
  ascii('CLS\n');

  let y = M;

  // 1. 桌号：放大字号，占 48 点高
  const tableMult = label.bigTable === false ? 1 : 2;
  const tableH = BASE_DOTS * tableMult;
  if (y + tableH <= H - M) {
    centered(y, tableMult, tableMult, `桌 ${label.tableNo}`);
    y += tableH + 4;
  }

  // 2. 菜名：最多两行
  for (const line of wrapToDots(label.name || '（未命名）', inner).slice(0, 2)) {
    if (y + BASE_DOTS > H - M) break;
    centered(y, 1, 1, line);
    y += BASE_DOTS;
  }
  y += 2;

  // 3. 规格备注：最多两行；标签不够高时整段让位（宁可不印，也不压住后面的时间和序号）
  if (label.spec) {
    const lines = wrapToDots(label.spec, inner).slice(0, 2);
    const need = lines.length * BASE_DOTS + BASE_DOTS + 6;
    if (y + need <= H - M) {
      for (const line of lines) {
        centered(y, 1, 1, line);
        y += BASE_DOTS;
      }
      y += 2;
    }
  }

  // 4. 分隔线 + 时间 / 单号 + 杯序
  if (y + 6 + BASE_DOTS * 2 <= H - M) {
    ascii(`BAR ${M},${y},${W - M},2\n`);
    y += 6;
  }
  const foot = `${label.time}  #${label.orderNo}`;
  if (y + BASE_DOTS <= H - M) {
    centered(y, 1, 1, foot);
    y += BASE_DOTS;
  }
  if (label.seq && label.seq.n > 1 && y + BASE_DOTS <= H - M) {
    centered(y, 1, 1, `${label.seq.k}/${label.seq.n}`);
  }

  // 每张单独 PRINT：模切纸出纸靠 Gap 定位，一次多张时中间任何一张没找到缝都会连累后面
  ascii('PRINT 1,1\n');
  return Buffer.concat(parts);
}
