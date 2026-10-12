import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from './helpers.js';
import { openDb } from '../src/db.js';
import { nextOrderNo } from '../src/utils/orderNo.js';

const s = await makeServer();

async function getJson(input: string, init?: RequestInit): Promise<any> {
  const res = await fetch(input, init);
  return { status: res.status, body: await res.json() };
}

test('会员卡全链路：建卡→充值→下单→扣款（含二次验证）→流水', async () => {
  const { body: d } = await s.createDish('会员测试菜', '10');
  // 建卡
  const created = await getJson(`${s.base}/api/members`, {
    method: 'POST', headers: s.admin,
    body: JSON.stringify({ card_no: 'VIP001', name: '测试会员', note: '老板朋友' }),
  });
  assert.equal(created.status, 201);

  // 充值 RM 25
  const top = await getJson(`${s.base}/api/members/VIP001/topup`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ amount_cents: 2500 }),
  });
  assert.equal(top.status, 200);
  assert.equal(top.body.balance_cents, 2500);

  // 下单 RM 20
  const o = await s.order({ table_no: 'VIP1', items: [{ dish_id: d.id, qty: 2 }] });
  const no = String(o.body.order_no);
  assert.equal(o.body.total_cents, 2000);

  // 会员卡收款（扣款+二次验证在服务端事务内）
  const pay = await getJson(`${s.base}/api/orders/${no}/pay`, {
    method: 'POST', headers: s.admin,
    body: JSON.stringify({ method: 'member', card_no: 'VIP001' }),
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.paid, true);
  assert.equal(pay.body.payment_method, 'member');
  assert.equal(pay.body.member_card_no, 'VIP001');

  // 余额 = 2500 - 2000
  const list = await getJson(`${s.base}/api/members`, { headers: s.admin });
  const vip = list.body.find((m: any) => m.card_no === 'VIP001');
  assert.equal(vip.balance_cents, 500);

  // 幂等：重复收款不再扣款
  const pay2 = await getJson(`${s.base}/api/orders/${no}/pay`, {
    method: 'POST', headers: s.admin,
    body: JSON.stringify({ method: 'member', card_no: 'VIP001' }),
  });
  assert.equal(pay2.status, 200);
  const list2 = await getJson(`${s.base}/api/members`, { headers: s.admin });
  assert.equal(list2.body.find((m: any) => m.card_no === 'VIP001').balance_cents, 500);

  // 余额不足拦截
  const o2 = await s.order({ table_no: 'VIP2', items: [{ dish_id: d.id, qty: 2 }] });
  const poor = await getJson(`${s.base}/api/orders/${o2.body.order_no}/pay`, {
    method: 'POST', headers: s.admin,
    body: JSON.stringify({ method: 'member', card_no: 'VIP001' }),
  });
  assert.equal(poor.status, 400);
  assert.ok(String(poor.body.error).includes('余额不足'));

  // 流水可查
  const logs = await getJson(`${s.base}/api/members/VIP001/logs`, { headers: s.admin });
  const consume = logs.body.find((l: any) => l.action === 'consume');
  assert.ok(consume, '有消费流水');
  assert.equal(consume.balance_after, 500);
});

test('反滥用：蜜罐字段必拒', async () => {
  const { body: d } = await s.createDish('蜜罐菜', '5');
  const r = await getJson(`${s.base}/api/orders`, {
    method: 'POST', headers: s.jsonHeaders,
    body: JSON.stringify({ table_no: 'HP1', items: [{ dish_id: d.id, qty: 1 }], hp: 'bot-fill' }),
  });
  assert.equal(r.status, 400);
});

test('反滥用：同桌30秒冷却', async () => {
  const { body: d } = await s.createDish('冷却菜', '5');
  const r1 = await s.order({ table_no: 'CD1', items: [{ dish_id: d.id, qty: 1 }] });
  assert.equal(r1.status, 201);
  const r2 = await getJson(`${s.base}/api/orders`, {
    method: 'POST', headers: s.jsonHeaders,
    body: JSON.stringify({ table_no: 'CD1', items: [{ dish_id: d.id, qty: 1 }] }),
  });
  assert.equal(r2.status, 429);
  // 换桌不受影响
  const r3 = await s.order({ table_no: 'CD2', items: [{ dish_id: d.id, qty: 1 }] });
  assert.equal(r3.status, 201);
});

test('订单号每日重置：跨日从0001开始', async () => {
  // 直接调用底层（API层无法伪造日期）；用未来日期避开当日真实计数
  const no1 = nextOrderNo(s.db, '2026-12-30T15:00:00.000Z'); // KL 12-30 23:00
  const no2 = nextOrderNo(s.db, '2026-12-31T15:00:00.000Z'); // KL 12-31 23:00
  const no3 = nextOrderNo(s.db, '2026-12-31T10:00:00.000Z'); // KL 12-31 18:00 同日
  assert.equal(no1, '20261230-0001');
  assert.equal(no2, '20261231-0001'); // 换日→归零
  assert.equal(no3, '20261231-0002'); // 同日→递增
});

