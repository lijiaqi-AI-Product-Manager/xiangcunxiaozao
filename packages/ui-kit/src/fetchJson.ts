/**
 * 前端统一请求入口：任何失败都变成一句看得懂的中文，交给页面显示在错误卡片里。
 * 后端给了 message 就用后端的；没给（服务器没启动、代理报错、返回的不是 JSON）就用通用说法。
 *
 * 超时：所有请求都带 AbortSignal.timeout。以前没有超时，商场 Wi-Fi 一抖请求就永久挂起，
 * 按钮一直停在「提交中…」，顾客只能刷新，而刷新之后不知道自己的单到底下没下。
 *
 * 超时和「连不上」要分开说：超时的意思是「服务器可能已经收到了，只是回话晚了」，
 * 这句文案必须能让顾客去查订单，不能让他以为没下成功又点一次。
 */

/** 读操作：15 秒还没回来就算超时 */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** 写操作（下单、退款、充值）：给多一点，20 秒 */
export const WRITE_TIMEOUT_MS = 20_000;

export interface FetchOptions extends RequestInit {
  /** 超时毫秒数，不传按 15 秒 */
  timeoutMs?: number;
  /** 外部取消（比如页面卸载）：会被合并进同一个 AbortSignal */
  signal?: AbortSignal | null;
}

/** 超时专用错误：页面可以据此显示「不确定是否成功，请查看订单」而不是「失败重试」 */
export class TimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`服务器 ${Math.round(timeoutMs / 1000)} 秒没有回应`);
    this.name = 'TimeoutError';
  }
}

export async function fetchJson<T>(url: string, parse: (v: unknown) => T, init?: FetchOptions): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init ?? {};
  // 浏览器太老（没有 AbortSignal.timeout）就退化成不带超时，不要因此整个页面不能用
  const timeoutSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : null;
  const merged = mergeSignals(signal, timeoutSignal);

  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: merged });
  } catch (e: unknown) {
    // 超时被 AbortController 变成 AbortError，这里要转成一句人话，并且和「连不上」区分开
    if (timeoutSignal?.aborted) throw new TimeoutError(timeoutMs);
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('请求已取消');
    throw new Error('网络连接失败，请检查网络后重试');
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok || body === undefined) {
    const msg = body && typeof body === 'object' && 'message' in body ? String(body.message) : null;
    throw new ApiError(msg ?? `暂时连不上服务器，请稍后再试（错误码 ${res.status}）`, res.status);
  }
  return parse(body);
}

/** 两个信号合并：任意一个 abort 就 abort。没有 AbortSignal.any 的旧浏览器手动接一下 */
function mergeSignals(a: AbortSignal | null | undefined, b: AbortSignal | null): AbortSignal | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (a.aborted || b.aborted) ctl.abort();
  else { a.addEventListener('abort', onAbort, { once: true }); b.addEventListener('abort', onAbort, { once: true }); }
  return ctl.signal;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** POST 一个 JSON；token 有值时带上老板端登录令牌 */
export function postJson<T>(url: string, payload: unknown, parse: (v: unknown) => T, token?: string | null, init?: FetchOptions): Promise<T> {
  return fetchJson(url, parse, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
}

/** 浏览器本地存储可能被禁用（无痕模式等），读写都包一层，失败就当没有 */
export const safeStorage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* 存不了就算了，功能不受影响 */ }
  },
  remove(key: string) {
    try { localStorage.removeItem(key); } catch { /* 同上 */ }
  },
};

/**
 * 生成一个随机请求编号，用作幂等键。
 * 不用 crypto.randomUUID：局域网用 IP 访问（http://192.168.x.x）时它不是安全上下文，浏览器里不存在这个方法。
 */
export function newRequestId(): string {
  const buf = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
