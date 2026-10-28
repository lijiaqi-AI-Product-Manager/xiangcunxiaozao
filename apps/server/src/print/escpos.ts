/**
 * ESC/POS 指令拼装（纯函数，不碰网络/串口，便于单元测试）
 *
 * 为什么自己拼而不用库：两台机器型号不同（芯烨 XP-236B 80mm / ZYWELL Zy307 标签机），
 * 现成库要么锁死一种纸宽，要么带一堆用不上的功能；小票和标签需要的指令很少，
 * 自己拼 = 每一字节都在掌控里，出问题一眼能定位。
 *
 * 用到的指令：ESC @ 初始化、ESC a 对齐、ESC ! 字重/倍高、GS ! 字号、
 * GS v 0 光栅位图、GS k 条码、GS V 走纸切线、ESC p 钱箱。
 */

import iconv from 'iconv-lite';

export type Align = 'left' | 'center' | 'right';

/** 纸宽（列数）：80mm ≈ 48 个半角 / 24 个全角；58mm ≈ 32 / 16 */
export type PaperSize = '80' | '58';

export const PAPER_COLS: Record<PaperSize, number> = { '80': 48, '58': 32 };

/**
 * 汉字编码。国产热敏机的「中文」全是双字节老朋友：
 *   gbk      芯烨/佳博/ZYWELL 出厂默认，一个字 2 字节（最稳）
 *   gb18030  GBK 的超集，生僻字（𠮷、犇、麤）不会变成问号，字节长度仍是 2，列宽算法不用改
 *   utf8     少数外贸机/安卓板子；国产机发 utf8 会打成一串乱码
 */
export type Encoding = 'gbk' | 'gb18030' | 'utf8';

export const CMD = {
  init: Buffer.from([0x1b, 0x40]),
  align: (a: Align): Buffer => Buffer.from([0x1b, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2]),
  /** bit3=加粗 bit4=双高 bit5=双宽 */
  emphasis: (bold: boolean, doubleH = false, doubleW = false): Buffer =>
    Buffer.from([0x1b, 0x21, (bold ? 0x08 : 0) | (doubleH ? 0x10 : 0) | (doubleW ? 0x20 : 0)]),
  normal: Buffer.from([0x1b, 0x21, 0x00]),
  /** GS ! 字号：1=常规 2=双倍 3=三倍 */
  size: (n: 1 | 2 | 3): Buffer => Buffer.from([0x1d, 0x21, n === 1 ? 0x00 : n === 2 ? 0x11 : 0x22]),
  /** 打开钱箱（ESC p 0 25 250） */
  kickDrawer: Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]),
  feed: (n = 1): Buffer => Buffer.from([0x1b, 0x64, Math.max(0, Math.min(255, n))]),
  /** 切纸：0 全切 / 1 半切（只有带切刀的机型认这条） */
  cut: (partial = false): Buffer => Buffer.from([0x1d, 0x56, partial ? 0x42 : 0x00, 0x03]),
  /**
   * 进入汉字模式（FS &）。
   * 芯烨、佳博、ZYWELL 这类机子里，双字节汉字的第一个字节（0xB0–0xF7）同时也是
   * 单字节的扩展 ASCII 区。不先发这条，机器会把「湘」拆成两个乱字符打出来——
   * 这也是「有的票中文正常、有的票全是怪符号」最常见的原因：前面那张票进了汉字模式，
   * 这张没进。gbk/gb18030 一律在票头补上，utf8 机器不能发（会把后面整段吞掉）。
   */
  chineseMode: Buffer.from([0x1c, 0x26]),
};

/**
 * 实时状态查询（DLE EOT n）：问打印机「你现在怎么样」，机器回 1 个字节。
 * n=1 打印机状态、n=2 离线状态、n=3 错误状态、n=4 纸张状态。
 * 见 ESC/POS 手册 DLE EOT；芯烨、佳博、ZYWELL 都实现了这组指令。
 */
export const statusQuery = (n: 1 | 2 | 3 | 4): Buffer => Buffer.from([0x10, 0x04, n]);

export interface PrinterStatus {
  /** 机器回了话，还是只回了空/乱码 */
  answered: boolean;
  paperOut: boolean;
  paperNearEnd: boolean;
  coverOpen: boolean;
  /** 切刀/字车等机械故障 */
  error: boolean;
  /** 离线（离线状态位或机器根本没回话） */
  offline: boolean;
}

