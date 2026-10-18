import { useCallback, useEffect, useRef, useState } from 'react';
import { Cart, Faq, MemberDetail, Menu, Order, StoreInfo, StoreStatus, TodaySignature, WaitInfo } from '@pkg/contract';
import { ApiError, fetchJson, postJson, safeStorage } from '@pkg/ui-kit';
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

  /** 在最新数量上加减 delta（+1 / -1） */
  const change = (dishUid: string, delta: number) =>
    apply((c) => {
      if (!c) return null;
      const qty = Math.max(0, Math.min(99, (c.lines.find((l) => l.dishUid === dishUid)?.qty ?? 0) + delta));
      return postJson('/api/cart/update', { cartId: c.id, dishUid, qty }, (v) => Cart.parse(v));
    });
  const remove = (dishUid: string) =>
    apply((c) => (c ? postJson('/api/cart/clearItem', { cartId: c.id, dishUid }, (v) => Cart.parse(v)) : null));
  const clear = () => apply((c) => (c ? postJson('/api/cart/clear', { cartId: c.id }, (v) => Cart.parse(v)) : null));
  const buyAgain = async (orderId: string): Promise<string[]> => {
    let skipped: string[] = [];
    await apply(async (c) => {
      if (!c) throw new Error('购物车还没准备好，请稍后再试');
      const r = await postJson('/api/cart/buyAgain', { cartId: c.id, orderId }, (v) => z.object({ cart: Cart, skipped: z.array(z.string()) }).parse(v));
      skipped = r.skipped;
      return r.cart;
    });
    return skipped;
  };
  /** 下单成功后服务器已清空购物车，这里同步一下 */
  const afterSubmit = () => refresh();

  return {
    cart, error, refresh, change, remove, clear, buyAgain, afterSubmit,
    qtyOf: (uid: string) => cart?.lines.find((l) => l.dishUid === uid)?.qty ?? 0,
  };
}
export type CartApi = ReturnType<typeof useCart>;

const MEMBER_KEY = 'member-token';

export function submitOrder(input: { cartId: string; tableNo: string; paymentMethod: string; note: string; useStoredValue: boolean }) {
  const token = safeStorage.get(MEMBER_KEY);
  return fetchJson('/api/order/submit', (v) => Order.parse(v), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-member-token': token } : {}) },
    body: JSON.stringify(input),
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
