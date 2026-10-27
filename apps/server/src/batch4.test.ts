// P2 第四批：今日售罄三态、混合支付、按菜品行部分退款、待柜台退还
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AdminDish, Cart, CounterRefund, Member, MemberDetail, Menu, Order } from '@pkg/contract';
import { z } from 'zod';
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
    headers: {
      'content-type': 'application/json',
      ...(o.admin ? { authorization: `Bearer ${admin}` } : {}),
      ...(o.member ? { 'x-member-token': o.member } : {}),
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
const msg = async (r: Response) => String(((await r.json()) as { message?: string }).message);

async function cartWith(items: [string, number][]) {
  const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
  for (const [uid, qty] of items) await req('/api/cart/update', { body: { cartId: cart.id, dishUid: uid, qty } });
  return cart.id;
}
async function memberWith(balanceSen: number) {
  const m = Member.parse(await (await req('/api/admin/members', { body: { pin: '1234' }, admin: true })).json());
  if (balanceSen > 0) await req(`/api/admin/members/${m.id}/recharge`, { body: { amountSen: balanceSen, requestId: randomUUID() }, admin: true });
  const token = String(((await (await req('/api/member/login', { body: { memberNo: m.memberNo, pin: '1234' } })).json()) as { token: string }).token);
  return { ...m, token };
}
const balanceOf = async (id: string) => MemberDetail.parse(await (await req(`/api/admin/members/${id}`, { admin: true })).json()).member.balanceSen;
const ledgerOf = async (id: string) => MemberDetail.parse(await (await req(`/api/admin/members/${id}`, { admin: true })).json()).ledger;
const pending = async () => z.array(CounterRefund).parse(await (await req('/api/admin/counter-refunds', { admin: true })).json());
const refund = (orderId: string, lines: { line: number; qty: number }[], requestId = randomUUID(), reason = '菜做咸了') =>
  req(`/api/admin/orders/${orderId}/refund`, { body: { lines, reason, requestId }, admin: true });

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡 12:00
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-test-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('今日售罄（28号 #5）', () => {
  it('售罄：顾客照常看得到（标售罄），不能加购；购物车里已有的标「今日售罄」、不能下单', async () => {
    const cartId = await cartWith([['c03', 1]]);
    const r = await req('/api/admin/dishes/c03/state', { body: { state: 'soldout' }, admin: true });
    expect(AdminDish.parse(await r.json()).state).toBe('soldout');
    const menu = Menu.parse(await (await req('/api/menu')).json());
    expect(menu.dishes.find((d) => d.uid === 'c03')).toMatchObject({ soldOut: true });
    const other = await cartWith([]);
    const add = await req('/api/cart/update', { body: { cartId: other, dishUid: 'c03', qty: 1 } });
    expect(add.status).toBe(409);
    expect(await msg(add)).toBe('「农家一碗香」今日已售罄');
    const cart = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId } })).json());
    expect(cart.lines[0]).toMatchObject({ available: false, unavailableReason: 'soldout' });
    const sub = await req('/api/order/submit', { body: { cartId, tableNo: '1', paymentMethod: 'cash' } });
    expect(await msg(sub)).toContain('农家一碗香（今日售罄）');
    // 已经在车里的可以减少/移除
    expect((await req('/api/cart/update', { body: { cartId, dishUid: 'c03', qty: 0 } })).status).toBe(200);
  });
  it('「今日」售罄：第二个营业日自动恢复在售', async () => {
    await req('/api/admin/dishes/c03/state', { body: { state: 'soldout' }, admin: true });
    now = new Date('2026-10-17T16:30:00Z'); // 吉隆坡 10-18 00:30
    const menu = Menu.parse(await (await req('/api/menu')).json());
    expect(menu.dishes.find((d) => d.uid === 'c03')?.soldOut).toBe(false);
  });
  it('三态切换都留痕；下架的顾客看不到', async () => {
    for (const s of ['soldout', 'off', 'on']) await req('/api/admin/dishes/c03/state', { body: { state: s }, admin: true });
    expect(db.prepare("SELECT old_value || '>' || new_value FROM dish_changes WHERE dish_uid = 'c03' ORDER BY id").pluck().all())
      .toEqual(['on>soldout', 'soldout>off', 'off>on']);
    expect((await req('/api/admin/dishes/c03/state', { body: { state: 'gone' }, admin: true })).status).toBe(400);
  });
});

