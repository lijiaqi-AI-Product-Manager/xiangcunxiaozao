import { useCallback, useEffect, useRef, useState } from 'react';
import { Cart, Faq, MemberDetail, Menu, Order, StoreInfo, StoreStatus, TodaySignature, WaitInfo } from '@pkg/contract';
import { ApiError, fetchJson, newRequestId, postJson, safeStorage, WRITE_TIMEOUT_MS } from '@pkg/ui-kit';
import { planChange } from './cart-plan.ts';
import { z } from 'zod';

export type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; message: string };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : '网络异常');

function useResource<T>(url: string | null, parse: (v: unknown) => T, pollMs?: number): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const run = (quiet: boolean) => {
      if (!quiet) setLoad({ state: 'loading' });
      fetchJson(url, parse)
        .then((data) => alive && setLoad({ state: 'ok', data }))
        .catch((e: unknown) => alive && !quiet && setLoad({ state: 'error', message: errMsg(e) }));
    };
    run(false);
    // 轮询时静默刷新：失败不打断已显示的内容
    const timer = pollMs ? setInterval(() => run(true), pollMs) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [url, tick, pollMs]);
  return [load, () => setTick((t) => t + 1)];
}

export const useMenu = () => useResource('/api/menu', (v) => Menu.parse(v));
export const useFaq = () => useResource('/api/faq', (v) => Faq.parse(v));
export const useWait = () => useResource('/api/cart/waitingTime', (v) => WaitInfo.parse(v), 30000);
export const useStoreStatus = () => useResource('/api/store/status', (v) => StoreStatus.parse(v), 60000);
/** 54号 §2.2 今日招牌：老板端配置的菜品 ID 列表（大画态 + 横幅卡同源）；每 5 分钟静默刷新一次 */
export const useToday = () => useResource('/api/store/today', (v) => TodaySignature.parse(v), 300000);
/** 58号 门店信息（地址 / 电话 / 营业时间 / WhatsApp）：老板端编辑，没填的为 null */
export const useStoreInfo = () => useResource('/api/store/info', (v) => StoreInfo.parse(v));
export const useMyOrders =(deviceId: string | null) =>
  useResource(deviceId ? `/api/order/mine?device=${encodeURIComponent(deviceId)}` : null, (v) => z.array(Order).parse(v), 10000);

const CART_KEY = 'cart-id';

/**
 * 这台手机的固定编号（存在本地，首次访问生成）。
 *
 * 以前取餐页和「我的订单」用的是购物车 id 当设备号——下单后购物车被清空、车号可能换掉，
 * 一旦刷新失败就查不到自己的单。设备号必须和购物车分开，才能做到「不管网络怎么抖，我都能找回我的单」。
 */
const DEVICE_KEY = 'device-id';
export function deviceId(): string {
  const saved = safeStorage.get(DEVICE_KEY);
  if (saved && /^[\w-]{8,64}$/.test(saved)) return saved;
  const fresh = newRequestId();
  safeStorage.set(DEVICE_KEY, fresh);
  return fresh;
}

/**
 * 购物车：服务器说了算（23号定律2）。本地只记一个车号；
 * 页面回到前台、网络恢复时整车重新拉一次（refresh 语义）。
 */
