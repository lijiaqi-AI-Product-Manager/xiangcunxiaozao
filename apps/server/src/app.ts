import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { Brand, Faq, Menu } from '@pkg/contract';
import { AdminAuth, LockoutGuard } from './auth.ts';
import { CartService } from './cart.ts';
import type { DB } from './db.ts';
import { MemberService } from './members.ts';
import { DashboardService } from './dashboard.ts';
import { ImageStore, MAX_IMAGE_BYTES, MenuService, StoreHours, StoreInfoStore } from './menu.ts';
import { OrderService, type OrderEvent } from './orders.ts';
import { HttpError, type Clock } from './support.ts';

export function loadBrandFiles(brandDir: string) {
  const read = (f: string): unknown => JSON.parse(readFileSync(join(brandDir, f), 'utf8'));
  return {
    brand: Brand.parse(read('brand.json')),
    menu: Menu.parse(read('menu.json')),
    faq: Faq.parse(read('faq.json')),
  };
}

export interface AppOptions {
  adminPassword: string;
  uploadDir: string;
  clock?: Clock;
}

const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

type Body = Record<string, unknown>;
const body = async (c: Context): Promise<Body> => {
  const b: unknown = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? (b as Body) : {};
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function clientScope(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createApp(db: DB, brandDir: string, opts: AppOptions) {
  const clock = opts.clock ?? (() => new Date());
  const data = loadBrandFiles(brandDir);
  const menu = new MenuService(db, data.menu, data.brand.timezone, clock);
  const images = new ImageStore(opts.uploadDir);
  const store = new StoreHours(db, data.brand.timezone, clock);
  const storeInfo = new StoreInfoStore(db, data.brand.store);
  const carts = new CartService(db, () => menu.listedMap(), clock);
  const orders = new OrderService(db, carts, data.brand, clock);
  const guard = new LockoutGuard(db, clock);
  const auth = new AdminAuth(db, opts.adminPassword, guard, clock);
  const members = new MemberService(db, guard, clock);
  const dashboard = new DashboardService(db, data.brand, clock);
  const memberToken = (c: Context) => c.req.header('x-member-token') ?? null;
  const currentMember = (c: Context) => {
    const id = members.memberIdFor(memberToken(c));
    return id ? { id, memberNo: members.memberNo(id) } : null;
  };

  const app = new Hono();

  app.get('/api/health', (c) => {
    const ok = db.prepare('SELECT 1').pluck().get() === 1;
    return c.json({ ok, brand: data.brand.id, dishes: data.menu.dishes.length, time: clock().toISOString() });
  });

  // ---------- 顾客端：菜单 ----------
  app.get('/api/brand', (c) => c.json(data.brand));
  app.get('/api/menu', (c) => c.json(menu.customerMenu()));
  app.get('/api/faq', (c) => c.json(data.faq));
  app.get('/api/store/status', (c) => c.json(store.status()));
  // 54号 §2.2：今日招牌（大画态 + 横幅卡同源）——老板端配置，顾客端只读
  app.get('/api/store/today', (c) => c.json(menu.today(true)));
  // 58号：门店信息（地址 / 电话 / 营业时间 / WhatsApp）——老板端编辑，顾客端只读
  app.get('/api/store/info', (c) => c.json(storeInfo.get()));

  // 老板上传的菜品图。文件名带内容指纹，内容变了名字就变，所以可以长期缓存
  app.get('/media/:file', (c) => {
    const file = c.req.param('file');
    const m = file.match(/^[a-z0-9-]+-[0-9a-f]{10}\.(jpg|png|webp)$/);
    if (!m) return c.json({ error: 'not_found', message: '没有这张图' }, 404);
    try {
      const bytes = readFileSync(join(opts.uploadDir, file));
      return c.body(bytes, 200, { 'content-type': MEDIA_TYPES[m[1]!]!, 'cache-control': 'public, max-age=31536000, immutable' });
    } catch {
      return c.json({ error: 'not_found', message: '没有这张图' }, 404);
    }
  });

  // ---------- 顾客端：购物车（23号 §2.1 语义） ----------
  app.post('/api/cart/refresh', async (c) => {
    const b = await body(c);
    return c.json(carts.view(carts.ensure(str(b.cartId))));
  });
  app.post('/api/cart/update', async (c) => {
    const b = await body(c);
    carts.setQty(str(b.cartId), str(b.dishUid), Number(b.qty));
    return c.json(carts.view(str(b.cartId)));
  });
  app.post('/api/cart/clearItem', async (c) => {
    const b = await body(c);
    carts.setQty(str(b.cartId), str(b.dishUid), 0);
    return c.json(carts.view(str(b.cartId)));
  });
  app.post('/api/cart/clear', async (c) => {
    const b = await body(c);
    carts.clear(str(b.cartId));
    return c.json(carts.view(str(b.cartId)));
  });
  app.post('/api/cart/buyAgain', async (c) => {
    const b = await body(c);
    const order = orders.get(str(b.orderId));
    // 订单只认下单的那台手机，别人拿不到你的订单内容
    if (order && (db.prepare('SELECT device_id FROM orders WHERE id = ?').pluck().get(order.id) as string) !== str(b.cartId)) {
      throw new HttpError(404, '找不到这张订单');
    }
    const skipped = carts.addMany(str(b.cartId), order.items);
    return c.json({ cart: carts.view(str(b.cartId)), skipped });
  });
  app.get('/api/cart/waitingTime', (c) => c.json(orders.waitInfo()));

  // ---------- 顾客端：下单与查单 ----------
  app.post('/api/order/submit', async (c) => {
    const b = await body(c);
    // 24号 #10：打烊/暂停时停止接单（不是防御机制，是营业状态）
    const st = store.status();
    if (!st.open) {
      throw new HttpError(409, st.reason === 'paused' ? '本店暂停接单，请稍后再来' : `本店已打烊，营业时间 ${st.openAt}–${st.closeAt}`);
    }
    const order = orders.submit(
      { cartId: str(b.cartId), tableNo: str(b.tableNo), paymentMethod: str(b.paymentMethod), note: str(b.note), useStoredValue: b.useStoredValue === true },
      currentMember(c),
    );
    return c.json(order, 201);
  });

  // ---------- 顾客端：会员（只读，充值和调整只在老板端） ----------
  app.post('/api/member/login', async (c) => {
    const b = await body(c);
    return c.json(members.login(b.memberNo, b.pin));
  });
  app.post('/api/member/logout', (c) => {
    members.logout(memberToken(c));
    return c.json({ ok: true });
  });
  app.get('/api/member/me', (c) => {
    const id = members.memberIdFor(memberToken(c));
    if (!id) throw new HttpError(401, '会员登录已过期，请重新登录');
    return c.json(members.detail(id, true, 50));
  });
  app.get('/api/order/mine', (c) => c.json(orders.listByDevice(c.req.query('device') ?? '')));
  app.get('/api/order/:id', (c) => c.json(orders.get(c.req.param('id'))));

  // ---------- 老板端 ----------
  app.post('/api/admin/login', async (c) => {
    const b = await body(c);
    return c.json({ token: auth.login(b.password, `admin:${clientScope(c)}`) });
  });

  // 以下接口都要先登录（实时推送用的 EventSource 不能带请求头，令牌放在 ?token=）
  app.use('/api/admin/*', async (c, next) => {
    if (c.req.path === '/api/admin/login') return next();
    const header = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!auth.verify(header ?? c.req.query('token'))) throw new HttpError(401, '请先登录老板端');
    return next();
  });
  app.post('/api/admin/logout', (c) => {
    auth.logout(c.req.header('authorization')?.replace(/^Bearer\s+/i, ''));
    return c.json({ ok: true });
  });
  app.get('/api/admin/orders', (c) => c.json({ day: c.req.query('day') ?? orders.today(), orders: orders.listByDay(c.req.query('day') ?? orders.today()) }));
  app.post('/api/admin/orders/:id/status', async (c) => {
    const b = await body(c);
    return c.json(orders.setStatus(c.req.param('id'), str(b.to), str(b.reason), 'admin'));
  });
  // 部分退款（按菜品行）与待柜台退还
  app.post('/api/admin/orders/:id/refund', async (c) => c.json(orders.refund(c.req.param('id'), await body(c), 'admin')));
  app.get('/api/admin/counter-refunds', (c) => c.json(orders.counterRefunds(c.req.query('all') !== '1')));
  app.post('/api/admin/counter-refunds/:id/resolve', async (c) =>
    c.json(orders.resolveCounterRefund(Number(c.req.param('id')), (await body(c)).resolution, 'admin')));
  app.get('/api/admin/wait', (c) => c.json({ ...orders.waitSettings(), current: orders.waitInfo() }));
  app.post('/api/admin/wait', async (c) => {
    const b = await body(c);
    const settings = orders.updateWaitSettings(b);
    return c.json({ ...settings, current: orders.waitInfo() });
  });

  // 菜品管理：上下架、改价、上传图片（每次改动留痕）
  app.get('/api/admin/dishes', (c) => c.json(menu.adminDishes()));
  app.post('/api/admin/dishes/:uid/state', async (c) => c.json(menu.setState(c.req.param('uid'), (await body(c)).state, 'admin')));
  app.post('/api/admin/dishes/:uid/price', async (c) => c.json(menu.setPrice(c.req.param('uid'), (await body(c)).priceSen, 'admin')));
  app.get('/api/admin/dashboard', (c) => c.json(dashboard.get(c.req.query('day'))));
  app.post('/api/admin/dishes/:uid/image/clear', (c) => c.json(menu.clearImage(c.req.param('uid'), 'admin')));
  app.post(
    '/api/admin/dishes/:uid/image',
    // ① 大小上限在读请求体之前就拦住，超大文件不会被整个读进内存
    bodyLimit({ maxSize: MAX_IMAGE_BYTES + 64 * 1024, onError: (c) => c.json({ error: 'business', message: '图片太大，请压缩到 5MB 以内' }, 413) }),
    async (c) => {
      const uid = c.req.param('uid');
      menu.dish(uid); // 菜不存在先报 404，不白存文件
      const form = await c.req.parseBody().catch(() => { throw new HttpError(400, '上传格式不对，请重新选择图片'); });
      const file = form['file'];
      if (!(file instanceof File)) throw new HttpError(400, '没有收到图片文件');
      const path = images.save(uid, new Uint8Array(await file.arrayBuffer()));
      return c.json(menu.setImage(uid, path, 'admin'));
    },
  );

  // 营业状态：暂停/恢复接单、营业时间
  app.post('/api/admin/store', async (c) => c.json(store.update(await body(c))));
  app.get('/api/admin/store-info', (c) => c.json(storeInfo.get()));
  app.post('/api/admin/store-info', async (c) => c.json(storeInfo.set(await body(c))));
  // 今日招牌：挑哪几道菜上点单页顶部大画（按顺序左右滑）
  app.get('/api/admin/today', (c) => c.json(menu.today(false)));
  app.post('/api/admin/today', async (c) => c.json(menu.setToday(await body(c))));

  // 会员管理：办卡、查询、充值、调整、重设密码、对账（只有老板端能做）
  app.get('/api/admin/members', (c) => c.json(members.search(c.req.query('q') ?? '')));
  app.post('/api/admin/members', async (c) => c.json(members.create(await body(c)), 201));
  app.get('/api/admin/members/:id', (c) => c.json(members.detail(c.req.param('id'), false)));
  app.post('/api/admin/members/:id/recharge', async (c) => c.json(members.recharge(c.req.param('id'), await body(c), 'admin')));
  app.post('/api/admin/members/:id/adjust', async (c) => c.json(members.adjust(c.req.param('id'), await body(c), 'admin')));
  app.post('/api/admin/members/:id/pin', async (c) => c.json(members.resetPin(c.req.param('id'), (await body(c)).pin)));
  app.get('/api/admin/reconcile', (c) => c.json({ last: members.lastReconcile() }));
  app.post('/api/admin/reconcile', (c) => c.json({ last: members.reconcile() }));

  // 新单实时推送（Server-Sent Events）：服务器主动「喊」老板端
  app.get('/api/admin/stream', (c) =>
    streamSSE(c, async (stream) => {
      const queue: OrderEvent[] = [];
      let wake: (() => void) | null = null;
      const off = orders.events.on((e) => { queue.push(e); wake?.(); });
      stream.onAbort(() => { off(); wake?.(); });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ day: orders.today() }) });
      while (!stream.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e.order) });
        }
        // 每 25 秒发一次心跳，防止中间的网络设备把空闲连接掐掉
        await new Promise<void>((r) => { wake = r; setTimeout(r, 25000); });
        wake = null;
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
      off();
    }),
  );

  app.notFound((c) => c.json({ error: 'not_found', message: '没有这个接口' }, 404));
  // 业务错误返回对应状态码和中文说明；未预料的错误统一 500，前端显示错误卡片，绝不白屏
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: 'business', message: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'internal', message: '服务器出了点问题，请稍后再试' }, 500);
  });

  return { app, orders, carts, members, menu, store };
}
