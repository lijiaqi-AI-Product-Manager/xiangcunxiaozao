/**
 * 前端统一请求入口：任何失败都变成一句看得懂的中文，交给页面显示在错误卡片里。
 * 后端给了 message 就用后端的；没给（服务器没启动、代理报错、返回的不是 JSON）就用通用说法。
 */
export async function fetchJson<T>(url: string, parse: (v: unknown) => T, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('网络连接失败，请检查网络后重试');
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok || body === undefined) {
    const msg = body && typeof body === 'object' && 'message' in body ? String(body.message) : null;
    throw new ApiError(msg ?? `暂时连不上服务器，请稍后再试（错误码 ${res.status}）`, res.status);
  }
  return parse(body);
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** POST 一个 JSON；token 有值时带上老板端登录令牌 */
export function postJson<T>(url: string, payload: unknown, parse: (v: unknown) => T, token?: string | null): Promise<T> {
  return fetchJson(url, parse, {
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
