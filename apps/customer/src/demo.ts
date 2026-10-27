// 58号 任务5 演示版：主程序原样打包成静态网页，不连服务器、不连数据库。
// 只有演示构建（scripts/build-demo.ts）才会打进这个文件；正式构建里 import.meta.env.VITE_DEMO 为空，整段被删掉。
// 做法：拦下页面发出的 /api/* 请求，在浏览器里按服务器同样的规则回答——菜单、问答、今日招牌是导出时从真服务器拿的一份快照，
// 购物车、下单、取餐进度在本机模拟（存在这台手机的浏览器里，别人看不到）；会员登录不模拟（会员体系挂起，演示版不编会员数据）。
import { formatDate, type Cart, type Dish, type Faq, type Menu, type Order, type StoreInfo, type TodaySignature } from '@pkg/contract';
import { safeStorage } from '@pkg/ui-kit';
import { brand } from './common.tsx';

interface DemoData { menu: Menu; faq: Faq; today: TodaySignature; info: StoreInfo }
// 购物车行 = 一道菜 + 一个辣度 + 一条备注（P1-9），跟服务端一致
interface DemoLine { id: string; uid: string; qty: number; spice: string; note: string }
interface State { carts: Record<string, DemoLine[]>; orders: (Omit<Order, 'status' | 'etaMinutes' | 'updatedAt'> & { device: string })[] }

const KEY = 'demo-state';
// 演示用的出餐节奏：下单后 15 秒开始制作、45 秒完成（只为让取餐页的进度动起来看效果）
const COOKING_AFTER = 15_000;
const DONE_AFTER = 45_000;

class Fail extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function installDemo() {
  const real = window.fetch.bind(window);
  const data = (await (await real(new URL('demo-data.json', location.href))).json()) as DemoData;
  fixBrandUrls();
  if (!safeStorage.get('last-table')) safeStorage.set('last-table', '8'); // 演示没有桌上二维码，先给一个桌号（结算页可改）

