// P2-4：日结单 / 交接班报表。重点验「时间段怎么切」和「口径和看板一致」两件事
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Cart, DayReport, Member, Order } from '@pkg/contract';
import { createApp } from './app.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';
let db: DB;
let now: Date;
let api: ReturnType<typeof createApp>['app'];
let admin: string;

const req = (path: string, o: { body?: unknown; admin?: boolean; member?: string } = {}) =>
  api.request(path, {
    method: o.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(o.admin ? { authorization: `Bearer ${admin}` } : {}), ...(o.member ? { 'x-member-token': o.member } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
const report = async (q = '') => DayReport.parse(await (await req(`/api/admin/report${q}`, { admin: true })).json());

async function order(items: [string, number][], paymentMethod = 'cash', opts: { member?: string; useStoredValue?: boolean } = {}) {
  const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
  for (const [uid, qty] of items) await req('/api/cart/update', { body: { cartId: cart.id, dishUid: uid, qty } });
  return Order.parse(
    await (await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '3', paymentMethod, useStoredValue: opts.useStoredValue ?? false }, member: opts.member })).json(),
  );
}
async function member(balanceSen: number) {
  const m = Member.parse(await (await req('/api/admin/members', { body: { pin: '1234' }, admin: true })).json());
  await req(`/api/admin/members/${m.id}/recharge`, { body: { amountSen: balanceSen, requestId: randomUUID() }, admin: true });
  const token = String(((await (await req('/api/member/login', { body: { memberNo: m.memberNo, pin: '1234' } })).json()) as { token: string }).token);
  return { ...m, token };
}
const setNow = (iso: string) => { now = new Date(iso); };

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡 12:00
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-test-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('日结单：时间段', () => {
  it('不传时间就是今天整天（按门店时区的日历日，不是 UTC）', async () => {
    const r = await report();
    // 吉隆坡 2026-10-17 00:00 = UTC 2026-10-16 16:00
    expect(r.from).toBe('2026-10-16T16:00:00.000Z');
    expect(r.to).toBe('2026-10-17T16:00:00.000Z');
    expect(r.rangeText).toBe('10-17 00:00 ~ 10-18 00:00');
  });

  it('只给日期：从头一天 00:00 到后一天 00:00，包含整天', async () => {
    const r = await report('?from=2026-10-10&to=2026-10-11');
    expect(r.from).toBe('2026-10-09T16:00:00.000Z');
    expect(r.to).toBe('2026-10-10T16:00:00.000Z');
  });

  it('给到时分：按门店时区的墙上钟解释，不会偏成凌晨', async () => {
    const r = await report('?from=2026-10-16%2017:00&to=2026-10-17%2002:00');
    expect(r.from).toBe('2026-10-16T09:00:00.000Z'); // 吉隆坡 17:00
    expect(r.to).toBe('2026-10-16T18:00:00.000Z'); // 吉隆坡次日 02:00
    expect(r.rangeText).toBe('10-16 17:00 ~ 10-17 02:00');
  });

  it('跨零点的晚市：凌晨那几单算进来、白天的不算', async () => {
    setNow('2026-10-16T04:00:00Z'); // 吉隆坡 12:00 中午
    const noon = await order([['l01', 1]]);
    setNow('2026-10-16T13:00:00Z'); // 吉隆坡 21:00 晚市
    const night = await order([['l01', 2]]);
    setNow('2026-10-16T18:30:00Z'); // 吉隆坡次日 02:30（打烊后）
    const after = await order([['l01', 1]]);

    const r = await report('?from=2026-10-16%2017:00&to=2026-10-17%2002:00');
    expect(r.orders).toBe(1);
    expect(r.topDishes.reduce((n, d) => n + d.qty, 0)).toBe(2);
    expect([noon.id, night.id, after.id]).toHaveLength(3);

    // 同一份晚市，把结束时间放到 03:00，打烊后那单就进来了
    const wider = await report('?from=2026-10-16%2017:00&to=2026-10-17%2003:00');
    expect(wider.orders).toBe(2);
  });

  it('时间倒过来 / 格式乱写 / 超过 31 天：都给一句人话，不是 500', async () => {
    for (const q of ['?from=2026-10-17&to=2026-10-10', '?from=昨天&to=今天', '?from=2026-01-01&to=2026-10-01']) {
      const res = await req(`/api/admin/report${q}`, { admin: true });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/结束时间必须晚于|格式不对|最多结 31 天/);
    }
  });

  it('不登录不给看：报表是营业数据', async () => {
    expect((await req('/api/admin/report')).status).toBe(401);
  });
});

