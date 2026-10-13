import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from './helpers.js';

const s = await makeServer();
const j = async (u: string, i?: RequestInit): Promise<any> => {
  const r = await fetch(u, i);
  return { status: r.status, body: await r.json() };
};

test('全菜单种子：48道上架/测试菜清场/C03路由', async () => {
  const r = await j(`${s.base}/api/dishes/seed`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ confirm: 'SEED_V1' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 48);
  const list = await j(`${s.base}/api/dishes`);
  const names = list.body.map((d: { name: string }) => d.name);
  assert.equal(names.includes('农家一碗香'), true);
  assert.equal(names.includes('招牌跳跳蛙'), true);
  assert.equal(names.includes('脆皮爆汁烤鱼'), true);
  assert.equal(names.includes('牛排'), false, '测试菜必须被清出场');
  assert.equal(names.includes('上线验证菜勿点'), false);
  const cats = [...new Set(list.body.map((d: { category: string }) => d.category))];
  assert.equal(cats.length, 9);
  // C03 路由键
  const all = await j(`${s.base}/api/dishes/all`, { headers: s.admin });
  const c03 = all.body.find((d: { animation_key: string }) => d.animation_key === 'C03');
  assert.equal(c03.name, '农家一碗香');
  assert.equal(c03.price_cents, 2500);
  // 下单可用性：新菜能进购物车
  const { body: d } = await s.createDish('临时验菜', '1');
  const o = await s.order({ table_no: 'SD1', items: [{ dish_id: d.id, qty: 1 }] });
  assert.equal(o.status, 201);
});

test('收尾', async () => { await s.close(); });
