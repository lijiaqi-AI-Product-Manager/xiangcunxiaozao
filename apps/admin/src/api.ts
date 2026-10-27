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
/**
 * 上传菜品图。除了主图（详情页大图），再带一张小图（点单页 64×64 小格子用）。
 * 小图是可选字段：老浏览器压不出小图、或者小图上传失败，服务端会退回用主图，功能不会坏。
 */
export const adminUpload = <T,>(url: string, file: File, parse: (v: unknown) => T, thumb?: File) => {
  const form = new FormData();
  form.append('file', file);
  if (thumb) form.append('thumb', thumb);
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
 *
 * 跨营业日：服务器的心跳里带 day（今天的营业日）。跨日之后取餐号从 001 重新开始，
 * 不重拉的话界面上会出现两个 001，而且昨天的单会一直挂在那里。所以发现 day 变了就整表重拉。
 *
 * 注意：这个 hook 要挂在页面最外层（App），不要挂在某个页签里。
 * 以前它挂在「订单」页签内，页签是条件渲染，切到菜品管理时组件卸载、连接被关，
 * 新单不响铃、不提示——老板改个价格就漏单。
 */
export function useLiveOrders(onNewOrder: (o: Order) => void) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [state, setState] = useState<LiveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const onNew = useRef(onNewOrder);
  onNew.current = onNewOrder;
  // 当前界面上的营业日：用 ref 存，事件回调里读到的永远是最新值
  const dayRef = useRef<string | null>(null);

  useEffect(() => {
    const reload = () =>
      adminGet('/api/admin/orders', (v) => OrdersDay.parse(v))
        .then((d) => {
          dayRef.current = d.day;
          setDay(d.day);
          setOrders(d.orders);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : '订单加载失败'));

    /** 服务器说有新的一天了：整表重拉，别把两天的取餐号混在一起 */
    const syncDay = (incoming: unknown) => {
      if (typeof incoming !== 'string' || !incoming) return;
      if (dayRef.current && incoming !== dayRef.current) {
        dayRef.current = incoming;
        setDay(incoming);
        void reload();
      } else if (!dayRef.current) {
        dayRef.current = incoming;
        setDay(incoming);
      }
    };

    // 收到任何事件都先对一下日期，再往列表里塞
    const acceptEvent = (raw: string): Order | null => {
      const parsed = Order.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      const o = parsed.data;
      syncDay(o.businessDate);
      // 跨日的那一瞬：旧单还在列表里，新单的 businessDate 已经变了 —— 直接交给 reload 整表对齐
      if (dayRef.current && o.businessDate !== dayRef.current) return null;
      return o;
    };

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
    let alive = true;
    // 连上过一次没有：EventSource 首次失败也会触发 onerror，不能一律当断线
    let wasLive = false;
    const beat = () => { lastBeat = Date.now(); };

    const open = (ticket: string | null) => {
      if (!alive || !ticket) {
        // 票据拿不到（登录过期）→ 不是网络问题，别假装「重连中」，直接说清楚要重登
        setState('broken');
        setError('登录已过期，请刷新页面重新登录');
        return;
      }
      es = new EventSource(`/api/admin/stream?ticket=${encodeURIComponent(ticket)}`);
      es.addEventListener('hello', (ev) => {
        beat();
        wasLive = true;
        setState('live');
        setError(null);
        try { syncDay((JSON.parse((ev as MessageEvent<string>).data) as { day?: string }).day); } catch { /* 格式不对就当没有 */ }
        void reload();
      });
      es.addEventListener('ping', (ev) => {
        beat();
        try { syncDay((JSON.parse((ev as MessageEvent<string>).data) as { day?: string }).day); } catch { /* 同上 */ }
      });
      es.addEventListener('order.created', (ev) => {
        beat();
        const o = acceptEvent((ev as MessageEvent<string>).data);
        if (!o) return;
        upsert(o);
        onNew.current(o);
      });
      es.addEventListener('order.updated', (ev) => {
        beat();
        const o = acceptEvent((ev as MessageEvent<string>).data);
        if (o) upsert(o);
      });
      // 只在「刚才还连着」时才翻成断线：刚打开页面就失败不该先闪一下绿的
      es.onerror = () => { if (wasLive) setState('broken'); };
    };

    // 每次（重）连都先换一张一次性票：EventSource 带不了请求头，
    // 直接把令牌塞 URL 会留在日志和截图里（P3-4）。
    const connect = () => {
      es?.close();
      beat();
      adminGet('/api/admin/stream/ticket', (v) => z.object({ ticket: z.string() }).parse(v))
        .then((r) => open(r.ticket))
        .catch(() => open(null));
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
      alive = false;
      clearInterval(watchdog);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      es?.close();
    };
  }, []);

  const replace = (o: Order) => setOrders((list) => (list ?? []).map((x) => (x.id === o.id ? o : x)));
  return { orders, state, error, replace, day, reload: () => { location.reload(); } };
}
