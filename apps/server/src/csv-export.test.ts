// 订单导出 CSV：Excel 打开不能乱码、不能被注入公式、金额必须是「元」两位小数
import { describe, expect, it } from 'vitest';
import type { Order } from '@pkg/contract';
import { csvCell, csvFileName, ordersToCsv } from './csv-export.ts';

const TZ = 'Asia/Kuala_Lumpur';

const order = (over: Partial<Order> = {}): Order => ({
  id: '78fcac7b-0a9f-4c1e-9b7a-1234567890ab',
  pickupNo: 35,
  businessDate: '2026-10-25',
  tableNo: '8',
  paymentMethod: 'cash',
  note: null,
  totalSen: 8760,
  status: 'done',
  cancelReason: null,
  createdAt: '2026-10-25T11:30:00.000Z', // 吉隆坡 19:30
  updatedAt: '2026-10-25T12:00:00.000Z',
  items: [
    { line: 1, dishUid: 'a01', code: 'A01', name: '剁椒鱼头', priceSen: 4800, qty: 1, refundedQty: 0, spice: '中辣', note: '' },
    { line: 2, dishUid: 'b03', code: 'B03', name: '拍黄瓜', priceSen: 1980, qty: 2, refundedQty: 0, spice: '', note: '不要蒜' },
  ],
  etaMinutes: null,
  storedSen: 0,
  otherSen: 8760,
  refundState: 'none',
  refundedSen: 0,
  refunds: [],
  autoCancelled: false,
  version: 0,
  parentOrderId: null,
  addSeq: null,
  groupTotalSen: 8760,
  groupRefundedSen: 0,
  addCount: 0,
  ...over,
});

const pay = (k: string) => (k === 'cash' ? '现金' : k);
const lines = (csv: string) => csv.replace('\uFEFF', '').trimEnd().split('\r\n');

describe('导出 CSV', () => {
  it('开头带 BOM：不然 Excel 打开中文全是乱码', () => {
    expect(ordersToCsv([order()], TZ, pay).startsWith('\uFEFF')).toBe(true);
  });

  it('金额是「元」两位小数，不是「仙」', () => {
    const row = lines(ordersToCsv([order()], TZ, pay))[1]!;
    const cells = row.split(',');
    expect(cells[7]).toBe('87.60'); // 金额(元)
    expect(cells[8]).toBe('0.00'); // 已退
    expect(cells[9]).toBe('87.60'); // 实收
  });

  it('实收 = 金额 − 退款，退款不退成负数', () => {
    const o = order({ totalSen: 5000, refundedSen: 2000 });
    const cells = lines(ordersToCsv([o], TZ, pay))[1]!.split(',');
    expect(cells[9]).toBe('30.00');
    const over = order({ totalSen: 5000, refundedSen: 9000 }); // 脏数据：退超了
    expect(lines(ordersToCsv([over], TZ, pay))[1]!.split(',')[9]).toBe('0.00');
  });

  it('下单时间按门店时区写成人看得懂的格式', () => {
    const cells = lines(ordersToCsv([order()], TZ, pay))[1]!.split(',');
    expect(cells[3]).toContain('2026-10-25');
    expect(cells[3]).toContain('19:30'); // UTC 11:30 → 吉隆坡 19:30
  });

  it('菜品摊平成「名×份」并带上辣度和备注', () => {
    const cells = lines(ordersToCsv([order()], TZ, pay))[1]!;
    expect(cells).toContain('剁椒鱼头×1(辣度:中辣)');
    expect(cells).toContain('拍黄瓜×2(备注:不要蒜)');
  });

  it('备注里有逗号：整格用引号包住，不能把列拆开', () => {
    // 用「英文逗号」：全角逗号「，」本身不是 CSV 分隔符，用不着加引号（Excel 打开也没问题，
    // 以前这条断言拿全角逗号当分隔符，实际上从没验到「引号包裹」这件事）
    const o = order({ note: '少油,不要葱,谢谢' });
    const row = lines(ordersToCsv([o], TZ, pay))[1]!;
    expect(row).toContain('"少油,不要葱,谢谢"');
    // 用真正的 CSV 解析法验一遍列数：逗号在引号内不算分隔
    const cols = parse(row);
    expect(cols).toHaveLength(14);
    expect(cols[12]).toBe('少油,不要葱,谢谢');
  });

  it('备注里有引号：翻倍转义，解析回来还是原样', () => {
    const note = '他说"不要辣"';
    const row = lines(ordersToCsv([order({ note })], TZ, pay))[1]!;
    expect(parse(row)[12]).toBe(note);
  });

  it('以 = + - @ 开头的内容前面加 单引号：防止 Excel 当公式执行（CSV 注入）', () => {
    for (const bad of ['=1+1', '+86 12', '-5', '@SUM(A1)']) {
      expect(csvCell(bad)).toBe(`'${bad}`);
    }
    const row = lines(ordersToCsv([order({ note: '=cmd|calc' })], TZ, pay))[1]!;
    expect(parse(row)[12]).toBe("'=cmd|calc");
  });

  it('多行备注里的换行被引号包住，不会在 CSV 里断成两行', () => {
    const row = lines(ordersToCsv([order({ note: '第一行\n第二行' })], TZ, pay))[1]!;
    expect(parse(row)[12]).toBe('第一行\n第二行');
  });

  it('空结果也有一行表头（老板打开看到列名，不是空文件）', () => {
    const l = lines(ordersToCsv([], TZ, pay));
    expect(l).toHaveLength(1);
    expect(l[0]).toContain('单号');
    expect(l[0]).toContain('实收(元)');
  });

  it('状态和付款方式写中文，不写英文 key', () => {
    const cells = lines(ordersToCsv([order()], TZ, pay))[1]!.split(',');
    expect(cells[10]).toBe('现金');
    expect(cells[11]).toBe('已完成');
    const c = order({ status: 'cancelled', cancelReason: '客人取消' });
    expect(lines(ordersToCsv([c], TZ, pay))[1]).toContain('客人取消');
  });

  it('文件名里不会有 : / 这类不能出现在路径里的字符', () => {
    const n = csvFileName('订单', '2026-10-25T00:00', '2026-10-26T00:00');
    expect(n).toBe('订单_2026-10-25_2026-10-26.csv');
    expect(n).not.toMatch(/[:/\\]/);
  });
});

/** 最小 CSV 解析（只为验证转义对不对） */
function parse(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (inQ) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
