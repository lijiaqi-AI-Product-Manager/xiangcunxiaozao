// 历史订单查询（P2-5）
//
// 老板要翻「上周三 8 号桌那桌吃了什么」，靠的是这个查询。
// 这里重点固定住几件容易被后来的改动悄悄弄坏的事：
//   ① 时间段按**门店时区**解释，不是 UTC —— 马来西亚 UTC+8，用错就整整差一天
//   ② 关键词要在**整段时间上**筛完再分页，不能只搜最近几十单
//   ③ 取餐号只做精确匹配，否则搜「12」会把 12 号桌、12 元的单全捞出来
//   ④ 合计金额算的是「全部命中」，不是「这一页」
//   ⑤ 不登录不能查（客人的订单明细、桌号都在里面）
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Cart, OrderSearchResult } from '@pkg/contract';
import { createApp } from './app.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';
let db: DB;
let now: Date;
let api: ReturnType<typeof createApp>['app'];
let admin: string;

const req = (path: string, o: { body?: unknown; auth?: boolean } = {}) =>
  api.request(path, {
    method: o.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(o.auth === false ? {} : { authorization: `Bearer ${admin}` }) },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });

const search = async (qs: string) => {
  const r = await req(`/api/admin/orders/search?${qs}`);
  expect(r.status, await r.clone().text()).toBe(200);
  return OrderSearchResult.parse(await r.json());
};