/**
 * 解析 DLE EOT 回来的状态字节，按位拆开。
 *
 * 为什么每一位都要判：`ok: true` 只说明网线通，缺纸的时候 TCP 照样连得上，
 * 老板看到绿灯、顾客的单却一张张没出来——这个「假绿灯」比直接报红更害人。
 *
 * 位定义（手册原文，bit0 是最高位那侧的习惯写法在这里统一按 bit0 = 0x01）：
 *   打印机状态 n=1：bit3 离线、bit5 等待恢复、bit6 纸将尽
 *   离线状态 n=2：bit2 纸尽、bit5 盖开、bit6 进纸键按下
 *   错误状态 n=3：bit2 切刀错、bit3 机械错、bit5 自动恢复、bit6 不可恢复
 *   纸张状态 n=4：bit2 纸将尽、bit3 纸尽
 */
export function parseStatus(n: 1 | 2 | 3 | 4, byte: number): PrinterStatus {
  const b = byte & 0xff;
  const s: PrinterStatus = { answered: true, paperOut: false, paperNearEnd: false, coverOpen: false, error: false, offline: false };
  if (n === 1) {
    s.offline = (b & 0x08) !== 0;
    s.paperNearEnd = (b & 0x40) !== 0;
  } else if (n === 2) {
    s.paperOut = (b & 0x04) !== 0;
    s.coverOpen = (b & 0x20) !== 0;
  } else if (n === 3) {
    s.error = (b & 0x04) !== 0 || (b & 0x08) !== 0 || (b & 0x40) !== 0;
  } else {
    s.paperNearEnd = (b & 0x04) !== 0;
    s.paperOut = (b & 0x08) !== 0;
  }
  return s;
}

/** 把一次健康检查的真实状态翻成一句给老板看的话；null 表示一切正常 */
export function statusText(s: PrinterStatus): string | null {
  if (!s.answered) return '机器没回话：可能没开机、IP 不对，或者这台机器不支持状态查询';
  if (s.offline) return '机器报离线：检查面板有没有亮红灯';
  if (s.paperOut) return '缺纸了：装一卷新纸再点一次检测';
  if (s.coverOpen) return '盖子没关好：关紧再点一次检测';
  if (s.error) return '机器报故障：看看有没有卡纸，重启机器试试';
  if (s.paperNearEnd) return '纸快用完了：现在换正合适，别等高峰';
  return null;
}

/** 国产热敏机基本是 GBK；个别新机是 UTF-8，由配置决定 */
export function text(s: string, encoding: Encoding = 'gbk'): Buffer {
  const norm = s.replace(/\r\n/g, '\n');
  if (encoding === 'utf8') return Buffer.from(norm, 'utf8');
  // gb18030 跟 gbk 一样是双字节定宽，折行/对齐用的是 displayWidth，不受影响
  return iconv.encode(norm, encoding);
}

/**
 * 一张纸的开头。初始化 + 汉字模式必须成对出现：
 * 只发 ESC @ 不发 FS &，机器回到上电默认的「单字节模式」，中文就散了。
 */
export function preamble(encoding: Encoding): Buffer[] {
  return encoding === 'utf8' ? [CMD.init] : [CMD.init, CMD.chineseMode];
}

/** 显示宽度：全角计 2、半角计 1（中文小票实现左右对齐全靠它） */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 一行内左右对齐（菜名…金额） */
export function lr(left: string, right: string, cols: number): string {
  const gap = Math.max(1, cols - displayWidth(left) - displayWidth(right));
  return left + ' '.repeat(gap) + right;
}

/** 按显示宽度折行，不丢字 */
export function wrap(s: string, cols: number): string[] {
  const out: string[] = [];
  let line = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > cols && line !== '') {
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
 * 光栅位图（GS v 0）：标签机打 Logo/二维码图时用
 * bitmap 每行 bytesPerRow 字节，1 = 黑点
 */
export function raster(bitmap: Buffer, widthDots: number, heightDots: number): Buffer {
  const bytesPerRow = Math.ceil(widthDots / 8);
  const need = bytesPerRow * heightDots;
  if (bitmap.length < need) {
    throw new Error(`位图数据不足：需要 ${need} 字节，实际 ${bitmap.length}`);
  }
  const head = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    heightDots & 0xff, (heightDots >> 8) & 0xff,
  ]);
  return Buffer.concat([head, bitmap.subarray(0, need)]);
}

/** 条码（GS k CODE39）：扫一下就能回查订单 */
export function barcode(code39: string, height = 60, width = 2): Buffer {
  return Buffer.concat([
    Buffer.from([0x1d, 0x68, height & 0xff]),
    Buffer.from([0x1d, 0x77, width & 0xff]),
    Buffer.from([0x1d, 0x48, 0x02]),
    Buffer.from([0x1d, 0x6b, 0x04]),
    Buffer.from(code39, 'ascii'),
    Buffer.from([0x00]),
  ]);
}
