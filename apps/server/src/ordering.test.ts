// 点单闭环的接口级测试：购物车 → 下单 → 取餐号 → 老板推进状态 → 等待时长 → 再来一单
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

const post = (path: string, body: unknown, token?: string) =>
  api.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

async function newCart() {
  return Cart.parse(await (await post('/api/cart/refresh', {})).json());
}
async function addDish(cartId: string, dishUid: string, qty: number) {
  const r = await post('/api/cart/update', { cartId, dishUid, qty });
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
  return Cart.parse(await r.json());
}
async function submit(cartId: string, extra: Record<string, unknown> = {}) {
  return post('/api/order/submit', { cartId, tableNo: '12', paymentMethod: 'cash', ...extra });
}
async function login() {
  const r = await post('/api/admin/login', { password: PASSWORD });
  expect(r.status).toBe(200);
  return String((await json(r)).token);
}

beforeEach(() => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z'); // 吉隆坡中午 12:00
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-test-uploads'), clock: () => now }).app;
});

describe('购物车以服务器为准', () => {
  it('增减数量、价格由服务器按菜单现算', async () => {
    const cart = await newCart();
    let c = await addDish(cart.id, 'e01', 2);
    c = await addDish(cart.id, 'staple-rice', 3);
    expect(c.count).toBe(5);
    expect(c.totalSen).toBe(4800 * 2 + 200 * 3);
    c = await addDish(cart.id, 'e01', 0);
    expect(c.lines.map((l) => l.dishUid)).toEqual(['staple-rice']);
  });
  it('刷新时整车拉齐（换个请求、同一个车号，内容一致）', async () => {
    const cart = await newCart();
    await addDish(cart.id, 'c03', 1);
    const again = Cart.parse(await (await post('/api/cart/refresh', { cartId: cart.id })).json());
    expect(again.lines).toHaveLength(1);
    expect(again.lines[0]?.name).toBe('农家一碗香');
  });
  it('不能点不存在或不上架的菜（配送费）', async () => {
    const cart = await newCart();
    expect((await post('/api/cart/update', { cartId: cart.id, dishUid: 'delivery-fee-1', qty: 1 })).status).toBe(404);
  });
});

describe('下单：只校验桌号和付款方式', () => {
  it('缺桌号 → 提示填桌号；缺付款方式 → 提示选择', async () => {
    const cart = await newCart();
    await addDish(cart.id, 'e01', 1);
    const noTable = await submit(cart.id, { tableNo: '  ' });
    expect(noTable.status).toBe(400);
    expect((await json(noTable)).message).toBe('请填写桌号');
    const noPay = await submit(cart.id, { paymentMethod: '' });
    expect((await json(noPay)).message).toBe('请选择付款方式');
  });
  it('成功下单：取餐号当天从 001 起递增，购物车清空，金额按快照', async () => {
    const a = await newCart();
    await addDish(a.id, 'e01', 1);
    const first = Order.parse(await (await submit(a.id)).json());
    expect(first.pickupNo).toBe(1);
    expect(first.totalSen).toBe(4800);
    expect(first.status).toBe('pending');
    expect((await newCartView(a.id)).count).toBe(0);
    const b = await newCart();
    await addDish(b.id, 'b02', 1);
    expect(Order.parse(await (await submit(b.id)).json()).pickupNo).toBe(2);
  });
  it('同一菜品连续快速下单 3 次全部成功（08号 Bug#4 验收线：不准有防重复）', async () => {
    const cart = await newCart();
    const nos: number[] = [];
    for (let i = 0; i < 3; i++) {
      await addDish(cart.id, 'c03', 1);
      const r = await submit(cart.id);
      expect(r.status).toBe(201);
      nos.push(Order.parse(await r.json()).pickupNo);
    }
    expect(nos).toEqual([1, 2, 3]);
  });
  it('第二天取餐号重新从 1 开始（按吉隆坡时间）', async () => {
    const cart = await newCart();
    await addDish(cart.id, 'e01', 1);
    await submit(cart.id);
    now = new Date('2026-10-17T16:30:00Z'); // 吉隆坡 10-18 00:30
    await addDish(cart.id, 'e01', 1);
    const o = Order.parse(await (await submit(cart.id)).json());
    expect(o.businessDate).toBe('2026-10-18');
    expect(o.pickupNo).toBe(1);
  });
  it('没登录会员不能选储值支付', async () => {
    const cart = await newCart();
    await addDish(cart.id, 'e01', 1);
    const r = await submit(cart.id, { paymentMethod: 'stored-value' });
    expect(r.status).toBe(401);
    expect(String((await json(r)).message)).toContain('会员');
  });
});

async function newCartView(id: string) {
  return Cart.parse(await (await post('/api/cart/refresh', { cartId: id })).json());
}

