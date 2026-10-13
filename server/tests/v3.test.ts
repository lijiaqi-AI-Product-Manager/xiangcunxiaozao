import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from './helpers.js';

const s = await makeServer();
async function j(input: string, init?: RequestInit): Promise<any> {
  const res = await fetch(input, init);
  return { status: res.status, body: await res.json() };
}

test('调账：日报可人工修正，月报联动，可删除', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
  const rep0 = await j(`${s.base}/api/reports/daily`, { headers: s.admin });
  const base = rep0.body.final_revenue_cents;
  // 加 RM 5.00
  const add = await j(`${s.base}/api/reports/adjust`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ date: today, amount_cents: 500, reason: '漏记一杯饮料' }),
  });
  assert.equal(add.status, 201);
  const rep1 = await j(`${s.base}/api/reports/daily`, { headers: s.admin });
  assert.equal(rep1.body.final_revenue_cents, base + 500);
  assert.equal(rep1.body.adjustments.length >= 1, true);
  // 负调账 RM 2
  await j(`${s.base}/api/reports/adjust`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ date: today, amount_cents: -200, reason: '多记一份' }),
  });
  const rep2 = await j(`${s.base}/api/reports/daily`, { headers: s.admin });
  assert.equal(rep2.body.final_revenue_cents, base + 300);
  // 删除-200那条（按金额找）
  const neg = rep2.body.adjustments.find((a: { amount_cents: number }) => a.amount_cents === -200);
  const del = await j(`${s.base}/api/reports/adjust/${neg.id}`, { method: 'DELETE', headers: s.admin });
  assert.equal(del.status, 200);
  const rep3 = await j(`${s.base}/api/reports/daily`, { headers: s.admin });
  assert.equal(rep3.body.final_revenue_cents, base + 500);
  // 必须有原因
  const noR = await j(`${s.base}/api/reports/adjust`, {
    method: 'POST', headers: s.admin, body: JSON.stringify({ date: today, amount_cents: 100, reason: '' }),
  });
  assert.equal(noR.status, 400);
  // 月报联动
  const mon = await j(`${s.base}/api/reports/monthly?month=${today.slice(0, 7)}`, { headers: s.admin });
  assert.equal(typeof mon.body.final_revenue_cents, 'number');
});

test('区间流水：四个preset边界正确（固定参考日2026-10-13周二）', async () => {
  const r7 = await j(`${s.base}/api/reports/range?preset=last7&date=2026-10-13`, { headers: s.admin });
  assert.equal(r7.status, 200);
  assert.equal(r7.body.from, '2026-10-07');
  assert.equal(r7.body.to, '2026-10-13');
  assert.ok(Array.isArray(r7.body.list));
  const r30 = await j(`${s.base}/api/reports/range?preset=last30&date=2026-10-13`, { headers: s.admin });
  assert.equal(r30.body.from, '2026-09-14');
  assert.equal(r30.body.to, '2026-10-13');
  const wk = await j(`${s.base}/api/reports/range?preset=this_week&date=2026-10-13`, { headers: s.admin });
  assert.equal(wk.body.from, '2026-10-12'); // 周一
  assert.equal(wk.body.to, '2026-10-18'); // 周日
  const mo = await j(`${s.base}/api/reports/range?preset=this_month&date=2026-10-13`, { headers: s.admin });
  assert.equal(mo.body.from, '2026-10-01');
  assert.equal(mo.body.to, '2026-10-31');
  // CSV导出
  const csv = await fetch(`${s.base}/api/reports/export?scope=range&preset=last7&date=2026-10-13`, { headers: { Authorization: s.admin.Authorization } });
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes('区间流水'));
});

test('顾客会员支付：查卡→下单→在线扣款→幂等', async () => {
  await j(`${s.base}/api/members`, { method: 'POST', headers: s.admin, body: JSON.stringify({ card_no: 'C-TEST', name: '顾客甲' }) });
  await j(`${s.base}/api/members/C-TEST/topup`, { method: 'POST', headers: s.admin, body: JSON.stringify({ amount_cents: 3000 }) });
  // 公开查卡
  const look = await j(`${s.base}/api/members/lookup?card_no=C-TEST`);
  assert.equal(look.status, 200);
  assert.equal(look.body.balance_cents, 3000);
  const look404 = await j(`${s.base}/api/members/lookup?card_no=NOPE-XX`);
  assert.equal(look404.status, 404);
  // 下单（顾客）
  const { body: d } = await s.createDish('顾客支付菜', '12');
  const o = await s.order({ table_no: 'CP1', items: [{ dish_id: d.id, qty: 2 }] });
  const no = String(o.body.order_no);
  // 顾客在线扣款
  const pay = await j(`${s.base}/api/orders/${no}/customer-pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_no: 'C-TEST' }) });
  assert.equal(pay.status, 200);
  assert.equal(pay.body.paid, true);
  assert.equal(pay.body.payment_method, 'member');
  assert.equal(pay.body.member_card_no, 'C-TEST');
  const bal = await j(`${s.base}/api/members/lookup?card_no=C-TEST`);
  assert.equal(bal.body.balance_cents, 600); // 3000-2400
  // 幂等：再扣不重复
  const pay2 = await j(`${s.base}/api/orders/${no}/customer-pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_no: 'C-TEST' }) });
  assert.equal(pay2.status, 200);
  const bal2 = await j(`${s.base}/api/members/lookup?card_no=C-TEST`);
  assert.equal(bal2.body.balance_cents, 600);
  // 余额不足
  const o2 = await s.order({ table_no: 'CP2', items: [{ dish_id: d.id, qty: 50 }] });
  const pay3 = await j(`${s.base}/api/orders/${o2.body.order_no}/customer-pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_no: 'C-TEST' }) });
  assert.equal(pay3.status, 400);
  assert.ok(String(pay3.body.error).includes('不足'));
});

test('收尾清理', async () => {
  await s.close();
});
