/**
 * 预览工具：不用真打印机，把两种纸的内容用文字画出来，调版式时用
 * 用法：npx tsx apps/server/src/print/preview.ts
 */
import iconv from 'iconv-lite';
import { renderCups, renderReceipt, type PrintOrder } from './templates.ts';

const demo: PrintOrder = {
  order_no: '2610-034',
  pickup_no: 34,
  table_no: '12',
  status: 'pending',
  total_rm: '134.00',
  note: '不要香菜，少辣',
  created_at: '2026-10-25 19:42:10',
  pay_method_label: '现金（到柜台）',
  items: [
    { dish_uid: 'f01', code: 'F01', name: '招牌剁椒鱼', qty: 1, price_rm: '48.00', subtotal_rm: '48.00', is_drink: false },
    { dish_uid: 'l01', code: 'L01', name: '招牌手打柠檬茶', qty: 3, price_rm: '19.90', subtotal_rm: '59.70', note: '少冰 少糖', is_drink: true },
    { dish_uid: 'f02', code: 'F02', name: '糖醋排骨', qty: 1, price_rm: '48.00', subtotal_rm: '48.00', is_drink: false },
  ],
};
// 示例店名故意用中性占位：真实店名一律来自 brand.json，代码里不写死（check:brand 规矩）
const shop = { name: '示例门店', address: '示例地址 1 号', phone: '000-0000000', footer: '谢谢光临，欢迎再来' };
const cfg = { paper: '80' as const, encoding: 'gbk' as const, cutter: true, cashDrawer: true };

const ESC = String.fromCharCode(0x1b);
const GS = String.fromCharCode(0x1d);

/**
 * 把 ESC/POS 字节还原成可读排版（去掉控制码、条码整段换成标记）
 *
 * 注意：ESC 后面只吃它真正带的参数个数，绝不能写 [\s\S]{0,3} 这种「多吃几个字符」，
 * 否则会把紧跟的汉字当成参数吃掉（之前「合计」被吃成「计」就是这么来的）。
 */
function pretty(buf: Buffer): string {
  let s = iconv.decode(buf, 'gbk');
  s = s.replace(new RegExp(GS + 'k[\\s\\S]*?\\x00', 'g'), '[条码]');      // GS k m d1..dk NUL
  s = s.replace(new RegExp(ESC + '@', 'g'), '');                          // ESC @ 初始化
  s = s.replace(new RegExp(ESC + 'a.', 'g'), '');                         // ESC a n
  s = s.replace(new RegExp(ESC + '!.', 'g'), '');                         // ESC ! n
  s = s.replace(new RegExp(ESC + 'd.', 'g'), '');                         // ESC d n 走纸
  s = s.replace(new RegExp(ESC + 'p[\\s\\S]{3}', 'g'), '');               // ESC p m t1 t2 钱箱
  s = s.replace(new RegExp(GS + '!.', 'g'), '');                          // GS ! n
  s = s.replace(new RegExp(GS + 'h.', 'g'), '');                          // GS h n 条码高
  s = s.replace(new RegExp(GS + 'w.', 'g'), '');                          // GS w n 条码宽
  s = s.replace(new RegExp(GS + 'H.', 'g'), '');                          // GS H n 条码字位
  s = s.replace(new RegExp(GS + 'V[\\s\\S]{3}', 'g'), '');                // GS V m n 切纸
  s = s.replace(new RegExp(GS + 'V[\\s\\S]{3}', 'g'), '');                // GS V m n 切纸
  s = s.replace(new RegExp(GS + 'V[\\s\\S]?', 'g'), '');                  // 切纸参数含 NUL，可能已被上一轮吃掉，这里兜底
  return s.replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

const R = '='.repeat(48);
console.log(`\n${R}\n 小票预览（80mm / 48 列）\n${R}`);
console.log(pretty(renderReceipt(demo, shop, cfg)));

const cups = renderCups(demo, { bigTable: true }, cfg);
console.log(`\n${R}\n 饮料标签预览（共 ${cups.length} 张，一杯一张）\n${R}`);
cups.forEach((c, i) => {
  console.log(`┌──────── 第 ${i + 1} 张 / 共 ${cups.length} 张 ────────`);
  console.log(
    pretty(c)
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => '│ ' + l.trimEnd())
      .join('\n')
  );
  console.log('└──────────────────────────────');
});
