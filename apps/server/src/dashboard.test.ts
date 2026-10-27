// P3 第③项：数据看板简版。每个数都从订单、退款、储值流水现算，这里逐项对账
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Cart, Dashboard, Member, Order } from '@pkg/contract';
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
const dash = async (day?: string) => Dashboard.parse(await (await req(`/api/admin/dashboard${day ? `?day=${day}` : ''}`, { admin: true })).json());
async function order(items: [string, number][], paymentMethod: string, opts: { member?: string; useStoredValue?: boolean } = {}) {
  const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
  for (const [uid, qty] of items) await req('/api/cart/update', { body: { cartId: cart.id, dishUid: uid, qty } });
  return Order.parse(await (await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '3', paymentMethod, useStoredValue: opts.useStoredValue ?? false }, member: opts.member })).json());
}
async function member(balanceSen: number) {
  const m = Member.parse(await (await req('/api/admin/members', { body: { pin: '1234' }, admin: true })).json());
  await req(`/api/admin/members/${m.id}/recharge`, { body: { amountSen: balanceSen, requestId: randomUUID() }, admin: true });
  const token = String(((await (await req('/api/member/login', { body: { memberNo: m.memberNo, pin: '1234' } })).json()) as { token: string }).token);
  return { ...m, token };
}

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡 12:00
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-test-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('数据看板简版（31号：今日营收 / 订单数 / 储值变动）', () => {
  it('没有任何单：全是 0，7 天表齐全，不报错', async () => {
    const d = await dash();
    expect(d.today).toBe('2026-10-17');
    expect(d.day).toMatchObject({ orders: 0, cancelled: 0, grossSen: 0, refundSen: 0, netSen: 0, byMethod: [] });
    expect(d.week.map((w) => w.day)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  });

  it('营收 = 未取消订单合计 − 退款；取消的单不计；按付款方式拆分，混合支付两边各算', async () => {
    const m = await member(5000); // 充值 50
    await order([['c03', 1]], 'cash'); // 现金 25
    await order([['e01', 1]], 'cash', { member: m.token, useStoredValue: true }); // 48 = 储值 50 中的 48？余额够整单 → 不会混合
    const big = await order([['v01', 1], ['c05', 1]], 'tng'); // TNG 78 + 25（只退烤鱼：整单退完会触发「全部菜品已退款」自动取消）
    const cancelled = await order([['c04', 1]], 'cash'); // 25，稍后取消
    await req(`/api/admin/orders/${cancelled.id}/status`, { body: { to: 'cancelled', reason: '客人走了' }, admin: true });
    const fishLine = big.items.find((i) => i.dishUid === 'v01')!.line;
    await req(`/api/admin/orders/${big.id}/refund`, { body: { lines: [{ line: fishLine, qty: 1 }], reason: '烤焦了', requestId: randomUUID() }, admin: true }); // TNG 退 78
    const d = (await dash()).day;
    expect(d.orders).toBe(3);
    expect(d.cancelled).toBe(1);
    const totals = { cash: 2500, e01: 4800, tng: 7800 + 2500 };
    expect(d.grossSen).toBe(totals.cash + totals.e01 + totals.tng);
    expect(d.refundSen).toBe(7800);
    expect(d.netSen).toBe(d.grossSen - d.refundSen);
    const by = Object.fromEntries(d.byMethod.map((x) => [x.method, x]));
    expect(by.tng).toMatchObject({ orders: 1, grossSen: 10300, refundSen: 7800, netSen: 2500 });
    // 第二单余额 50 够付 48 → 只要选了「先用储值」也是混合逻辑：储值付 48、现金 0
    const storedPart = by['stored-value']?.grossSen ?? 0;
    expect(storedPart + (by.cash?.grossSen ?? 0)).toBe(totals.cash + totals.e01);
    expect(d.byMethod.reduce((n, x) => n + x.netSen, 0)).toBe(d.netSen); // 拆分合计 = 总实收
  });

  it('混合支付：储值部分记储值，其余记另一种方式；部分退款按比例分摊到两边', async () => {
    const m = await member(3000); // 余额 30
    const o = await order([['e01', 1], ['c03', 1]], 'cash', { member: m.token, useStoredValue: true }); // 73 = 储值 30 + 现金 43
    expect(o).toMatchObject({ storedSen: 3000, otherSen: 4300 });
    const frogLine = o.items.find((i) => i.dishUid === 'e01')!.line;
    await req(`/api/admin/orders/${o.id}/refund`, { body: { lines: [{ line: frogLine, qty: 1 }], reason: '上错菜', requestId: randomUUID() }, admin: true }); // 退 48
    // 退 48 占整单 73 的 4800/7300，按「各付了多少」等比例退回：
    //   储值 3000 × 4800/7300 = 1972.6 → 1973
    //   现金 4300 × 4800/7300 = 2827.4 → 2827（余数落到最后一行）
    // 这样顾客手上两种钱的比例不变；旧规则「储值先退」会把储值掏空、现金几乎没退。
    const day = (await dash()).day;
    const by = Object.fromEntries(day.byMethod.map((x) => [x.method, x]));
    expect(by['stored-value']).toMatchObject({ orders: 1, grossSen: 3000, refundSen: 1973, netSen: 1027 });
    expect(by.cash).toMatchObject({ orders: 1, grossSen: 4300, refundSen: 2827, netSen: 1473 });
    expect(day).toMatchObject({ orders: 1, grossSen: 7300, refundSen: 4800, netSen: 2500 });
    // 退回的储值确实回到了会员余额里（余额 30 全花掉，退了 19.73 → 19.73）
    const detail = (await (await req(`/api/admin/members/${m.id}`, { admin: true })).json()) as { member: { balanceSen: number } };
    expect(detail.member.balanceSen).toBe(1973);
  });

  it('储值变动：充值、消费、退回、调整逐项合计，净变动 = 全店余额变化', async () => {
    const before = (await dash()).storedBalanceSen;
    const m = await member(10000); // +100
    const o = await order([['e01', 1]], 'stored-value', { member: m.token }); // −48
    await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'cancelled', reason: '客人走了' }, admin: true }); // +48 退回
    await req(`/api/admin/members/${m.id}/adjust`, { body: { amountSen: -500, note: '多充了', requestId: randomUUID() }, admin: true }); // −5
    const d = await dash();
    expect(d.day.stored).toMatchObject({ rechargeSen: 10000, consumeSen: -4800, refundSen: 4800, adjustSen: -500, importSen: 0, netSen: 9500, entries: 4 });
    expect(d.storedBalanceSen - before).toBe(d.day.stored.netSen);
  });

  it('按营业日归属：凌晨跨日后，前一天的单留在前一天；可以往回查，不能查未来', async () => {
    await order([['c03', 1]], 'cash');
    now = new Date('2026-10-17T16:30:00Z'); // 吉隆坡 10-18 00:30
    await order([['c04', 1]], 'cash');
    // 时间往后跳了半天，老板端登录已过期，重新登录
    admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
    const today = await dash();
    expect(today.today).toBe('2026-10-18');
    expect(today.day).toMatchObject({ day: '2026-10-18', orders: 1, grossSen: 2500 });
    expect(today.week.slice(-2)).toEqual([
      { day: '2026-10-17', orders: 1, netSen: 2500, storedNetSen: 0 },
      { day: '2026-10-18', orders: 1, netSen: 2500, storedNetSen: 0 },
    ]);
    expect((await dash('2026-10-17')).day.orders).toBe(1);
    expect((await req('/api/admin/dashboard?day=2026-10-19', { admin: true })).status).toBe(400);
    expect((await req('/api/admin/dashboard?day=17-10-2026', { admin: true })).status).toBe(400);
  });

  it('没登录看不到', async () => {
    expect((await req('/api/admin/dashboard')).status).toBe(401);
  });
});
