import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { Brand, Faq, Menu, ORDER_SEARCH_MAX_LIMIT, OrderSearchQuery } from '@pkg/contract';
import { AdminAuth, LockoutGuard } from './auth.ts';
import { CartService } from './cart.ts';
import type { DB } from './db.ts';
import { MemberService } from './members.ts';
import { DashboardService } from './dashboard.ts';
import { ReportService } from './report.ts';
import { ImageStore, MAX_IMAGE_BYTES, MenuService, StoreHours, StoreInfoStore } from './menu.ts';
import { OrderService, type OrderEvent } from './orders.ts';
import { csvFileName, ordersToCsv } from './csv-export.ts';
import { HttpError, type Clock } from './support.ts';
import { buildDispatcher, payLabelOf, readPrintEnv, toPrintOrder, type PrintDispatcher } from './print/index.ts';
import { PrintLog } from './print/log.ts';

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
  /** 打印调度器；不传则按环境变量建，全未配置时等于不打纸 */
  printer?: PrintDispatcher;
}

const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

type Body = Record<string, unknown>;
const body = async (c: Context): Promise<Body> => {
  const b: unknown = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? (b as Body) : {};
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * 当前操作人（谁在动这笔钱/这张单）。
 *
 * 以前所有老板端操作都硬编码记成 'admin'，两个店员共用一个密码时，出了问题查不出是谁退的款。
 * 现在老板可以在登录后选一个名字（存在浏览器里，随请求头带上来），记进 order_events 和储值流水。
 * 这不是账号体系，只是「把名字签上」——真正的多账号权限是另一件事。
 */
function operatorOf(c: Context): string {
  const raw = c.req.header('x-operator');
  if (!raw) return 'admin';
  // 只留名字：去掉控制字符，限长，避免有人往日志里塞奇怪的东西
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return name || 'admin';
}

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
  // 辣度选项来自 brand.json 的 spiceOptions：购物车只认这几档，别让「超微辣」这种自造词进后厨
  const carts = new CartService(db, () => menu.listedMap(), clock, () => data.brand.spiceOptions);
  const orders = new OrderService(db, carts, data.brand, clock);
  const guard = new LockoutGuard(db, clock);
  const auth = new AdminAuth(db, opts.adminPassword, guard, clock);
  const members = new MemberService(db, guard, clock);
  const dashboard = new DashboardService(db, data.brand, clock);
  const report = new ReportService(db, data.brand, clock);
  const memberToken = (c: Context) => c.req.header('x-member-token') ?? null;
  const currentMember = (c: Context) => {
    const id = members.memberIdFor(memberToken(c));
    return id ? { id, memberNo: members.memberNo(id) } : null;
  };

  // ---- 打印：挂在订单创建事件上，异步出纸，绝不拖慢下单 ----
  const printLog = new PrintLog(db);
  const printer = opts.printer ?? buildDispatcher(readPrintEnv(), printLog.record);
  const shopForPrint = {
    name: data.brand.name,
    address: null as string | null,
    phone: null as string | null,
    footer: null as string | null,
  };

  /** 哪些菜算饮品：按 brand.json 的 drinkCategories。只有饮品才出杯贴 */
  const drinkUids = (): Set<string> => {
    const cats = new Set<string>(data.brand.drinkCategories ?? []);
    const out = new Set<string>();
    for (const d of menu.listedMap().values()) if (cats.has(d.categoryKey)) out.add(d.uid);
    return out;
  };

  /** 订单 DTO → 两张纸。打印失败只记日志，不影响下单结果。 */
  const buildPrintOrder = (o: ReturnType<OrderService['get']>) => {
    const info = storeInfo.get();
    // 以前这里有个 perItemNote()：整单备注要摊到每一行，还得把「辣度：」那一段剔掉，
    // 免得杯贴上印出整桌的辣度。现在辣度和备注就挂在行上（P1-9），这个补丁可以整个删掉。
    return toPrintOrder(
      {
        pickupNo: o.pickupNo,
        addSeq: o.addSeq,
        tableNo: o.tableNo,
        status: o.status,
        totalSen: o.totalSen,
        note: o.note,
        createdAt: o.createdAt,
        paymentMethod: o.paymentMethod,
        items: o.items.map((i) => ({
          dishUid: i.dishUid,
          code: i.code,
          name: i.name,
          priceSen: i.priceSen,
          qty: i.qty,
          note: i.note || null,
          spice: i.spice || null,
        })),
      },
      {
        timezone: data.brand.timezone,
        businessDate: o.businessDate,
        payLabel: payLabelOf(data.brand.paymentMethods, o.paymentMethod),
        shop: { address: info.address, phone: info.phone, hours: info.hours },
        drinkUids: drinkUids(),
      }
    );
  };

  const firePrint = (o: ReturnType<OrderService['get']>): void => {
    try {
      printer.printOrder(buildPrintOrder(o), shopForPrint);
    } catch (e) {
      console.error(JSON.stringify({ msg: '打印排版失败', err: String(e) }));
    }
  };

  orders.events.on((e) => {
    if (e.type === 'order.created') firePrint(e.order);
  });
  const app = new Hono();

  /**
   * 安全响应头（P3-4）。手机扫码点单、局域网访问，攻击面不大，但有一点很实际：
   * 老板会用同一个浏览器同时开着菜单页和别的网站，一旦有页面想把这个后台套进 iframe
   * 骗他点「取消订单」，没有 X-Frame-Options 就拦不住。
   * 这套头一次性加上，成本为零，出事时能顶一下。
   */
  app.use('*', async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set('X-Frame-Options', 'SAMEORIGIN'); // 不许别的站点嵌我们的页面
    h.set('X-Content-Type-Options', 'nosniff'); // 别猜类型（防止把上传的图片当脚本跑）
    h.set('Referrer-Policy', 'same-origin'); // 别把带 token 的地址漏给外站
    h.set('X-XSS-Protection', '0'); // 老浏览器那套有漏洞的过滤器关掉，靠 CSP 说话
    // 只允许自己站点、内联样式（Vite 会把关键 CSS 内联）、data: 图片（菜品图是 base64 缩略图）
    h.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    // 本地打印接口和顾客端都在店里内网跑，没必要让浏览器缓存 API 结果
    if (c.req.path.startsWith('/api/')) h.set('Cache-Control', 'no-store');
  });

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
    const m = file.match(/^[a-z0-9-]+-[0-9a-f]{10}(-thumb)?\.(jpg|png|webp)$/);
    if (!m) return c.json({ error: 'not_found', message: '没有这张图' }, 404);
    try {
      const bytes = readFileSync(join(opts.uploadDir, file));
      return c.body(bytes, 200, { 'content-type': MEDIA_TYPES[m[2]!]!, 'cache-control': 'public, max-age=31536000, immutable' });
    } catch {
      return c.json({ error: 'not_found', message: '没有这张图' }, 404);
    }
  });

  // ---------- 顾客端：购物车（23号 §2.1 语义） ----------
  app.post('/api/cart/refresh', async (c) => {
    const b = await body(c);
    return c.json(carts.view(carts.ensure(str(b.cartId))));
  });
  /**
   * 改购物车（P1-9）。三种用法：
   *   带 lineId  → 改这一行的数量（0 = 删掉）
   *   带 spice/note + dishUid → 加菜（同菜同辣度同备注合并成一行）
   *   只带 dishUid + qty → 老调用，按菜改数量（同菜多行时动数量最多的那行）
   */
  app.post('/api/cart/update', async (c) => {
    const b = await body(c);
    const cartId = str(b.cartId);
    if (typeof b.lineId === 'string' && b.lineId) {
      carts.setQty(cartId, b.lineId, Number(b.qty));
    } else if (b.spice !== undefined || b.note !== undefined) {
      carts.add(cartId, { dishUid: str(b.dishUid), qty: Number(b.qty) || 1, spice: b.spice == null ? '' : str(b.spice), note: b.note == null ? '' : str(b.note) });
    } else {
      carts.setQtyByDish(cartId, str(b.dishUid), Number(b.qty));
    }
    return c.json(carts.view(cartId));
  });
  /** 改某一行的辣度/备注（顾客在购物车里直接改，不用删了重加） */
  app.post('/api/cart/line', async (c) => {
    const b = await body(c);
    carts.setLine(str(b.cartId), str(b.lineId), {
      spice: b.spice === undefined ? undefined : b.spice == null ? '' : str(b.spice),
      note: b.note === undefined ? undefined : b.note == null ? '' : str(b.note),
    });
    return c.json(carts.view(str(b.cartId)));
  });
  /** 删一行 */
  app.post('/api/cart/remove', async (c) => {
    const b = await body(c);
    carts.removeLine(str(b.cartId), str(b.lineId));
    return c.json(carts.view(str(b.cartId)));
  });
  app.post('/api/cart/clearItem', async (c) => {
    const b = await body(c);
    carts.setQtyByDish(str(b.cartId), str(b.dishUid), 0);
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
    /**
     * 订单只认下单的那台手机，别人拿不到你的订单内容。
     *
     * 这里以前比的是 **cartId**，这是错的：orders.device_id 存的是手机设备号
     * （前端 localStorage 里的 device-id），而 cartId 是购物车编号——下单后购物车会被清空，
     * 车号也可能换掉，两者本来就不是一个东西。
     * 结果就是老板端一切正常、顾客点「再来一单」永远弹「找不到这张订单」。
     *
     * 现在两边都认：传 deviceId 就比设备号；没传（老版本前端 / 直接调接口）才退回比 cartId，
     * 和下单接口 orders.submit 的兜底规则保持一致。
     */
    if (order) {
      const owner = db.prepare('SELECT device_id FROM orders WHERE id = ?').pluck().get(order.id) as string;
      const claimed = typeof b.deviceId === 'string' && /^[\w-]{8,64}$/.test(b.deviceId) ? b.deviceId : str(b.cartId);
      if (owner !== claimed) throw new HttpError(404, '找不到这张订单');
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
      { cartId: str(b.cartId), tableNo: str(b.tableNo), paymentMethod: str(b.paymentMethod), note: str(b.note), useStoredValue: b.useStoredValue === true, requestId: b.requestId == null ? null : str(b.requestId), deviceId: b.deviceId == null ? null : str(b.deviceId) },
      currentMember(c),
    );
    // 重复提交（同一个 requestId）返回的仍是第一张单；用 200 区分「新建 201 / 重放 200」，
    // 顾客端不关心差别（拿到单号就行），但日志和排查时一眼能看出哪些是网络重试
    const { replay, ...dto } = order;
    return c.json(dto, replay ? 200 : 201);
  });

  /**
   * 加菜（P2-6）：往今天这张还没做完的单后面再挂一张子单。
   *
   * 顾客只提供取餐号（他手上只有这个），桌号、付款方式都沿用父单——
   * 一桌一单的账，桌号和付款方式不该出现两种说法。
   */
  app.post('/api/order/add', async (c) => {
    const b = await body(c);
    const st = store.status();
    if (!st.open) {
      throw new HttpError(409, st.reason === 'paused' ? '本店暂停接单，请稍后再来' : `本店已打烊，营业时间 ${st.openAt}–${st.closeAt}`);
    }
    const pickupNo = Number(b.pickupNo);
    if (!Number.isInteger(pickupNo) || pickupNo <= 0) throw new HttpError(400, '请填写要加菜的取餐号');
    const order = orders.addDishes(
      { pickupNo, cartId: str(b.cartId), note: str(b.note), requestId: b.requestId == null ? null : str(b.requestId), deviceId: b.deviceId == null ? null : str(b.deviceId) },
      currentMember(c),
    );
    const { replay, ...dto } = order;
    return c.json(dto, replay ? 200 : 201);
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

  // 以下接口都要先登录。
  //
  // 两种凭证：
  // ① Authorization 头里的令牌（普通接口）——不会出现在日志里，最安全；
  // ② 推送专用的一次性 ticket（只有 /api/admin/stream）——EventSource 带不了请求头，
  //    所以先用令牌换一张 30 秒、用一次就焚的票。以前是直接把令牌塞进 ?token=，
  //    老板随手截个图、反代日志留一行，令牌就漏了（P3-4）。
  app.get('/api/admin/stream/ticket', (c) =>
    c.json({ ticket: auth.issueTicket(c.req.header('authorization')?.replace(/^Bearer\s+/i, '')), ttlMs: 30_000 }));

  app.use('/api/admin/*', async (c, next) => {
    if (c.req.path === '/api/admin/login') return next();
    if (c.req.path === '/api/admin/stream') {
      // 推送只认 ticket，不再接受 ?token=
      if (!auth.redeemTicket(c.req.query('ticket'))) throw new HttpError(401, '推送票据无效或已过期，请刷新页面');
      return next();
    }
    const header = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!auth.verifyAndRefresh(header)) throw new HttpError(401, '请先登录老板端');
    return next();
  });
  app.post('/api/admin/logout', (c) => {
    auth.logout(c.req.header('authorization')?.replace(/^Bearer\s+/i, ''));
    return c.json({ ok: true });
  });
  app.get('/api/admin/orders', (c) => c.json({ day: c.req.query('day') ?? orders.today(), orders: orders.listByDay(c.req.query('day') ?? orders.today()) }));
  /**
   * 历史订单查询（P2-5）：跨天、按桌号/取餐号/菜品名搜、按状态筛、分页。
   *
   * 时间段和日结单用同一套解释（ReportService.rangeParser），不传就默认最近 7 天。
   * 参数非法（比如 to 早于 from）一律 400 并给中文提示，不让老板对着空白页猜。
   */
  app.get('/api/admin/orders/search', (c) => {
    const d = report.searchRange();
    const num = (v: string | undefined, dflt: number) => {
      const n = Number(v);
      return v === undefined || v === '' || !Number.isFinite(n) ? dflt : Math.floor(n);
    };
    // limit/offset 用夹取而不是报错：老板改地址栏、或者前端算出了个越界值，
    // 该看到的是「少一点结果」，不是一页红字。夹取后仍交给 zod 把关类型。
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
    const parsed = OrderSearchQuery.safeParse({
      from: c.req.query('from') || d.from,
      to: c.req.query('to') || d.to,
      q: c.req.query('q') ?? '',
      status: c.req.query('status') || 'all',
      limit: clamp(num(c.req.query('limit'), 50), 1, ORDER_SEARCH_MAX_LIMIT),
      offset: clamp(num(c.req.query('offset'), 0), 0, 1_000_000),
    });
    if (!parsed.success) throw new HttpError(400, '查询条件不对，请检查日期和状态');
    return c.json(orders.search(parsed.data, report.rangeParser()));
  });
  /**
   * 导出 CSV（老板要拿去做账 / 发给会计）。
   *
   * 和搜索接口用同一套筛选条件，但**不分页**——导一个月账就是要几千单。
   * 文件名放在 Content-Disposition 里，浏览器直接当下载处理；老板端用一个隐藏的
   * <a download> 触发，不走 fetch，省得在浏览器里再拼一遍 Blob。
   */
  app.get('/api/admin/orders/export.csv', async (c) => {
    const d = report.searchRange();
    const parsed = OrderSearchQuery.safeParse({
      from: c.req.query('from') || d.from,
      to: c.req.query('to') || d.to,
      q: c.req.query('q') ?? '',
      status: c.req.query('status') || 'all',
      limit: 50,
      offset: 0,
    });
    if (!parsed.success) throw new HttpError(400, '导出条件不对，请检查日期和状态');
    const { orders: list, total, truncated } = orders.exportAll(parsed.data, report.rangeParser());
    const csv = ordersToCsv(list, data.brand.timezone, (k) => payLabelOf(data.brand.paymentMethods, k) ?? k);
    const name = csvFileName('订单', parsed.data.from.slice(0, 10), parsed.data.to.slice(0, 10));
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        // filename* 按 RFC 5987 编码，中文文件名才不会在下载时变成乱码
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        // 前端拿这两个头告诉老板「导了多少单 / 是不是被截断了」
        'x-export-count': String(list.length),
        'x-export-total': String(total),
        'x-export-truncated': truncated ? '1' : '0',
        'access-control-expose-headers': 'x-export-count, x-export-total, x-export-truncated',
      },
    });
  });
  app.post('/api/admin/orders/:id/status', async (c) => {
    const b = await body(c);
    // version 由前端带回来：两台设备同时改单时，版本对不上的那台会收到 409 而不是悄悄覆盖
    const v = typeof b.version === 'number' && Number.isInteger(b.version) ? b.version : null;
    return c.json(orders.setStatus(c.req.param('id'), str(b.to), str(b.reason), operatorOf(c), v));
  });
  // 部分退款（按菜品行）与待柜台退还
  app.post('/api/admin/orders/:id/refund', async (c) => c.json(orders.refund(c.req.param('id'), await body(c), operatorOf(c))));
  app.get('/api/admin/counter-refunds', (c) => c.json(orders.counterRefunds(c.req.query('all') !== '1')));
  app.post('/api/admin/counter-refunds/:id/resolve', async (c) =>
    c.json(orders.resolveCounterRefund(Number(c.req.param('id')), (await body(c)).resolution, operatorOf(c))));
  app.get('/api/admin/wait', (c) => c.json({ ...orders.waitSettings(), current: orders.waitInfo() }));
  app.post('/api/admin/wait', async (c) => {
    const b = await body(c);
    const settings = orders.updateWaitSettings(b);
    return c.json({ ...settings, current: orders.waitInfo() });
  });

  // 菜品管理：上下架、改价、上传图片（每次改动留痕）
  app.get('/api/admin/dishes', (c) => c.json(menu.adminDishes()));
  app.post('/api/admin/dishes/:uid/state', async (c) => c.json(menu.setState(c.req.param('uid'), (await body(c)).state, operatorOf(c))));
  app.post('/api/admin/dishes/:uid/price', async (c) => c.json(menu.setPrice(c.req.param('uid'), (await body(c)).priceSen, operatorOf(c))));
  // 批量改状态：一整类菜一次收拾干净（104 道菜逐道点三次是什么体验，老板已经抱怨过了）
  app.post('/api/admin/dishes/bulk-state', async (c) => {
    const b = await body(c);
    return c.json(menu.setStateMany(b.uids, b.state, operatorOf(c)));
  });
  app.get('/api/admin/dashboard', (c) => c.json(dashboard.get(c.req.query('day'))));
  // 日结单 / 交接班报表：不传时间就默认「今天整天」，老板点一下就能出一张纸
  app.get('/api/admin/report', (c) => {
    const t = report.todayRange();
    const from = c.req.query('from') || t.from;
    const to = c.req.query('to') || t.to;
    return c.json(report.build(from, to));
  });
  app.post('/api/admin/dishes/:uid/image/clear', (c) => c.json(menu.clearImage(c.req.param('uid'), operatorOf(c))));
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
      // 小格子用的小图（可选）：前端压好一起传上来。压不出来 / 没传都不影响，读的时候退回用大图。
      // 小图坏了不能连累主图——主图已经存好，这里失败就当作没传小图。
      let thumbPath: string | null = null;
      const thumb = form['thumb'];
      if (thumb instanceof File && thumb.size > 0) {
        try {
          thumbPath = images.saveThumb(uid, new Uint8Array(await thumb.arrayBuffer()));
        } catch {
          thumbPath = null;
        }
      }
      return c.json(menu.setImage(uid, path, operatorOf(c), thumbPath));
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
  app.post('/api/admin/members/:id/recharge', async (c) => c.json(members.recharge(c.req.param('id'), await body(c), operatorOf(c))));
  app.post('/api/admin/members/:id/adjust', async (c) => c.json(members.adjust(c.req.param('id'), await body(c), operatorOf(c))));
  app.post('/api/admin/members/:id/pin', async (c) => c.json(members.resetPin(c.req.param('id'), (await body(c)).pin)));
  /** 老板端「错误日志」页（P3-8）：最近的前端报错，按最后发生时间倒序 */
  app.get('/api/admin/client-errors', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
    const rows = db.prepare('SELECT app, message, source, lineno, stack, ua, url, hits, first_at, last_at FROM client_errors ORDER BY last_at DESC LIMIT ?').all(limit);
    return c.json({ errors: rows, total: db.prepare('SELECT COUNT(*) FROM client_errors').pluck().get() });
  });
  app.post('/api/admin/client-errors/clear', async (c) => {
    db.prepare('DELETE FROM client_errors').run();
    return c.json({ ok: true });
  });
  app.get('/api/admin/reconcile', (c) => c.json({ last: members.lastReconcile() }));
  // 刚跑完的那一次一定是最新的：直接回 uncheckedCount: 0，别让前端刚点完还提示「有 N 位没核对」
  app.post('/api/admin/reconcile', (c) => c.json({ last: { ...members.reconcile(), uncheckedCount: 0 } }));

  // 新单实时推送（Server-Sent Events）：服务器主动「喊」老板端
  //
  // 两个细节不能省：
  // ① 心跳定时器必须能取消。以前 setTimeout 的返回值没保存，连接断了定时器还留着，
  //    每 25 秒积一个，老板端开一整天会攒下一堆闭包（闭包里还持有 stream）。
  // ② 心跳里带 currentDay：老板端靠它发现「跨营业日了」，从而整表重拉。
  //    跨日之后取餐号从 001 重新开始，不重拉的话界面会把两个 001 混在一起。
  app.get('/api/admin/stream', (c) =>
    streamSSE(c, async (stream) => {
      const queue: OrderEvent[] = [];
      let wake: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const off = orders.events.on((e) => { queue.push(e); wake?.(); });
      const stop = () => {
        off();
        if (timer) { clearTimeout(timer); timer = null; }
        wake?.();
      };
      stream.onAbort(stop);
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ day: orders.today() }) });
      while (!stream.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e.order) });
        }
        // 每 25 秒发一次心跳，防止中间的网络设备把空闲连接掐掉
        await new Promise<void>((r) => {
          wake = r;
          timer = setTimeout(r, 25000);
        });
        if (timer) { clearTimeout(timer); timer = null; }
        wake = null;
        if (!queue.length && !stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: JSON.stringify({ day: orders.today() }) });
        }
      }
      stop();
    }),
  );

  // 打印机状态（老板端"打印设置"页用）：能不能连通，一台一句人话
  app.get('/api/admin/printers', async (c) => {
    const env = readPrintEnv();
    return c.json({
      ...(await printer.healthAll()),
      // 两台编码/纸宽各配各的，UI 分别展示，避免"一台对一台错"时看不出哪台要改
      encodings: { receipt: env.receiptEncoding, label: env.labelEncoding },
      papers: { receipt: env.receiptPaper, label: env.labelPaper },
      // 标签机是「票据模式」还是「标签模式」决定发 ESC/POS 还是 TSPL；选错打出来就是空白，
      // 页面上必须让人看见当前是哪一种，否则只能靠猜
      labelProtocol: env.labelProtocol,
      labelSize: env.labelSize,
      recent: printLog.recent(),
    });
  });

  // 打测试页：不占订单，直接送一张示例小票/标签，用来确认纸宽、字号、切刀对不对
  // 装机那天老板就靠这一个按钮判断"连上了没有"
  app.post('/api/admin/printers/test', async (c) => {
    const target = String((await body(c)).target ?? 'receipt') as 'receipt' | 'label';
    const demo = toPrintOrder(
      {
        pickupNo: 88, tableNo: '12', status: 'pending', totalSen: 4970,
        note: '这是测试单，不用做', createdAt: clock().toISOString(), paymentMethod: 'cash',
        items: [
          { dishUid: '__demo_f', code: 'T01', name: '测试菜名（很长的那种，看看折行）', priceSen: 1990, qty: 2 },
          { dishUid: '__demo_l', code: 'T02', name: '测试饮品', priceSen: 990, qty: 1 },
        ],
      },
      {
        timezone: data.brand.timezone,
        payLabel: payLabelOf(data.brand.paymentMethods, 'cash'),
        shop: { ...storeInfo.get() },
        // 测试页两种纸都要能出，所以把 demo 那杯也认定为饮品
        drinkUids: ['__demo_l'],
      }
    );
    const r = await printer.reprint(target, demo, shopForPrint);
    return c.json(r, r.ok ? 200 : 502);
  });

  // 手动补打（老板端点"重新打印"）：鉴权由上面的 /api/admin/* 中间件统一负责
  app.post('/api/admin/orders/:id/reprint', async (c) => {
    const target = String((await body(c)).target ?? 'receipt') as 'receipt' | 'label';
    const o = orders.get(c.req.param('id'));
    const r = await printer.reprint(target, buildPrintOrder(o), shopForPrint);
    return c.json(r, r.ok ? 200 : 502);
  });

  /**
   * 前端错误上报（P3-8）。**不带鉴权、也不该带**：错误往往发生在登录之前。
   * 所以这里自己立规矩，不让它变成写库的洞：
   *   · 字段全部截断（message 500 字、stack 2000 字），不接受任意长的字符串
   *   · 同一台机器每分钟最多 10 条（内存计数，进程重启就清零，够用）
   *   · 同一错误（message+source+line）已经有过就只把 hits 加一，不新增行
   */
  const errHits = new Map<string, { count: number; resetAt: number }>();
  const tooManyErrors = (ip: string): boolean => {
    const now = clock().getTime();
    const rec = errHits.get(ip);
    if (!rec || now > rec.resetAt) { errHits.set(ip, { count: 1, resetAt: now + 60_000 }); return false; }
    rec.count += 1;
    return rec.count > 10;
  };
  app.post('/api/client-error', async (c) => {
    const ip = clientScope(c);
    if (tooManyErrors(ip)) return c.json({ ok: true }); // 静默丢弃，别让上报接口自己变成攻击面
    const b = await body(c);
    const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);
    const app = b.app === 'admin' ? 'admin' : 'customer';
    const message = cut(b.message, 500)?.trim();
    // 消息为空或者明显是噪音，就当收到、不落库
    if (!message) return c.json({ ok: true });
    const source = cut(b.source, 300);
    const lineno = typeof b.lineno === 'number' && Number.isFinite(b.lineno) ? Math.trunc(b.lineno) : null;
    const at = clock().toISOString();
    // 注意引号：SQLite 里双引号是「标识符」（列名），只有单引号才是字符串字面量。
    // 写成 ifnull(source, "") 会让 SQLite 去解读一个叫「」的列，整句 prepare 直接报错——
    // 这个接口是第一版就写错的，结果错误监控自己 500，一条错误都收不到（已修，并加了回归测试）。
    // 用 IS 比较而不是 = ：source/lineno 可能是 NULL，NULL = NULL 不成立，会漏掉重复项。
    const exist = db
      .prepare('SELECT id FROM client_errors WHERE app = ? AND message = ? AND source IS ? AND lineno IS ?')
      .get(app, message, source, lineno) as { id: number } | undefined;
    if (exist) {
      db.prepare('UPDATE client_errors SET hits = hits + 1, last_at = ? WHERE id = ?').run(at, exist.id);
    } else {
      db.prepare(`INSERT INTO client_errors (app, message, source, lineno, colno, stack, ua, url, first_at, last_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          app, message, source, lineno,
          typeof b.colno === 'number' && Number.isFinite(b.colno) ? Math.trunc(b.colno) : null,
          cut(b.stack, 2000), cut(c.req.header('user-agent'), 200), cut(b.url, 300), at, at,
        );
    }
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: 'not_found', message: '没有这个接口' }, 404));
  // 业务错误返回对应状态码和中文说明；未预料的错误统一 500，前端显示错误卡片，绝不白屏
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: 'business', message: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'internal', message: '服务器出了点问题，请稍后再试' }, 500);
  });

  // auth 一并交出去：main.ts 要拿它做过期会话清理（P1-8）
  return { app, orders, carts, members, menu, store, auth };
}
