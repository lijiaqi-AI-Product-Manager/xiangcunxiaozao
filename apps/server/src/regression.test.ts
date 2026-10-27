// 开业前必修项的回归测试（P3-5）：幂等重放、并发覆盖、跨日、超时重试
//
// 这几个是最容易被后续改动悄悄弄坏的：它们都藏在「看起来正常」的路径之外，
// 平时手点测不出来，只有网络一抖、两台设备一起点、凌晨跨日时才跳出来。
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Cart, Order } from '@pkg/contract';
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

const submit = (cartId: string, requestId?: string | null, tableNo = '12') =>
  req('/api/order/submit', { body: { cartId, tableNo, paymentMethod: 'cash', requestId } });

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡 12:00
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-reg-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('下单幂等：网络一抖重发，不能变成两张单（P0-1）', () => {
  it('同一个 requestId 发三次，库里只有一张单，取餐号也不跳号', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 1 } });
    const rid = randomUUID();

    const first = await submit(cart.id, rid);
    expect(first.status).toBe(201);
    const a = Order.parse(await first.json());

    // 第二次、第三次：顾客手机没收到回应，点了重试 / 页面自己重发
    const second = await submit(cart.id, rid);
    expect(second.status).toBe(200); // 200 = 重放，不是新建
    const b = Order.parse(await second.json());
    const third = await submit(cart.id, rid);
    expect(third.status).toBe(200);
    const c = Order.parse(await third.json());

    // 三张「单」其实是同一张
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(c.pickupNo).toBe(a.pickupNo);
    expect(db.prepare('SELECT COUNT(*) FROM orders').pluck().get()).toBe(1);
  });

  it('重放发生在「购物车已经被清空」之后：不会报「购物车是空的」', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 1 } });
    const rid = randomUUID();
    expect((await submit(cart.id, rid)).status).toBe(201);
    // 下单后购物车空了；此时重试必须靠幂等编号接住，而不是走到「购物车是空的」校验
    const again = await submit(cart.id, rid);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('换了 requestId 就是新单：幂等不能把「客人真的要加单」也吞掉', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 1 } });
    const a = Order.parse(await (await submit(cart.id, randomUUID())).json());
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c04', qty: 1 } });
    const b = Order.parse(await (await submit(cart.id, randomUUID())).json());
    expect(b.id).not.toBe(a.id);
    expect(b.pickupNo).not.toBe(a.pickupNo); // 取餐号连着往下发
    expect(db.prepare('SELECT COUNT(*) FROM orders').pluck().get()).toBe(2);
  });

  it('没带 requestId 时退化成普通下单（老版本客户端也不至于打不开门）', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 1 } });
    expect((await submit(cart.id, null)).status).toBe(201);
  });
});

describe('并发改单：两台设备同时点，后到的收到 409 而不是悄悄覆盖（P0-5）', () => {
  it('版本号对不上 → 409，并且单子保持先到的那次的状态', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 1 } });
    const o = Order.parse(await (await submit(cart.id, randomUUID())).json());
    expect(o.version).toBe(0);

    // 平板先点了「已接单」
    const r1 = await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'cooking', version: o.version }, admin: true });
    expect(r1.status).toBe(200);
    const after1 = Order.parse(await r1.json());
    expect(after1.version).toBe(1);

    // 手机还停在旧版本上点了「已出餐」——必须被拒
    const r2 = await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'done', version: o.version }, admin: true });
    expect(r2.status).toBe(409);

    // 拿最新版本再点就成功
    const r3 = await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'done', version: after1.version }, admin: true });
    expect(r3.status).toBe(200);
    const latest = Order.parse(await r3.json());
    expect(latest.status).toBe('done');
    expect(latest.version).toBe(2);
  });

  it('不带 version 仍然能用（老客户端 / 后台脚本），但版本照样往前走', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 1 } });
    const o = Order.parse(await (await submit(cart.id, randomUUID())).json());
    const r = await req(`/api/admin/orders/${o.id}/status`, { body: { to: 'cooking' }, admin: true });
    expect(r.status).toBe(200);
    expect(Order.parse(await r.json()).version).toBe(1);
  });
});