describe('混合支付（储值 + 其他方式）', () => {
  it('余额不够整单：储值先扣完，剩下的记现金；储值部分与订单同一事务', async () => {
    const m = await memberWith(3000);
    const cartId = await cartWith([['e01', 1]]); // 48
    const r = await req('/api/order/submit', { body: { cartId, tableNo: '2', paymentMethod: 'cash', useStoredValue: true }, member: m.token });
    expect(r.status).toBe(201);
    const o = Order.parse(await r.json());
    expect(o).toMatchObject({ paymentMethod: 'cash', storedSen: 3000, otherSen: 1800, totalSen: 4800 });
    expect(await balanceOf(m.id)).toBe(0);
    expect((await ledgerOf(m.id))[0]).toMatchObject({ type: 'consume', amountSen: -3000, orderId: o.id });
  });
  it('勾了合付但余额其实够整单：记为纯储值', async () => {
    const m = await memberWith(10000);
    const cartId = await cartWith([['e01', 1]]);
    const o = Order.parse(await (await req('/api/order/submit', { body: { cartId, tableNo: '2', paymentMethod: 'tng', useStoredValue: true }, member: m.token })).json());
    expect(o).toMatchObject({ paymentMethod: 'stored-value', storedSen: 4800, otherSen: 0 });
  });
  it('余额为 0 / 没登录会员：都有可读提示；纯储值余额不够时提示可以合付', async () => {
    const zero = await memberWith(0);
    const c1 = await cartWith([['e01', 1]]);
    const r1 = await req('/api/order/submit', { body: { cartId: c1, tableNo: '2', paymentMethod: 'cash', useStoredValue: true }, member: zero.token });
    expect(await msg(r1)).toBe('储值余额为 0，请直接选择其他付款方式');
    const r2 = await req('/api/order/submit', { body: { cartId: c1, tableNo: '2', paymentMethod: 'cash', useStoredValue: true } });
    expect(r2.status).toBe(401);
    const poor = await memberWith(1000);
    const r3 = await req('/api/order/submit', { body: { cartId: c1, tableNo: '2', paymentMethod: 'stored-value' }, member: poor.token });
    expect(await msg(r3)).toContain('可以选「储值 + 其他方式」合付');
    expect(db.prepare('SELECT COUNT(*) FROM orders').pluck().get()).toBe(0);
  });
});

