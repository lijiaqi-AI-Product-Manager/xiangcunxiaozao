import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from './helpers.js';
import { openDb } from '../src/db.js';

const s = await makeServer();

/** fetch + json 合一，测试用 */
async function getJson(input: string, init?: RequestInit): Promise<any> {
  const res = await fetch(input, init);
  return res.json();
}

test('健康检查', async () => {
  const r = await getJson(`${s.base}/healthz`);
  assert.equal(r.ok, true);
});

test('鉴权：无令牌进不了管理接口', async () => {
  const res = await fetch(`${s.base}/api/dishes/all`);
  assert.equal(res.status, 401);
  const res2 = await fetch(`${s.base}/api/orders`);
  assert.equal(res2.status, 401);
});

test('菜单：顾客只见在售，老板见全部', async () => {
  await s.createDish('农家一碗香', '18.5');
  await s.createDish('酸豆角炒肉末', '15');
  const { body: d3 } = await s.createDish('内部试做菜', '9.9');
  const tg = await fetch(`${s.base}/api/dishes/${d3.id}/toggle`, { method: 'POST', headers: s.admin });
  assert.equal(tg.status, 200);

  const pub = await getJson(`${s.base}/api/dishes`);
  assert.equal(pub.length, 2);
  const all = await getJson(`${s.base}/api/dishes/all`, { headers: s.admin });
  assert.equal(all.length, 3);
});

test('下单：金额精确到分，订单号=日期+流水', async () => {
  const { body: d1 } = await s.createDish('测试菜A', '10.10');
  const { body: d2 } = await s.createDish('测试菜B', '10.20');
  const r = await s.order({
    table_no: '5',
    items: [
      { dish_id: d1.id, qty: 2 },
      { dish_id: d2.id, qty: 1 },
    ],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total_cents, 2 * 1010 + 1020);
  assert.equal(r.body.total_rm, 'RM 30.40');
  assert.match(String(r.body.order_no), /^\d{8}-\d{4}$/);
});

test('幂等：同一 client_id 重复提交返回同一单，不重复收单', async () => {
  const { body: d } = await s.createDish('幂等测试菜', '5');
  const cid = 'test-client-xyz';
  const r1 = await s.order({ table_no: '1', items: [{ dish_id: d.id, qty: 1 }], client_id: cid });
  const r2 = await s.order({ table_no: '1', items: [{ dish_id: d.id, qty: 1 }], client_id: cid });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.order_no, r2.body.order_no);
});

test('价格快照：改价后历史订单金额不变，新单用新价', async () => {
  const { body: d } = await s.createDish('快照测试菜', '12');
  const o1 = await s.order({ table_no: '2', items: [{ dish_id: d.id, qty: 3 }] });
  assert.equal(o1.body.total_cents, 3600);

  await fetch(`${s.base}/api/dishes/${d.id}`, {
    method: 'PUT',
    headers: s.admin,
    body: JSON.stringify({ price: '99' }),
  });
  const got = await getJson(`${s.base}/api/orders/${o1.body.order_no}`);
  assert.equal(got.total_cents, 3600); // 历史不变

  const o2 = await s.order({ table_no: '2b', items: [{ dish_id: d.id, qty: 1 }] });
  assert.equal(o2.body.total_cents, 9900); // 新单新价
});

test('状态机：pending→confirmed→served；已接单不能取消', async () => {
  const { body: d } = await s.createDish('状态机测试菜', '8');
  const o = await s.order({ table_no: '3', items: [{ dish_id: d.id, qty: 1 }] });
  const no = String(o.body.order_no);

  const cf = await fetch(`${s.base}/api/orders/${no}/confirm`, { method: 'POST', headers: s.kitchen });
  assert.equal(cf.status, 200);
  assert.equal((await cf.json() as { status: string }).status, 'confirmed');

  const cancel = await fetch(`${s.base}/api/orders/${no}/cancel`, {
    method: 'POST',
    headers: s.admin,
    body: JSON.stringify({ reason: '测试' }),
  });
  assert.equal(cancel.status, 409);

  const sv = await fetch(`${s.base}/api/orders/${no}/serve`, { method: 'POST', headers: s.kitchen });
  assert.equal((await sv.json() as { status: string }).status, 'served');
});

test('下架菜品不能下单', async () => {
  const { body: d } = await s.createDish('将下架菜', '7');
  await fetch(`${s.base}/api/dishes/${d.id}/toggle`, { method: 'POST', headers: s.admin });
  const r = await s.order({ table_no: '4', items: [{ dish_id: d.id, qty: 1 }] });
  assert.equal(r.status, 400);
});

test('并发30单：订单号唯一且连续、金额零误差', async () => {
  const { body: dA } = await s.createDish('并发菜A', '3.05');
  const { body: dB } = await s.createDish('并发菜B', '4.10');
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      s.order({
        table_no: String(100 + i),
        items: [
          { dish_id: dA.id, qty: 2 },
          { dish_id: dB.id, qty: 3 },
        ],
        client_id: `conc-${i}`,
      })
    )
  );
  const nos = results.map((r) => String(r.body.order_no));
  assert.equal(new Set(nos).size, 30); // 无重号
  for (const r of results) {
    assert.equal(r.status, 201);
    assert.equal(r.body.total_cents, 2 * 305 + 3 * 410); // 全部 1840，零误差
  }
  const nums = nos.map((n) => Number(n.split('-')[1])).sort((a, b) => a - b);
  assert.equal(nums[nums.length - 1] - nums[0], 29); // 流水连续无跳号
});

test('日报：收入=非取消订单之和，取消单独计数', async () => {
  const { body: d } = await s.createDish('日报菜', '10');
  await s.order({ table_no: '6', items: [{ dish_id: d.id, qty: 2 }] });
  const o2 = await s.order({ table_no: '6b', items: [{ dish_id: d.id, qty: 1 }] });
  await fetch(`${s.base}/api/orders/${o2.body.order_no}/cancel`, {
    method: 'POST',
    headers: s.admin,
    body: JSON.stringify({ reason: '顾客不要了' }),
  });

  const rep = await getJson(`${s.base}/api/reports/daily`, { headers: s.admin });
  const list = await getJson(`${s.base}/api/orders?limit=500`, { headers: s.kitchen });
  const expected = (list as { status: string; total_cents: number }[])
    .filter((o) => o.status !== 'cancelled')
    .reduce((sum, o) => sum + o.total_cents, 0);
  assert.equal(rep.revenue_cents, expected);
  assert.ok(rep.cancelled >= 1);
});

test('持久性：关库重开（模拟容器重启）数据不丢', async () => {
  const { body: d } = await s.createDish('持久菜', '11');
  const o = await s.order({ table_no: '7', items: [{ dish_id: d.id, qty: 1 }] });

  s.db.close();
  const db2 = openDb(s.dbFile);
  const row = db2.prepare('SELECT * FROM orders WHERE order_no = ?').get(o.body.order_no) as
    | { total_cents: number; id: number }
    | undefined;
  assert.ok(row, '订单还在');
  assert.equal(row.total_cents, 1100);
  const items = db2.prepare('SELECT * FROM order_items WHERE order_id = ?').all(row.id) as unknown[];
  assert.equal(items.length, 1);
  db2.close();
});

test('收尾清理', async () => {
  await s.close();
});
