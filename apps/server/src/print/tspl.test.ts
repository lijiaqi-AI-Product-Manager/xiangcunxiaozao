import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import {
  DEFAULT_LABEL_GEOMETRY,
  dotsWidth,
  escapeTspl,
  renderCupLabelTspl,
  wrapToDots,
} from './tspl.ts';
import { renderCups, type PrintOrder } from './templates.ts';
import { readPrintEnv } from './index.ts';

const order: PrintOrder = {
  order_no: '2610-034',
  pickup_no: 34,
  table_no: '12',
  status: 'pending',
  total_rm: '134.00',
  note: '不要香菜，少辣',
  created_at: '2026-10-25 19:42:10',
  items: [
    { dish_uid: 'f01', code: 'F01', name: '招牌剁椒鱼', qty: 1, price_rm: '48.00', subtotal_rm: '48.00', is_drink: false },
    { dish_uid: 'l01', code: 'L01', name: '招牌手打柠檬茶', qty: 3, price_rm: '19.90', subtotal_rm: '59.70', note: '少冰', is_drink: true },
  ],
};

const dec = (b: Buffer): string => iconv.decode(b, 'gbk');
const geom = DEFAULT_LABEL_GEOMETRY;
const W = geom.widthMm * 8;

describe('TSPL 标签指令', () => {
  it('一张标签 = 一条完整作业：尺寸、间隙、清画布、出纸都要有', () => {
    const s = dec(renderCupLabelTspl({ tableNo: '12', name: '柠檬茶', time: '19:42', orderNo: '034' }, geom, 'gbk'));
    expect(s).toContain('SIZE 30 mm,40 mm');
    expect(s).toContain('GAP 2 mm,0 mm');
    expect(s).toContain('CLS');
    expect(s.trimEnd().endsWith('PRINT 1,1')).toBe(true);
    // 一张纸只许出一张：PRINT 出现两次多半是把一条作业拆重了
    expect(s.match(/PRINT 1,1/g)?.length).toBe(1);
  });

  it('中文按 GBK 出字节，不是 UTF-8', () => {
    const buf = renderCupLabelTspl({ tableNo: '12', name: '柠檬茶', time: '19:42', orderNo: '034' }, geom, 'gbk');
    expect(buf.includes(Buffer.from('柠檬茶', 'utf8'))).toBe(false);
    expect(dec(buf)).toContain('柠檬茶');
  });

  it('菜名里的双引号被换成单引号，不会把指令截断', () => {
    expect(escapeTspl('少"冰"')).toBe("少'冰'");
    const s = dec(renderCupLabelTspl({ tableNo: '12', name: '少"冰"柠檬茶', time: '19:42', orderNo: '034' }, geom, 'gbk'));
    // 双引号总数必须是偶数：每行 TEXT 一对
    expect((s.match(/"/g) ?? []).length % 2).toBe(0);
    expect(s).toContain("少'冰'");
  });

  it('换行/制表符压成空格：标签上换行只能靠自己算 y', () => {
    expect(escapeTspl('少冰\n去糖\t多柠檬')).toBe('少冰 去糖 多柠檬');
  });

  it('折行按点宽算：30mm 纸一行最多 9 个汉字，且不丢字', () => {
    expect(wrapToDots('一二三四五六七八九十', 240 - 12)).toEqual(['一二三四五六七八九', '十']);
    const joined = wrapToDots('招牌手打柠檬茶', 240 - 12).join('');
    expect(joined).toBe('招牌手打柠檬茶');
  });

  it('每一行都落在纸面内，不会印到标签外面', () => {
    const s = dec(
      renderCupLabelTspl(
        { tableNo: '12', name: '招牌手打柠檬茶（大杯）', spec: '少冰 少糖 去柠檬片', time: '19:42', orderNo: '034' },
        geom,
        'gbk'
      )
    );
    for (const m of s.matchAll(/TEXT (\d+),(\d+),"[^"]*",0,(\d+),(\d+),"([^"]*)"/g)) {
      const [, x, , mx, , content] = m;
      expect(Number(x) + dotsWidth(content ?? '', Number(mx))).toBeLessThanOrEqual(W);
    }
  });

  it('多杯才印 1/3，单杯不印', () => {
    const three = dec(renderCupLabelTspl({ tableNo: '12', name: '柠檬茶', time: '19:42', orderNo: '034', seq: { k: 2, n: 3 } }, geom, 'gbk'));
    expect(three).toContain('2/3');
    const one = dec(renderCupLabelTspl({ tableNo: '12', name: '柠檬茶', time: '19:42', orderNo: '034', seq: { k: 1, n: 1 } }, geom, 'gbk'));
    expect(one).not.toContain('1/1');
  });

  it('30×40 的纸放得下：内容不溢出高度', () => {
    const H = geom.heightMm * 8;
    const s = dec(
      renderCupLabelTspl({ tableNo: '12', name: '招牌手打柠檬茶', spec: '少冰', time: '19:42', orderNo: '034', seq: { k: 1, n: 3 } }, geom, 'gbk')
    );
    for (const m of s.matchAll(/TEXT (\d+),(\d+),"[^"]*",0,(\d+),(\d+),"/g)) {
      expect(Number(m[2]) + 24 * Number(m[4])).toBeLessThanOrEqual(H);
    }
  });
});

describe('标签走 TSPL 协议时（renderCups）', () => {
  const tsplCfg = { paper: '58' as const, encoding: 'gbk' as const, cutter: false, cashDrawer: false, protocol: 'tspl' as const };

  it('一杯一张、只出饮品、炒菜一个字都没有', () => {
    const cups = renderCups(order, { bigTable: true }, tsplCfg);
    expect(cups.length).toBe(3);
    for (const c of cups) {
      const s = dec(c);
      expect(s).toContain('招牌手打柠檬茶');
      expect(s).not.toContain('剁椒鱼');
      expect(s).toContain('SIZE 30 mm,40 mm');
    }
  });

  it('三杯分别带 1/3 2/3 3/3', () => {
    const cups = renderCups(order, { bigTable: true }, tsplCfg).map(dec);
    expect(cups[0]).toContain('1/3');
    expect(cups[1]).toContain('2/3');
    expect(cups[2]).toContain('3/3');
  });

  it('规格备注跟着自己的那几张走', () => {
    const cups = renderCups(order, { bigTable: true }, tsplCfg).map(dec);
    for (const s of cups) expect(s).toContain('少冰');
  });

  it('不配协议时仍然是 ESC/POS，不能把老机器悄悄改成 TSPL', () => {
    const escposCfg = { paper: '58' as const, encoding: 'gbk' as const, cutter: false, cashDrawer: false };
    const cups = renderCups(order, { bigTable: true }, escposCfg).map(dec);
    expect(cups[0]).not.toContain('SIZE 30 mm');
    // ESC @ + FS & 的开头还在
    expect(cups[0]?.charCodeAt(0)).toBe(0x1b);
    expect(cups[0]?.charCodeAt(1)).toBe(0x40);
  });
});

describe('标签尺寸与协议配置', () => {
  it('默认就是 30×40 间隙纸、TSC 中文字库', () => {
    const env = readPrintEnv({});
    expect(env.labelProtocol).toBe('escpos');
    expect(env.labelSize).toEqual({ widthMm: 30, heightMm: 40, gapMm: 2, font: 'TSS24.BF2' });
  });

  it('配了 tspl 就按标签模式出纸', () => {
    const env = readPrintEnv({ PRINT_LABEL_PROTOCOL: 'tspl', PRINT_LABEL_WIDTH_MM: '40', PRINT_LABEL_HEIGHT_MM: '30', PRINT_LABEL_GAP_MM: '3' });
    expect(env.labelProtocol).toBe('tspl');
    expect(env.labelSize).toMatchObject({ widthMm: 40, heightMm: 30, gapMm: 3 });
  });

  it('间隙 0 是合法的（连续纸），不能被当成没填', () => {
    expect(readPrintEnv({ PRINT_LABEL_GAP_MM: '0' }).labelSize.gapMm).toBe(0);
  });

  it('尺寸填错回落默认，不打废纸', () => {
    const env = readPrintEnv({ PRINT_LABEL_WIDTH_MM: 'abc', PRINT_LABEL_HEIGHT_MM: '-5' });
    expect(env.labelSize.widthMm).toBe(30);
    expect(env.labelSize.heightMm).toBe(40);
  });

  it('字体名可以换（芯烨部分固件是 TST24.BF2）', () => {
    expect(readPrintEnv({ PRINT_LABEL_FONT: 'TST24.BF2' }).labelSize.font).toBe('TST24.BF2');
  });
});