describe('跨营业日：凌晨的单不能跑到前一天去（P0-2）', () => {
  it('23:50 的单算今天；过了 00:10 的新单算新的一天，旧单留在旧账上', async () => {
    // 吉隆坡 10-18 23:50
    now = new Date('2026-10-18T15:50:00Z');
    const c1 = await newCart();
    await req('/api/cart/update', { body: { cartId: c1.id, dishUid: 'c03', qty: 1 } });
    const o1 = Order.parse(await (await submit(c1.id, randomUUID(), '1')).json());
    expect(o1.businessDate).toBe('2026-10-18');

    // 跨到 10-19 00:10（同一个营业日判定里，凌晨算前一天的店会在这里分叉）
    now = new Date('2026-10-18T16:10:00Z');
    const c2 = await newCart();
    await req('/api/cart/update', { body: { cartId: c2.id, dishUid: 'c04', qty: 1 } });
    const o2 = Order.parse(await (await submit(c2.id, randomUUID(), '2')).json());

    // 两张单各自归属正确，不会因为「都是凌晨」混到一起
    expect(o2.businessDate).toBe('2026-10-19');
    expect(o1.businessDate).not.toBe(o2.businessDate);

    // 取餐号在新的一天重新从 001 开始
    expect(o2.pickupNo).toBe(1);

    // 时间往前跳了一整天，登录会话（12 小时）自然过期了，重新登录再查
    admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);

    // 按日查：各查各的，互不串单
    const day18 = (await (await req('/api/admin/orders?day=2026-10-18', { admin: true })).json()) as { orders: { id: string }[] };
    const day19 = (await (await req('/api/admin/orders?day=2026-10-19', { admin: true })).json()) as { orders: { id: string }[] };
    expect(day18.orders.map((x) => x.id)).toEqual([o1.id]);
    expect(day19.orders.map((x) => x.id)).toEqual([o2.id]);
  });
});

describe('超时重试的语义（P0-1b / P0-6）', () => {
  it('服务器收到两次「同一个 requestId」时，落库只有一张、金额只算一次', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 2 } });
    const rid = randomUUID();
    // 模拟并发：两个请求几乎同时在飞（服务端是同步 SQLite，第二个会被唯一索引接住）
    const [r1, r2] = await Promise.all([submit(cart.id, rid), submit(cart.id, rid)]);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    const a = Order.parse(await r1.json());
    const b = Order.parse(await r2.json());
    expect(a.id).toBe(b.id);
    expect(db.prepare('SELECT COUNT(*) FROM orders').pluck().get()).toBe(1);
    // 金额不能被算两遍
    expect(db.prepare('SELECT SUM(total_sen) FROM orders').pluck().get()).toBe(a.totalSen);
  });
});

/**
 * 订单归属哪台手机（P0 修复）
 *
 * 现场是这样露出来的：客人下完单回头看「我的订单」，永远是「还没有订单」；
 * 取餐页也找不到自己的单，只能靠记着取餐号。
 * 根因：订单的 device_id 写的是购物车 id，而查「我的订单」用的是手机设备号，
 * 购物车每单都换一个，两边永远不可能相等。
 */
describe('订单要挂在「这台手机」名下，取餐页和我的订单才找得回来', () => {
  const DEVICE = 'aaaabbbbccccdddd1111222233334444';

  it('带设备号下单：按设备号查得到，购物车 id 反倒查不到', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'l01', qty: 1 } });
    const o = Order.parse(await (await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '5', paymentMethod: 'cash', deviceId: DEVICE } })).json());

    const mine = (await (await req(`/api/order/mine?device=${DEVICE}`)).json()) as { id: string }[];
    expect(mine.map((x) => x.id)).toEqual([o.id]);

    // 关键断言：不能再靠购物车 id 找单（这正是之前的错法）
    const byCart = (await (await req(`/api/order/mine?device=${cart.id}`)).json()) as unknown[];
    expect(byCart).toHaveLength(0);
  });

  it('同一台手机连下两单，第二单的购物车换了，两单都还在', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const cart = await newCart();
      await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'l01', qty: 1 } });
      const o = Order.parse(await (await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '5', paymentMethod: 'cash', deviceId: DEVICE } })).json());
      ids.push(o.id);
    }
    const mine = (await (await req(`/api/order/mine?device=${DEVICE}`)).json()) as { id: string }[];
    expect(mine.map((x) => x.id).sort()).toEqual(ids.sort());
  });

  it('老版本前端不带设备号：退回用购物车 id，单照样下得成（不能让用户下不了单）', async () => {
    const cart = await newCart();
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'l01', qty: 1 } });
    const res = await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '5', paymentMethod: 'cash' } });
    expect(res.status).toBe(201);
    const byCart = (await (await req(`/api/order/mine?device=${cart.id}`)).json()) as unknown[];
    expect(byCart).toHaveLength(1);
  });

  it('设备号乱写（太长 / 带奇怪字符）：不认，退回购物车 id，不会写脏数据', async () => {
    for (const bad of ['x'.repeat(200), '../../etc/passwd', '', '短']) {
      const cart = await newCart();
      await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'l01', qty: 1 } });
      await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '5', paymentMethod: 'cash', deviceId: bad } });
      const row = db.prepare('SELECT device_id FROM orders WHERE device_id = ?').get(bad);
      expect(row).toBeUndefined();
    }
  });
});