describe('按菜品行部分退款（28号 §三-2/3）', () => {
  async function mixedOrder() {
    const m = await memberWith(5000);
    const cartId = await cartWith([['e01', 2], ['staple-rice', 3]]); // 96 + 6 = 102
    const o = Order.parse(await (await req('/api/order/submit', { body: { cartId, tableNo: '6', paymentMethod: 'cash', useStoredValue: true }, member: m.token })).json());
    expect(o).toMatchObject({ storedSen: 5000, otherSen: 5200 });
    return { m, o };
  }

  it('混付单退款按「储值 : 现金」比例分摊，不是先退储值；每行每次一笔独立的红字流水', async () => {
    // 这张单：储值 50 + 现金 52 = 102，比例 5000 : 5200
    const { m, o } = await mixedOrder();
    const first = Order.parse(await (await refund(o.id, [{ line: 1, qty: 1 }])).json());
    expect(first.refundState).toBe('partial');
    expect(first.items[0]?.refundedQty).toBe(1);
    // 退一道 48 元的菜（占整单 102 元的 47.06%）：储值退 23.53 → 23.53，现金退 24.47
    // 旧算法「先退储值」会把 48 元全退进储值余额，柜台一分现金不用给——顾客拿到的是余额不是现金
    expect(first.refunds[0]).toMatchObject({ amountSen: 4800, storedSen: 2353, counterSen: 2447 });
    expect(await balanceOf(m.id)).toBe(2353); // 5000 - 2353（扣掉储值那部分后剩下的余额）
    expect(await pending()).toMatchObject([{ amountSen: 2447, method: 'cash', pickupNo: 1 }]);

    const second = Order.parse(await (await refund(o.id, [{ line: 1, qty: 1 }])).json());
    const last = second.refunds[1]!;
    expect(last.amountSen).toBe(4800);
    expect(last.storedSen + last.counterSen).toBe(4800);
    // 储值余额只会变多（退款），不会凭空多退
    expect(await balanceOf(m.id)).toBeLessThan(5000);

    const ledger = await ledgerOf(m.id);
    expect(ledger.filter((l) => l.type === 'refund')).toHaveLength(2);
  });
  it('边界：同一行累计退的份数不能超过下单份数（分多次退也一样）', async () => {
    const { o } = await mixedOrder();
    await refund(o.id, [{ line: 1, qty: 1 }]);
    await refund(o.id, [{ line: 1, qty: 1 }]);
    const third = await refund(o.id, [{ line: 1, qty: 1 }]);
    expect(third.status).toBe(409);
    expect(await msg(third)).toBe('「招牌跳跳蛙」最多还能退 0 份（下单 2 份，已退 2 份）');
    const tooMany = await refund(o.id, [{ line: 2, qty: 4 }]);
    expect(await msg(tooMany)).toContain('最多还能退 3 份');
    // 一次请求里同一行写两遍，合并后同样受限
    expect((await refund(o.id, [{ line: 2, qty: 2 }, { line: 2, qty: 2 }])).status).toBe(409);
    // 数据库也把关：绕过接口直接写也写不进去
    expect(() => db.prepare(`INSERT INTO order_refunds (order_id, line, qty, amount_sen, stored_sen, counter_sen, reason, operator, at, request_key)
                             VALUES (?, 1, 1, 4800, 0, 4800, 'x', 't', 't', 'k')`).run(o.id)).toThrow(/exceeds/);
  });
  it('同一个请求编号重复提交只退一次', async () => {
    const { m, o } = await mixedOrder();
    const rid = randomUUID();
    await refund(o.id, [{ line: 2, qty: 1 }], rid);
    await refund(o.id, [{ line: 2, qty: 1 }], rid);
    expect(Order.parse(await (await req(`/api/order/${o.id}`)).json()).items[1]?.refundedQty).toBe(1);
    expect((await ledgerOf(m.id)).filter((l) => l.type === 'refund')).toHaveLength(1);
  });
  it('已下架的菜也能退', async () => {
    const { o } = await mixedOrder();
    await req('/api/admin/dishes/e01/state', { body: { state: 'off' }, admin: true });
    expect((await refund(o.id, [{ line: 1, qty: 1 }])).status).toBe(200);
  });
  it('一次退多行：每行各一条记录；没做完的单全部退完 → 自动取消（后厨不再做），不会多退钱', async () => {
    const { m, o } = await mixedOrder();
    const done = Order.parse(await (await refund(o.id, [{ line: 1, qty: 2 }, { line: 2, qty: 3 }])).json());
    expect(done.refunds).toHaveLength(2);
    expect(done).toMatchObject({ refundState: 'full', refundedSen: 10200, status: 'cancelled', cancelReason: '全部菜品已退款', etaMinutes: null, autoCancelled: true });
    expect(await balanceOf(m.id)).toBe(5000); // 储值 50 全退回，没有多退
    // 现金 52 待柜台退还：按比例分摊后每行各一条，合计必须**正好** 5200，一分不多一分不少
    // 这是最关键的一条：全额退完时，储值恰好退满 5000、现金恰好退满 5200，一分不多一分不少。
    // 比例分摊容易算错的地方就在舍入余数，这里用「精确等于」守住。
    const p = (await pending()).map((x) => x.amountSen);
    expect(p.reduce((a, b) => a + b, 0)).toBe(5200);
    const backStored = (await ledgerOf(m.id)).filter((l) => l.type === 'refund').reduce((n, l) => n + l.amountSen, 0);
    expect(backStored).toBe(5000);
  });
  it('已完成的单全部退完：保持「已完成」，标「已全额退款」', async () => {
    const { o } = await mixedOrder();
    await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'cooking' }, admin: true });
    await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'done' }, admin: true });
    const done = Order.parse(await (await refund(o.id, [{ line: 1, qty: 2 }, { line: 2, qty: 3 }])).json());
    expect(done).toMatchObject({ status: 'done', refundState: 'full' });
  });
  it('部分退款后整单取消：只退还没退过的部分；取消后不能再退', async () => {
    const { m, o } = await mixedOrder();
    await refund(o.id, [{ line: 1, qty: 1 }]); // 按比例退：储值 23.53 + 现金 24.47
    const cancelled = Order.parse(await (await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'cancelled', reason: '客人走了' }, admin: true })).json());
    expect(cancelled.autoCancelled).toBe(false); // 店员手动取消，不标「系统自动取消」
    // 两次退款（部分退 + 取消补退）加起来，储值恰好回到 5000、现金恰好退满 5200
    expect(await balanceOf(m.id)).toBe(5000);
    const all = (await pending()).map((p) => p.amountSen);
    expect(all.reduce((a, b) => a + b, 0)).toBe(5200);
    const after = await refund(o.id, [{ line: 2, qty: 1 }]);
    expect(await msg(after)).toContain('不能再退款');
  });
  it('退款必须写原因；对账仍然平', async () => {
    const { o } = await mixedOrder();
    expect(await msg(await refund(o.id, [{ line: 1, qty: 1 }], randomUUID(), ' '))).toBe('退款需要填写原因');
    await refund(o.id, [{ line: 1, qty: 1 }]);
    const run = ((await (await req('/api/admin/reconcile', { body: {}, admin: true })).json()) as { last: { mismatches: unknown[] } }).last;
    expect(run.mismatches).toHaveLength(0);
    expect(() => db.prepare('DELETE FROM order_refunds').run()).toThrow(/append-only/);
  });
});

describe('待柜台退还', () => {
  it('处理一次就锁定：已退还 / 未收款无需退；不能改第二次、不能删', async () => {
    const cartId = await cartWith([['e01', 1]]);
    const o = Order.parse(await (await req('/api/order/submit', { body: { cartId, tableNo: '3', paymentMethod: 'cash' } })).json());
    await refund(o.id, [{ line: 1, qty: 1 }]);
    const [p] = await pending();
    expect(p).toMatchObject({ amountSen: 4800, resolution: null });
    const ok = await req(`/api/admin/counter-refunds/${p!.id}/resolve`, { body: { resolution: 'refunded' }, admin: true });
    expect(CounterRefund.parse(await ok.json()).resolution).toBe('refunded');
    expect(await pending()).toHaveLength(0);
    expect((await req(`/api/admin/counter-refunds/${p!.id}/resolve`, { body: { resolution: 'not-collected' }, admin: true })).status).toBe(409);
    expect(() => db.prepare("UPDATE counter_refunds SET resolution = 'not-collected'").run()).toThrow(/only be resolved once/);
    expect(() => db.prepare('DELETE FROM counter_refunds').run()).toThrow(/cannot be deleted/);
  });
});