  const dishes = new Map<string, Dish>(data.menu.dishes.filter((d) => d.orderable).map((d) => [d.uid, d]));
  let state: State = { carts: {}, orders: [] };
  try { state = { ...state, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<State>) }; } catch { /* 隐私模式：只在内存里 */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 同上 */ } };
  const now = () => new Date().toISOString();
  const perOrder = brand.wait.minutesPerOrder;

  const cartView = (id: string): Cart => {
    const lines = (state.carts[id] ?? []).map((it) => {
      const d = dishes.get(it.uid);
      const price = d?.priceSen ?? null;
      const reason = !d || price === null ? ('off' as const) : d.soldOut ? ('soldout' as const) : null;
      return {
        id: it.id, dishUid: it.uid, code: d?.code ?? '', name: d?.name ?? '已下架的菜品', priceSen: price, qty: it.qty,
        subtotalSen: price === null ? 0 : price * it.qty, spice: it.spice, note: it.note,
        available: reason === null, unavailableReason: reason,
      };
    });
    return { id, lines, count: lines.reduce((n, l) => n + l.qty, 0), totalSen: lines.reduce((n, l) => n + l.subtotalSen, 0), updatedAt: now() };
  };
  const mustCart = (id: unknown) => {
    if (typeof id !== 'string' || !state.carts[id]) throw new Fail(404, '购物车不存在，请刷新页面');
    return id;
  };
  const statusOf = (o: State['orders'][number]): Order['status'] => {
    const age = Date.now() - Date.parse(o.createdAt);
    return age >= DONE_AFTER ? 'done' : age >= COOKING_AFTER ? 'cooking' : 'pending';
  };
  const orderView = (o: State['orders'][number]): Order => {
    const status = statusOf(o);
    const active = state.orders.filter((x) => statusOf(x) !== 'done' && x.pickupNo <= o.pickupNo).length;
    const { device: _device, ...rest } = o;
    return { ...rest, status, updatedAt: o.createdAt, etaMinutes: status === 'done' ? null : active * perOrder };
  };

  const routes: Record<string, (b: Record<string, unknown>, url: URL) => unknown> = {
    'GET /api/menu': () => data.menu,
    'GET /api/faq': () => data.faq,
    'GET /api/store/status': () => ({ open: true, reason: null, openAt: null, closeAt: null }),
    'GET /api/store/today': () => data.today,
    'GET /api/store/info': () => data.info,
    'GET /api/cart/waitingTime': () => {
      const queue = state.orders.filter((o) => statusOf(o) !== 'done').length;
      return { minutes: (queue + 1) * perOrder, queue, source: 'auto' };
    },
    'POST /api/cart/refresh': (b) => {
      const id = typeof b.cartId === 'string' && b.cartId ? b.cartId : crypto.randomUUID();
      state.carts[id] ??= [];
      save();
      return cartView(id);
    },
    'POST /api/cart/update': (b) => {
      const id = mustCart(b.cartId);
      const items = state.carts[id]!;
      // 按行改数量（新）或按菜改数量（老调用），两条路都留着
      if (typeof b.lineId === 'string') {
        const line = items.find((x) => x.id === b.lineId);
        if (!line) throw new Fail(404, '这一行已经不在购物车里了，刷新看看');
        const qty = Number(b.qty);
        if (!Number.isInteger(qty) || qty < 0 || qty > 99) throw new Fail(400, '数量需在 0 到 99 之间');
        if (qty === 0) state.carts[id] = items.filter((x) => x.id !== line.id);
        else line.qty = qty;
        save();
        return cartView(id);
      }
      const qty = Number(b.qty);
      if (!Number.isInteger(qty) || qty < 0 || qty > 99) throw new Fail(400, '数量需在 0 到 99 之间');
      const spice = String(b.spice ?? '');
      const note = String(b.note ?? '');
      // 同菜同辣度同备注 = 同一行
      const had = items.find((x) => x.uid === b.dishUid && x.spice === spice && x.note === note);
      if (qty === 0) state.carts[id] = items.filter((x) => !(x.uid === b.dishUid && x.spice === spice && x.note === note));
      else {
        const d = dishes.get(String(b.dishUid));
        if (!d) throw new Fail(404, '这道菜暂时不能点');
        if (d.soldOut && qty > (had?.qty ?? 0)) throw new Fail(409, `「${d.name}」今日已售罄`);
        if (had) had.qty = qty;
        else items.push({ id: crypto.randomUUID(), uid: d.uid, qty, spice, note });
      }
      save();
      return cartView(id);
    },
    'POST /api/cart/remove': (b) => {
      const id = mustCart(b.cartId);
      state.carts[id] = state.carts[id]!.filter((x) => x.id !== b.lineId);
      save();
      return cartView(id);
    },
    'POST /api/cart/clearItem': (b) => {
      const id = mustCart(b.cartId);
      state.carts[id] = state.carts[id]!.filter((x) => x.uid !== b.dishUid);
      save();
      return cartView(id);
    },
    'POST /api/cart/clear': (b) => {
      const id = mustCart(b.cartId);
      state.carts[id] = [];
      save();
      return cartView(id);
    },
    'POST /api/cart/buyAgain': (b) => {
      const id = mustCart(b.cartId);
      // 同一台手机 = 同一个设备号（订单不再按购物车 id 归属，见 submit 里的说明）
      const device = typeof b.deviceId === 'string' && b.deviceId ? b.deviceId : id;
      const o = state.orders.find((x) => x.id === b.orderId && x.device === device);
      if (!o) throw new Fail(404, '找不到这张订单');
      const skipped: string[] = [];
      for (const it of o.items) {
        const d = dishes.get(it.dishUid);
        if (!d || d.soldOut) { skipped.push(it.name); continue; }
        const spice = it.spice ?? '';
        const note = it.note ?? '';
        const had = state.carts[id]!.find((x) => x.uid === it.dishUid && x.spice === spice && x.note === note);
        if (had) had.qty = Math.min(99, had.qty + it.qty);
        else state.carts[id]!.push({ id: crypto.randomUUID(), uid: it.dishUid, qty: Math.min(99, it.qty), spice, note });
      }
      save();
      return { cart: cartView(id), skipped };
    },
    'POST /api/order/submit': (b) => {
      const id = mustCart(b.cartId);
      const tableNo = String(b.tableNo ?? '').trim();
      if (!tableNo) throw new Fail(400, '请填写桌号');
      const pm = brand.paymentMethods.find((m) => m.key === b.paymentMethod);
      if (!pm) throw new Fail(400, '请选择付款方式');
      if (pm.requiresMember || b.useStoredValue === true) throw new Fail(401, '储值支付需要先在「会员」页登录');
      const cart = cartView(id);
      if (cart.lines.length === 0) throw new Fail(400, '购物车是空的');
      const gone = cart.lines.filter((l) => !l.available);
      if (gone.length) throw new Fail(409, `以下菜品暂时不能点，请先从购物车移除：${gone.map((l) => l.name).join('、')}`);
      const at = now();
      // 订单挂在「设备号」名下，不是购物车 id：下单后购物车会被清空换号，
      // 取餐页和「我的订单」都靠设备号找自己的单（和正式服务端一致）。
      const device = typeof b.deviceId === 'string' && b.deviceId ? b.deviceId : id;
      const o = {
        id: crypto.randomUUID(), device, pickupNo: state.orders.reduce((n, x) => Math.max(n, x.pickupNo), 0) + 1, businessDate: formatDate(at, brand.timezone),
        tableNo, paymentMethod: pm.key, note: String(b.note ?? '').trim() || null, totalSen: cart.totalSen, cancelReason: null, createdAt: at,
        items: cart.lines.map((l, i) => ({ line: i + 1, dishUid: l.dishUid, code: l.code, name: l.name, priceSen: l.priceSen ?? 0, qty: l.qty, refundedQty: 0, spice: l.spice ?? '', note: l.note ?? '' })),
        storedSen: 0, otherSen: cart.totalSen, refundState: 'none' as const, refundedSen: 0, refunds: [], autoCancelled: false, version: 0,
        // 演示版不做加菜：这三个字段留空，接口形状和正式版保持一致
        parentOrderId: null, addSeq: null, groupTotalSen: cart.totalSen, groupRefundedSen: 0, addCount: 0,
      };
      state.orders.push(o);
      state.carts[id] = [];
      save();
      return orderView(o);
    },
    'GET /api/order/mine': (_b, url) => state.orders.filter((o) => o.device === url.searchParams.get('device')).map(orderView).reverse(),
    'POST /api/member/login': () => { throw new Fail(400, '演示版不连会员数据，会员登录请到店里体验'); },
    'GET /api/member/me': () => { throw new Fail(401, '会员登录已过期，请重新登录'); },
    'POST /api/member/logout': () => ({ ok: true }),
  };

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const one = url.pathname.match(/^\/api\/order\/([\w-]+)$/);
    const handler = routes[`${method} ${url.pathname}`] ?? (method === 'GET' && one && one[1] !== 'mine'
      ? () => { const o = state.orders.find((x) => x.id === one[1]); if (!o) throw new Fail(404, '找不到这张订单'); return orderView(o); }
      : undefined);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!handler) return json(404, { error: 'not_found', message: '演示版没有这个功能' });
    try {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      return json(method === 'POST' && url.pathname === '/api/order/submit' ? 201 : 200, handler(body, url));
    } catch (e) {
      return e instanceof Fail ? json(e.status, { error: 'business', message: e.message }) : json(500, { error: 'internal', message: '演示版出错了，请刷新' });
    }
  };
}

/** 构建出来的品牌字体、水墨纹理用的是站点根路径（/brand-font/、/brand-art/）；静态网页不在站点根上，改成相对当前页面的完整地址 */
function fixBrandUrls() {
  const base = new URL('.', location.href).href;
  const fix = (s: string) => s.replace(/(["'(])\/(brand-(?:art|font)\/)/g, `$1${base}$2`);
  for (const el of document.querySelectorAll('style')) if (/\/brand-(art|font)\//.test(el.textContent ?? '')) el.textContent = fix(el.textContent ?? '');
  for (const el of document.querySelectorAll<HTMLLinkElement>('link[href^="/brand-"]')) el.href = base + el.getAttribute('href')!.slice(1);
}
