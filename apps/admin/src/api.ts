import { useEffect, useRef, useState } from 'react';
import { Order } from '@pkg/contract';
import { ApiError, fetchJson, postJson, safeStorage } from '@pkg/ui-kit';
import { z } from 'zod';

const TOKEN_KEY = 'admin-token';
export const getToken = () => safeStorage.get(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? safeStorage.set(TOKEN_KEY, t) : safeStorage.remove(TOKEN_KEY));

/** 令牌失效（401）时通知外层回到登录页 */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setToken(null); onUnauthorized(); }
    throw e;
  }
}

export const adminGet = <T,>(url: string, parse: (v: unknown) => T) =>
  guard(fetchJson(url, parse, { headers: { authorization: `Bearer ${getToken() ?? ''}` } }));
export const adminPost = <T,>(url: string, body: unknown, parse: (v: unknown) => T) =>
  guard(postJson(url, body, parse, getToken()));

/** 上传文件（菜品图）：不设 content-type，让浏览器自己带上分隔符 */
export const adminUpload = <T,>(url: string, file: File, parse: (v: unknown) => T) => {
  const form = new FormData();
  form.append('file', file);
  return guard(fetchJson(url, parse, { method: 'POST', headers: { authorization: `Bearer ${getToken() ?? ''}` }, body: form }));
};

export const login = (password: string) =>
  postJson('/api/admin/login', { password }, (v) => z.object({ token: z.string() }).parse(v)).then((r) => { setToken(r.token); });

export const OrdersDay = z.object({ day: z.string(), orders: z.array(Order) });
export const WaitSettings = z.object({
  minutesPerOrder: z.number(),
  manualMinutes: z.number().nullable(),
  current: z.object({ minutes: z.number(), queue: z.number(), source: z.enum(['auto', 'manual']) }),
});
export type WaitSettings = z.infer<typeof WaitSettings>;

export type LiveState = 'connecting' | 'live' | 'broken';

/**
 * 实时订单：先拉一次今天的全部订单，再订阅服务器推送。
 * 断线时浏览器会自动重连；每次（重新）连上都会收到 hello，这时整表重拉一次，补上断线期间漏掉的单。
 */
export function useLiveOrders(onNewOrder: (o: Order) => void) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [state, setState] = useState<LiveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const onNew = useRef(onNewOrder);
  onNew.current = onNewOrder;

  useEffect(() => {
    const reload = () =>
      adminGet('/api/admin/orders', (v) => OrdersDay.parse(v))
        .then((d) => { setOrders(d.orders); setError(null); })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : '订单加载失败'));
    const upsert = (o: Order) =>
      setOrders((list) => {
        const rest = (list ?? []).filter((x) => x.id !== o.id);
        return [...rest, o].sort((a, b) => a.pickupNo - b.pickupNo);
      });

    // 只靠浏览器自己发现断线不够：Wi-Fi 悄悄掉线时，连接可能「看起来还连着」但再也收不到新单。
    // 所以加两道保险：① 服务器每 25 秒发一次心跳，40 秒没听到就判定断线、主动重连；
    // ② 手机/平板报告「断网」时立刻显示断线，「恢复联网」时立刻重连。每次重连成功都整表重拉补漏单。
    let es: EventSource | null = null;
    let lastBeat = Date.now();
    const beat = () => { lastBeat = Date.now(); };
    const connect = () => {
      es?.close();
      beat();
      es = new EventSource(`/api/admin/stream?token=${encodeURIComponent(getToken() ?? '')}`);
      es.addEventListener('hello', () => { beat(); setState('live'); void reload(); });
      es.addEventListener('ping', beat);
      es.addEventListener('order.created', (ev) => {
        beat();
        const o = Order.parse(JSON.parse((ev as MessageEvent<string>).data));
        upsert(o);
        onNew.current(o);
      });
      es.addEventListener('order.updated', (ev) => { beat(); upsert(Order.parse(JSON.parse((ev as MessageEvent<string>).data))); });
      es.onerror = () => setState('broken');
    };
    const watchdog = setInterval(() => {
      if (Date.now() - lastBeat > 40000) { setState('broken'); connect(); }
    }, 5000);
    const offline = () => { setState('broken'); es?.close(); };
    const online = () => { setState('connecting'); connect(); };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    connect();
    void reload();
    return () => {
      clearInterval(watchdog);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      es?.close();
    };
  }, []);

  const replace = (o: Order) => setOrders((list) => (list ?? []).map((x) => (x.id === o.id ? o : x)));
  return { orders, state, error, replace };
}