export function useCart() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<Cart | null>(null);
  const queue = useRef(Promise.resolve());

  // 请求排队一个一个发：连点两下「+」时，第二下要等第一下的结果回来、基于最新数量再算，
  // 否则两下都会发「数量 = 1」
  const apply = useCallback((make: (current: Cart | null) => Promise<Cart> | null) => {
    queue.current = queue.current.then(async () => {
      const p = make(latest.current);
      if (!p) return;
      try {
        const c = await p;
        latest.current = c;
        safeStorage.set(CART_KEY, c.id);
        setCart(c);
        setError(null);
      } catch (e) {
        setError(errMsg(e));
      }
    });
    return queue.current;
  }, []);

  const refresh = useCallback(
    () => apply(() => postJson('/api/cart/refresh', { cartId: safeStorage.get(CART_KEY) }, (v) => Cart.parse(v))),
    [apply],
  );

  useEffect(() => {
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refresh);
    };
  }, [refresh]);

  /**
   * 加一份菜（可带辣度和备注）。辣度相同的同一个菜会合并到一行，
   * 辣度不同就是新的一行——一桌人辣度不同就靠这个（P1-9）。
   */
  const addDish = (dishUid: string, spice = '', note = '', delta = 1) =>
    apply((cur) => {
      if (!cur) return null;
      // 已有「同菜 + 同辣度 + 同备注」的那一行 → 在它上面加，避免冒出两行一样的
      const same = cur.lines.find((l) => l.dishUid === dishUid && l.spice === spice && l.note === note);
      const qty = Math.max(0, Math.min(99, (same?.qty ?? 0) + delta));
      return postJson('/api/cart/update', { cartId: cur.id, dishUid, qty, spice, note }, (v) => Cart.parse(v));
    });

  /** 改某一行的数量（0 = 删掉这一行）。认行 id，不认菜——同菜多行时不会改错 */
  const setLineQty = (lineId: string, qty: number) =>
    apply((c) => (c ? postJson('/api/cart/update', { cartId: c.id, lineId, qty: Math.max(0, Math.min(99, qty)) }, (v) => Cart.parse(v)) : null));

  /** 改某一行的辣度/备注（顾客在购物车里直接改，不用删了重加） */
  const setLine = (lineId: string, patch: { spice?: string; note?: string }) =>
    apply((c) => (c ? postJson('/api/cart/line', { cartId: c.id, lineId, ...patch }, (v) => Cart.parse(v)) : null));

  /** 删掉某一整行 */
  const removeLine = (lineId: string) =>
    apply((c) => (c ? postJson('/api/cart/remove', { cartId: c.id, lineId }, (v) => Cart.parse(v)) : null));

  /**
   * 在最新数量上加减 delta（+1 / -1），动的是「数量最多的那一行」。
   * 只有一行时就是它；同菜多行（不同辣度）时，界面上每行有自己的加减按钮（走 setLineQty），
   * 这里作为菜单页 / 详情页上那个「+」的入口。
   *
   * 具体发什么请求由 planChange() 决定（纯函数，有单元测试）。这里只负责发。
   */
  const change = (dishUid: string, delta: number) =>
    apply((c) => {
      if (!c) return null;
      const plan = planChange(c.lines, dishUid, delta);
      if (plan.kind === 'none') return null;
      if (plan.kind === 'addDish') return addRow(c, plan.dishUid, plan.qty);
      return postJson('/api/cart/update', { cartId: c.id, lineId: plan.lineId, qty: plan.qty }, (v) => Cart.parse(v));
    });

  /**
   * 往车里加一行（不带辣度 / 备注）。辣度和备注在详情页选，那是顾客有上下文的地方；
   * 菜单列表上的「+」只管「来一份」，要讲究的顾客会点进详情。
   */
  function addRow(c: Cart, dishUid: string, qty: number): Promise<Cart> {
    return postJson('/api/cart/update', { cartId: c.id, dishUid, qty: Math.max(1, qty), spice: '', note: '' }, (v) => Cart.parse(v));
  }
  const remove = (dishUid: string) =>
    apply((c) => (c ? postJson('/api/cart/clearItem', { cartId: c.id, dishUid }, (v) => Cart.parse(v)) : null));
  const clear = () => apply((c) => (c ? postJson('/api/cart/clear', { cartId: c.id }, (v) => Cart.parse(v)) : null));
  const buyAgain = async (orderId: string): Promise<string[]> => {
    let skipped: string[] = [];
    await apply(async (c) => {
      if (!c) throw new Error('购物车还没准备好，请稍后再试');
      // 必须带上 deviceId：服务端靠它认「这张单是不是这台手机的」。
      // 只给 cartId 的话，前端一旦换了车号（或下单后车被清空重开），会一直报「找不到这张订单」。
      const r = await postJson('/api/cart/buyAgain', { cartId: c.id, orderId, deviceId: deviceId() }, (v) => z.object({ cart: Cart, skipped: z.array(z.string()) }).parse(v));
      skipped = r.skipped;
      return r.cart;
    });
    return skipped;
  };
  /**
   * 下单成功后服务器已清空购物车，这里同步一下。
   * 返回 Promise：调用方必须 await 之后再跳取餐页，否则取餐页拿到的是旧数据，会先闪一下「还没有订单」。
   */
  const afterSubmit = () => refresh();

  return {
    cart, error, refresh, change, remove, clear, buyAgain, afterSubmit,
    addDish, setLineQty, setLine, removeLine,
    qtyOf: (uid: string) => cart?.lines.filter((l) => l.dishUid === uid).reduce((n, l) => n + l.qty, 0) ?? 0,
  };
}
export type CartApi = ReturnType<typeof useCart>;

