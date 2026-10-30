import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { CMD, PAPER_COLS, displayWidth, lr, raster, text, wrap } from './escpos.ts';
import { renderCups, renderReceipt, type PrintOrder } from './templates.ts';
import { MockChannel } from './transport.ts';
import { PrintDispatcher } from './dispatcher.ts';
import { readPrintEnv, toPrintOrder } from './index.ts';

const order: PrintOrder = {
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
    { dish_uid: 'l01', code: 'L01', name: '招牌手打柠檬茶', qty: 3, price_rm: '19.90', subtotal_rm: '59.70', note: '少冰', is_drink: true },
    { dish_uid: 'f02', code: 'F02', name: '糖醋排骨', qty: 1, price_rm: '48.00', subtotal_rm: '48.00', is_drink: false },
  ],
};

const shop = { name: '示例门店', address: '示例地址 1 号', phone: '000-0000000', footer: '谢谢光临' };
const cfg = { paper: '80' as const, encoding: 'gbk' as const, cutter: true, cashDrawer: false };
const dec = (b: Buffer): string => iconv.decode(b, 'gbk');

describe('排版工具', () => {
  it('全角 2 格、半角 1 格', () => {
    expect(displayWidth('招牌剁椒鱼')).toBe(10);
    expect(displayWidth('RM 48.00')).toBe(8);
  });

  it('左右对齐刚好占满一行', () => {
    const line = lr('合计', 'RM 134.00', 48);
    expect(displayWidth(line)).toBe(48);
    expect(line.startsWith('合计')).toBe(true);
    expect(line.endsWith('RM 134.00')).toBe(true);
  });

  it('折行不丢字、不超宽', () => {
    const s = '招牌剁椒鱼特制加辣加香菜版本';
    const lines = wrap(s, 10);
    expect(lines.every((l) => displayWidth(l) <= 10)).toBe(true);
    expect(lines.join('')).toBe(s);
  });

  it('58mm 32 列 / 80mm 48 列', () => {
    expect(PAPER_COLS['58']).toBe(32);
    expect(PAPER_COLS['80']).toBe(48);
  });
});

describe('小票', () => {
  const buf = renderReceipt(order, shop, cfg);

  it('以初始化开头、含切纸指令', () => {
    expect(buf.subarray(0, 2)).toEqual(CMD.init);
    expect(buf.includes(Buffer.from([0x1d, 0x56, 0x00, 0x03]))).toBe(true);
  });

  it('桌号、取餐号、单号、合计、备注都印出来', () => {
    const t = dec(buf);
    expect(t).toContain('桌号 12');
    expect(t).toContain('取餐号 34');
    expect(t).toContain('单号 034');
    expect(t).toContain('RM 134.00');
    expect(t).toContain('不要香菜');
  });

  it('每道菜都在票上，数量写清', () => {
    const t = dec(buf);
    expect(t).toContain('招牌剁椒鱼');
    expect(t).toContain('19.90x3');
    expect(t).toContain('糖醋排骨');
  });

  it('钱箱指令只在开启时出现', () => {
    const drawer = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(buf.includes(drawer)).toBe(false);
    expect(renderReceipt(order, shop, { ...cfg, cashDrawer: true }).includes(drawer)).toBe(true);
  });

  it('无切刀机型不打切纸指令', () => {
    expect(renderReceipt(order, shop, { ...cfg, cutter: false }).includes(Buffer.from([0x1d, 0x56, 0x00, 0x03]))).toBe(false);
  });

  it('58mm 纸也能排版且不溢出', () => {
    const narrow = dec(renderReceipt(order, shop, { ...cfg, paper: '58' }));
    for (const line of narrow.split('\n')) {
      expect(displayWidth(line.replace(/[\x00-\x1f]/g, ''))).toBeLessThanOrEqual(64); // GBK 解码后中文仍按 1 字符计
    }
  });
});

