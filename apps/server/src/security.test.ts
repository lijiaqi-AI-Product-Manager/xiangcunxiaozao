// 安全与运维：响应头（P3-4）、推送票据（P3-4）、会话滑动续期（P1-6）、过期数据清理（P1-8）
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { sweepCarts } from './auth.ts';
import { openDb, type DB } from './db.ts';

const PASSWORD = 'test-password-123';
let db: DB;
let now: Date;
let created: ReturnType<typeof createApp>;

const req = (path: string, o: { body?: unknown; token?: string; headers?: Record<string, string> } = {}) =>
  created.app.request(path, {
    method: o.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...o.headers,
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });

const login = async () =>
  String(((await (await req('/api/admin/login', { body: { password: PASSWORD } })).json()) as { token: string }).token);

beforeEach(() => {
  db = openDb(':memory:');
  now = new Date('2026-10-17T04:00:00Z');
  created = createApp(db, resolve('brands', process.env.BRAND!), {
    adminPassword: PASSWORD,
    uploadDir: join(tmpdir(), 'xc-sec-uploads'),
    clock: () => now,
  });
});

describe('安全响应头（P3-4）', () => {
  it('页面不许被外站套 iframe，API 不被缓存，也不许浏览器猜类型', async () => {
    const r = await req('/api/health');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    // 图片要允许 data: —— 菜品缩略图是 base64 内联的，禁掉整页图就全没了
    expect(csp).toContain('img-src');
    expect(csp).toContain('data:');
  });
});

describe('推送票据：URL 里不再出现长期令牌（P3-4）', () => {
  it('令牌换票 → 票能连；同一张票第二次用不行（一次性）', async () => {
    const token = await login();
    const r1 = await req('/api/admin/stream/ticket', { token });
    expect(r1.status).toBe(200);
    const { ticket } = (await r1.json()) as { ticket: string; ttlMs: number };
    expect(ticket).toBeTruthy();
    expect(ticket).not.toBe(token); // 票和令牌不是一回事

    const redeem = (t: string) => req(`/api/admin/stream?ticket=${encodeURIComponent(t)}`);
    // 第一次：放行（SSE 会一直挂着，这里只关心不是 401）
    const first = await Promise.race([redeem(ticket), new Promise<null>((r) => setTimeout(() => r(null), 150))]);
    expect(first === null || first.status !== 401).toBe(true);
    // 第二次：票已焚
    const second = await redeem(ticket);
    expect(second.status).toBe(401);
  });

  it('不登录换不到票；拿长期令牌当票直接连也不行', async () => {
    expect((await req('/api/admin/stream/ticket')).status).toBe(401);
    const token = await login();
    const r = await req(`/api/admin/stream?token=${encodeURIComponent(token)}`);
    expect(r.status).toBe(401); // 老的 ?token= 通道已经关掉
  });

  it('票据 30 秒后失效（过期票连不上）', async () => {
    const token = await login();
    const { ticket } = (await (await req('/api/admin/stream/ticket', { token })).json()) as { ticket: string };
    now = new Date(now.getTime() + 31_000);
    const r = await req(`/api/admin/stream?ticket=${encodeURIComponent(ticket)}`);
    expect(r.status).toBe(401);
  });
});

describe('登录会话滑动续期（P1-6）', () => {
  it('一直在用就一直不掉线：11 小时后还在用，再用 11 小时依然有效', async () => {
    const token = await login();
    // 12 小时有效期，走到 11 小时——如果没有续期，再过 1 小时就该失效
    now = new Date(now.getTime() + 11 * 3600_000);
    expect((await req('/api/admin/orders', { token })).status).toBe(200);
    now = new Date(now.getTime() + 11 * 3600_000); // 距登录 22 小时
    expect((await req('/api/admin/orders', { token })).status).toBe(200);
  });

  it('放着不管超过 12 小时，照样要重登（不能续成永久令牌）', async () => {
    const token = await login();
    now = new Date(now.getTime() + 13 * 3600_000);
    expect((await req('/api/admin/orders', { token })).status).toBe(401);
  });

  it('刷新只写库一次：有效期过半才续，不是每个请求都写', async () => {
    const token = await login();
    const hash = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
    const exp = () =>
      (db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(hash) as { expires_at: string }).expires_at;
    const before = exp();
    now = new Date(now.getTime() + 60_000); // 才过 1 分钟，不该写库
    await req('/api/admin/orders', { token });
    expect(exp()).toBe(before);
    now = new Date(now.getTime() + 7 * 3600_000); // 过了 7 小时（> 一半），该续了
    await req('/api/admin/orders', { token });
    expect(exp()).not.toBe(before);
  });
});

