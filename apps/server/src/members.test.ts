// 会员与储值：办卡 → 充值 → 顾客登录 → 储值下单扣款 → 取消原路退回 → 对账
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Cart, Member, MemberDetail, Order } from '@pkg/contract';
import { createApp } from './app.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';
let db: DB;
let now: Date;
let api: ReturnType<typeof createApp>['app'];
let admin: string;

const req = (path: string, opts: { body?: unknown; admin?: boolean; member?: string } = {}) =>
  api.request(path, {
    method: opts.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.admin ? { authorization: `Bearer ${admin}` } : {}),
      ...(opts.member ? { 'x-member-token': opts.member } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
const msg = async (r: Response) => String(((await r.json()) as { message?: string }).message);

async function newMember(pin = '1234', phone = '0123456789') {
  const r = await req('/api/admin/members', { body: { phone, pin }, admin: true });
  expect(r.status).toBe(201);
  return Member.parse(await r.json());
}
async function recharge(id: string, amountSen: number, requestId = randomUUID()) {
  return req(`/api/admin/members/${id}/recharge`, { body: { amountSen, note: '柜台现金', requestId }, admin: true });
}
async function memberLogin(memberNo: string, pin = '1234') {
  const r = await req('/api/member/login', { body: { memberNo, pin } });
  expect(r.status).toBe(200);
  return String(((await r.json()) as { token: string }).token);
}
async function orderWithStoredValue(token: string | undefined, dishUid = 'e01') {
  const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
  await req('/api/cart/update', { body: { cartId: cart.id, dishUid, qty: 1 } });
  return req('/api/order/submit', { body: { cartId: cart.id, tableNo: '5', paymentMethod: 'stored-value' }, member: token });
}
const balanceOf = async (id: string) => MemberDetail.parse(await (await req(`/api/admin/members/${id}`, { admin: true })).json()).member.balanceSen;

beforeEach(async () => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z');
  api = createApp(db, resolve('brands', process.env.BRAND!), { adminPassword: PASSWORD, uploadDir: join(tmpdir(), 'xc-test-uploads'), clock: () => now }).app;
  admin = String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);
});