describe('饮料标签', () => {
  const cups = renderCups(order, { bigTable: true }, cfg);

  it('一杯一张：只算饮品，炒菜不出杯贴', () => {
    expect(cups).toHaveLength(3);
  });

  it('炒菜一个字都不出现在标签上', () => {
    for (const c of cups) {
      expect(dec(c)).not.toContain('剁椒鱼');
      expect(dec(c)).not.toContain('糖醋排骨');
    }
  });

  it('每张都有桌号与时间', () => {
    for (const c of cups) {
      const t = dec(c);
      expect(t).toContain('桌 12');
      expect(t).toContain('19:42');
    }
  });

  it('同一饮料三杯分别带 1/3 2/3 3/3 序号', () => {
    const ts = cups.map(dec);
    for (const s of ['1/3', '2/3', '3/3']) expect(ts.some((t) => t.includes(s))).toBe(true);
  });

  it('规格备注只跟对应的三张走', () => {
    expect(cups.filter((c) => dec(c).includes('少冰'))).toHaveLength(3);
  });

  it('标签每张都独立初始化（防止上一张的字体状态串味）', () => {
    for (const c of cups) expect(c.subarray(0, 2)).toEqual(CMD.init);
  });
});

describe('位图', () => {
  it('数据不足直接报错，不发半张图', () => {
    expect(() => raster(Buffer.alloc(10), 32, 10)).toThrow(/位图数据不足/);
  });
  it('指令头按字节数计算正确', () => {
    const buf = raster(Buffer.alloc(2 * 8), 16, 8);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x1d, 0x76, 0x30, 0x00, 2, 0, 8, 0]));
  });
});

describe('调度器', () => {
  it('下单 → 小票 1 张 + 标签 3 张', async () => {
    const rc = new MockChannel();
    const lc = new MockChannel();
    const results: string[] = [];
    const d = new PrintDispatcher({
      targets: [
        { name: 'receipt', enabled: true, channel: rc, config: cfg, retries: 0, backoffMs: 1 },
        { name: 'label', enabled: true, channel: lc, config: cfg, retries: 0, backoffMs: 1 },
      ],
      sink: (r) => results.push(`${r.target}:${r.ok}`),
    });
    d.printOrder(order, shop);
    await new Promise((r) => setTimeout(r, 200));
    expect(rc.sent).toHaveLength(1);
    expect(lc.sent).toHaveLength(3);
    expect(results.sort()).toEqual(['label:true', 'receipt:true']);
  });

  it('同一订单重复触发不重复出纸', async () => {
    const rc = new MockChannel();
    const d = new PrintDispatcher({
      targets: [{ name: 'receipt', enabled: true, channel: rc, config: cfg, retries: 0, backoffMs: 1 }],
    });
    d.printOrder(order, shop);
    d.printOrder(order, shop);
    await new Promise((r) => setTimeout(r, 150));
    expect(rc.sent).toHaveLength(1);
  });

  it('打印机离线：重试后如实报错，不抛异常', async () => {
    const bad = {
      kind: 'net' as const,
      label: '坏的',
      send: async () => {
        throw new Error('打印机没开机');
      },
      health: async () => ({ ok: false, detail: '不通' }),
    };
    const results: { ok: boolean; attempts: number; error?: string }[] = [];
    const d = new PrintDispatcher({
      targets: [{ name: 'receipt', enabled: true, channel: bad, config: cfg, retries: 2, backoffMs: 1 }],
      sink: (r) => results.push(r),
    });
    d.printOrder(order, shop);
    await new Promise((r) => setTimeout(r, 300));
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.attempts).toBe(3);
    expect(results[0]!.error).toContain('打印机没开机');
  });

  // 两台机器都没开机时，老板端「打印设置」要等两台各超时一次才能出结果。
  // 以前 healthAll 是 for...await 串行，等 5s + 5s = 10s，页面空白十秒像卡死。
  // 这条测试用「每台睡 100ms」把差距放大：并行约 100ms，串行会到 200ms。
  it('两台一起检测是并行的，不是排队等（健康检查不许把页面拖十秒）', async () => {
    const slowChannel = () => ({
      kind: 'net' as const,
      label: '慢的',
      send: async () => {},
      health: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { ok: false, detail: '超时' };
      },
    });
    const d = new PrintDispatcher({
      targets: [
        { name: 'receipt', enabled: true, channel: slowChannel(), config: cfg, retries: 0, backoffMs: 1 },
        { name: 'label', enabled: true, channel: slowChannel(), config: cfg, retries: 0, backoffMs: 1 },
      ],
    });
    const t0 = Date.now();
    const all = await d.healthAll();
    const ms = Date.now() - t0;
    expect(Object.keys(all).sort()).toEqual(['label', 'receipt']);
    expect(all.receipt!.ok).toBe(false);
    expect(all.label!.ok).toBe(false);
    // 串行会 ≥200ms；留足机器抖动的余量，但 180ms 这条线足以分开「并行」和「串行」
    expect(ms).toBeLessThan(180);
  });

  it('未启用的打印机一张不打', async () => {
    const lc = new MockChannel();
    const d = new PrintDispatcher({
      targets: [{ name: 'label', enabled: false, channel: lc, config: cfg, retries: 0, backoffMs: 1 }],
    });
    d.printOrder(order, shop);
    await new Promise((r) => setTimeout(r, 100));
    expect(lc.sent).toHaveLength(0);
  });

  it('两台机器互不阻塞：一台慢不影响另一台出纸', async () => {
    const slow = new MockChannel();
    const origSend = slow.send.bind(slow);
    slow.send = async (p: Buffer) => {
      await new Promise((r) => setTimeout(r, 100));
      await origSend(p);
    };
    const fast = new MockChannel();
    const d = new PrintDispatcher({
      targets: [
        { name: 'receipt', enabled: true, channel: slow, config: cfg, retries: 0, backoffMs: 1 },
        { name: 'label', enabled: true, channel: fast, config: cfg, retries: 0, backoffMs: 1 },
      ],
    });
    d.printOrder(order, shop);
    await new Promise((r) => setTimeout(r, 60));
    expect(fast.sent.length).toBeGreaterThan(0); // 标签机已经出了几张，而小票机还在第一张
    await new Promise((r) => setTimeout(r, 800));
    expect(slow.sent).toHaveLength(1);
    expect(fast.sent).toHaveLength(3);
  });
});

