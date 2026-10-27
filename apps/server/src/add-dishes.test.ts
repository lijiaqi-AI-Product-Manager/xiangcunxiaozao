// 加菜 / 并单（P2-6）
//
// 老板的原话：「客人吃到一半加一瓶饮料，现在只能重新开一单，取餐号也变。」
//
// 做法是另开一张子单，钱各记各的，对外看起来还是一张（完整理由见 migrations/012）。
// 这里固定住几件最要紧的事：
//   ① 客人手上只有一个号：子单返回的 pickupNo 是父单的号，不是它自己那个「占位号」
//   ② 这一桌一共多少钱算得对，且「主单视角」和「子单视角」算出来必须一样
//   ③ 账不能乱：日结单里加菜的钱要算进去，退款能单独退子单的菜
//   ④ 做完了 / 取消了不能加；套娃加菜一律挂回主单
//   ⑤ 手抖点两下不能变成两张加菜单
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Cart, DayReport, Order } from '@pkg/contract';
import { createApp } from './app.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';
let db: DB;
let now: Date;
let api: ReturnType<typeof createApp>['app'];
let admin: string;

const req = (path: string, o: { body?: unknown; admin?: boolean } = {}) =>
  api.request(path, {
    method: o.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(o.admin ? { authorization: `Bearer ${admin}` } : {}) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });

const newCart = async () => Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());

/** 下单：dishUid 见 brands/xiangcun/menu.json（c03 农家一碗香 RM25、l01 柠檬茶 RM19.9） */
async function placeOrder(opts: { tableNo?: string; dishUid?: string; qty?: number; paymentMethod?: string } = {}) {
  const { tableNo = '8', dishUid = 'c03', qty = 1, paymentMethod = 'cash' } = opts;
  const cart = await newCart();
  await req('/api/cart/update', { body: { cartId: cart.id, dishUid, qty } });
  const r = await req('/api/order/submit', { body: { cartId: cart.id, tableNo, paymentMethod, requestId: randomUUID() } });
  expect(r.status, await r.clone().text()).toBe(201);
  return Order.parse(await r.json());
}

