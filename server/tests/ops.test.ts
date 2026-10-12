import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from './helpers.js';

const s = await makeServer();

async function getJson(input: string, init?: RequestInit): Promise<any> {
  const res = await fetch(input, init);
  return res.json();
}

test('手动建单：优惠+收款方式+总价校验', async () => {
  const { body: d1 } = await s.createDish('招牌菜', '20');
  const { body: d2 } = await s.createDish('小菜', '8.5');
  const res = await fetch(`${s.base}/api/orders/manual`, {
    method: 'POST',
    headers: s.admin,
    body: JSON.stringify({
      table_no: 'M1',
      items: [
        { dish_id: d1.id, qty: 2 },
        { dish_id: d2.id, qty: 1, price_cents: 500 }, // 逐行改价 RM5
      ],
      discount_cents: 300,
      payment_method: 'tng',
      note: '电话单',
    }),
  });
  assert.equal(res.status, 201);
  const o = (await res.json()) as { source: string; total_cents: number; payment_method: string; paid: boolean; status: string; items: { unit_price_cents: number }[] };
  assert.equal(o.source, 'manual');
  assert.equal(o.total_cents, 4000 + 500 - 300); // 4200
  assert.equal(o.payment_method, 'tng');
  assert.equal(o.paid, true);
  assert.equal(o.status, 'pending'); // 仍走后厨确认流
  assert.equal(o.items.length, 2);
  assert.equal(o.items[1].unit_price_cents, 500);
});

test('手动建单：优惠超过金额被拒', async () => {
  const { body: d } = await s.createDish('小额菜', '3');
  const res = await fetch(`${s.base}/api/orders/manual`, {
    method: 'POST',
    headers: s.admin,
    body: JSON.stringify({ table_no: 'M2', items: [{ dish_id: d.id, qty: 1 }], discount_cents: 99999 }),
  });
  assert.equal(res.status, 400);
});

test('编辑订单：改数量+逐行改价+优惠重算', async () => {
  const { body: d } = await s.createDish('编辑测试菜', '15');
  const o = await s.order({ table_no: 'E1', items: [{ dish_id: d.id, qty: 1 }] });
  const no = String(o.body.order_no);

  const res = await fetch(`${s.base}/api/orders/${no}`, {
    method: 'PUT',
    headers: s.admin,
    body: JSON.stringify({
      table_no: 'E9',
      items: [{ dish_id: d.id, qty: 3, price_cents: 1200 }],
      discount_cents: 100,
      note: '改过了',
    }),
  });
  assert.equal(res.status, 200);
  const edited = (await res.json()) as any;
  assert.equal(edited.table_no, 'E9');
  assert.equal(edited.total_cents, 1200 * 3 - 100); // 3500
  assert.equal(edited.discount_cents, 100);
  assert.equal(edited.items[0].qty, 3);
});

test('顾客不能逐行改价（红线）', async () => {
  const { body: d } = await s.createDish('价格红线菜', '10');
  const o = await s.order({ table_no: 'R1', items: [{ dish_id: d.id, qty: 1 }] });
  const res = await fetch(`${s.base}/api/orders/${o.body.order_no}`, {
    method: 'PUT',
    headers: s.admin,
    body: JSON.stringify({ items: [{ dish_id: d.id, qty: 1, price_cents: 1 }] }),
  });
  // admin编辑允许改价——这条是顾客端直接POST订单时的红线，用顾客通道验证：
  const cust = await fetch(`${s.base}/api/orders`, {
    method: 'POST',
    headers: s.jsonHeaders,
    body: JSON.stringify({ table_no: 'R2', items: [{ dish_id: d.id, qty: 1, price_cents: 1 }] }),
  });
  assert.equal(cust.status, 403);
  void res;
});

test('后厨拒绝→老板改单→重提→接单全链路', async () => {
  const { body: d } = await s.createDish('拒绝测试菜', '12');
  const o = await s.order({ table_no: 'J1', items: [{ dish_id: d.id, qty: 1 }] });
  const no = String(o.body.order_no);

  const rj = await fetch(`${s.base}/api/orders/${no}/reject`, {
    method: 'POST',
    headers: s.kitchen,
    body: JSON.stringify({ reason: '没菜了' }),
  });
  assert.equal(rj.status, 200);
  assert.equal(((await rj.json()) as any).status, 'rejected');

  const o2 = await s.order({ table_no: 'J2', items: [{ dish_id: d.id, qty: 1 }] });
  const noReason = await fetch(`${s.base}/api/orders/${o2.body.order_no}/reject`, {
    method: 'POST', headers: s.kitchen, body: JSON.stringify({ reason: '' }),
  });
  assert.equal(noReason.status, 400);

  const edit = await fetch(`${s.base}/api/orders/${no}`, {
    method: 'PUT',
    headers: s.admin,
    body: JSON.stringify({ items: [{ dish_id: d.id, qty: 2 }] }),
  });
  assert.equal(edit.status, 200);
  assert.equal(((await edit.json()) as any).total_cents, 2400);

  const rs = await fetch(`${s.base}/api/orders/${no}/resubmit`, { method: 'POST', headers: s.admin });
  assert.equal(rs.status, 200);
  assert.equal(((await rs.json()) as any).status, 'pending');

  const cf = await fetch(`${s.base}/api/orders/${no}/confirm`, { method: 'POST', headers: s.kitchen });
  assert.equal(((await cf.json()) as any).status, 'confirmed');
});

