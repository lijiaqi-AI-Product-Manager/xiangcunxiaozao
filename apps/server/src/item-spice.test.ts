// 逐菜辣度 + 菜品级备注（P1-9）
//
// 真实场景：一桌三个人，一个不辣、一个微辣、一个特辣，点同一道剁椒鱼。
// 以前只能整单选一次辣度，再在备注里写「辣度：微辣；其中一份不要辣」——后厨靠眼睛找。
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
const update = (cartId: string, body: Record<string, unknown>) => req('/api/cart/update', { body: { cartId, ...body } });

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z');
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-spice-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('同一道菜，不同辣度算两行（P1-9）', () => {
  it('一桌三个人点同一道菜，微辣和不辣各占一行，互不合并', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '微辣', note: '' });
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '不辣', note: '' });
    const view = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId: cart.id } })).json());
    expect(view.lines).toHaveLength(2);
    expect(view.lines.map((l) => l.spice).sort()).toEqual(['不辣', '微辣'].sort());
    expect(view.count).toBe(2);
    // 两份都要算钱
    expect(view.totalSen).toBe(view.lines.reduce((n, l) => n + (l.priceSen ?? 0) * l.qty, 0));
  });

  it('同菜同辣度同备注连点两下 → 还是同一行，数量 2（不会冒出两行一样的）', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '微辣', note: '' });
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '微辣', note: '' });
    const view = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId: cart.id } })).json());
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]!.qty).toBe(2);
    expect(view.lines[0]!.spice).toBe('微辣');
  });

  it('备注不同也算两行：一份「不要香菜」一份正常', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '', note: '不要香菜' });
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '', note: '' });
    const view = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId: cart.id } })).json());
    expect(view.lines).toHaveLength(2);
    expect(view.lines.map((l) => l.note).sort()).toEqual(['', '不要香菜']);
  });

  it('辣度只认 brand.spiceOptions 那五档：自造词被拒，不让「超微辣」进后厨', async () => {
    const cart = await newCart();
    const bad = await update(cart.id, { dishUid: 'c03', qty: 1, spice: '超微辣', note: '' });
    expect(bad.status).toBe(400);
    expect(String(((await bad.json()) as { message?: string }).message)).toContain('辣度只能选');
  });

  it('点两行的加减按行 id 走：改「微辣」那份的数量，不会动到「不辣」那份', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '微辣', note: '' });
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '不辣', note: '' });
    const v1 = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId: cart.id } })).json());
    const spicy = v1.lines.find((l) => l.spice === '微辣')!;
    const mild = v1.lines.find((l) => l.spice === '不辣')!;

    const v2 = Cart.parse(await (await update(cart.id, { lineId: spicy.id, qty: 3 })).json());
    expect(v2.lines.find((l) => l.id === spicy.id)!.qty).toBe(3);
    expect(v2.lines.find((l) => l.id === mild.id)!.qty).toBe(1);
  });

  it('改一行的辣度改到和另一行撞了 → 自动合并，不留两行一样的', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '微辣', note: '' });
    await update(cart.id, { dishUid: 'c03', qty: 2, spice: '特辣', note: '' });
    const v1 = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId: cart.id } })).json());
    const spicy = v1.lines.find((l) => l.spice === '微辣')!;

    const v2 = Cart.parse(await (await req('/api/cart/line', { body: { cartId: cart.id, lineId: spicy.id, spice: '特辣' } })).json());
    expect(v2.lines).toHaveLength(1);
    expect(v2.lines[0]!.spice).toBe('特辣');
    expect(v2.lines[0]!.qty).toBe(3); // 1 + 2 合起来
  });

  it('删一行只删那一行', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '微辣', note: '' });
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '不辣', note: '' });
    const v1 = Cart.parse(await (await req('/api/cart/refresh', { body: { cartId: cart.id } })).json());
    const gone = v1.lines.find((l) => l.spice === '微辣')!;
    const v2 = Cart.parse(await (await req('/api/cart/remove', { body: { cartId: cart.id, lineId: gone.id } })).json());
    expect(v2.lines).toHaveLength(1);
    expect(v2.lines[0]!.spice).toBe('不辣');
  });
});

describe('辣度和备注要进订单、进后厨小票（P1-9）', () => {
  it('下单后订单明细逐行带着辣度和备注，数量金额不变', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1, spice: '不辣', note: '' });
    await update(cart.id, { dishUid: 'c03', qty: 2, spice: '特辣', note: '多放辣椒' });
    const r = await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '8', paymentMethod: 'cash', requestId: randomUUID() } });
    expect(r.status).toBe(201);
    const o = Order.parse(await r.json());

    expect(o.items).toHaveLength(2);
    const mild = o.items.find((i) => i.spice === '不辣')!;
    const hot = o.items.find((i) => i.spice === '特辣')!;
    expect(mild.qty).toBe(1);
    expect(hot.qty).toBe(2);
    expect(hot.note).toBe('多放辣椒');
    // 金额按份数算，不会因为拆行算错
    expect(o.totalSen).toBe(o.items.reduce((n, i) => n + i.priceSen * i.qty, 0));
  });

  it('老订单（没有辣度字段的数据）读出来是空串，不炸', async () => {
    const cart = await newCart();
    await update(cart.id, { dishUid: 'c03', qty: 1 });
    const o = Order.parse(await (await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '9', paymentMethod: 'cash', requestId: randomUUID() } })).json());
    expect(o.items[0]!.spice).toBe('');
    expect(o.items[0]!.note).toBe('');
  });

  it('备注太长会被截断，不报错（顾客手抖粘一大段也不至于下不了单）', async () => {
    const cart = await newCart();
    const long = '不'.repeat(200);
    const v = Cart.parse(await (await update(cart.id, { dishUid: 'c03', qty: 1, spice: '', note: long })).json());
    expect(v.lines[0]!.note.length).toBeLessThanOrEqual(40);
  });
});