test('逐菜上桌：勾一道划一道，全勾自动整单完成', async () => {
  const { body: d1 } = await s.createDish('逐菜A', '6');
  const { body: d2 } = await s.createDish('逐菜B', '7');
  const o = await s.order({ table_no: 'IT1', items: [{ dish_id: d1.id, qty: 1 }, { dish_id: d2.id, qty: 2 }] });
  const no = String(o.body.order_no);
  const full = await getJson(`${s.base}/api/orders/${no}`, { headers: s.jsonHeaders });
  assert.equal(full.body.items.length, 2);
  assert.equal(full.body.items[0].served, false);

  // 接单
  await getJson(`${s.base}/api/orders/${no}/confirm`, { method: 'POST', headers: s.kitchen });

  // 勾第一道
  const b1 = await getJson(`${s.base}/api/orders/${no}/items/${full.body.items[0].id}/serve`, {
    method: 'POST', headers: s.kitchen,
  });
  assert.equal(b1.body.status, 'confirmed'); // 还没全上
  assert.equal(b1.body.items[0].served, true);
  assert.equal(b1.body.items[1].served, false);

  // 重复勾同一道（幂等无害）
  const b1b = await getJson(`${s.base}/api/orders/${no}/items/${full.body.items[0].id}/serve`, {
    method: 'POST', headers: s.kitchen,
  });
  assert.equal(b1b.body.items[0].served, true);

  // 勾最后一道 → 整单自动上桌
  const b2 = await getJson(`${s.base}/api/orders/${no}/items/${full.body.items[1].id}/serve`, {
    method: 'POST', headers: s.kitchen,
  });
  assert.equal(b2.body.status, 'served');
});

test('菜品管理：忌口选项+月售覆盖+软删除', async () => {
  const { body: d } = await s.createDish('忌口测试菜', '12');
  // 设置忌口与月售覆盖
  const ed = await getJson(`${s.base}/api/dishes/${d.id}`, {
    method: 'PUT', headers: s.admin,
    body: JSON.stringify({ avoid_options: ['不放葱', '不放香菜', '不放笋', '不放板栗'], monthly_sold_override: 88 }),
  });
  assert.equal(ed.status, 200);
  assert.deepEqual(ed.body.avoid_options, ['不放葱', '不放香菜', '不放笋', '不放板栗']);
  assert.equal(ed.body.monthly_sold, 88); // 覆盖值生效

  // 公开菜单可见忌口与月售
  const pub = await getJson(`${s.base}/api/dishes`);
  const mine = pub.body.find((x: any) => x.id === d.id);
  assert.deepEqual(mine.avoid_options.length, 4);
  assert.equal(mine.monthly_sold, 88);

  // 有订单的菜删除=软删
  await s.order({ table_no: 'DL1', items: [{ dish_id: d.id, qty: 1 }] });
  const del = await getJson(`${s.base}/api/dishes/${d.id}`, { method: 'DELETE', headers: s.admin });
  assert.equal(del.status, 200);
  assert.equal(del.body.soft, true);
  const pub2 = await getJson(`${s.base}/api/dishes`);
  assert.equal(pub2.body.find((x: any) => x.id === d.id), undefined); // 公开菜单不再出现

  // 无订单的菜=物理删
  const { body: d2 } = await s.createDish('秒删菜', '1');
  const del2 = await getJson(`${s.base}/api/dishes/${d2.id}`, { method: 'DELETE', headers: s.admin });
  assert.equal(del2.body.soft, false);
});

test('月报与CSV导出', async () => {
  const now = new Date();
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit' }).format(now);
  const rep = await getJson(`${s.base}/api/reports/monthly?month=${month}`, { headers: s.admin });
  assert.equal(rep.status, 200);
  assert.ok(Array.isArray(rep.body.by_day));
  assert.ok(Array.isArray(rep.body.top_dishes));
  assert.ok(rep.body.top_pairs.length >= 1, '有共现对（逐菜测试单含A+B同单）');

  const csvRes = await fetch(`${s.base}/api/reports/export?scope=monthly&month=${month}`, { headers: { Authorization: s.admin.Authorization } });
  assert.equal(csvRes.status, 200);
  const csv = await csvRes.text();
  assert.ok(csv.includes('组合共现'));
  assert.ok(csv.includes('菜品销量'));
});

test('收尾清理', async () => {
  await s.close();
});