describe('配置与环境', () => {
  it('默认全关：不配任何环境变量就不打纸', () => {
    const cfgEnv = readPrintEnv({});
    expect(cfgEnv.receiptEnabled).toBe(false);
    expect(cfgEnv.labelEnabled).toBe(false);
  });

  it('订单 DTO 转打印结构，金额按分转元', () => {
    const o = toPrintOrder(
      {
        pickupNo: 7,
        tableNo: '3',
        status: 'pending',
        totalSen: 1990,
        note: null,
        createdAt: '2026-10-25T11:42:10.000Z',
        paymentMethod: 'cash',
        items: [{ dishUid: 'l01', code: 'L01', name: '柠檬茶', priceSen: 1990, qty: 1 }],
      },
      { timezone: 'Asia/Kuala_Lumpur', businessDate: '2026-10-25', payLabel: '现金（到柜台）', drinkUids: ['l01'] }
    );
    expect(o.items[0]!.is_drink).toBe(true);
    expect(o.order_no).toBe('1025-007'); // 月日 + 取餐号，人能念的单号
    expect(o.pay_method_label).toBe('现金（到柜台）');
    expect(o.total_rm).toBe('19.90');
    expect(o.items[0]!.subtotal_rm).toBe('19.90');
    expect(o.created_at).toMatch(/^2026-10-25 19:42:10$/); // 吉隆坡 UTC+8
  });
});