describe('老板端', () => {
  it('没登录不能看订单', async () => {
    expect((await api.request('/api/admin/orders')).status).toBe(401);
  });
  it('密码连错 5 次锁定 15 分钟，到时间自动解锁', async () => {
    for (let i = 1; i <= 4; i++) expect((await post('/api/admin/login', { password: 'wrong' })).status).toBe(401);
    expect((await post('/api/admin/login', { password: 'wrong' })).status).toBe(423);
    expect((await post('/api/admin/login', { password: PASSWORD })).status).toBe(423); // 锁定期间正确密码也不行
    now = new Date(now.getTime() + 16 * 60000);
    expect((await post('/api/admin/login', { password: PASSWORD })).status).toBe(200);
  });
  it('状态机：待制作 → 制作中 → 已完成；非法跳转被拒；取消必须填原因', async () => {
    const token = await login();
    const cart = await newCart();
    await addDish(cart.id, 'e01', 1);
    const o = Order.parse(await (await submit(cart.id)).json());
    expect((await post(`/api/admin/orders/${o.id}/status`, { to: 'done' }, token)).status).toBe(409);
    expect((await post(`/api/admin/orders/${o.id}/status`, { to: 'cancelled' }, token)).status).toBe(400);
    expect(Order.parse(await (await post(`/api/admin/orders/${o.id}/status`, { to: 'cooking' }, token)).json()).status).toBe('cooking');
    expect(Order.parse(await (await post(`/api/admin/orders/${o.id}/status`, { to: 'done' }, token)).json()).status).toBe('done');
    expect((await post(`/api/admin/orders/${o.id}/status`, { to: 'cooking' }, token)).status).toBe(409);
  });
  it('数据库也拦非法状态（就算绕过接口）', () => {
    db.prepare(`INSERT INTO orders (id, business_date, pickup_no, device_id, table_no, payment_method, total_sen, status, created_at, updated_at)
                VALUES ('x', '2026-10-17', 99, 'd', '1', 'cash', 0, 'done', 't', 't')`).run();
    expect(() => db.prepare("UPDATE orders SET status = 'pending' WHERE id = 'x'").run()).toThrow(/illegal/);
    expect(() => db.prepare("DELETE FROM orders WHERE id = 'x'").run()).toThrow(/cannot be deleted/);
  });
});

describe('等待时长（24号 #6）', () => {
  it('自动：(排队单数 + 1) × 每单分钟；老板可改均值、可手动覆盖', async () => {
    const token = await login();
    const w0 = await json(await api.request('/api/cart/waitingTime'));
    expect(w0).toMatchObject({ minutes: 8, queue: 0, source: 'auto' });
    const cart = await newCart();
    await addDish(cart.id, 'e01', 1);
    await submit(cart.id);
    expect(await json(await api.request('/api/cart/waitingTime'))).toMatchObject({ minutes: 16, queue: 1 });
    await post('/api/admin/wait', { minutesPerOrder: 10 }, token);
    expect((await json(await api.request('/api/cart/waitingTime'))).minutes).toBe(20);
    await post('/api/admin/wait', { manualMinutes: 30 }, token);
    expect(await json(await api.request('/api/cart/waitingTime'))).toMatchObject({ minutes: 30, source: 'manual' });
    await post('/api/admin/wait', { manualMinutes: null }, token);
    expect((await json(await api.request('/api/cart/waitingTime'))).source).toBe('auto');
  });
});

describe('再来一单', () => {
  it('上一单整单进购物车；别人的订单不能复制', async () => {
    const cart = await newCart();
    await addDish(cart.id, 'e01', 2);
    await addDish(cart.id, 'staple-rice', 2);
    const o = Order.parse(await (await submit(cart.id)).json());
    const r = await json(await post('/api/cart/buyAgain', { cartId: cart.id, orderId: o.id }));
    expect(Cart.parse(r.cart).count).toBe(4);
    const stranger = await newCart();
    expect((await post('/api/cart/buyAgain', { cartId: stranger.id, orderId: o.id })).status).toBe(404);
  });

  /**
   * 回归：顾客点了「再来一单」，弹出来「找不到这张订单」。
   *
   * 真机上的路径是——下单时前端带了 deviceId（手机设备号），订单挂在设备号名下；
   * 而再来一单只传 cartId（购物车编号）。两个编号永远不相等，于是自己的单也 404。
   *
   * 上面那条用例为什么没抓到：它下单时没带 deviceId，服务端退回用 cartId 记 owner，
   * 于是「拿 cartId 比」刚好成立——测试把 bug 一起绕过去了。
   * 这条用例按真前端的传法走：下单带 deviceId，再来一单也只带 deviceId。
   */
  it('下单时带了设备号：同一台手机还能再来一单（不会被当成别人的单）', async () => {
    const device = 'device-abc-12345678';
    const cart = await newCart();
    await addDish(cart.id, 'e01', 1);
    const o = Order.parse(await (await submit(cart.id, { deviceId: device })).json());

    // 购物车被清空后换了车号（换手机重进 / 网络抖动重建车），设备号不变
    const cart2 = await newCart();
    const r = await post('/api/cart/buyAgain', { cartId: cart2.id, orderId: o.id, deviceId: device });
    expect(r.status).toBe(200);
    expect(Cart.parse((await json(r)).cart).count).toBe(1);

    // 别的手机拿同一个订单号来复制，仍然 404
    const other = await post('/api/cart/buyAgain', { cartId: (await newCart()).id, orderId: o.id, deviceId: 'someone-else-99999' });
    expect(other.status).toBe(404);
  });
});
