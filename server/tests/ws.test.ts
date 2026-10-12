import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { makeServer } from './helpers.js';

const s = await makeServer();

/**
 * 正确姿势：message 监听器必须在 new WebSocket 后立刻挂上。
 * 教训（2026-10-12 D2 实测）：服务端 101 响应与 hello 帧常在同一 TCP 段到达，
 * open 与 message 事件连续同步触发，await open 之后再挂监听器会直接丢事件。
 */
function connect(url: string, onOpenReject: (e: Error) => void) {
  const buffer: any[] = [];
  const waiters: Array<(m: any) => void> = [];
  const ws = new WebSocket(url);
  ws.on('message', (d: WebSocket.RawData) => {
    let m: any;
    try {
      m = JSON.parse(String(d));
    } catch {
      return;
    }
    const w = waiters.shift();
    if (w) w(m);
    else buffer.push(m);
  });
  ws.once('error', (e) => onOpenReject(e));
  return {
    ws,
    opened: new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
    }),
    /** 取下一条满足条件的消息（历史缓冲优先） */
    nextMsg(filter?: (m: any) => boolean, timeoutMs = 4000): Promise<any> {
      // 先翻缓冲
      if (filter) {
        const idx = buffer.findIndex((m) => filter(m));
        if (idx >= 0) {
          const [m] = buffer.splice(idx, 1);
          return Promise.resolve(m);
        }
      } else if (buffer.length > 0) {
        return Promise.resolve(buffer.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等消息超时')), timeoutMs);
        const tryMatch = (m: any) => {
          if (!filter || filter(m)) {
            clearTimeout(timer);
            resolve(m);
          } else {
            buffer.push(m);
          }
        };
        waiters.push(tryMatch);
      });
    },
  };
}

/** 连WS（自动吃掉hello） */
async function connectKitchen() {
  const c = connect(`${s.wsBase}?token=${encodeURIComponent('test-kitchen-token-0123456789ab')}`, () => {});
  await c.opened;
  const hello = await c.nextMsg();
  assert.equal(hello.type, 'hello');
  return c;
}

/** 等服务端踢线：返回关闭码 */
function expectKicked(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('等close超时')), 3000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('WS：无令牌连接被拒（close code 4001）', async () => {
  assert.equal(await expectKicked(`${s.wsBase}`), 4001);
});

test('WS：错令牌连接被拒（close code 4001）', async () => {
  assert.equal(await expectKicked(`${s.wsBase}?token=wrong-token-abcdef`), 4001);
});

test('WS+下单+接单全链路：后厨实时收到两条事件', async () => {
  const c = await connectKitchen();

  const { body: d } = await s.createDish('WS测试菜', '12.34');
  const created = await s.order({ table_no: 'W1', items: [{ dish_id: d.id, qty: 3 }], note: '不要葱' });

  const ev1 = await c.nextMsg((m: any) => m.type === 'order:new');
  assert.equal(ev1.order_no, created.body.order_no);
  assert.equal(ev1.status, 'pending');
  assert.equal(ev1.table_no, 'W1');
  assert.equal(ev1.total_rm, 'RM 37.02');
  assert.deepEqual(ev1.items, [{ dish_name: 'WS测试菜', qty: 3 }]);

  const cf = await fetch(`${s.base}/api/orders/${created.body.order_no}/confirm`, {
    method: 'POST',
    headers: s.kitchen,
  });
  assert.equal(cf.status, 200);

  const ev2 = await c.nextMsg((m: any) => m.type === 'order:status');
  assert.equal(ev2.order_no, created.body.order_no);
  assert.equal(ev2.status, 'confirmed');

  c.ws.close();
});

test('WS：老板令牌也能收到事件（role=admin）', async () => {
  const c = connect(`${s.wsBase}?token=${encodeURIComponent('test-admin-token-0123456789ab')}`, () => {});
  await c.opened;
  const hello = await c.nextMsg();
  assert.equal(hello.role, 'admin');

  const { body: d } = await s.createDish('WS老板测试菜', '5');
  await s.order({ table_no: 'W2', items: [{ dish_id: d.id, qty: 1 }] });
  const ev = await c.nextMsg((m: any) => m.type === 'order:new');
  assert.equal(ev.table_no, 'W2');
  c.ws.close();
});

test('WS：重复下单（幂等命中）不产生第二次推送', async () => {
  const c = await connectKitchen();

  const { body: d } = await s.createDish('幂等推送测试菜', '6');
  const first = await s.order({ table_no: 'W3', items: [{ dish_id: d.id, qty: 1 }], client_id: 'dup-ws-1' });
  const ev1 = await c.nextMsg((m: any) => m.type === 'order:new');
  assert.equal(ev1.order_no, first.body.order_no);

  await s.order({ table_no: 'W3', items: [{ dish_id: d.id, qty: 1 }], client_id: 'dup-ws-1' }); // 幂等

  const gotSecond = await Promise.race([
    c.nextMsg((m: any) => m.type === 'order:new', 1500).then(
      () => true,
      () => false
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1800)),
  ]);
  assert.equal(gotSecond, false, '幂等订单不应再次推送');
  c.ws.close();
});

test('收尾清理', async () => {
  await s.close();
});