describe('Windows 本机 USB（winspool）', () => {
  it('KIND=winspool + QUEUE 被接受，不再悄悄降级成 mock', () => {
    const env = readPrintEnv({
      PRINT_RECEIPT_ON: '1', PRINT_RECEIPT_KIND: 'winspool', PRINT_RECEIPT_QUEUE: 'ZYWELL Zy307',
      PRINT_LABEL_ON: '1', PRINT_LABEL_KIND: 'winspool', PRINT_LABEL_QUEUE: 'XP-236B',
    });
    expect(env.receiptKind).toBe('winspool');
    expect(env.receiptQueue).toBe('ZYWELL Zy307');
    expect(env.labelKind).toBe('winspool');
    expect(env.labelQueue).toBe('XP-236B');
  });

  it('通道带着队列名，报表里一眼看得出打给哪台', async () => {
    const { createChannel, RAW_PRINT_SCRIPT } = await import('./transport.ts');
    const ch = createChannel('winspool', { queue: 'XP-236B' });
    expect(ch.kind).toBe('winspool');
    expect(ch.label).toContain('XP-236B');
    expect(RAW_PRINT_SCRIPT.endsWith('win-raw-print.ps1')).toBe(true);
  });

  it('没填打印机名字就明确报错，而不是发去一个空队列', async () => {
    const { createChannel } = await import('./transport.ts');
    expect(() => createChannel('winspool', { queue: '' })).toThrow(/打印机名称/);
  });
});