describe('办卡与充值（只有老板端）', () => {
  it('会员号从 100001 起自动编号；密码必须 4 位数字；手机号不能重复', async () => {
    expect((await newMember()).memberNo).toBe('100001');
    expect((await newMember('5678', '0199999999')).memberNo).toBe('100002');
    expect((await req('/api/admin/members', { body: { pin: '12a4' }, admin: true })).status).toBe(400);
    expect((await req('/api/admin/members', { body: { phone: '0123456789', pin: '1111' }, admin: true })).status).toBe(409);
  });
  it('没登录老板端不能办卡、不能充值', async () => {
    const m = await newMember();
    expect((await api.request('/api/admin/members', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await api.request(`/api/admin/members/${m.id}/recharge`, { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('充值：手抖点两下（同一个请求编号）只入账一次', async () => {
    const m = await newMember();
    const rid = randomUUID();
    expect((await recharge(m.id, 10000, rid)).status).toBe(200);
    expect((await recharge(m.id, 10000, rid)).status).toBe(200);
    expect(await balanceOf(m.id)).toBe(10000);
  });
  it('充值金额必须大于 0，单笔不超过 RM 10,000', async () => {
    const m = await newMember();
    expect((await recharge(m.id, 0)).status).toBe(400);
    expect((await recharge(m.id, -500)).status).toBe(400);
    expect((await recharge(m.id, 1_000_001)).status).toBe(400);
  });
  it('调整余额必须写原因；扣成负数被拒', async () => {
    const m = await newMember();
    await recharge(m.id, 5000);
    const noReason = await req(`/api/admin/members/${m.id}/adjust`, { body: { amountSen: -1000, note: '', requestId: randomUUID() }, admin: true });
    expect(await msg(noReason)).toBe('调整余额必须写原因');
    const ok = await req(`/api/admin/members/${m.id}/adjust`, { body: { amountSen: -1000, note: '多充冲回', requestId: randomUUID() }, admin: true });
    expect(MemberDetail.parse(await ok.json()).member.balanceSen).toBe(4000);
    const tooMuch = await req(`/api/admin/members/${m.id}/adjust`, { body: { amountSen: -9000, note: '测试', requestId: randomUUID() }, admin: true });
    expect(tooMuch.status).toBe(409);
    expect(await balanceOf(m.id)).toBe(4000);
  });
});

describe('顾客端会员登录（只读）', () => {
  it('登录后看到余额和流水，手机号打码', async () => {
    const m = await newMember();
    await recharge(m.id, 10000);
    const token = await memberLogin(m.memberNo);
    const me = MemberDetail.parse(await (await req('/api/member/me', { member: token })).json());
    expect(me.member.balanceSen).toBe(10000);
    expect(me.member.phone).toBe('012****789');
    expect(me.ledger[0]).toMatchObject({ type: 'recharge', amountSen: 10000, balanceAfterSen: 10000 });
  });
  it('错 5 次锁 15 分钟；老板重设密码立即解锁', async () => {
    const m = await newMember();
    for (let i = 0; i < 4; i++) expect((await req('/api/member/login', { body: { memberNo: m.memberNo, pin: '0000' } })).status).toBe(401);
    expect((await req('/api/member/login', { body: { memberNo: m.memberNo, pin: '0000' } })).status).toBe(423);
    expect((await req('/api/member/login', { body: { memberNo: m.memberNo, pin: '1234' } })).status).toBe(423);
    await req(`/api/admin/members/${m.id}/pin`, { body: { pin: '4321' }, admin: true });
    expect((await req('/api/member/login', { body: { memberNo: m.memberNo, pin: '4321' } })).status).toBe(200);
  });
  it('会员号不存在时，提示与密码错误相同（不让人试出谁是会员）', async () => {
    const r = await req('/api/member/login', { body: { memberNo: '999999', pin: '1234' } });
    expect(await msg(r)).toContain('会员号或密码不对');
  });
  it('顾客端没有任何改余额的接口', async () => {
    const m = await newMember();
    const token = await memberLogin(m.memberNo);
    expect((await req(`/api/admin/members/${m.id}/recharge`, { body: { amountSen: 100, requestId: randomUUID() }, member: token })).status).toBe(401);
  });
});

describe('储值支付', () => {
  it('下单即扣；流水记下订单；余额不够整单不成立', async () => {
    const m = await newMember();
    await recharge(m.id, 6000);
    const token = await memberLogin(m.memberNo);
    const r = await orderWithStoredValue(token); // 跳跳蛙 48
    expect(r.status).toBe(201);
    const order = Order.parse(await r.json());
    expect(await balanceOf(m.id)).toBe(1200);
    const ledger = MemberDetail.parse(await (await req(`/api/admin/members/${m.id}`, { admin: true })).json()).ledger;
    expect(ledger[0]).toMatchObject({ type: 'consume', amountSen: -4800, orderId: order.id, operator: 'member:100001' });
    const poor = await orderWithStoredValue(token);
    expect(poor.status).toBe(409);
    expect(await msg(poor)).toContain('余额不足');
    expect(await balanceOf(m.id)).toBe(1200);
    expect(db.prepare('SELECT COUNT(*) FROM orders').pluck().get()).toBe(1); // 失败的那单没有留下
  });
  it('取消储值订单：自动退回，流水留一笔退款', async () => {
    const m = await newMember();
    await recharge(m.id, 10000);
    const token = await memberLogin(m.memberNo);
    const order = Order.parse(await (await orderWithStoredValue(token)).json());
    expect(await balanceOf(m.id)).toBe(5200);
    await req(`/api/admin/orders/${order.id}/status`, { body: { to: 'cancelled', reason: '菜卖完了' }, admin: true });
    expect(await balanceOf(m.id)).toBe(10000);
    const ledger = MemberDetail.parse(await (await req(`/api/admin/members/${m.id}`, { admin: true })).json()).ledger;
    expect(ledger[0]).toMatchObject({ type: 'refund', amountSen: 4800, orderId: order.id });
    expect(ledger).toHaveLength(3); // 充值、消费、退款——全部保留
  });
  it('现金单取消不动任何会员余额', async () => {
    const m = await newMember();
    await recharge(m.id, 10000);
    const cart = Cart.parse(await (await req('/api/cart/refresh', { body: {} })).json());
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'e01', qty: 1 } });
    const order = Order.parse(await (await req('/api/order/submit', { body: { cartId: cart.id, tableNo: '1', paymentMethod: 'cash' } })).json());
    await req(`/api/admin/orders/${order.id}/status`, { body: { to: 'cancelled', reason: '测试' }, admin: true });
    expect(await balanceOf(m.id)).toBe(10000);
  });
});

describe('对账', () => {
  it('流水合计 = 余额时无异常；有人绕过流水直接改余额会被抓出来', async () => {
    const m = await newMember();
    await recharge(m.id, 10000);
    let run = ((await (await req('/api/admin/reconcile', { body: {}, admin: true })).json()) as { last: { mismatches: unknown[] } }).last;
    expect(run.mismatches).toHaveLength(0);
    db.prepare('UPDATE members SET balance_sen = 99999 WHERE id = ?').run(m.id);
    run = ((await (await req('/api/admin/reconcile', { body: {}, admin: true })).json()) as { last: { mismatches: unknown[] } }).last;
    expect(run.mismatches).toEqual([{ memberNo: '100001', balanceSen: 99999, ledgerSumSen: 10000 }]);
  });

  it('一个会员都没有时不落记录：空对账不能算「对过了」', async () => {
    expect(((await (await req('/api/admin/reconcile', { body: {}, admin: true })).json()) as { last: { checked: number } }).last.checked).toBe(0);
    // 空库跑了一遍，不该留下「已对账」的痕迹，否则老板端会显示「对账正常：0 位会员」
    expect(((await (await req('/api/admin/reconcile', { admin: true })).json()) as { last: unknown }).last).toBeNull();
    // 办了卡之后才有记录的资格
    await newMember();
    await req('/api/admin/reconcile', { body: {}, admin: true });
    expect(((await (await req('/api/admin/reconcile', { admin: true })).json()) as { last: { checked: number } }).last.checked).toBe(1);
  });

  it('上次对账之后新办的卡算「没核对过」，不能说全部一致', async () => {
    await newMember('1234', '0123456789');
    await req('/api/admin/reconcile', { body: {}, admin: true });
    await newMember('1234', '0199999999'); // 对账之后才办的第二张
    const last = ((await (await req('/api/admin/reconcile', { admin: true })).json()) as { last: { checked: number; uncheckedCount: number } }).last;
    expect(last.checked).toBe(1);
    expect(last.uncheckedCount).toBe(1);
  });

  it('手动对账后随即返回 uncheckedCount 0，不会让老板刚点完还看到「有 N 位没核对」', async () => {
    await newMember();
    const last = ((await (await req('/api/admin/reconcile', { body: {}, admin: true })).json()) as { last: { checked: number; uncheckedCount: number } }).last;
    expect(last.checked).toBe(1);
    expect(last.uncheckedCount).toBe(0);
  });
});