describe('日结单：账要对得上', () => {
  it('净收入 = 下单 − 退款；退款拆成「退回储值」和「柜台退现」两笔', async () => {
    // 卡里只放 RM 5，一份招牌柠檬茶 RM 19.90 → 储值扣 5，剩下 14.90 走现金，才拆得成两条
    const m = await member(500);
    const o = await order([['l01', 1]], 'cash', { member: m.token, useStoredValue: true });
    const storedPart = o.storedSen;
    const cashPart = o.totalSen - storedPart;
    expect(storedPart).toBe(500);
    expect(cashPart).toBeGreaterThan(0);

    const r0 = await report();
    expect(r0.grossSen).toBe(o.totalSen);
    expect(r0.netSen).toBe(o.totalSen);
    // 混合支付拆两条，各算一单
    expect(r0.byMethod.length).toBe(2);
    expect(r0.byMethod.find((x) => x.method === 'cash')?.grossSen).toBe(cashPart);
    expect(r0.byMethod.find((x) => x.grossSen === storedPart)).toBeTruthy();

    // 退掉这单
    // 退一份（qty 不能省，否则被当成「退 0 份」静默通过）
    const rf = await req(`/api/admin/orders/${o.id}/refund`, { body: { lines: [{ line: 1, qty: 1 }], reason: 'test', requestId: randomUUID() }, admin: true });
    expect(rf.status).toBe(200);
    const r1 = await report();
    expect(r1.refundSen).toBeGreaterThan(0);
    expect(r1.netSen).toBe(r1.grossSen - r1.refundSen);
    expect(r1.refundStoredSen + r1.refundCounterSen).toBe(r1.refundSen);
    // 储值那部分必须回到卡里，不能算成柜台退现
    expect(r1.refundStoredSen).toBeGreaterThan(0);
  });

  it('取消的单不算营收，但单独计数给老板看', async () => {
    const o = await order([['l01', 1]]);
    const res = await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'cancelled', reason: 'test' }, admin: true });
    expect(res.status).toBe(200);
    const r = await report();
    expect(r.orders).toBe(0);
    expect(r.cancelled).toBe(1);
    expect(r.netSen).toBe(0);
    expect(r.avgPerOrderSen).toBe(0);
  });

  it('人均 = 净收入 ÷ 有效单数，四舍五入到分', async () => {
    await order([['l01', 1]]);
    await order([['l01', 2]]);
    const r = await report();
    expect(r.orders).toBe(2);
    expect(r.avgPerOrderSen).toBe(Math.round(r.netSen / 2));
  });

  it('卖了什么：同名菜合并、按份数从多到少', async () => {
    const m = await member(50_000);
    await order([['l01', 1]], 'cash', { member: m.token, useStoredValue: true });
    await order([['l01', 3]], 'cash');
    const r = await report();
    const top = r.topDishes[0]!;
    expect(top.qty).toBe(4);
    expect(r.topDishes.every((d, i, a) => i === 0 || a[i - 1]!.qty >= d.qty)).toBe(true);
  });

  it('储值进出：充值 / 消费 / 退回都记进这一班，余额是全店此刻的', async () => {
    const m = await member(10_000);
    await order([['l01', 1]], 'cash', { member: m.token, useStoredValue: true });
    const r = await report();
    expect(r.stored.rechargeSen).toBe(10_000);
    expect(r.stored.consumeSen).toBeLessThan(0); // 消费是负数
    expect(r.stored.netSen).toBe(r.stored.rechargeSen + r.stored.consumeSen + r.stored.refundSen + r.stored.adjustSen + r.stored.importSen);
    expect(r.storedBalanceSen).toBe(10_000 + r.stored.consumeSen);
  });

  it('今天卖、明天退：两天的账都不许丢（全额退款会自动取消，取消单也要留在账上）', async () => {
    setNow('2026-10-17T04:00:00Z'); // 10-17 中午卖一单 RM 19.90
    const o = await order([['l01', 1]], 'cash');
    expect(o.totalSen).toBe(1990);

    setNow('2026-10-18T04:00:00Z'); // 第二天客人投诉，全额退掉
    // 时间跳了一天，会话自然过期（正确行为），重新登录取新令牌
    admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
    const rf = await req(`/api/admin/orders/${o.id}/refund`, { body: { lines: [{ line: 1, qty: 1 }], reason: '客人投诉', requestId: randomUUID() }, admin: true });
    expect(rf.status).toBe(200);
    // 全额退款会自动把单置为 cancelled（顾客看到「全部退款」）
    const row = db.prepare('SELECT status FROM orders WHERE id = ?').get(o.id) as { status: string };
    expect(row.status).toBe('cancelled');

    // 卖出那天：收入还在，净额是 19.90
    const d17 = await report('?from=2026-10-17&to=2026-10-18');
    expect(d17.grossSen).toBe(1990);
    expect(d17.refundSen).toBe(0);
    expect(d17.netSen).toBe(1990);

    // 退款那天：这一班没有新单，但退款要记在这一班的头上（净额 −19.90，柜台必须数出这笔钱）
    const d18 = await report('?from=2026-10-18&to=2026-10-19');
    expect(d18.grossSen).toBe(0);
    expect(d18.refundSen).toBe(1990);
    expect(d18.refundCounterSen).toBe(1990);
    expect(d18.netSen).toBe(-1990);

    // 付款方式明细必须能加起来对上总额，否则老板拿着这张纸对不上账
    expect(d18.byMethod.reduce((n, m) => n + m.refundSen, 0)).toBe(d18.refundSen);
    expect(d18.byMethod.reduce((n, m) => n + m.netSen, 0)).toBe(d18.netSen);

    // 把两天一起结：收入与退款互相抵消，净额 0，一分不多一分不少
    const both = await report('?from=2026-10-17&to=2026-10-19');
    expect(both).toMatchObject({ grossSen: 1990, refundSen: 1990, netSen: 0 });
  });

  it('空的一天：全 0，不报错，也不编数字', async () => {
    const r = await report('?from=2020-01-01&to=2020-01-02');
    expect(r).toMatchObject({ orders: 0, cancelled: 0, grossSen: 0, refundSen: 0, netSen: 0, avgPerOrderSen: 0 });
    expect(r.byMethod).toEqual([]);
    expect(r.topDishes).toEqual([]);
  });
});