describe('过期数据清理（P1-8）', () => {
  it('清掉过期会话、早已解锁的失败计数、过期票据；有效会话一个不动', async () => {
    const token = await login();
    // 造三条垃圾：过期会话、一条早解锁的失败记录、一张过期票
    db.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run('dead', now.toISOString(), new Date(now.getTime() - 3600_000).toISOString());
    db.prepare('INSERT INTO login_attempts (scope, failed, locked_until) VALUES (?, ?, ?)').run('admin:1.2.3.4', 0, new Date(now.getTime() - 3600_000).toISOString());
    db.prepare('INSERT INTO admin_tickets (ticket_hash, expires_at) VALUES (?, ?)').run('oldticket', new Date(now.getTime() - 1000).toISOString());

    const r = created.auth.sweep();
    expect(r.sessions).toBe(1);
    expect(r.attempts).toBe(1);
    expect(r.tickets).toBe(1);
    // 正在用的令牌必须还在
    expect((await req('/api/admin/orders', { token })).status).toBe(200);
  });

  it('购物车只清空车：有菜的购物车一行不动（顾客回来菜还在）', async () => {
    const cart = (await (await req('/api/cart/refresh', { body: {} })).json()) as { id: string };
    await req('/api/cart/update', { body: { cartId: cart.id, dishUid: 'c03', qty: 1 } });
    const empty = (await (await req('/api/cart/refresh', { body: {} })).json()) as { id: string };
    expect(empty.id).not.toBe(cart.id);

    now = new Date(now.getTime() + 25 * 3600_000); // 25 小时后
    // 先把时间戳拨老：carts.updated_at 是默认值，不拨的话不会过期
    db.prepare('UPDATE carts SET updated_at = ?').run(new Date(now.getTime() - 25 * 3600_000).toISOString());
    sweepCarts(db, () => now);

    // 有菜的车还在，空车没了
    const rows = db.prepare('SELECT id FROM carts').all() as { id: string }[];
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(cart.id);
    expect(ids).not.toContain(empty.id);
    // 菜还在那辆车里
    const items = db.prepare('SELECT dish_uid FROM cart_items WHERE cart_id = ?').all(cart.id) as { dish_uid: string }[];
    expect(items.map((i) => i.dish_uid)).toEqual(['c03']);
  });
});

/**
 * 前端报错上报（P3-8）
 *
 * 这里单独立一组用例，是因为这个接口出过一次「自己就是故障源」的事故：
 * 去重查询写成了 ifnull(source, "")，SQLite 把双引号当列名，整句 prepare 直接抛错，
 * 结果每次上报都 500 —— 错误监控自己错了，一条错误也收不到，而且因为前端上报是 fire-and-forget，
 * 现场完全没人发现。这类「监控自己坏了」的洞必须有测试兜住。
 */
describe('前端报错上报（P3-8）', () => {
  const post = (body: unknown) => req('/api/client-error', { body, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' } });
  const rows = () => db.prepare('SELECT app, message, source, lineno, hits FROM client_errors ORDER BY id').all() as { app: string; message: string; source: string | null; lineno: number | null; hits: number }[];

  it('收了就落库，并且返回 200（不能自己 500）', async () => {
    const res = await post({ app: 'customer', message: 'Cannot read properties of undefined', source: '/assets/a.js', lineno: 412, stack: 'TypeError…', url: '/menu' });
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ app: 'customer', message: 'Cannot read properties of undefined', source: '/assets/a.js', lineno: 412, hits: 1 }]);
  });

  it('同一条错误反复发生只加 hits，不刷屏', async () => {
    for (let i = 0; i < 5; i += 1) expect((await post({ app: 'customer', message: '同一个错', source: '/a.js', lineno: 7 })).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.hits).toBe(5);
  });

  it('只给了消息、没给文件和行号：也能存，且重复上报能认出来（NULL 不能靠 = 比较）', async () => {
    for (let i = 0; i < 3; i += 1) expect((await post({ app: 'admin', message: 'Failed to fetch' })).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ app: 'admin', message: 'Failed to fetch', source: null, lineno: null, hits: 3 });
  });

  it('消息不同 / 行号不同都算不同的错误', async () => {
    await post({ app: 'customer', message: 'A', source: '/a.js', lineno: 1 });
    await post({ app: 'customer', message: 'B', source: '/a.js', lineno: 1 });
    await post({ app: 'customer', message: 'A', source: '/a.js', lineno: 2 });
    await post({ app: 'customer', message: 'A', source: '/b.js', lineno: 1 });
    expect(rows()).toHaveLength(4);
  });

  it('空消息、乱传 app：一律当收到，不落库也不报错', async () => {
    for (const body of [{ message: '' }, { message: '   ' }, {}, { app: 'hacker', message: 'x' }]) {
      expect((await post(body)).status).toBe(200);
    }
    const kept = rows();
    expect(kept).toHaveLength(1); // 只有 app:'hacker' 那条，被归成 customer
    expect(kept[0]!.app).toBe('customer');
  });

  it('超长字段被截断，不会把库撑爆', async () => {
    await post({ app: 'customer', message: 'x'.repeat(2000), source: 'y'.repeat(1000), stack: 'z'.repeat(9000) });
    const row = db.prepare('SELECT message, source, stack, ua FROM client_errors').get() as { message: string; source: string; stack: string; ua: string };
    expect(row.message.length).toBe(500);
    expect(row.source.length).toBe(300);
    expect(row.stack.length).toBe(2000);
    expect(row.ua.length).toBeLessThanOrEqual(200);
  });

  it('同一台机器每分钟最多 10 条，多了静默丢弃（不让上报接口变成攻击面）', async () => {
    for (let i = 0; i < 15; i += 1) await post({ app: 'customer', message: `错 ${i}` });
    expect(rows()).toHaveLength(10);
  });

  it('老板端能看列表、能清空；不登录看不了', async () => {
    await post({ app: 'customer', message: '看得到吗' });
    const token = await login();
    const list = (await (await req('/api/admin/client-errors', { token })).json()) as { errors: unknown[]; total: number };
    expect(list.total).toBe(1);
    expect(list.errors).toHaveLength(1);
    expect((await req('/api/admin/client-errors')).status).toBe(401);
    expect((await req('/api/admin/client-errors/clear', { body: {}, token })).status).toBe(200);
    expect(rows()).toHaveLength(0);
  });
});