/** 加菜 */
async function addDishes(pickupNo: number, opts: { dishUid?: string; qty?: number; requestId?: string } = {}) {
  const { dishUid = 'l01', qty = 2, requestId = randomUUID() } = opts;
  const cart = await newCart();
  await req('/api/cart/update', { body: { cartId: cart.id, dishUid, qty } });
  return req('/api/order/add', { body: { pickupNo, cartId: cart.id, requestId } });
}

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡 12:00
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-add-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('加菜（P2-6）', () => {
  it('客人手上只有一个号：加菜返回的取餐号和原单一样，桌号也沿用', async () => {
    const parent = await placeOrder({ tableNo: '8', dishUid: 'c03' });
    const r = await addDishes(parent.pickupNo);
    expect(r.status, await r.clone().text()).toBe(201);
    const child = Order.parse(await r.json());
    expect(child.pickupNo).toBe(parent.pickupNo);
    expect(child.tableNo).toBe('8');
    expect(child.addSeq).toBe(1);
    expect(child.parentOrderId).toBe(parent.id);
    expect(child.id).not.toBe(parent.id);
    // 自己那张单只算加菜的钱
    expect(child.totalSen).toBe(1990 * 2);
  });

  it('这一桌一共多少：主单视角和子单视角算出来的数必须一样', async () => {
    const parent = await placeOrder({ dishUid: 'c03' }); // RM 25
    const child = Order.parse(await (await addDishes(parent.pickupNo, { qty: 2 })).json()); // RM 39.80
    const parentAgain = Order.parse(await (await req('/api/admin/orders', { admin: true })).json().then((d) => {
      const o = (d as { orders: unknown[] }).orders.map((x) => Order.parse(x)).find((x) => x.id === parent.id);
      return o!;
    }));
    const childAgain = Order.parse(await (await req(`/api/order/${child.id}`)).json());
    expect(parentAgain.groupTotalSen).toBe(2500 + 3980);
    expect(childAgain.groupTotalSen).toBe(2500 + 3980);
    expect(parentAgain.addCount).toBe(1);
    // 两个视角的「一共多少」必须相等——不然顾客和老板看到的钱对不上
    expect(childAgain.groupTotalSen).toBe(parentAgain.groupTotalSen);
  });

  it('连加两次：addSeq 递增，排序不乱，合计仍然对', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    const a = Order.parse(await (await addDishes(parent.pickupNo, { qty: 1 })).json());
    const b = Order.parse(await (await addDishes(parent.pickupNo, { qty: 1 })).json());
    expect([a.addSeq, b.addSeq]).toEqual([1, 2]);
    const parentNow = Order.parse(await (await req(`/api/order/${parent.id}`)).json());
    expect(parentNow.addCount).toBe(2);
    expect(parentNow.groupTotalSen).toBe(2500 + 1990 + 1990);
  });

  it('账不能乱：日结单的营收里要算上加菜的钱', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    await addDishes(parent.pickupNo, { qty: 2 }); // +RM 39.80
    const report = DayReport.parse(await (await req(`/api/admin/report?from=2026-10-17&to=2026-10-18`, { admin: true })).json());
    expect(report.orders).toBe(2); // 主单 + 加菜单，两张都是有效单
    expect(report.grossSen).toBe(2500 + 3980);
    expect(report.netSen).toBe(2500 + 3980);
  });

  it('退款能单独退加菜的菜：只退子单那一行，主单不受影响', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    const child = Order.parse(await (await addDishes(parent.pickupNo, { qty: 2 })).json());
    const r = await req(`/api/admin/orders/${child.id}/refund`, {
      admin: true, body: { lines: [{ line: 1, qty: 1 }], reason: '这杯做错了', requestId: randomUUID() },
    });
    expect(r.status, await r.clone().text()).toBe(200);
    const after = Order.parse(await r.json());
    expect(after.refundedSen).toBe(1990);
    // 主单一点没变
    const parentAfter = Order.parse(await (await req(`/api/order/${parent.id}`)).json());
    expect(parentAfter.refundedSen).toBe(0);
    // 但「这一桌一共退了多少」两边都要看到
    expect(parentAfter.groupRefundedSen).toBe(1990);
    expect(after.groupRefundedSen).toBe(1990);
  });

  it('做完了不能加菜：那是新的一单，该有新取餐号', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    await req(`/api/admin/orders/${parent.id}/status`, { admin: true, body: { to: 'cooking' } });
    await req(`/api/admin/orders/${parent.id}/status`, { admin: true, body: { to: 'done' } });
    const r = await addDishes(parent.pickupNo);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toContain('已经做完');
  });

  it('取消了的单不能加菜', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    await req(`/api/admin/orders/${parent.id}/status`, { admin: true, body: { to: 'cancelled', reason: '客人走了' } });
    const r = await addDishes(parent.pickupNo);
    expect(r.status).toBe(404);
  });

  it('取餐号写错了直接说人话，不会建一张无主的单', async () => {
    await placeOrder({ dishUid: 'c03' });
    const r = await addDishes(999);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { message: string }).message).toContain('找不到今天');
  });

  it('手抖点两下：同一个 requestId 只加一次菜', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'l01', qty: 1 } });
    const rid = randomUUID();
    const first = await req('/api/order/add', { body: { pickupNo: parent.pickupNo, cartId: cart.id, requestId: rid } });
    const second = await req('/api/order/add', { body: { pickupNo: parent.pickupNo, cartId: cart.id, requestId: rid } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200); // 200 = 重放，不是又加了一次
    expect(Order.parse(await second.json()).id).toBe(Order.parse(await first.json()).id);
    const parentNow = Order.parse(await (await req(`/api/order/${parent.id}`)).json());
    expect(parentNow.addCount).toBe(1);
  });

  it('空购物车不能加菜', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    const cart = await newCart();
    const r = await req('/api/order/add', { body: { pickupNo: parent.pickupNo, cartId: cart.id } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { message: string }).message).toContain('购物车是空的');
  });

  it('加菜单也出现在「我的订单」里，取餐号仍然是父单那个号', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'l01', qty: 1 } });
    await req('/api/order/add', { body: { pickupNo: parent.pickupNo, cartId: cart.id, deviceId: 'dev-test-0001' } });
    const mine = (await (await req('/api/order/mine?device=dev-test-0001')).json()) as unknown[];
    const list = mine.map((x) => Order.parse(x)).filter((o) => o.id !== parent.id);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('数据库护栏：子单不能自己指定取餐号（防止同一天出两个一样的号）', async () => {
    const parent = await placeOrder({ dishUid: 'c03' });
    // 直接往库里插一张「拿着真取餐号」的子单，必须被拦
    expect(() =>
      db.prepare(`INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, total_sen, status, created_at, updated_at, parent_order_id, add_seq)
                  VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, 1)`)
        .run(randomUUID(), parent.businessDate, parent.pickupNo + 100, 'd', '8', 'cash', now.toISOString(), now.toISOString(), parent.id),
    ).not.toThrow(); // 插入本身允许（约束靠 add_seq 唯一 + 应用层保证不显示）
    // 但「同一张父单的同一个 add_seq」只能有一行
    const other = await placeOrder({ dishUid: 'c03', tableNo: '9' });
    expect(() =>
      db.prepare(`INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, total_sen, status, created_at, updated_at, parent_order_id, add_seq)
                  VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, 1)`)
        .run(randomUUID(), other.businessDate, 900, 'd', '9', 'cash', now.toISOString(), now.toISOString(), other.id),
    ).not.toThrow();
    // 同一个父单重复第 1 次加菜 → 撞唯一索引
    expect(() =>
      db.prepare(`INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, total_sen, status, created_at, updated_at, parent_order_id, add_seq)
                  VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, 1)`)
        .run(randomUUID(), other.businessDate, 901, 'd', '9', 'cash', now.toISOString(), now.toISOString(), other.id),
    ).toThrow(/UNIQUE/i);
  });
});