test('作废：已上桌也能作废（可控删除），出营收口径', async () => {
  const { body: d } = await s.createDish('作废测试菜', '30');
  const o = await s.order({ table_no: 'V1', items: [{ dish_id: d.id, qty: 1 }] });
  const no = String(o.body.order_no);
  await fetch(`${s.base}/api/orders/${no}/confirm`, { method: 'POST', headers: s.kitchen });
  await fetch(`${s.base}/api/orders/${no}/serve`, { method: 'POST', headers: s.kitchen });

  const noReason = await fetch(`${s.base}/api/orders/${no}`, {
    method: 'DELETE', headers: s.admin, body: JSON.stringify({ reason: '' }),
  });
  assert.equal(noReason.status, 400);

  const vd = await fetch(`${s.base}/api/orders/${no}`, {
    method: 'DELETE', headers: s.admin, body: JSON.stringify({ reason: '下错单' }),
  });
  assert.equal(vd.status, 200);
  assert.equal(((await vd.json()) as any).status, 'voided');

  // 作废后不可编辑、不可再作废
  const ed = await fetch(`${s.base}/api/orders/${no}`, {
    method: 'PUT', headers: s.admin, body: JSON.stringify({ table_no: 'X' }),
  });
  assert.equal(ed.status, 409);

  // 日报：作废单不计营收
  const rep = await getJson(`${s.base}/api/reports/daily`, { headers: s.admin });
  const list = await getJson(`${s.base}/api/orders?limit=500`, { headers: s.kitchen });
  const expected = list
    .filter((x: any) => !['cancelled', 'rejected', 'voided'].includes(x.status))
    .reduce((sum: number, x: any) => sum + x.total_cents, 0);
  assert.equal(rep.revenue_cents, expected);
  assert.ok(rep.voided >= 1);
});

test('收款：标记与撤销', async () => {
  const { body: d } = await s.createDish('收款测试菜', '9');
  const o = await s.order({ table_no: 'P1', items: [{ dish_id: d.id, qty: 2 }] });
  const no = String(o.body.order_no);

  const pay = await fetch(`${s.base}/api/orders/${no}/pay`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ method: 'wechat' }),
  });
  const paid = (await pay.json()) as any;
  assert.equal(paid.payment_method, 'wechat');
  assert.equal(paid.paid, true);

  const undo = await fetch(`${s.base}/api/orders/${no}/pay`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ method: '' }),
  });
  const undone = (await undo.json()) as any;
  assert.equal(undone.payment_method, '');
  assert.equal(undone.paid, false);

  const bad = await fetch(`${s.base}/api/orders/${no}/pay`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ method: 'bitcoin' }),
  });
  assert.equal(bad.status, 400);
});

test('审计日志：编辑/作废动作全部留痕', async () => {
  const { body: d } = await s.createDish('审计菜', '7');
  const o = await s.order({ table_no: 'A1', items: [{ dish_id: d.id, qty: 1 }] });
  const no = String(o.body.order_no);
  await fetch(`${s.base}/api/orders/${no}`, {
    method: 'PUT', headers: s.admin, body: JSON.stringify({ table_no: 'A2' }),
  });
  await fetch(`${s.base}/api/orders/${no}`, {
    method: 'DELETE', headers: s.admin, body: JSON.stringify({ reason: '测试作废' }),
  });
  const logs = await getJson(`${s.base}/api/orders/${no}/logs`, { headers: s.admin });
  const actions = logs.map((l: any) => l.action);
  assert.ok(actions.includes('edit'));
  assert.ok(actions.includes('voided'));
});

test('老库迁移：无discount_cents列的库自动重建', async () => {
  // 用旧版建表语句造一个"老库"
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcz-mig-'));
  const file = path.join(dir, 'old.db');
  const raw = new Database(file);
  raw.exec(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL UNIQUE, client_id TEXT UNIQUE,
    table_no TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    total_cents INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '2026-10-12T00:00:00.000Z',
    confirmed_at TEXT, served_at TEXT, cancelled_at TEXT, cancel_reason TEXT NOT NULL DEFAULT '')`);
  raw.prepare(`INSERT INTO orders(order_no, table_no, status, total_cents) VALUES('20261012-0099','T1','served',1234)`).run();
  raw.close();

  // 用 openDb 打开 → 触发迁移
  const { openDb } = await import('../src/db.js');
  const db = openDb(file);
  const row = db.prepare(`SELECT * FROM orders WHERE order_no='20261012-0099'`).get() as any;
  assert.equal(row.total_cents, 1234); // 数据无损
  assert.equal(row.status, 'served');
  assert.equal(row.discount_cents, 0); // 新列有默认值
  // 新状态可写（老CHECK已解除）
  db.prepare(`UPDATE orders SET status='voided' WHERE order_no='20261012-0099'`).run();
  const after = db.prepare(`SELECT status FROM orders WHERE order_no='20261012-0099'`).get() as any;
  assert.equal(after.status, 'voided');
  db.close();
});

test('收尾清理', async () => {
  await s.close();
});