describe('健康检查是真检测，不是「网线通了就报绿灯」', () => {
  it('缺纸：机器回「纸尽」位 → ok=false，并且说的是缺纸，不是缺纸以外的话', async () => {
    const net = await import('node:net');
    const { NetChannel } = await import('./transport.ts');
    // 假打印机：收到一条 DLE EOT 就回一个字节。n=2 的 bit2=纸尽
    const srv = net.createServer((sock) => {
      sock.on('data', (buf) => {
        // 按 DLE EOT n 逐条回应，和真机一样一问一答
        for (let i = 0; i + 2 < buf.length; i += 3) {
          const n = buf[i + 2];
          sock.write(Buffer.from([n === 2 ? 0x04 : 0x00]));
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const ch = new NetChannel({ host: '127.0.0.1', port, timeoutMs: 800 });
      const h = await ch.health();
      expect(h.ok).toBe(false);
      expect(h.detail).toContain('缺纸');
    } finally {
      srv.close();
    }
  });

  it('一切正常：回全 0 → ok=true，且说的是「在线」', async () => {
    const net = await import('node:net');
    const { NetChannel } = await import('./transport.ts');
    const srv = net.createServer((sock) => {
      sock.on('data', (buf) => {
        for (let i = 0; i + 2 < buf.length; i += 3) sock.write(Buffer.from([0x00]));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const ch = new NetChannel({ host: '127.0.0.1', port, timeoutMs: 800 });
      const h = await ch.health();
      expect(h.ok).toBe(true);
      expect(h.detail).toContain('在线');
    } finally {
      srv.close();
    }
  });

  it('端口开着但机器不回话（没装纸/没开机）→ 不许报绿灯', async () => {
    const net = await import('node:net');
    const { NetChannel } = await import('./transport.ts');
    // 只接受连接、不回任何数据：旧实现会在这里报「可连通」
    const srv = net.createServer(() => {});
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const ch = new NetChannel({ host: '127.0.0.1', port, timeoutMs: 300 });
      const h = await ch.health();
      expect(h.ok).toBe(false);
      expect(h.detail).toContain('没回话');
    } finally {
      srv.close();
    }
  });

  it('状态字节按位解析：盖开 / 离线 / 故障 / 纸将尽各认各的', async () => {
    const { parseStatus, statusText, statusQuery } = await import('./escpos.ts');
    expect(statusQuery(1)).toEqual(Buffer.from([0x10, 0x04, 0x01]));
    expect(parseStatus(2, 0x20).coverOpen).toBe(true); // bit5
    expect(parseStatus(1, 0x08).offline).toBe(true); // bit3
    expect(parseStatus(3, 0x08).error).toBe(true); // bit3 机械错
    expect(parseStatus(4, 0x0c).paperOut).toBe(true); // bit3 纸尽
    expect(statusText(parseStatus(2, 0x00))).toBeNull(); // 全 0 = 正常，不该冒提示
  });
});

describe('逐菜辣度印在小票上（P1-9）', () => {
  it('辣度跟在菜名后面；同菜两行不同辣度各自成条', async () => {
    const { toPrintOrder } = await import('./index.ts');
    const po = toPrintOrder(
      {
        pickupNo: 12, tableNo: '5', status: 'pending', totalSen: 9600, note: null,
        createdAt: '2026-10-25T11:42:10.000Z', paymentMethod: 'cash',
        items: [
          { dishUid: 'f01', code: 'F01', name: '招牌剁椒鱼', priceSen: 4800, qty: 1, spice: '不辣', note: null },
          { dishUid: 'f01', code: 'F01', name: '招牌剁椒鱼', priceSen: 4800, qty: 1, spice: '特辣', note: '多放辣椒' },
        ],
      },
      { timezone: 'Asia/Kuala_Lumpur', payLabel: '现金', drinkUids: [] }
    );
    const t = dec(renderReceipt(po, shop, cfg));
    // 后厨扫一眼就知道哪份不辣、哪份特辣——不用去读备注
    expect(t).toContain('招牌剁椒鱼（不辣）');
    expect(t).toContain('招牌剁椒鱼（特辣）');
    expect(t).toContain('多放辣椒');
    // 两份都要印金额
    expect(t).toContain('RM 96.00');
  });

  it('没选辣度就只印菜名，不印空括号', async () => {
    const { toPrintOrder } = await import('./index.ts');
    const po = toPrintOrder(
      {
        pickupNo: 13, tableNo: '5', status: 'pending', totalSen: 2500, note: null,
        createdAt: '2026-10-25T11:42:10.000Z', paymentMethod: 'cash',
        items: [{ dishUid: 'c03', code: 'C03', name: '农家一碗香', priceSen: 2500, qty: 1 }],
      },
      { timezone: 'Asia/Kuala_Lumpur', drinkUids: [] }
    );
    const t = dec(renderReceipt(po, shop, cfg));
    expect(t).toContain('农家一碗香');
    expect(t).not.toContain('农家一碗香（');
    expect(t).not.toContain('（）');
  });
});

/**
 * 这一组全部对着店里那两台机器的铭牌写：
 *   ZYWELL Zy307      80mm 纸 / 48 列 / 带切刀 / ESC/POS / USB + 网口
 *   Xprinter XP-236B  58mm 纸（48mm 打印区）/ 32 列 / 无切刀 / USB + 蓝牙，票据标签双模
 *
 * 纸宽和切刀错一个，现场的表现是「出半张」「字折到纸外面」「空吐一段」，
 * 老板看不出来是配置问题，只会觉得「这系统不爱出纸」——所以全写成测试卡住。
 */
describe('店里两台机器：纸宽、汉字编码、切刀', () => {
  // 剥掉 ESC/POS 控制码，只留看得见的字，用来数列宽
  const plain = (b: Buffer): string => {
    let s = iconv.decode(b, 'gbk');
    s = s.replace(/\x1dk[\s\S]*?\x00/g, '[条码]');
    s = s.replace(/\x1b[@]/g, '');
    s = s.replace(/\x1bp[\s\S]{3}/g, '');
    s = s.replace(/\x1b[ad!]./g, '');
    s = s.replace(/\x1d[!hHw]./g, '');
    s = s.replace(/\x1dV[\s\S]{2}/g, '');
    s = s.replace(/\x1c&/g, '');
    return s.replace(/[\x00-\x08\x0b-\x1f]/g, '');
  };
  const widths = (s: string): number[] =>
    s.split('\n').map((l) => displayWidth(l.replace(/\s+$/, '')));

  // 长店名 + 长备注：最容易把版式撑出纸边的两个来源
  const longOrder: PrintOrder = {
    ...order,
    note: '不要香菜不要葱，辣椒单独装一碟，米饭晚点上',
    items: [
      { dish_uid: 'f01', code: 'F01', name: '招牌剁椒鱼头（大份加宽的那种）', qty: 1, price_rm: '88.00', subtotal_rm: '88.00', note: '不要香菜不要葱，多放辣椒，做成微辣', is_drink: false },
      { dish_uid: 'l01', code: 'L01', name: '柠檬茶', qty: 1, price_rm: '19.90', subtotal_rm: '19.90', is_drink: true },
    ],
  };
  const longShop = { ...shop, name: '示例门店吉隆坡双子塔旗舰店' };

  it('58mm 小票：折行后每行都不超过 32 列', () => {
    const t = plain(renderReceipt(longOrder, longShop, { paper: '58', encoding: 'gbk', cutter: false, cashDrawer: false }));
    expect(Math.max(...widths(t))).toBeLessThanOrEqual(32);
  });

  it('80mm 小票：折行后每行都不超过 48 列', () => {
    const t = plain(renderReceipt(longOrder, longShop, { paper: '80', encoding: 'gbk', cutter: true, cashDrawer: false }));
    expect(Math.max(...widths(t))).toBeLessThanOrEqual(48);
  });

  it('标签按配置的纸宽排，不多占一列', () => {
    const [c58] = renderCups(longOrder, { bigTable: true }, { paper: '58', encoding: 'gbk', cutter: false, cashDrawer: false });
    const [c80] = renderCups(longOrder, { bigTable: true }, { paper: '80', encoding: 'gbk', cutter: false, cashDrawer: false });
    expect(Math.max(...widths(plain(c58!)))).toBeLessThanOrEqual(32);
    expect(Math.max(...widths(plain(c80!)))).toBeLessThanOrEqual(48);
  });

  it('票头先初始化再进汉字模式（FS &），否则中文打成乱码', () => {
    const b = renderReceipt(order, shop, { paper: '58', encoding: 'gbk', cutter: false, cashDrawer: false });
    // ESC @ = 1b 40，FS & = 1c 26
    expect([...b.subarray(0, 4)]).toEqual([0x1b, 0x40, 0x1c, 0x26]);
  });

  it('utf8 机型不发汉字模式（会吞掉后面整段）', () => {
    const b = renderReceipt(order, shop, { paper: '58', encoding: 'utf8', cutter: false, cashDrawer: false });
    expect([...b.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(b.includes(Buffer.from([0x1c, 0x26]))).toBe(false);
  });

  it('gb18030 编得出 GBK 编不出的生僻字，不变成问号', () => {
    const wide = text('𠮷', 'gb18030');
    expect(iconv.decode(wide, 'gb18030')).toBe('𠮷');
    expect(iconv.encode('𠮷', 'gbk').toString('hex')).toBe('3f'); // 问号：这就是 gbk 掉字的样子
  });

  it('无切刀的标签机默认不发切纸指令', () => {
    const env = readPrintEnv({ PRINT_LABEL_ON: '1' });
    expect(env.labelCutter).toBe(false);
    const [c] = renderCups(order, { bigTable: true }, { paper: '58', encoding: 'gbk', cutter: false, cashDrawer: false });
    expect(c!.includes(Buffer.from([0x1d, 0x56]))).toBe(false);
  });

  it('两台可以各配各的编码，没配就吃 PRINT_ENCODING 兜底', () => {
    const both = readPrintEnv({ PRINT_ENCODING: 'gbk', PRINT_RECEIPT_ENCODING: 'utf8', PRINT_LABEL_ENCODING: 'gb18030' });
    expect(both.receiptEncoding).toBe('utf8');
    expect(both.labelEncoding).toBe('gb18030');
    const fallback = readPrintEnv({ PRINT_ENCODING: 'utf8' });
    expect(fallback.receiptEncoding).toBe('utf8');
    expect(fallback.labelEncoding).toBe('utf8');
    expect(readPrintEnv({}).labelEncoding).toBe('gbk'); // 国产机缺省，不用配
  });

  it('纸宽默认值对着机器来：小票 80、标签 58；桌号大字能关', () => {
    const env = readPrintEnv({ PRINT_LABEL_ON: '1', PRINT_RECEIPT_ON: '1' });
    expect(env.receiptPaper).toBe('80'); // Zy307
    expect(env.labelPaper).toBe('58'); // XP-236B 的 48mm 打印区
    expect(env.labelBigTable).toBe(true);
    expect(readPrintEnv({ PRINT_LABEL_BIGTABLE: '0' }).labelBigTable).toBe(false);
    expect(readPrintEnv({ PRINT_LABEL_PAPER: '80' }).labelPaper).toBe('80');
  });
});