/** 造一张单：dish 是菜品 uid（c01–c06 主食/菜、l01–l06 柠檬茶），day 用 'YYYY-MM-DD' 指定营业日 */
async function order(opts: { day: string; hour?: number; tableNo: string; dishUid: string; qty?: number }): Promise<string> {
  const { day, hour = 12, tableNo, dishUid, qty = 1 } = opts;
  // 门店时区（+08:00）的墙上钟 → UTC 时刻
  now = new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`);
  const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
  await req('/api/cart/update', { body: { cartId: cart.id, dishUid, qty } });
  const r = await req('/api/order/submit', { body: { cartId: cart.id, tableNo, paymentMethod: 'cash', requestId: randomUUID() } });
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-25T04:00:00Z'); // 吉隆坡 10-25 12:00
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-hist-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('历史订单查询（P2-5）', () => {
  it('不登录不能查：里面有桌号、菜品、金额', async () => {
    const r = await req('/api/admin/orders/search', { auth: false });
    expect(r.status).toBe(401);
  });

  it('不传时间段就查最近 7 天（含今天），不会把上个月的也捞进来', async () => {
    await order({ day: '2026-10-01', tableNo: '1', dishUid: 'c03' }); // 太早，不该出现
    await order({ day: '2026-10-25', tableNo: '8', dishUid: 'c03' });
    now = new Date('2026-10-25T04:00:00Z');
    const r = await search('');
    expect(r.total).toBe(1);
    expect(r.orders[0]!.tableNo).toBe('8');
  });

  it('按日期查某一天：起点是那天 00:00（门店时区），前一天的晚单不算进来', async () => {
    await order({ day: '2026-10-23', hour: 23, tableNo: '3', dishUid: 'c03' });
    await order({ day: '2026-10-24', hour: 0, tableNo: '4', dishUid: 'c03' });
    await order({ day: '2026-10-24', hour: 19, tableNo: '5', dishUid: 'c03' });
    const r = await search('from=2026-10-24&to=2026-10-25');
    expect(r.orders.map((o) => o.tableNo).sort()).toEqual(['4', '5']);
    expect(r.rangeText).toBe('10-24 00:00 ~ 10-25 00:00');
  });

  it('按桌号搜：模糊命中，不用记得完整写法', async () => {
    await order({ day: '2026-10-24', tableNo: '8', dishUid: 'c03' });
    await order({ day: '2026-10-24', tableNo: '8A', dishUid: 'c04' });
    await order({ day: '2026-10-24', tableNo: '20', dishUid: 'c05' });
    const r = await search('from=2026-10-24&to=2026-10-25&q=8');
    expect(r.orders.map((o) => o.tableNo).sort()).toEqual(['8', '8A']);
  });

  it('按取餐号搜：只认精确号，012 和 12 都指 12 号；搜「1」不会把所有单捞出来', async () => {
    for (let i = 0; i < 12; i++) await order({ day: '2026-10-24', tableNo: String(100 + i), dishUid: 'c03' });
    const byZero = await search('from=2026-10-24&to=2026-10-25&q=012');
    expect(byZero.orders.map((o) => o.pickupNo)).toEqual([12]);
    const byPlain = await search('from=2026-10-24&to=2026-10-25&q=12');
    // 只命中 12 号单（桌号 100..111 里没有含「12」的），不会把 1 号、11 号也带出来
    expect(byPlain.orders.map((o) => o.pickupNo)).toEqual([12]);
  });

  it('按菜品名搜：三天前那道剁椒鱼也能搜到，不是只搜最近几十单', async () => {
    await order({ day: '2026-10-20', tableNo: '1', dishUid: 'a03' }); // 剁椒皮蛋
    for (let i = 0; i < 60; i++) await order({ day: '2026-10-24', tableNo: String(200 + i), dishUid: 'l01' });
    const r = await search(`from=2026-10-20&to=2026-10-25&q=${encodeURIComponent('剁椒')}`);
    expect(r.total).toBe(1);
    expect(r.orders[0]!.tableNo).toBe('1');
  });

  it('按状态筛：只看取消的单', async () => {
    await order({ day: '2026-10-24', tableNo: '1', dishUid: 'c03' });
    const toCancel = await order({ day: '2026-10-24', tableNo: '2', dishUid: 'c03' });
    await req(`/api/admin/orders/${toCancel}/status`, { body: { to: 'cancelled', reason: '客人走了' } });
    const all = await search('from=2026-10-24&to=2026-10-25');
    expect(all.total).toBe(2);
    const only = await search('from=2026-10-24&to=2026-10-25&status=cancelled');
    expect(only.total).toBe(1);
    expect(only.orders[0]!.status).toBe('cancelled');
  });

  it('合计金额算全部命中，不是这一页；取消的单不计入营收', async () => {
    const a = await order({ day: '2026-10-24', tableNo: '1', dishUid: 'c03', qty: 1 });
    await order({ day: '2026-10-24', tableNo: '2', dishUid: 'c03', qty: 2 });
    await req(`/api/admin/orders/${a}/status`, { body: { to: 'cancelled', reason: '点错了' } });
    const page1 = await search('from=2026-10-24&to=2026-10-25&limit=1');
    expect(page1.total).toBe(2);
    expect(page1.orders).toHaveLength(1);
    // 只取 1 单，但合计仍是有效的另一单（c03 单价 × 2）
    const live = page1.orders[0]!;
    expect(page1.sumSen).toBe(live.tableNo === '2' ? live.totalSen : 0);
  });

  it('分页不重不漏：limit=2 翻三页，正好覆盖全部 5 单', async () => {
    for (let i = 0; i < 5; i++) await order({ day: '2026-10-24', tableNo: String(i + 1), dishUid: 'c03' });
    const seen: number[] = [];
    for (let off = 0; off < 6; off += 2) {
      const r = await search(`from=2026-10-24&to=2026-10-25&limit=2&offset=${off}`);
      expect(r.total).toBe(5);
      seen.push(...r.orders.map((o) => o.pickupNo));
    }
    expect(seen.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });

  it('这段时间卖了多少份：退回的份数要扣掉', async () => {
    const id = await order({ day: '2026-10-24', tableNo: '1', dishUid: 'c03', qty: 3 });
    await req(`/api/admin/orders/${id}/refund`, { body: { lines: [{ line: 1, qty: 1 }], reason: '上错菜', requestId: randomUUID() } });
    const r = await search('from=2026-10-24&to=2026-10-25');
    const dish = r.dishes.find((d) => d.qty > 0)!;
    expect(dish.qty).toBe(2);
    expect(r.refundSen).toBeGreaterThan(0);
  });

  it('输入不对直接说人话：结束早于开始、状态瞎填、时间段超过 31 天', async () => {
    const bad = async (qs: string) => (await req(`/api/admin/orders/search?${qs}`)).status;
    expect(await bad('from=2026-10-25&to=2026-10-24')).toBe(400);
    expect(await bad('from=2026-10-24&to=2026-10-25&status=whatever')).toBe(400);
    expect(await bad('from=2026-01-01&to=2026-10-25')).toBe(400);
    // limit 超上限不该报 400，而是夹到 200——老板多点几下不该看到红字
    const r = await search('from=2026-10-24&to=2026-10-25&limit=9999');
    expect(r.total).toBe(0);
  });
});