const MEMBER_KEY = 'member-token';

/**
 * 下单。带幂等编号 requestId：同一个编号重复提交，服务端返回的是第一次那张单，不会建两张。
 *
 * 为什么必须有：顾客网络一抖，订单已经在后厨了，但响应丢了，页面显示「网络连接失败」。
 * 顾客唯一的合理动作是再点一次——没有幂等键的话，第二次撞上「购物车是空的」，他以为没下成功。
 * 有了幂等键，第二次拿回来的是同一张单，取餐号都一样。
 *
 * requestId 由调用方保管（重试时复用）；不传就当场新生成一个。
 */
export function submitOrder(input: {
  cartId: string; tableNo: string; paymentMethod: string; note: string; useStoredValue: boolean;
  requestId: string;
}) {
  const token = safeStorage.get(MEMBER_KEY);
  return fetchJson('/api/order/submit', (v) => Order.parse(v), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-member-token': token } : {}) },
    // deviceId 让这张单挂在「这台手机」名下，取餐页和「我的订单」才找得回来。
    // 不带的话服务端只能退回用购物车 id，那两处就永远是空的（见 SubmitOrderInput.deviceId 的说明）
    body: JSON.stringify({ ...input, deviceId: deviceId() }),
    // 写操作多给 5 秒：建单要写库、要触发打印，比读接口重
    timeoutMs: WRITE_TIMEOUT_MS,
  });
}

/**
 * 加菜（P2-6）：往今天这张还没做完的单后面再加两个菜。
 *
 * 顾客只需要填取餐号——桌号、付款方式都沿用原单，所以这里一个多余的问题都不问。
 * 和下单一样带 requestId：手抖点两下、或者网络重试，都只会加一次菜。
 */
export function addDishes(input: { pickupNo: number; cartId: string; note: string; requestId: string }) {
  const token = safeStorage.get(MEMBER_KEY);
  return fetchJson('/api/order/add', (v) => Order.parse(v), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-member-token': token } : {}) },
    body: JSON.stringify({ ...input, deviceId: deviceId() }),
    timeoutMs: WRITE_TIMEOUT_MS,
  });
}

/** 会员（顾客端只读）：登录后显示余额与流水；储值支付时带上会员令牌 */
export function useMember() {
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(safeStorage.get(MEMBER_KEY)));
  const refresh = useCallback(async () => {
    const token = safeStorage.get(MEMBER_KEY);
    if (!token) { setDetail(null); setLoading(false); return; }
    try {
      setDetail(await fetchJson('/api/member/me', (v) => MemberDetail.parse(v), { headers: { 'x-member-token': token } }));
    } catch (e) {
      // 令牌过期就当没登录；网络问题保留已显示的内容
      if (e instanceof ApiError && e.status === 401) { safeStorage.remove(MEMBER_KEY); setDetail(null); }
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const login = async (memberNo: string, pin: string) => {
    const r = await postJson('/api/member/login', { memberNo, pin }, (v) => z.object({ token: z.string() }).parse(v));
    safeStorage.set(MEMBER_KEY, r.token);
    await refresh();
  };
  const logout = async () => {
    const token = safeStorage.get(MEMBER_KEY);
    safeStorage.remove(MEMBER_KEY);
    setDetail(null);
    if (token) await fetchJson('/api/member/logout', () => null, { method: 'POST', headers: { 'x-member-token': token } }).catch(() => {});
  };
  return { detail, loading, refresh, login, logout };
}
export type MemberApi = ReturnType<typeof useMember>;
